'use strict';

const logger = require('../../utils/logger');

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 30;

// In-memory store: Map<userId, { count, resetAt }>
const store = new Map();

// Cleanup old entries every 5 minutes to prevent memory leak
setInterval(
  () => {
    const now = Date.now();
    for (const [key, val] of store.entries()) {
      if (now > val.resetAt) store.delete(key);
    }
  },
  5 * 60 * 1000,
);

/**
 * Simple in-memory rate limiter (no Redis required).
 * 30 requests per minute per user.
 */
module.exports = async (ctx, next) => {
  if (!ctx.from) return next();

  const key = ctx.from.id;
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  entry.count += 1;

  if (entry.count > MAX_REQUESTS) {
    logger.warn('Rate limit exceeded', { userId: ctx.from.id, count: entry.count });
    if (entry.count === MAX_REQUESTS + 1) {
      await ctx.reply(
        '\u23F3 \u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u043C\u0438\u043D\u0443\u0442\u0443.',
      );
    }
    return;
  }

  return next();
};
