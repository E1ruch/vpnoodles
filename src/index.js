'use strict';

/**
 * VPNoodles Bot — Entry Point
 * Boots the application: DB, Redis, Bot, Cron
 */

require('dotenv').config();
const config = require('./config');
const logger = require('./utils/logger');
const { checkConnection: checkDb } = require('./database/knex');
const { connect: connectRedis } = require('./database/redis');
const { createBot } = require('./bot');
const { registerCronJobs } = require('./cron');

async function bootstrap() {
  logger.info(`🚀 Starting VPNoodles Bot [${config.app.env}]`);

  // ── 1. Connect to PostgreSQL ───────────────────────────────────────────────
  await checkDb();

  // ── 2. Connect to Redis ───────────────────────────────────────────────────
  try {
    await connectRedis();
  } catch (err) {
    logger.warn('Redis unavailable — sessions will use in-memory store', { error: err.message });
  }

  // ── 3. Create bot ─────────────────────────────────────────────────────────
  const bot = await createBot();

  // ── 4. Register cron jobs ─────────────────────────────────────────────────
  registerCronJobs(bot);

  // ── 5. Launch bot ─────────────────────────────────────────────────────────
  if (config.telegram.mode === 'webhook' && config.telegram.webhookDomain) {
    const webhookPath = `/webhook/${config.telegram.token}`;
    const webhookUrl = `${config.telegram.webhookDomain}${webhookPath}`;

    await bot.launch({
      webhook: {
        domain: config.telegram.webhookDomain,
        path: webhookPath,
        port: config.app.port,
      },
    });

    logger.info(`✅ Bot launched in WEBHOOK mode`, { url: webhookUrl, port: config.app.port });
  } else {
    await bot.launch();
    logger.info('✅ Bot launched in POLLING mode');
  }

  // ── 6. Set bot commands ───────────────────────────────────────────────────
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 Главное меню' },
    { command: 'vpn', description: '📱 Мой VPN' },
    { command: 'subscribe', description: '💳 Подписка' },
    { command: 'profile', description: '👤 Профиль' },
    { command: 'referral', description: '👥 Реферальная программа' },
    { command: 'menu', description: '📋 Меню' },
  ]);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    bot.stop(signal);

    const db = require('./database/knex');
    await db.destroy();

    const redis = require('./database/redis');
    if (redis.client.isOpen) await redis.client.quit();

    logger.info('Shutdown complete.');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // ── Unhandled errors ──────────────────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
