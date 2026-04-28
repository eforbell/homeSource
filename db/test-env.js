'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.join(__dirname, '..');
const TEST_ENV_PATH = path.join(ROOT_DIR, '.env.test');

function fail(message) {
  throw new Error(`Test DB setup failed: ${message}`);
}

function extractDatabaseName(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

function isSafeTestDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return false;
  const dbName = extractDatabaseName(databaseUrl);
  if (!dbName) return false;
  return /(^test[_-])|([_-]test($|[_-]))/i.test(dbName);
}

function ensureTestDatabaseEnvironment() {
  if (fs.existsSync(TEST_ENV_PATH)) {
    dotenv.config({ path: TEST_ENV_PATH, override: true });
  }

  if (!process.env.DATABASE_URL) {
    fail(
      `.env.test is missing and DATABASE_URL is not set.\n` +
      `Create .env.test with a DATABASE_URL pointing to a test database ` +
      `(e.g. postgresql://homesource:homesource@localhost:5432/homesource_test).`
    );
  }

  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'test';
  }

  if (process.env.NODE_ENV !== 'test') {
    fail(`NODE_ENV must be "test", received "${process.env.NODE_ENV}".`);
  }

  if (!isSafeTestDatabaseUrl(process.env.DATABASE_URL)) {
    const dbName = extractDatabaseName(process.env.DATABASE_URL) || '<unparsed>';
    fail(
      `DATABASE_URL must target a dedicated test database. ` +
      `Resolved database name: "${dbName}". Expected a name containing "test" (e.g. "homesource_test").`
    );
  }

  process.env.STORAGE_PATH = path.join(ROOT_DIR, 'data', 'test');

  return {
    databaseUrl: process.env.DATABASE_URL,
    databaseName: extractDatabaseName(process.env.DATABASE_URL)
  };
}

module.exports = { ensureTestDatabaseEnvironment, extractDatabaseName, isSafeTestDatabaseUrl };
