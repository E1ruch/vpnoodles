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

  async _ensureReferralLink(referredUserId) {
    const user = await User.findById(referredUserId);
    if (!user?.referred_by) return null;

    const existing = await db('referrals')
      .where({ referrer_id: user.referred_by, referred_id: referredUserId })
      .first();
    if (existing) return existing;

    const inserted = await db('referrals')
      .insert({
        referrer_id: user.referred_by,
        referred_id: referredUserId,
        bonus_days: 0,
      })
      .onConflict(['referrer_id', 'referred_id'])
      .ignore()
      .returning('*');

    if (Array.isArray(inserted) && inserted.length > 0) {
      return inserted[0];
    }

    return db('referrals').where({ referrer_id: user.referred_by, referred_id: referredUserId }).first();
  },

  async _applyReferralBonusRecord(referral, bonusDays) {
    const SubscriptionService = require('./SubscriptionService');
    const extended = await SubscriptionService.extendByDays(referral.referrer_id, bonusDays);

    if (!extended) {
      logger.warn('Referral bonus deferred: referrer has no active subscription', {
        referrerId: referral.referrer_id,
        referredId: referral.referred_id,
        bonusDays,
      });
      return false;
    }

    const updated = await db('referrals')
      .where({ id: referral.id, bonus_applied: false })
      .update({
        bonus_days: bonusDays,
        bonus_applied: true,
        bonus_applied_at: db.fn.now(),
      });

    if (!updated) return false;

    logger.info('Referral bonus applied', {
      referrerId: referral.referrer_id,
      referredId: referral.referred_id,
      bonusDays,
    });

    return true;
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
    let referral = await db('referrals')
      .where({ referred_id: referredUserId, bonus_applied: false })
      .first();

    // Backward compatibility: if referral row was never created, rebuild it from users.referred_by.
    if (!referral) {
      referral = await UserService._ensureReferralLink(referredUserId);
    }
    if (!referral || referral.bonus_applied) return;

    try {
      await UserService._applyReferralBonusRecord(referral, config.referral.bonusDays);
    } catch (err) {
      logger.error('Failed to apply referral bonus', { error: err.message });
    }
  },

  /**
   * Apply all pending referral bonuses for a referrer.
   * Used when user purchases a subscription after bonuses were deferred.
   */
  async applyPendingReferralBonusesForReferrer(referrerUserId) {
    const config = require('../config');
    const pending = await db('referrals')
      .where({ referrer_id: referrerUserId, bonus_applied: false })
      .orderBy('created_at', 'asc');

    if (!pending.length) return 0;

    let applied = 0;
    for (const referral of pending) {
      try {
        const ok = await UserService._applyReferralBonusRecord(referral, config.referral.bonusDays);
        if (ok) applied += 1;
      } catch (err) {
        logger.error('Failed to apply pending referral bonus', {
          referrerUserId,
          referralId: referral.id,
          error: err.message,
        });
      }
    }

    return applied;
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
