'use strict';

const cron = require('node-cron');
const SubscriptionService = require('../services/SubscriptionService');
const PaymentService = require('../services/PaymentService');
const PaymentReminderService = require('../services/PaymentReminderService');
const NotificationService = require('../services/NotificationService');
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

  // ── Send trial expired notifications — every 15 minutes ───────────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      const count = await SubscriptionService.processTrialExpiredNotifications(bot);
      if (count > 0) {
        logger.info(`Cron: sent ${count} trial expired notification(s)`);
      }
    } catch (err) {
      logger.error('Cron: processTrialExpiredNotifications failed', { error: err.message });
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

  // ── Poll YooKassa for paid payments — every minute ──────────────────────────
  if (config.payments.yookassa.enabled) {
    cron.schedule('* * * * *', async () => {
      try {
        const count = await PaymentService.processYooKassaPaid();
        if (count > 0) {
          logger.info(`Cron: processed ${count} YooKassa payment(s)`);

          // Notify users about successful payment
          await notifyYooKassaUsers(bot, count);
        }
      } catch (err) {
        logger.error('Cron: processYooKassaPaid failed', { error: err.message });
      }
    });
    logger.info('YooKassa polling cron registered (every minute)');
  }

  // ── Payment reminders and expiration — every minute ──────────────────────────
  cron.schedule('* * * * *', async () => {
    try {
      const result = await PaymentReminderService.processAll(bot);
      if (result.reminders30 > 0 || result.reminders50 > 0 || result.canceled > 0) {
        logger.info('Cron: payment reminders processed', {
          reminders30: result.reminders30,
          reminders50: result.reminders50,
          canceled: result.canceled,
        });
      }
    } catch (err) {
      logger.error('Cron: payment reminders failed', { error: err.message });
    }
  });
  logger.info('Payment reminders cron registered (every minute)');

  // ── Check traffic and device limits — every hour ──────────────────────────────
  cron.schedule('0 * * * *', async () => {
    try {
      const LimitCheckService = require('../services/LimitCheckService');
      const result = await LimitCheckService.runAllChecks(bot);
      if (result.traffic80 > 0 || result.traffic100 > 0 || result.devices > 0) {
        logger.info('Cron: limit checks processed', {
          traffic80: result.traffic80,
          traffic100: result.traffic100,
          devices: result.devices,
        });
      }
    } catch (err) {
      logger.error('Cron: limit checks failed', { error: err.message });
    }
  });
  logger.info('Limit checks cron registered (every hour)');

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

/**
 * After YooKassa payments are processed, notify affected users.
 */
async function notifyYooKassaUsers(bot, count) {
  if (count === 0) return;

  try {
    const Payment = require('../models/Payment');
    const User = require('../models/User');
    const SubscriptionService = require('../services/SubscriptionService');
    const { Markup } = require('telegraf');

    // Find recently paid yookassa payments (last 2 minutes to avoid duplicates)
    const recentPaid = await Payment.findRecentPaidByProvider('yookassa', 2);

    for (const payment of recentPaid) {
      try {
        const user = await User.findById(payment.user_id);
        if (!user) continue;

        const sub = await SubscriptionService.getActive(payment.user_id);
        const expiryDate = sub ? new Date(sub.expires_at).toLocaleDateString('ru-RU') : '—';

        await bot.telegram.sendMessage(
          user.telegram_id,
          `🎉 *Оплата картой подтверждена!*\n\n` +
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
        logger.error('Failed to notify user about YooKassa payment', {
          paymentId: payment.id,
          error: err.message,
        });
      }
    }
  } catch (err) {
    logger.error('notifyYooKassaUsers failed', { error: err.message });
  }
}

module.exports = { registerCronJobs };
