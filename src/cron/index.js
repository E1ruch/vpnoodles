'use strict';

const cron = require('node-cron');
const SubscriptionService = require('../services/SubscriptionService');
const logger = require('../utils/logger');

/**
 * Register all cron jobs.
 * @param {import('telegraf').Telegraf} bot
 */
function registerCronJobs(bot) {
  // ── Expire overdue subscriptions — every 15 minutes ───────────────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      const count = await SubscriptionService.processExpired();
      if (count > 0) {
        logger.info(`Cron: expired ${count} subscription(s)`);
      }
    } catch (err) {
      logger.error('Cron: processExpired failed', { error: err.message });
    }
  });

  // ── Send expiry notifications — every day at 10:00 UTC ────────────────────
  cron.schedule('0 10 * * *', async () => {
    try {
      await SubscriptionService.processExpiryNotifications(bot);
      logger.info('Cron: expiry notifications sent');
    } catch (err) {
      logger.error('Cron: processExpiryNotifications failed', { error: err.message });
    }
  });

  logger.info('✅ Cron jobs registered');
}

module.exports = { registerCronJobs };
