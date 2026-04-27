'use strict';

const Notification = require('../models/Notification');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const VpnConfig = require('../models/VpnConfig');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Notification Service
 *
 * Handles all user notifications with idempotency:
 * - Trial expired
 * - Subscription expiring soon
 * - Traffic limit warnings (80%, 100%)
 * - Device limit reached
 */
const NotificationService = {
  // Notification types
  TYPES: {
    TRIAL_EXPIRED: 'trial_expired',
    SUBSCRIPTION_EXPIRING: 'subscription_expiring',
    TRAFFIC_80: 'traffic_80',
    TRAFFIC_100: 'traffic_100',
    DEVICE_LIMIT: 'device_limit',
  },

  /**
   * Send trial expired notification.
   * Called when a trial subscription expires.
   *
   * @param {import('telegraf').Telegraf} bot
   * @param {number} userId
   * @param {number} subscriptionId
   * @returns {Promise<boolean>} true if notification was sent
   */
  async sendTrialExpiredNotification(bot, userId, subscriptionId) {
    const key = String(subscriptionId);

    // Check if already sent
    const { created } = await Notification.createIfNotExists(
      userId,
      NotificationService.TYPES.TRIAL_EXPIRED,
      key,
    );

    logger.logNotification('trial_expired', { userId, key, created }, created);

    if (!created) {
      logger.debug('Trial expired notification already sent', { userId, subscriptionId });
      return false;
    }

    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for trial expired notification', { userId });
      return false;
    }

    const text =
      '⏰ *Бесплатный период закончился*\n\n' +
      'Ваш пробный доступ к VPN Лапша истёк, но мы сохранили ваши настройки.\n\n' +
      'Оформите подписку — и VPN снова заработает за пару секунд. Все ключи и устройства останутся на месте.';

    try {
      await bot.telegram.sendMessage(user.telegram_id, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '💳 Оформить подписку', callback_data: 'subscribe' }]],
        },
      });

      // Mark subscription as notified
      await Subscription.update(subscriptionId, { notified_trial_expired: true });

      logger.logMessage(
        'trial_expired',
        { userId, telegramId: user.telegram_id, subscriptionId },
        { text, buttons: ['subscribe'], chatId: user.telegram_id },
      );

      return true;
    } catch (err) {
      logger.error('Failed to send trial expired notification', {
        userId,
        subscriptionId,
        error: err.message,
      });
      return false;
    }
  },

  /**
   * Send subscription expiring notification.
   * Called N days before subscription expires.
   *
   * @param {import('telegraf').Telegraf} bot
   * @param {object} subscription
   * @param {number} daysLeft
   * @returns {Promise<boolean>}
   */
  async sendExpiringNotification(bot, subscription, daysLeft) {
    const key = `${subscription.id}_${daysLeft}d`;

    const { created } = await Notification.createIfNotExists(
      subscription.user_id,
      NotificationService.TYPES.SUBSCRIPTION_EXPIRING,
      key,
    );

    if (!created) {
      return false;
    }

    const user = await User.findById(subscription.user_id);
    if (!user) return false;

    try {
      await bot.telegram.sendMessage(
        user.telegram_id,
        `⚠️ *Ваша подписка истекает через ${daysLeft} дн.*\n\n` +
          'Продлите её, чтобы не потерять доступ к VPN.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Продлить подписку', callback_data: 'subscribe' }]],
          },
        },
      );

      await Subscription.markNotified(subscription.id);
      logger.info('Expiring notification sent', {
        userId: user.id,
        subscriptionId: subscription.id,
        daysLeft,
      });
      return true;
    } catch (err) {
      logger.error('Failed to send expiring notification', {
        subscriptionId: subscription.id,
        error: err.message,
      });
      return false;
    }
  },

  /**
   * Send traffic limit notification (80% or 100%).
   *
   * @param {import('telegraf').Telegraf} bot
   * @param {number} userId
   * @param {number} subscriptionId
   * @param {number} percentage - 80 or 100
   * @param {object} trafficInfo - { used, limit, percentUsed }
   * @returns {Promise<boolean>}
   */
  async sendTrafficLimitNotification(bot, userId, subscriptionId, percentage, trafficInfo) {
    const type =
      percentage === 100
        ? NotificationService.TYPES.TRAFFIC_100
        : NotificationService.TYPES.TRAFFIC_80;
    const key = String(subscriptionId);

    const { created } = await Notification.createIfNotExists(userId, type, key, trafficInfo);

    if (!created) {
      return false;
    }

    const user = await User.findById(userId);
    if (!user) return false;

    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const usedStr = formatBytes(trafficInfo.used);
    const limitStr = formatBytes(trafficInfo.limit);

    try {
      let message;
      if (percentage === 100) {
        message =
          '🚫 *Лимит трафика исчерпан*\n\n' +
          `Вы использовали весь доступный трафик (${limitStr}).\n` +
          'Для продолжения работы оформите новую подписку.';
      } else {
        message =
          '⚠️ *Внимание: трафик на исходе*\n\n' +
          `Вы использовали ${trafficInfo.percentUsed}% трафика (${usedStr} из ${limitStr}).\n` +
          'Скоро доступ к VPN может быть ограничен.';
      }

      await bot.telegram.sendMessage(user.telegram_id, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '💳 Оформить подписку', callback_data: 'subscribe' }]],
        },
      });

      // Mark subscription
      const field = percentage === 100 ? 'notified_traffic_100' : 'notified_traffic_80';
      await Subscription.update(subscriptionId, { [field]: true });

      logger.info('Traffic limit notification sent', {
        userId,
        subscriptionId,
        percentage,
      });
      return true;
    } catch (err) {
      logger.error('Failed to send traffic limit notification', {
        userId,
        subscriptionId,
        error: err.message,
      });
      return false;
    }
  },

  /**
   * Send device limit reached notification.
   *
   * @param {import('telegraf').Telegraf} bot
   * @param {number} userId
   * @param {number} subscriptionId
   * @param {object} deviceInfo - { used, limit }
   * @returns {Promise<boolean>}
   */
  async sendDeviceLimitNotification(bot, userId, subscriptionId, deviceInfo) {
    const key = String(subscriptionId);

    const { created } = await Notification.createIfNotExists(
      userId,
      NotificationService.TYPES.DEVICE_LIMIT,
      key,
      deviceInfo,
    );

    if (!created) {
      return false;
    }

    const user = await User.findById(userId);
    if (!user) return false;

    try {
      await bot.telegram.sendMessage(
        user.telegram_id,
        '📱 *Достигнут лимит устройств*\n\n' +
          `Подключено устройств: ${deviceInfo.used} из ${deviceInfo.limit}.\n` +
          'Отключите неиспользуемые устройства или оформите тариф с большим лимитом.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📱 Управление устройствами', callback_data: 'my_devices' }],
              [{ text: '💳 Оформить подписку', callback_data: 'subscribe' }],
            ],
          },
        },
      );

      await Subscription.update(subscriptionId, { notified_device_limit: true });

      logger.info('Device limit notification sent', { userId, subscriptionId });
      return true;
    } catch (err) {
      logger.error('Failed to send device limit notification', {
        userId,
        subscriptionId,
        error: err.message,
      });
      return false;
    }
  },

  /**
   * Reset notification flags when subscription is extended/renewed.
   * This allows re-sending notifications for the new period.
   *
   * @param {number} subscriptionId
   */
  async resetNotificationFlags(subscriptionId) {
    await Subscription.update(subscriptionId, {
      notified_expiry: false,
      notified_trial_expired: false,
      notified_traffic_80: false,
      notified_traffic_100: false,
      notified_device_limit: false,
    });

    logger.debug('Notification flags reset', { subscriptionId });
  },
};

module.exports = NotificationService;
