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
    `🎁 Бонусных дней получено: *${stats.totalBonusDays}* дн.\n\n` +
    `💡 *Как это работает:*\n` +
    `1. Поделитесь ссылкой с другом\n` +
    `2. Друг регистрируется и оплачивает подписку\n` +
    `3. Вы получаете +${config.referral.bonusDays} дней к своей подписке`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.url(
        '📤 Поделиться ссылкой',
        `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('🌐 Попробуй VPNoodles — быстрый VPN прямо в Telegram!')}`,
      ),
    ],
    [Markup.button.callback('◀️ Назад', 'menu')],
  ]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
};
