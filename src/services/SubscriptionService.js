'use strict';

const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const User = require('../models/User');
const VpnConfig = require('../models/VpnConfig');
const NotificationService = require('./NotificationService');
const logger = require('../utils/logger');

const SubscriptionService = {
  /**
   * Activate a trial subscription for a user.
   * Returns null if trial already used.
   */
  async activateTrial(userId) {
    const hasUsedTrial = await User.hasUsedTrial(userId);
    if (hasUsedTrial) return null;

    const trialPlan = await Plan.findTrial();
    if (!trialPlan) throw new Error('Trial plan not configured');

    const sub = await Subscription.create({
      userId,
      planId: trialPlan.id,
      durationDays: trialPlan.duration_days,
      trafficLimitBytes: trialPlan.traffic_bytes,
    });

    await User.markTrialUsed(userId);

    logger.info('Trial activated', { userId, subscriptionId: sub.id });
    return sub;
  },

  /**
   * Activate a paid subscription for a user.
   * If user already has an active sub — extends it.
   * Re-enables VPN configs if they were disabled.
   */
  async activate(userId, planId) {
    const plan = await Plan.findById(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    const existing = await Subscription.findActiveByUserId(userId);
    const VpnService = require('./VpnService');

    if (existing) {
      // Extend existing subscription
      const extended = await Subscription.extend(existing.id, plan.duration_days);

      // Reset notification flags for new period
      await Subscription.resetNotificationFlags(existing.id);

      // Re-enable VPN if it was disabled
      await VpnService.enableForUser(userId).catch((err) =>
        logger.error('Failed to re-enable VPN on extend', { error: err.message }),
      );

      logger.info('Subscription extended', {
        userId,
        subscriptionId: extended.id,
        days: plan.duration_days,
      });
      return extended;
    }

    // Check for expired subscription to re-enable VPN
    const expiredSub = await Subscription.findAllByUserId(userId);
    const lastSub = expiredSub[0];
    if (lastSub) {
      // Reset notification flags
      await Subscription.resetNotificationFlags(lastSub.id);
    }

    const sub = await Subscription.create({
      userId,
      planId: plan.id,
      durationDays: plan.duration_days,
      trafficLimitBytes: plan.traffic_bytes,
    });

    // Re-enable VPN configs if they exist
    await VpnService.enableForUser(userId).catch((err) =>
      logger.error('Failed to re-enable VPN on new subscription', { error: err.message }),
    );

    logger.info('Subscription created', { userId, subscriptionId: sub.id, planSlug: plan.slug });
    return sub;
  },

  /**
   * Extend the active subscription of a user by N days.
   * Used for referral bonuses, admin gifts, etc.
   */
  async extendByDays(userId, days) {
    const sub = await Subscription.findActiveByUserId(userId);
    if (!sub) {
      logger.warn('No active subscription to extend', { userId });
      return null;
    }
    const extended = await Subscription.extend(sub.id, days);
    logger.info('Subscription extended by bonus', { userId, days });
    return extended;
  },

  async getActive(userId) {
    return Subscription.findActiveByUserId(userId);
  },

  async getHistory(userId) {
    return Subscription.findAllByUserId(userId);
  },

  async cancel(userId) {
    const sub = await Subscription.findActiveByUserId(userId);
    if (!sub) return null;

    const cancelled = await Subscription.cancel(sub.id);

    // Disable VPN configs
    const VpnService = require('./VpnService');
    await VpnService.disableForUser(userId).catch((err) =>
      logger.error('Failed to disable VPN on cancel', { error: err.message }),
    );

    logger.info('Subscription cancelled', { userId, subscriptionId: sub.id });
    return cancelled;
  },

  /**
   * Called by cron: expire all overdue subscriptions and disable VPN.
   */
  async processExpired() {
    const expired = await Subscription.findExpiredActive();
    const VpnService = require('./VpnService');

    for (const sub of expired) {
      try {
        await Subscription.expire(sub.id);
        await VpnService.disableForUser(sub.user_id);
        logger.info('Subscription expired', { subscriptionId: sub.id, userId: sub.user_id });
      } catch (err) {
        logger.error('Error expiring subscription', { subscriptionId: sub.id, error: err.message });
      }
    }

    return expired.length;
  },

  /**
   * Called by cron: send expiry notifications.
   * Uses NotificationService for idempotency.
   */
  async processExpiryNotifications(bot) {
    const config = require('../config');
    const subs = await Subscription.findExpiringIn(config.notifications.expiryDaysBefore);

    for (const sub of subs) {
      try {
        const daysLeft = Math.ceil((new Date(sub.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

        await NotificationService.sendExpiringNotification(bot, sub, daysLeft);
      } catch (err) {
        logger.error('Failed to send expiry notification', {
          subscriptionId: sub.id,
          error: err.message,
        });
      }
    }
  },

  /**
   * Called by cron: send trial expired notifications.
   * Finds all expired trial subscriptions that haven't been notified.
   */
  async processTrialExpiredNotifications(bot) {
    const expiredTrials = await Subscription.findExpiredTrialNotNotified();

    let sent = 0;
    for (const sub of expiredTrials) {
      try {
        const notified = await NotificationService.sendTrialExpiredNotification(
          bot,
          sub.user_id,
          sub.id,
        );
        if (notified) sent++;
      } catch (err) {
        logger.error('Failed to send trial expired notification', {
          subscriptionId: sub.id,
          error: err.message,
        });
      }
    }

    if (sent > 0) {
      logger.info('Trial expired notifications sent', { count: sent });
    }
    return sent;
  },
};

module.exports = SubscriptionService;
