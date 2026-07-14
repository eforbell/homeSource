'use strict';

const { pool } = require('./db');

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

async function createTrustee({ name, relationship = null, email, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO vault_trustees (name, relationship, email, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [requiredText(name, 'name'), relationship?.trim() || null, requiredText(email, 'email'), Number(createdBy)]
  );
  return rows[0];
}

async function createDesignation({ documentId, memberId = null, trusteeId = null, role, encryptionKeyId = null }) {
  const hasMember = Number.isInteger(Number(memberId)) && Number(memberId) > 0;
  const hasTrustee = Number.isInteger(Number(trusteeId)) && Number(trusteeId) > 0;
  if (hasMember === hasTrustee) throw new TypeError('A designation requires exactly one recipient identity');
  if ((role === 'beneficiary') !== hasMember || (role === 'trustee') !== hasTrustee) {
    throw new TypeError('Designation role must match its recipient identity');
  }
  if (!['beneficiary', 'trustee'].includes(role)) throw new TypeError('Invalid designation role');

  const { rows } = await pool.query(
    `INSERT INTO document_designations (document_id, member_id, trustee_id, role, encryption_key_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [Number(documentId), hasMember ? Number(memberId) : null, hasTrustee ? Number(trusteeId) : null, role, encryptionKeyId || null]
  );
  return rows[0];
}

module.exports = { createTrustee, createDesignation };
