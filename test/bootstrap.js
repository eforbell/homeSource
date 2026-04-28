'use strict';

const { ensureTestDatabaseEnvironment } = require('../db/test-env');

try {
  ensureTestDatabaseEnvironment();
} catch (err) {
  throw new Error(err.message.replace(/^Test DB setup failed:/, 'Test bootstrap failed:'));
}
