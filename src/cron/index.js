'use strict';

const cron = require('node-cron');
const SubscriptionService = require('../services/SubscriptionService');
const PaymentService = require('../services/PaymentService');
const config = require('../config');
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

  // ── Poll CryptoPay for paid invoices — every minute ────────────────────────
  if (config.payments.cryptoPay.enabled) {
    cron.schedule('* * * * *', async () => {
      try {
        const count = await PaymentService.processCryptoPayPaid();
        if (count > 0) {
          logger.info(`Cron: processed ${count} CryptoPay payment(s)`);

          // Notify users about successful payment
          await notifyCryptoPayUsers(bot, count);
        }
      } catch (err) {
        logger.error('Cron: processCryptoPayPaid failed', { error: err.message });
      }
    });
    logger.info('CryptoPay polling cron registered (every minute)');
  }

  logger.info('Cron jobs registered');
}

/**
 * After CryptoPay payments are processed, notify affected users.
 * We re-query recently paid cryptopay payments and send notifications.
 */
async function notifyCryptoPayUsers(bot, count) {
  if (count === 0) return;

  try {
    const Payment = require('../models/Payment');
    const User = require('../models/User');
    const SubscriptionService = require('../services/SubscriptionService');
    const { Markup } = require('telegraf');

    // Find recently paid cryptopay payments (last 2 minutes to avoid duplicates)
    const recentPaid = await Payment.findRecentPaidByProvider('cryptopay', 2);

    for (const payment of recentPaid) {
      try {
        const user = await User.findById(payment.user_id);
        if (!user) continue;

        const sub = await SubscriptionService.getActive(payment.user_id);
        const expiryDate = sub ? new Date(sub.expires_at).toLocaleDateString('ru-RU') : '—';

        await bot.telegram.sendMessage(
          user.telegram_id,
          `🎉 *Оплата криптовалютой подтверждена!*\n\n` +
            `✅ Подписка активирована\n` +
            `📅 Действует до: *${expiryDate}*\n\n` +
            `Нажмите "Мой VPN" чтобы получить конфигурацию.`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
              [Markup.button.callback('◀️ Меню', 'menu')],
            ]),
          },
        );
      } catch (err) {
        logger.error('Failed to notify user about CryptoPay payment', {
          paymentId: payment.id,
          error: err.message,
        });
      }
    }
  } catch (err) {
    logger.error('notifyCryptoPayUsers failed', { error: err.message });
  }
}

module.exports = { registerCronJobs };
