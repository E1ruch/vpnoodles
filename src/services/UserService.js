'use strict';

const User = require('../models/User');
const db = require('../database/knex');
const logger = require('../utils/logger');

const UserService = {
  /**
   * Register or update a user from Telegram context.
   * Handles referral tracking automatically.
   */
  async registerOrUpdate(ctx, referralCode = null) {
    const tg = ctx.from;

    let referredBy = null;

    // Resolve referral: referralCode is the referrer's telegram_id (as string)
    if (referralCode) {
      const referrer = await User.findByTelegramId(parseInt(referralCode, 10));
      if (referrer && referrer.telegram_id !== tg.id) {
        referredBy = referrer.id;
      }
    }

    const user = await User.upsert({
      telegramId: tg.id,
      username: tg.username,
      firstName: tg.first_name,
      lastName: tg.last_name,
      languageCode: tg.language_code,
      referredBy,
    });

    // If new user came via referral — record it
    if (referredBy && user.referred_by === referredBy) {
      await UserService._handleReferral(user, referredBy);
    }

    logger.debug('User registered/updated', { telegramId: tg.id, userId: user.id });
    return user;
  },

  async _handleReferral(newUser, referrerId) {
    try {
      const existing = await db('referrals')
        .where({ referrer_id: referrerId, referred_id: newUser.id })
        .first();

      if (!existing) {
        await db('referrals').insert({
          referrer_id: referrerId,
          referred_id: newUser.id,
          bonus_days: 0, // will be applied after first payment
        });
        await User.incrementReferralCount(referrerId);
        logger.info('Referral recorded', { referrerId, newUserId: newUser.id });
      }
    } catch (err) {
      logger.error('Failed to record referral', { error: err.message });
    }
  },

  async getProfile(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    return user;
  },

  async ban(userId) {
    const user = await User.ban(userId);
    logger.info('User banned', { userId });
    return user;
  },

  async unban(userId) {
    const user = await User.unban(userId);
    logger.info('User unbanned', { userId });
    return user;
  },

  async isAdmin(telegramId) {
    const config = require('../config');
    return config.telegram.adminIds.includes(telegramId);
  },

  async isBanned(telegramId) {
    const user = await User.findByTelegramId(telegramId);
    return user?.status === 'banned';
  },

  /**
   * Apply referral bonus to referrer after referred user makes first payment.
   */
  async applyReferralBonus(referredUserId) {
    const config = require('../config');
    const SubscriptionService = require('./SubscriptionService');

    const referral = await db('referrals')
      .where({ referred_id: referredUserId, bonus_applied: false })
      .first();

    if (!referral) return;

    try {
      // Extend referrer's active subscription
      await SubscriptionService.extendByDays(referral.referrer_id, config.referral.bonusDays);

      await db('referrals').where({ id: referral.id }).update({
        bonus_days: config.referral.bonusDays,
        bonus_applied: true,
        bonus_applied_at: db.fn.now(),
      });

      logger.info('Referral bonus applied', {
        referrerId: referral.referrer_id,
        bonusDays: config.referral.bonusDays,
      });
    } catch (err) {
      logger.error('Failed to apply referral bonus', { error: err.message });
    }
  },

  async getReferralStats(userId) {
    const referrals = await db('referrals')
      .where({ referrer_id: userId })
      .count('id as total')
      .sum('bonus_days as total_bonus_days')
      .first();

    return {
      total: parseInt(referrals.total || 0, 10),
      totalBonusDays: parseInt(referrals.total_bonus_days || 0, 10),
    };
  },
};

module.exports = UserService;
