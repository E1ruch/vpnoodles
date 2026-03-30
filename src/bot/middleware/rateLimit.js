'use strict';

const redis = require('../../database/redis');
const logger = require('../../utils/logger');

const WINDOW_SECONDS = 60; // 1 minute window
const MAX_REQUESTS = 30; // max 30 updates per minute per user

/**
 * Simple Redis-based rate limiter.
 * Falls back gracefully if Redis is unavailable.
 */
module.exports = async (ctx, next) => {
  if (!ctx.from) return next();

  const key = `rl:${ctx.from.id}`;

  try {
    const count = await redis.incr(key, WINDOW_SECONDS);

    if (count > MAX_REQUESTS) {
      logger.warn('Rate limit exceeded', { userId: ctx.from.id, count });
      // Only reply once (when first exceeded)
      if (count === MAX_REQUESTS + 1) {
        await ctx.reply('⏳ Слишком много запросов. Подождите минуту.');
      }
      return;
    }
  } catch {
    // Redis unavailable — allow request through
  }

  return next();
};
