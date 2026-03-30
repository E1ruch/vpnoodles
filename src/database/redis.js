'use strict';

const { createClient } = require('redis');
const config = require('../config');
const logger = require('../utils/logger');

const client = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
  },
  password: config.redis.password || undefined,
  database: config.redis.db,
});

client.on('error', (err) => logger.error('Redis error', { error: err.message }));
client.on('connect', () => logger.info('✅ Redis connected'));
client.on('reconnecting', () => logger.warn('Redis reconnecting...'));

async function connect() {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Set a JSON value with optional TTL (seconds) */
async function setJson(key, value, ttl = null) {
  const str = JSON.stringify(value);
  if (ttl) {
    await client.setEx(key, ttl, str);
  } else {
    await client.set(key, str);
  }
}

/** Get and parse a JSON value */
async function getJson(key) {
  const str = await client.get(key);
  return str ? JSON.parse(str) : null;
}

/** Delete one or more keys */
async function del(...keys) {
  return client.del(keys);
}

/** Increment a counter with optional TTL (sets TTL only on first creation) */
async function incr(key, ttl = null) {
  const val = await client.incr(key);
  if (val === 1 && ttl) {
    await client.expire(key, ttl);
  }
  return val;
}

module.exports = {
  client,
  connect,
  setJson,
  getJson,
  del,
  incr,
};
