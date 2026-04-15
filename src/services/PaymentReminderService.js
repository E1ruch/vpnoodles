'use strict';

const Payment = require('../models/Payment');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Payment Reminder Service
 *
 * Handles payment reminder notifications:
 * - 30 min after creation: "Кажется, вы планировали продлить подписку"
 * - 50 min after creation: "Осталось 10 минут на оплату..."
 * - 60 min after creation: cancel payment
 *
 * All operations are idempotent and protected against race conditions.
 */
const PaymentReminderService = {
  /**
   * Send 30-minute reminder to users with pending payments.
   * Called by cron every minute.
   *
   * @param {import('telegraf').Telegraf} bot
   * @returns {Promise<number>} count of reminders sent
   */
  async send30MinReminders(bot) {
    const payments = await Payment.findPendingFor30MinReminder();
    if (!payments.length) return 0;

    let sent = 0;

    for (const payment of payments) {
      try {
        // Double-check status before sending
        const freshPayment = await Payment.findById(payment.id);
        if (!freshPayment || freshPayment.status !== 'pending') {
          logger.debug('Payment no longer pending, skipping 30-min reminder', {
            paymentId: payment.id,
            status: freshPayment?.status,
          });
          continue;
        }

        // Atomically mark reminder as sent (prevents duplicates)
        const marked = await Payment.markReminder30Sent(payment.id);
        if (!marked) {
          logger.debug('30-min reminder already sent, skipping', {
            paymentId: payment.id,
          });
          continue;
        }

        // Get user for notification
        const user = await User.findById(payment.user_id);
        if (!user) {
          logger.warn('User not found for 30-min reminder', {
            paymentId: payment.id,
            userId: payment.user_id,
          });
          continue;
        }

        // Send reminder message
        await bot.telegram.sendMessage(
          user.telegram_id,
          '⏰ *Кажется, вы планировали продлить подписку*\n\n' +
            'Нажмите кнопку ниже, чтобы продолжить оплату.',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💳 Продлить', callback_data: `remind_pay_${payment.id}` }],
                [{ text: '◀️ Меню', callback_data: 'menu' }],
              ],
            },
          },
        );

        sent++;
        logger.info('30-min payment reminder sent', {
          paymentId: payment.id,
          userId: user.id,
        });
      } catch (err) {
        logger.error('Failed to send 30-min reminder', {
          paymentId: payment.id,
          error: err.message,
        });
      }
    }

    return sent;
  },

  /**
   * Send 50-minute reminder to users with pending payments.
   * Called by cron every minute.
   *
   * @param {import('telegraf').Telegraf} bot
   * @returns {Promise<number>} count of reminders sent
   */
  async send50MinReminders(bot) {
    const payments = await Payment.findPendingFor50MinReminder();
    if (!payments.length) return 0;

    let sent = 0;

    for (const payment of payments) {
      try {
        // Double-check status before sending
        const freshPayment = await Payment.findById(payment.id);
        if (!freshPayment || freshPayment.status !== 'pending') {
          logger.debug('Payment no longer pending, skipping 50-min reminder', {
            paymentId: payment.id,
            status: freshPayment?.status,
          });
          continue;
        }

        // Atomically mark reminder as sent (prevents duplicates)
        const marked = await Payment.markReminder50Sent(payment.id);
        if (!marked) {
          logger.debug('50-min reminder already sent, skipping', {
            paymentId: payment.id,
          });
          continue;
        }

        // Get user for notification
        const user = await User.findById(payment.user_id);
        if (!user) {
          logger.warn('User not found for 50-min reminder', {
            paymentId: payment.id,
            userId: payment.user_id,
          });
          continue;
        }

        // Send reminder message
        await bot.telegram.sendMessage(
          user.telegram_id,
          '⚠️ *Осталось 10 минут на оплату*\n\n' +
            'Если возникли трудности — обратитесь в поддержку.',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💳 Продлить', callback_data: `remind_pay_${payment.id}` }],
                [{ text: '📞 Поддержка', callback_data: 'support' }],
                [{ text: '◀️ Меню', callback_data: 'menu' }],
              ],
            },
          },
        );

        sent++;
        logger.info('50-min payment reminder sent', {
          paymentId: payment.id,
          userId: user.id,
        });
      } catch (err) {
        logger.error('Failed to send 50-min reminder', {
          paymentId: payment.id,
          error: err.message,
        });
      }
    }

    return sent;
  },

  /**
   * Cancel expired pending payments (60+ minutes old).
   * Called by cron every minute.
   *
   * @returns {Promise<number>} count of payments canceled
   */
  async cancelExpiredPayments() {
    const payments = await Payment.findExpiredPending();
    if (!payments.length) return 0;

    let canceled = 0;

    for (const payment of payments) {
      try {
        // Atomically cancel if still pending
        const result = await Payment.cancelIfPending(payment.id);

        if (result) {
          canceled++;
          logger.info('Expired payment canceled', {
            paymentId: payment.id,
            userId: payment.user_id,
          });
        } else {
          logger.debug('Payment already processed, skipping cancel', {
            paymentId: payment.id,
          });
        }
      } catch (err) {
        logger.error('Failed to cancel expired payment', {
          paymentId: payment.id,
          error: err.message,
        });
      }
    }

    return canceled;
  },

  /**
   * Process all payment reminders and expirations.
   * Called by cron every minute.
   *
   * @param {import('telegraf').Telegraf} bot
   * @returns {Promise<{reminders30: number, reminders50: number, canceled: number}>}
   */
  async processAll(bot) {
    const [reminders30, reminders50, canceled] = await Promise.all([
      PaymentReminderService.send30MinReminders(bot),
      PaymentReminderService.send50MinReminders(bot),
      PaymentReminderService.cancelExpiredPayments(),
    ]);

    return { reminders30, reminders50, canceled };
  },
};

module.exports = PaymentReminderService;
