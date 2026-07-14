'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, getNotificationRecipients } = require('../lib/notifications');

describe('getNotificationRecipients', () => {
  it('parses comma-separated household notification recipients', () => {
    assert.deepEqual(
      getNotificationRecipients({ NOTIFICATION_TO: 'first@family.test, second@family.test' }),
      ['first@family.test', 'second@family.test']
    );
  });

  it('rejects malformed or header-injected recipient configuration', () => {
    assert.throws(() => getNotificationRecipients({ NOTIFICATION_TO: 'first@family.test\nBcc: injected' }), /line breaks/);
  });
});

describe('createNotifier', () => {
  it('skips delivery when no household notification recipient is configured', async () => {
    const notifier = createNotifier({
      env: {},
      mailer: { sendMail: async () => assert.fail('mailer must not be called') }
    });

    assert.deepEqual(
      await notifier.notifyKeyEvent({ event: 'key.registered', memberName: 'Parker' }),
      { delivered: false, reason: 'NOTIFICATION_TO is not configured' }
    );
  });

  it('sends a generic key-event notice to all configured recipients', async () => {
    const messages = [];
    const notifier = createNotifier({
      env: { NOTIFICATION_TO: 'first@family.test, second@family.test' },
      mailer: {
        sendMail: async (message) => {
          messages.push(message);
          return { delivered: true, transport: 'smtp', messageId: '<notification@example.test>' };
        }
      }
    });

    const result = await notifier.notifyKeyEvent({ event: 'key.holder_added', memberName: 'Parker' });

    assert.deepEqual(result, { delivered: true, transport: 'smtp', messageId: '<notification@example.test>' });
    assert.deepEqual(messages, [{
      to: ['first@family.test', 'second@family.test'],
      subject: 'Home Source key update',
      text: 'A Home Source key access change was recorded for Parker. No document contents are included in this notice. Review Home Source if you did not expect this change.'
    }]);
  });

  it('rejects unknown notification events', async () => {
    const notifier = createNotifier({ env: { NOTIFICATION_TO: 'first@family.test' }, mailer: { sendMail: async () => ({}) } });
    await assert.rejects(notifier.notifyKeyEvent({ event: 'document.decrypted', memberName: 'Parker' }), /Unsupported key notification event/);
  });
});
