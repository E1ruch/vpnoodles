'use strict';

const { Markup } = require('telegraf');

/**
 * Main menu handler
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
    [Markup.button.callback('💳 Подписка', 'subscribe')],
    [
      Markup.button.callback('👤 Профиль', 'profile'),
      Markup.button.callback('👥 Реферал', 'referral'),
    ],
    [Markup.button.callback('❓ Помощь', 'help')],
  ]);

  const text = `🌐 *VPNoodles — Главное меню*\n\n` + `Выберите раздел:`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
};
