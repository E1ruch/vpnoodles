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

    return db('referrals')
      .where({ referrer_id: user.referred_by, referred_id: referredUserId })
      .first();
  },

  /**
   * Credit referral bonus to referrer's balance (without auto-applying).
   * Called when referred user makes first payment.
   */
  async _creditReferralBonus(referral, bonusDays) {
    const updated = await db('referrals').where({ id: referral.id }).update({
      bonus_days: bonusDays,
      bonus_applied: false, // Not applied yet, waiting for manual use
    });

    if (!updated) return false;

    logger.info('Referral bonus credited to balance', {
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
   * Credit referral bonus to referrer after referred user makes first payment.
   * Bonus is added to balance and can be used manually later.
   */
  async creditReferralBonus(referredUserId) {
    const config = require('../config');
    let referral = await db('referrals')
      .where({ referred_id: referredUserId, bonus_days: 0 })
      .first();

    // Backward compatibility: if referral row was never created, rebuild it from users.referred_by.
    if (!referral) {
      referral = await UserService._ensureReferralLink(referredUserId);
    }
    if (!referral || referral.bonus_days > 0) return; // Already credited

    try {
      await UserService._creditReferralBonus(referral, config.referral.bonusDays);
    } catch (err) {
      logger.error('Failed to credit referral bonus', { error: err.message });
    }
  },

  /**
   * Get available bonus days for a user (not yet applied).
   */
  async getAvailableBonusDays(userId) {
    const result = await db('referrals')
      .where({ referrer_id: userId, bonus_applied: false })
      .where('bonus_days', '>', 0)
      .sum('bonus_days as available')
      .first();

    return parseInt(result?.available || 0, 10);
  },

  /**
   * Use all available bonus days for a user.
   * Returns { success, daysUsed, newExpiresAt } or { success: false, error }.
   */
  async useBonusDays(userId) {
    const availableDays = await UserService.getAvailableBonusDays(userId);

    if (availableDays <= 0) {
      return { success: false, error: 'no_bonus_days' };
    }

    const SubscriptionService = require('./SubscriptionService');
    const VpnService = require('./VpnService');
    const Subscription = require('../models/Subscription');

    const sub = await Subscription.findActiveByUserId(userId);
    if (!sub) {
      return { success: false, error: 'no_active_subscription' };
    }

    // Extend subscription in DB
    const extended = await SubscriptionService.extendByDays(userId, availableDays);
    if (!extended) {
      return { success: false, error: 'extension_failed' };
    }

    // Extend in VPN panel (Remnawave)
    try {
      await VpnService.extendInPanel(userId, availableDays);
    } catch (err) {
      logger.error('Failed to extend VPN in panel for bonus', {
        userId,
        days: availableDays,
        error: err.message,
      });
      // Continue - DB extension is more important
    }

    // Mark all bonus days as applied
    await db('referrals')
      .where({ referrer_id: userId, bonus_applied: false })
      .where('bonus_days', '>', 0)
      .update({
        bonus_applied: true,
        bonus_applied_at: db.fn.now(),
      });

    logger.info('Bonus days applied manually', {
      userId,
      daysUsed: availableDays,
      newExpiresAt: extended.expires_at,
    });

    return {
      success: true,
      daysUsed: availableDays,
      newExpiresAt: extended.expires_at,
    };
  },

  async getReferralStats(userId) {
    const referrals = await db('referrals')
      .where({ referrer_id: userId })
      .count('id as total')
      .sum('bonus_days as total_bonus_days')
      .first();

    const availableDays = await UserService.getAvailableBonusDays(userId);

    return {
      total: parseInt(referrals.total || 0, 10),
      totalBonusDays: parseInt(referrals.total_bonus_days || 0, 10),
      availableBonusDays: availableDays,
    };
  },
};

module.exports = UserService;
