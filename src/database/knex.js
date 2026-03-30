'use strict';

const knex = require('knex');
const config = require('../config');
const logger = require('../utils/logger');

const db = knex({
  client: 'pg',
  connection: {
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl,
  },
  pool: {
    min: config.db.pool.min,
    max: config.db.pool.max,
    afterCreate(conn, done) {
      conn.query('SET timezone="UTC";', (err) => done(err, conn));
    },
  },
  acquireConnectionTimeout: 10000,
});

// ── Health check ──────────────────────────────────────────────────────────────
async function checkConnection() {
  try {
    await db.raw('SELECT 1');
    logger.info('✅ PostgreSQL connected');
  } catch (err) {
    logger.error('❌ PostgreSQL connection failed', { error: err.message });
    throw err;
  }
}

module.exports = db;
module.exports.checkConnection = checkConnection;
