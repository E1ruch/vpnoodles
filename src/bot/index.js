'use strict';

const { Telegraf, session } = require('telegraf');
const config = require('../config');
const logger = require('../utils/logger');

// ── Middleware ─────────────────────────────────────────────────────────────────
const authMiddleware = require('./middleware/auth');
const loggerMiddleware = require('./middleware/logger');
const rateLimitMiddleware = require('./middleware/rateLimit');
const userMiddleware = require('./middleware/user');

// ── Scenes ────────────────────────────────────────────────────────────────────
const { stage } = require('./scenes');

// ── Handlers ──────────────────────────────────────────────────────────────────
const startHandler = require('./handlers/start');
const menuHandler = require('./handlers/menu');
const subscribeHandler = require('./handlers/subscribe');
const myVpnHandler = require('./handlers/myVpn');
const profileHandler = require('./handlers/profile');
const referralHandler = require('./handlers/referral');
const paymentHandler = require('./handlers/payment');
const adminHandler = require('./handlers/admin');

async function createBot() {
  const bot = new Telegraf(config.telegram.token);

  // ── Session ───────────────────────────────────────────────────────────────
  // We use Telegraf's built-in in-memory session for both dev and prod.
  // Session data is lightweight (scene state only) — Redis is used separately
  // for rate limiting and caching via src/database/redis.js.
  // For multi-instance prod deployments, swap to a custom store below.
  bot.use(session());

  // ── Global middleware (order matters) ─────────────────────────────────────
  bot.use(loggerMiddleware);
  bot.use(rateLimitMiddleware);
  bot.use(userMiddleware);
  bot.use(authMiddleware);
  bot.use(stage.middleware());

  // ── Commands ──────────────────────────────────────────────────────────────
  bot.start(startHandler);
  bot.command('menu', menuHandler);
  bot.command('vpn', myVpnHandler);
  bot.command('profile', profileHandler);
  bot.command('subscribe', subscribeHandler);
  bot.command('referral', referralHandler);
  bot.command('admin', adminHandler);

  // ── Callback queries ──────────────────────────────────────────────────────
  bot.action('menu', menuHandler);
  bot.action('subscribe', subscribeHandler);
  bot.action('my_vpn', myVpnHandler);
  bot.action('profile', profileHandler);
  bot.action('referral', referralHandler);
  bot.action(/^buy_plan_(\d+)$/, subscribeHandler);

  // ── Payments ──────────────────────────────────────────────────────────────
  bot.on('pre_checkout_query', paymentHandler.preCheckout);
  bot.on('successful_payment', paymentHandler.successfulPayment);

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    logger.error('Bot error', {
      error: err.message,
      stack: err.stack,
      updateType: ctx.updateType,
      userId: ctx.from?.id,
    });

    ctx.reply('⚠️ Произошла ошибка. Попробуйте позже или напишите в поддержку.').catch(() => {});
  });

  return bot;
}

module.exports = { createBot };
