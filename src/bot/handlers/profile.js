'use strict';

const { Markup } = require('telegraf');
const SubscriptionService = require('../../services/SubscriptionService');
const PaymentService = require('../../services/PaymentService');

/**
 * Profile handler — shows user info, subscription status, payment history
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const activeSub = await SubscriptionService.getActive(user.id);
  const payments = await PaymentService.getHistory(user.id);
  const paidCount = payments.filter((p) => p.status === 'paid').length;

  const subStatus = activeSub
    ? `✅ Активна до *${new Date(activeSub.expires_at).toLocaleDateString('ru-RU')}*`
    : `❌ Нет активной подписки`;

  const text =
    `👤 *Ваш профиль*\n\n` +
    `🆔 ID: \`${user.telegram_id}\`\n` +
    `👤 Имя: ${user.first_name || '—'} ${user.last_name || ''}\n` +
    `📛 Username: ${user.username ? `@${user.username}` : '—'}\n` +
    `📅 Регистрация: ${new Date(user.created_at).toLocaleDateString('ru-RU')}\n\n` +
    `📦 *Подписка:* ${subStatus}\n\n` +
    `💳 Оплат: ${paidCount}\n` +
    `👥 Рефералов: ${user.referral_count || 0}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💳 Управление подпиской', 'subscribe')],
    [Markup.button.callback('👥 Реферальная программа', 'referral')],
    [Markup.button.callback('◀️ Меню', 'menu')],
  ]);

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
