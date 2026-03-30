'use strict';

const logger = require('../../utils/logger');

/**
 * Logs every incoming update with basic info.
 */
module.exports = async (ctx, next) => {
  const start = Date.now();
  const updateType = ctx.updateType;
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  let text = '';
  if (ctx.message?.text) text = ctx.message.text.slice(0, 80);
  else if (ctx.callbackQuery?.data) text = `[cb] ${ctx.callbackQuery.data}`;

  await next();

  const ms = Date.now() - start;
  logger.debug('Update processed', { updateType, userId, username, text, ms });
};
