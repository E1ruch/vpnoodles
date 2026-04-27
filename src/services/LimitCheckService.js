'use strict';

const Subscription = require('../models/Subscription');
const VpnConfig = require('../models/VpnConfig');
const NotificationService = require('./NotificationService');
const VpnService = require('./VpnService');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Limit Check Service
 *
 * Checks traffic and device limits for active subscriptions.
 * Sends notifications when limits are approached or reached.
 *
 * Note: Traffic limits only apply to trial subscriptions (paid plans are unlimited).
 * Device limits apply to all subscriptions.
 *
 * Called by cron periodically.
 */
const LimitCheckService = {
  /**
   * Check traffic limits for trial subscriptions.
   * Paid plans have unlimited traffic (traffic_bytes = null).
   * Sends notifications at 80% and 100% thresholds.
   *
   * @param {import('telegraf').Telegraf} bot
   * @returns {Promise<{traffic80: number, traffic100: number}>}
   */
  async checkTrafficLimits(bot) {
    const threshold80 = config.notifications?.trafficThreshold80 || 80;
    const threshold100 = 100;

    // Get active trial subscriptions with traffic limits
    // Only trial plans have traffic_bytes set; paid plans have null (unlimited)
    const db = require('../database/knex');
    const activeTrials = await db('subscriptions')
      .join('plans', 'subscriptions.plan_id', 'plans.id')
      .where('subscriptions.status', 'active')
      .where('plans.is_trial', true)
      .whereNotNull('subscriptions.traffic_limit_bytes')
      .where('subscriptions.traffic_limit_bytes', '>', 0)
      .select('subscriptions.*');

    let notified80 = 0;
    let notified100 = 0;

    for (const sub of activeTrials) {
      try {
        // Get traffic usage from VPN panel
        const trafficInfo = await LimitCheckService._getTrafficUsage(sub.user_id, sub);

        if (!trafficInfo) continue;

        const { used, limit, percentUsed } = trafficInfo;

        // Check 100% threshold first
        if (percentUsed >= threshold100 && !sub.notified_traffic_100) {
          const sent = await NotificationService.sendTrafficLimitNotification(
            bot,
            sub.user_id,
            sub.id,
            100,
            { used, limit, percentUsed },
          );
          if (sent) notified100++;
        }
        // Check 80% threshold
        else if (percentUsed >= threshold80 && !sub.notified_traffic_80) {
          const sent = await NotificationService.sendTrafficLimitNotification(
            bot,
            sub.user_id,
            sub.id,
            80,
            { used, limit, percentUsed },
          );
          if (sent) notified80++;
        }
      } catch (err) {
        logger.error('Failed to check traffic limit', {
          subscriptionId: sub.id,
          error: err.message,
        });
      }
    }

    if (notified80 > 0 || notified100 > 0) {
      logger.info('Traffic limit notifications sent (trial only)', { notified80, notified100 });
    }

    return { traffic80: notified80, traffic100: notified100 };
  },

  /**
   * Check device limits for all active subscriptions.
   * Sends notification when device limit is reached.
   *
   * @param {import('telegraf').Telegraf} bot
   * @returns {Promise<number>} count of notifications sent
   */
  async checkDeviceLimits(bot) {
    // Get all active subscriptions
    const db = require('../database/knex');
    const activeSubs = await db('subscriptions').where('status', 'active');

    let notified = 0;

    for (const sub of activeSubs) {
      try {
        if (sub.notified_device_limit) continue;

        // Get device info from VPN panel
        const deviceInfo = await VpnService.getDevicesForUser(sub.user_id);

        if (!deviceInfo) continue;

        const { used, limit } = deviceInfo;

        // Only notify if limit is set and reached
        if (limit > 0 && used >= limit) {
          const sent = await NotificationService.sendDeviceLimitNotification(
            bot,
            sub.user_id,
            sub.id,
            { used, limit },
          );
          if (sent) notified++;
        }
      } catch (err) {
        logger.error('Failed to check device limit', {
          subscriptionId: sub.id,
          error: err.message,
        });
      }
    }

    if (notified > 0) {
      logger.info('Device limit notifications sent', { count: notified });
    }

    return notified;
  },

  /**
   * Get traffic usage for a user from VPN panel.
   *
   * @param {number} userId
   * @param {object} subscription
   * @returns {Promise<{used: number, limit: number, percentUsed: number}|null>}
   */
  async _getTrafficUsage(userId, subscription) {
    try {
      const configs = await VpnConfig.findActiveByUserId(userId);
      if (!configs || configs.length === 0) return null;

      const cfg = configs[0];

      // Get panel user to extract traffic info
      const adapter = require('./vpn/RemnawaveAdapter');
      const panelUser = await adapter.getUser(cfg.panel_user_id);

      if (!panelUser) return null;

      const used = panelUser.usedTrafficBytes ?? panelUser.used_traffic_bytes ?? 0;
      const limit =
        subscription.traffic_limit_bytes ||
        panelUser.trafficLimitBytes ||
        panelUser.traffic_limit_bytes ||
        0;

      if (limit <= 0) return null;

      const percentUsed = Math.round((used / limit) * 100);

      return { used, limit, percentUsed };
    } catch (err) {
      logger.debug('Failed to get traffic usage', { userId, error: err.message });
      return null;
    }
  },

  /**
   * Run all limit checks.
   * Called by cron.
   *
   * @param {import('telegraf').Telegraf} bot
   * @returns {Promise<object>}
   */
  async runAllChecks(bot) {
    const [traffic, devices] = await Promise.all([
      LimitCheckService.checkTrafficLimits(bot),
      LimitCheckService.checkDeviceLimits(bot),
    ]);

    return {
      traffic80: traffic.traffic80,
      traffic100: traffic.traffic100,
      devices: devices,
    };
  },
};

module.exports = LimitCheckService;
