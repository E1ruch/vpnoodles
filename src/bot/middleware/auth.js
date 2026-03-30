'use strict';

const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Auth middleware:
 * - Blocks banned users
 * - Attaches isAdmin flag to ctx
 */
module.exports = async (ctx, next) => {
  // Skip non-user updates (channel posts, etc.)
  if (!ctx.from) return next();

  const user = ctx.state.user;

  // Block banned users
  if (user?.status === 'banned') {
    logger.warn('Banned user attempted access', { telegramId: ctx.from.id });
    return ctx.reply('🚫 Ваш аккаунт заблокирован. Обратитесь в поддержку.');
  }

  // Attach admin flag
  ctx.state.isAdmin = config.telegram.adminIds.includes(ctx.from.id);

  return next();
};
