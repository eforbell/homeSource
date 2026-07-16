'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const nodemailerDefault = require('nodemailer');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function envValue(env, key) {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolean(value, fallback, name) {
  if (value === '') return { value: fallback };
  const normalized = value.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return { value: true };
  if (FALSE_VALUES.has(normalized)) return { value: false };
  return { error: `${name} must be a boolean value` };
}

function parsePort(value) {
  if (value === '') return { value: 587 };
  if (!/^\d+$/.test(value)) return { error: 'SMTP_PORT must be an integer between 1 and 65535' };
  const port = Number(value);
  if (port < 1 || port > 65535) return { error: 'SMTP_PORT must be an integer between 1 and 65535' };
  return { value: port };
}

function disabled(reason) {
  return { transport: 'disabled', reason };
}

function getMailerConfig(env = process.env) {
  const requestedTransport = envValue(env, 'MAIL_TRANSPORT').toLowerCase();
  if (requestedTransport && !['smtp', 'console', 'file', 'disabled'].includes(requestedTransport)) {
    return disabled('MAIL_TRANSPORT must be smtp, console, file, or disabled');
  }
  if (requestedTransport === 'disabled') return disabled('MAIL_TRANSPORT is disabled');

  const transport = requestedTransport || (envValue(env, 'SMTP_HOST') ? 'smtp' : 'disabled');
  if (transport === 'disabled') return disabled('SMTP_HOST is not configured');

  const from = envValue(env, 'SMTP_FROM');
  if (!from) return disabled('SMTP_FROM is not configured');

  if (transport !== 'smtp') {
    return {
      transport,
      from,
      outputDir: envValue(env, 'MAIL_OUTPUT_DIR') || path.resolve(process.cwd(), 'data', 'mail')
    };
  }

  const host = envValue(env, 'SMTP_HOST');
  if (!host) return disabled('SMTP_HOST is not configured');

  const portResult = parsePort(envValue(env, 'SMTP_PORT'));
  if (portResult.error) return disabled(portResult.error);
  const secureResult = parseBoolean(envValue(env, 'SMTP_SECURE'), portResult.value === 465, 'SMTP_SECURE');
  if (secureResult.error) return disabled(secureResult.error);
  const requireTlsResult = parseBoolean(envValue(env, 'SMTP_REQUIRE_TLS'), true, 'SMTP_REQUIRE_TLS');
  if (requireTlsResult.error) return disabled(requireTlsResult.error);
  const rejectUnauthorizedResult = parseBoolean(
    envValue(env, 'SMTP_REJECT_UNAUTHORIZED'),
    true,
    'SMTP_REJECT_UNAUTHORIZED'
  );
  if (rejectUnauthorizedResult.error) return disabled(rejectUnauthorizedResult.error);

  const user = envValue(env, 'SMTP_USER');
  const pass = typeof env.SMTP_PASS === 'string' ? env.SMTP_PASS : '';
  if (Boolean(user) !== Boolean(pass)) return disabled('SMTP_USER and SMTP_PASS must be configured together');

  const options = {
    host,
    port: portResult.value,
    secure: secureResult.value,
    requireTLS: requireTlsResult.value,
    dnsTimeout: 5_000,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true
  };
  if (!rejectUnauthorizedResult.value) options.tls = { rejectUnauthorized: false };
  if (user) options.auth = { user, pass };

  return { transport: 'smtp', from, options };
}

function validateAddress(value, name) {
  const addresses = Array.isArray(value) ? value : [value];
  if (!addresses.length || addresses.some(address => typeof address !== 'string' || !address.trim())) {
    throw new TypeError(`${name} must contain at least one email address`);
  }
  if (addresses.some(address => /[\r\n]/.test(address))) {
    throw new TypeError(`${name} must not contain line breaks`);
  }
}

