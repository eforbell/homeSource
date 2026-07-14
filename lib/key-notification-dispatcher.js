'use strict';

function createKeyNotificationDispatcher({ notifyKeyEvent, audit, logger = console }) {
  async function deliver({ event, memberId, memberName, actorId }) {
    let result;
    try {
      result = await notifyKeyEvent({ event, memberName });
    } catch (err) {
      logger.warn('Key notification dispatch failed:', err.message);
      result = { delivered: false, reason: 'notification_failed' };
    }

    try {
      await audit.log('notification.key_event_result', 'family_member', memberId, actorId, {
        event,
        delivered: result.delivered === true,
        transport: result.transport || null,
        reason: result.reason || null
      });
    } catch (err) {
      logger.error('Key notification audit log failed:', err.message);
    }
  }

  async function dispatch(eventDetails) {
    const { event, memberId, actorId } = eventDetails;
    try {
      await audit.log('notification.key_event_queued', 'family_member', memberId, actorId, { event });
    } catch (err) {
      logger.error('Key notification queue audit log failed:', err.message);
    }

    void deliver(eventDetails);
  }

  return { dispatch };
}

module.exports = { createKeyNotificationDispatcher };
