#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { ensureTestDatabaseEnvironment } = require('./test-env');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function databaseUrlFor(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function schemaShape(databaseUrl) {
  const db = new Pool({ connectionString: databaseUrl });
  try {
    const queries = {
      columns: `
        SELECT table_name, column_name, ordinal_position, data_type, udt_name,
               is_nullable, column_default, is_identity, identity_generation
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
        ORDER BY table_name, ordinal_position`,
      constraints: `
        SELECT relation.relname AS table_name, constraint_row.conname AS constraint_name,
               constraint_row.contype AS constraint_type,
               pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname <> 'schema_migrations'
        ORDER BY relation.relname, constraint_row.conname`,
      indexes: `
        SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
        ORDER BY tablename, indexname`,
      triggers: `
        SELECT relation.relname AS table_name, trigger_row.tgname AS trigger_name,
               pg_get_triggerdef(trigger_row.oid, TRUE) AS definition
        FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND NOT trigger_row.tgisinternal
        ORDER BY relation.relname, trigger_row.tgname`,
      functions: `
        SELECT routine.proname AS function_name,
               pg_get_function_identity_arguments(routine.oid) AS arguments,
               pg_get_functiondef(routine.oid) AS definition
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'public'
        ORDER BY routine.proname, arguments`,
      sequences: `
        SELECT sequence_name, data_type, start_value, minimum_value, maximum_value,
               increment, cycle_option
        FROM information_schema.sequences
        WHERE sequence_schema = 'public'
        ORDER BY sequence_name`,
      views: `
        SELECT viewname AS view_name, definition
        FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`
    };
    const result = {};
    for (const [name, sql] of Object.entries(queries)) {
      result[name] = (await db.query(sql)).rows;
    }
    return result;
  } finally {
    await db.end();
  }
}

async function dropDatabase(admin, name) {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]
  );
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}

async function main() {
  const { databaseUrl } = ensureTestDatabaseEnvironment();
  const suffix = `${process.pid}_${Date.now()}`;
  const migrationName = `homesource_schema_migration_test_${suffix}`;
  const snapshotName = `homesource_schema_snapshot_test_${suffix}`;
  const adminUrl = databaseUrlFor(databaseUrl, 'postgres');
  const admin = new Pool({ connectionString: adminUrl });
  try {
    for (const name of [migrationName, snapshotName]) {
      await dropDatabase(admin, name);
      await admin.query(`CREATE DATABASE "${name}"`);
    }
    const migrationUrl = databaseUrlFor(databaseUrl, migrationName);
    const snapshotUrl = databaseUrlFor(databaseUrl, snapshotName);
    const migrated = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js')], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: migrationUrl }, encoding: 'utf8'
    });
    if (migrated.status !== 0) {
      throw new Error(`Migration build failed:\n${migrated.stdout}${migrated.stderr}`);
    }
    const snapshot = new Pool({ connectionString: snapshotUrl });
    try {
      await snapshot.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    } finally {
      await snapshot.end();
    }
    assert.deepStrictEqual(
      await schemaShape(snapshotUrl),
      await schemaShape(migrationUrl),
      'db/schema.sql differs from the fresh migration chain'
    );
    process.stdout.write('db/schema.sql matches the fresh migration chain.\n');
  } finally {
    for (const name of [migrationName, snapshotName]) {
      await dropDatabase(admin, name).catch(() => {});
    }
    await admin.end();
  }
}

main().catch((error) => {
  console.error('Schema parity check failed:', error.message);
  process.exitCode = 1;
});
