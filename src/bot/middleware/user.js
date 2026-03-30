'use strict';

const UserService = require('../../services/UserService');
const logger = require('../../utils/logger');

/**
 * User middleware:
 * Registers/updates user in DB on every update and attaches to ctx.state.user
 */
module.exports = async (ctx, next) => {
  if (!ctx.from) return next();

  try {
    // Extract referral code from /start payload (e.g. /start ref_123456789)
    let referralCode = null;
    if (ctx.message?.text?.startsWith('/start ')) {
      const payload = ctx.message.text.split(' ')[1];
      if (payload?.startsWith('ref_')) {
        referralCode = payload.replace('ref_', '');
      }
    }

    const user = await UserService.registerOrUpdate(ctx, referralCode);
    ctx.state.user = user;
  } catch (err) {
    logger.error('User middleware error', { error: err.message, userId: ctx.from.id });
    // Don't block the update — continue without user in state
  }

  return next();
};
