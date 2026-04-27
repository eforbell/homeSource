'use strict';

const { pool } = require('./db');

async function log(action, entityType, entityId, actorId, details = {}) {
  await pool.query(
    'INSERT INTO audit_log (action, entity_type, entity_id, actor_id, details) VALUES ($1, $2, $3, $4, $5)',
    [action, entityType, entityId, actorId, JSON.stringify(details)]
  );
}

async function getLog(filters = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (filters.action) {
    conditions.push(`action = $${idx++}`);
    params.push(filters.action);
  }
  if (filters.entity_type) {
    conditions.push(`entity_type = $${idx++}`);
    params.push(filters.entity_type);
  }
  if (filters.entity_id) {
    conditions.push(`entity_id = $${idx++}`);
    params.push(Number(filters.entity_id));
  }
  if (filters.actor_id) {
    conditions.push(`actor_id = $${idx++}`);
    params.push(Number(filters.actor_id));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit) || 100, 500);

  const { rows } = await pool.query(`
    SELECT al.*, m.name AS actor_name, m.avatar_emoji AS actor_avatar
    FROM audit_log al
    LEFT JOIN family_members m ON al.actor_id = m.id
    ${where}
    ORDER BY al.created_at DESC
    LIMIT $${idx}
  `, [...params, limit]);

  return rows;
}

module.exports = { log, getLog };
