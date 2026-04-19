'use strict';

const { btn, keyboard } = require('../utils/btn');

/**
 * Main menu handler
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const inlineKeyboard = [
    [btn('Моя конфигурация VPN', 'my_vpn', 'primary', '5967574255670399788')], //📱
    [btn('Приобрести подписку', 'subscribe', 'primary', '5983399041197675256')], //💳
    [
      btn('Профиль', 'profile', '5920344347152224466'), //👤
      btn('Реферал', 'referral', '5944970130554359187'), //👥
    ],
    [btn('Помощь', 'help', '5988023995125993550')], //❓
  ];

  const text = `🌐 *VPNoodles — Главное меню*\n\n` + `Выберите раздел:`;

  if (ctx.callbackQuery) {
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (ctx.callbackQuery.message?.photo) {
      await ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard(inlineKeyboard) });
    } else {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard(inlineKeyboard) });
    }
  } else {
    await ctx.replyWithMarkdown(text, keyboard(inlineKeyboard));
  }
};
