'use strict';

const { sendMail } = require('./mailer');

const KEY_EVENT_TEXT = {
  'key.registered': 'A new Home Source encryption key was registered',
  'key.revoked': 'A Home Source encryption key was revoked',
  'key.holder_added': 'A Home Source key access change was recorded'
};

function getNotificationRecipients(env = process.env) {
  const raw = typeof env.NOTIFICATION_TO === 'string' ? env.NOTIFICATION_TO.trim() : '';
  if (!raw) return [];
  if (/[\r\n]/.test(raw)) throw new TypeError('NOTIFICATION_TO must not contain line breaks');
  const recipients = raw.split(',').map((recipient) => recipient.trim()).filter(Boolean);
  if (!recipients.length) return [];
  if (recipients.some((recipient) => /[\r\n]/.test(recipient))) {
    throw new TypeError('NOTIFICATION_TO must not contain line breaks');
  }
  return recipients;
}

function createNotifier({ env = process.env, mailer = { sendMail } } = {}) {
  async function notifyKeyEvent({ event, memberName }) {
    const eventText = KEY_EVENT_TEXT[event];
    if (!eventText) throw new TypeError(`Unsupported key notification event: ${event}`);
    const recipients = getNotificationRecipients(env);
    if (!recipients.length) return { delivered: false, reason: 'NOTIFICATION_TO is not configured' };

    const name = typeof memberName === 'string' && memberName.trim() ? memberName.trim() : 'a household member';
    return mailer.sendMail({
      to: recipients,
      subject: 'Home Source key update',
      text: `${eventText} for ${name}. No document contents are included in this notice. Review Home Source if you did not expect this change.`
    });
  }

  return { notifyKeyEvent };
}

const notifier = createNotifier();

module.exports = {
  createNotifier,
  getNotificationRecipients,
  notifyKeyEvent: notifier.notifyKeyEvent
};
