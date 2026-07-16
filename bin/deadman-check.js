#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });
const { pool } = require('../lib/db');
const { advanceDueSwitches } = require('../lib/continuity');

async function main() {
  if (!process.argv.includes('--once')) throw new Error('deadman-check currently requires --once');
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query(`SELECT pg_try_advisory_lock(hashtext('homesource-continuity-state-advance')) AS acquired`);
    if (!rows[0].acquired) {
      console.log(JSON.stringify({ ok: true, skipped: 'already_running' }));
      return;
    }
    const result = await advanceDueSwitches();
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('homesource-continuity-state-advance'))`).catch(() => {});
    lock.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
