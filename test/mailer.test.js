'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createMailer, getMailerConfig } = require('../lib/mailer');

const testDirectories = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createNodemailerStub() {
  const calls = [];
  return {
    calls,
    createTransport(options, defaults) {
      const transport = {
        options,
        defaults,
        async sendMail(message) {
          calls.push(message);
          return {
            messageId: '<test-message@example.test>',
            accepted: [message.to],
            message: Buffer.from(`To: ${message.to}\nSubject: ${message.subject}\n\n${message.text || ''}`)
          };
        },
        async verify() {
          return true;
        }
      };
      return transport;
    }
  };
}

describe('getMailerConfig', () => {
  it('uses a disabled transport when SMTP is unconfigured', () => {
    assert.deepEqual(getMailerConfig({}), { transport: 'disabled', reason: 'SMTP_HOST is not configured' });
  });

  it('builds a TLS-required SMTP configuration with optional authentication', () => {
    const config = getMailerConfig({
      SMTP_HOST: 'mail.family.test',
      SMTP_PORT: '587',
      SMTP_FROM: 'Home Source <vault@family.test>',
      SMTP_USER: 'vault',
      SMTP_PASS: 'secret'
    });

    assert.equal(config.transport, 'smtp');
    assert.deepEqual(config.options, {
      host: 'mail.family.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'vault', pass: 'secret' },
      disableFileAccess: true,
      disableUrlAccess: true
    });
    assert.equal(config.from, 'Home Source <vault@family.test>');
  });

  it('rejects partial SMTP credentials without attempting delivery', () => {
    assert.deepEqual(getMailerConfig({
      SMTP_HOST: 'mail.family.test',
      SMTP_FROM: 'vault@family.test',
      SMTP_USER: 'vault'
    }), { transport: 'disabled', reason: 'SMTP_USER and SMTP_PASS must be configured together' });
  });

  it('supports an explicit file transport for local message inspection', () => {
    const config = getMailerConfig({ MAIL_TRANSPORT: 'file', SMTP_FROM: 'vault@family.test' });
    assert.equal(config.transport, 'file');
    assert.equal(config.from, 'vault@family.test');
  });
});

describe('createMailer', () => {
  it('does not deliver mail when SMTP is unconfigured', async () => {
    const logs = [];
    const nodemailer = createNodemailerStub();
    const mailer = createMailer({ env: {}, nodemailer, logger: { info: entry => logs.push(entry), warn: entry => logs.push(entry) } });

    const result = await mailer.send({ to: 'recipient@family.test', subject: 'A private note', text: 'Hello' });

    assert.deepEqual(result, { delivered: false, transport: 'disabled', reason: 'SMTP_HOST is not configured' });
    assert.equal(nodemailer.calls.length, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'mailer.skipped');
  });

  it('delivers through configured SMTP with the configured sender', async () => {
    const nodemailer = createNodemailerStub();
    const mailer = createMailer({
      env: { SMTP_HOST: 'mail.family.test', SMTP_FROM: 'vault@family.test' },
      nodemailer,
      logger: { info() {}, warn() {} }
    });

    const result = await mailer.send({ to: 'recipient@family.test', subject: 'A private note', text: 'Hello' });

    assert.deepEqual(result, { delivered: true, transport: 'smtp', messageId: '<test-message@example.test>' });
    assert.deepEqual(nodemailer.calls[0], {
      to: 'recipient@family.test',
      subject: 'A private note',
      text: 'Hello',
      from: 'vault@family.test'
    });
  });

  it('writes explicit file-transport messages with owner-only permissions', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homesource-mailer-'));
    testDirectories.push(outputDir);
    const nodemailer = createNodemailerStub();
    const mailer = createMailer({
      env: { MAIL_TRANSPORT: 'file', MAIL_OUTPUT_DIR: outputDir, SMTP_FROM: 'vault@family.test' },
      nodemailer,
      logger: { info() {}, warn() {} }
    });

    const result = await mailer.send({ to: 'recipient@family.test', subject: 'A private note', text: 'Hello' });
    const files = await fs.readdir(outputDir);
    const details = await fs.stat(path.join(outputDir, files[0]));

    assert.equal(result.delivered, true);
    assert.equal(result.transport, 'file');
    assert.match(result.path, /\.eml$/);
    assert.equal(files.length, 1);
    assert.equal(details.mode & 0o777, 0o600);
  });

  it('rejects malformed messages before creating a delivery transport', async () => {
    const nodemailer = createNodemailerStub();
    const mailer = createMailer({
      env: { SMTP_HOST: 'mail.family.test', SMTP_FROM: 'vault@family.test' },
      nodemailer,
      logger: { info() {}, warn() {} }
    });

    await assert.rejects(
      mailer.send({ to: 'recipient@family.test', subject: 'bad\nBcc: injected', text: 'Hello' }),
      /subject must not contain line breaks/
    );
    assert.equal(nodemailer.calls.length, 0);
  });
});