function validateMessage(message) {
  if (!message || typeof message !== 'object') throw new TypeError('message is required');
  validateAddress(message.to, 'to');
  if (typeof message.subject !== 'string' || !message.subject.trim()) {
    throw new TypeError('subject is required');
  }
  if (/[\r\n]/.test(message.subject)) throw new TypeError('subject must not contain line breaks');
  if (message.replyTo !== undefined) validateAddress(message.replyTo, 'replyTo');
  if (message.text !== undefined && typeof message.text !== 'string') throw new TypeError('text must be a string');
  if (message.html !== undefined && typeof message.html !== 'string') throw new TypeError('html must be a string');
  if (message.text === undefined && message.html === undefined) throw new TypeError('text or html is required');
}

function messageSummary(message) {
  return {
    recipientCount: Array.isArray(message.to) ? message.to.length : 1
  };
}

function classifyDeliveryError(err) {
  const code = String(err?.code || '').toUpperCase();
  const responseCode = Number(err?.responseCode || 0);
  const permanent = code === 'EENVELOPE' || code === 'EMESSAGE' || (responseCode >= 500 && responseCode <= 599);
  return {
    error_class: permanent ? 'smtp_permanent' : 'smtp_transient',
    retryable: !permanent
  };
}

function createMailer({ env = process.env, nodemailer = nodemailerDefault, logger = console } = {}) {
  const config = getMailerConfig(env);
  let transporter;

  function getTransporter() {
    if (transporter) return transporter;
    if (config.transport === 'smtp') {
      transporter = nodemailer.createTransport(config.options, { from: config.from });
    } else {
      transporter = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        disableFileAccess: true,
        disableUrlAccess: true
      }, { from: config.from });
    }
    return transporter;
  }

  async function send(message) {
    validateMessage(message);
    if (config.transport === 'disabled') {
      logger.warn({ event: 'mailer.skipped', reason: config.reason, ...messageSummary(message) });
      return { delivered: false, transport: 'disabled', reason: config.reason };
    }

    const mail = { ...message, from: config.from };
    try {
      const info = await getTransporter().sendMail(mail);
      if (config.transport === 'smtp') {
        logger.info({ event: 'mailer.sent', transport: 'smtp', messageId: info.messageId, ...messageSummary(message) });
        return { delivered: true, transport: 'smtp', messageId: info.messageId };
      }

      const output = Buffer.isBuffer(info.message) ? info.message : Buffer.from(String(info.message));
      if (config.transport === 'console') {
        logger.info({ event: 'mailer.message', transport: 'console', message: output.toString('utf8') });
        return { delivered: true, transport: 'console', messageId: info.messageId };
      }

      await fs.mkdir(config.outputDir, { recursive: true, mode: 0o700 });
      const filePath = path.join(config.outputDir, `${Date.now()}-${crypto.randomUUID()}.eml`);
      await fs.writeFile(filePath, output, { mode: 0o600 });
      logger.info({ event: 'mailer.message', transport: 'file', path: filePath, ...messageSummary(message) });
      return { delivered: true, transport: 'file', messageId: info.messageId, path: filePath };
    } catch (err) {
      logger.warn({ event: 'mailer.failed', transport: config.transport, error: err.message, ...messageSummary(message) });
      return { delivered: false, transport: config.transport, reason: 'delivery_failed', ...classifyDeliveryError(err) };
    }
  }

  async function verify() {
    if (config.transport !== 'smtp') return { verified: false, transport: config.transport, reason: config.reason || 'SMTP is not configured' };
    try {
      await getTransporter().verify();
      return { verified: true, transport: 'smtp' };
    } catch (err) {
      logger.warn({ event: 'mailer.verify_failed', transport: 'smtp', error: err.message });
      return { verified: false, transport: 'smtp', reason: 'verification_failed' };
    }
  }

  return { config, send, verify };
}

const mailer = createMailer();

module.exports = {
  createMailer,
  getMailerConfig,
  classifyDeliveryError,
  mailer,
  sendMail: mailer.send,
  verify: mailer.verify
};
