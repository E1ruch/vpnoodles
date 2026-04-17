'use strict';

const { Markup } = require('telegraf');
const config = require('../../config');
const UserService = require('../../services/UserService');

/**
 * Referral handler — shows referral link and stats
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const stats = await UserService.getReferralStats(user.id);

  const refLink = `https://t.me/${config.telegram.username}?start=ref_${user.telegram_id}`;

  const text =
    `👥 *Реферальная программа*\n\n` +
    `Приглашайте друзей и получайте *+${config.referral.bonusDays} дней* к подписке за каждого!\n\n` +
    `🔗 *Ваша реферальная ссылка:*\n` +
    `\`${refLink}\`\n\n` +
    `📊 *Ваша статистика:*\n` +
    `👤 Приглашено: *${stats.total}* чел.\n` +
    `🎁 Бонусных дней доступно: *${stats.availableBonusDays}* дн.\n` +
    `✅ Бонусных дней использовано: *${stats.totalBonusDays - stats.availableBonusDays}* дн.\n\n` +
    `💡 *Как это работает:*\n` +
    `1. Поделитесь ссылкой с другом\n` +
    `2. Друг регистрируется и оплачивает подписку\n` +
    `3. Вам начисляются бонусные дни\n` +
    `4. Используйте их для продления подписки`;

  const buttons = [
    [
      Markup.button.url(
        '📤 Поделиться ссылкой',
        `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('🌐 Попробуй VPNoodles — быстрый VPN прямо в Telegram!')}`,
      ),
    ],
  ];

  // Show "Use bonus days" button only if user has available days
  if (stats.availableBonusDays > 0) {
    buttons.push([
      Markup.button.callback(
        `🎁 Использовать бонусные дни (${stats.availableBonusDays} дн.)`,
        'use_bonus_days',
      ),
    ]);
  }

  buttons.push([Markup.button.callback('◀️ Назад', 'menu')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (ctx.callbackQuery.message?.photo) {
      await ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
};

/**
 * Handle "Use bonus days" button click
 */
module.exports.handleUseBonusDays = async (ctx) => {
  await ctx.answerCbQuery();

  const user = ctx.state.user;
  const result = await UserService.useBonusDays(user.id);

  if (!result.success) {
    let errorText;
    if (result.error === 'no_bonus_days') {
      errorText = '❌ У вас нет доступных бонусных дней.';
    } else if (result.error === 'no_active_subscription') {
      errorText =
        '❌ У вас нет активной подписки.\n\n' +
        'Сначала оформите подписку, чтобы использовать бонусные дни.';
    } else {
      errorText = '⚠️ Произошла ошибка. Попробуйте позже.';
    }

    return ctx.editMessageText(errorText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💳 Оформить подписку', 'subscribe')],
        [Markup.button.callback('◀️ Назад', 'referral')],
      ]),
    });
  }

  const expiresAt = new Date(result.newExpiresAt);
  const expiresAtStr = expiresAt.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const successText =
    `✅ *Бонусные дни применены!*\n\n` +
    `📅 Продлено на: *${result.daysUsed}* дн.\n` +
    `🗓 Новая дата окончания: *${expiresAtStr}*\n\n` +
    `Спасибо, что приглашаете друзей! 🎉`;

  return ctx.editMessageText(successText, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
      [Markup.button.callback('◀️ Назад', 'referral')],
    ]),
  });
};
