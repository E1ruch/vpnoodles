'use strict';

/**
 * Redis stub — Redis has been removed from this project.
 * Rate limiting is now handled in-memory (src/bot/middleware/rateLimit.js).
 * Sessions use Telegraf's built-in in-memory store.
 *
 * This file is kept as a no-op stub to avoid import errors
 * if any legacy code still references it.
 */

const noop = async () => {};

const stub = {
  connect: noop,
  disconnect: noop,
  get: async () => null,
  set: noop,
  del: noop,
  incr: async () => 1,
  expire: noop,
  isOpen: false,
  client: {
    isOpen: false,
    quit: noop,
  },
};

module.exports = stub;
