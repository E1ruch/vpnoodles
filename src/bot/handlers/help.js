'use strict';

const SubscriptionService = require('../../services/SubscriptionService');
const config = require('../../config');
const { btn, btnUrl } = require('../utils/btn');

/**
 * Help handler — shows user info, subscription status, support contacts
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const activeSub = await SubscriptionService.getActive(user.id);

  const subStatus = activeSub
    ? `✅ Активна до *${new Date(activeSub.expires_at).toLocaleDateString('ru-RU')}*`
    : `❌ Нет активной подписки`;

  const text =
    `❓ *Помощь*\n\n` +
    `👤 *Ваша информация:*\n` +
    `🆔 ID: \`${user.telegram_id}\`\n` +
    `📛 Имя: ${user.first_name || '—'} ${user.last_name || ''}\n` +
    `📦 Подписка: ${subStatus}\n\n`;

  const inline_keyboard = [
    [btn('Обратиться в поддержку', 'support_contact', 'primary', '5967574255670399788')],
    [btn('Перейти в группу', 'support_group', 'primary', '5875465628285931233')],
    [btn('Перейти на сайт', 'support_website', 'primary', '5994323406479167187')],
    [btn('Назад', 'menu', null, '5875082500023258804')],
  ];

  if (ctx.callbackQuery) {
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (ctx.callbackQuery.message?.photo) {
      await ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
      });
    } else {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
      });
    }
  } else {
    await ctx.replyWithMarkdown(text, {
      reply_markup: { inline_keyboard },
    });
  }
};

/**
 * Handle support contact button click
 */
module.exports.handleSupportContact = async (ctx) => {
  await ctx.answerCbQuery();

  const text =
    `📞 *Связаться с поддержкой*\n\n` +
    `Вы можете написать напрямую:\n\n` +
    `• @vladiuslaviosa\n` +
    `• @Doofoos\n\n` +
    `Мы ответим в ближайшее время!`;

  const inline_keyboard = [[btn('Назад', 'help', null, '5875082500023258804')]];

  if (ctx.callbackQuery.message?.photo) {
    await ctx.editMessageCaption(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  } else {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }
};

/**
 * Handle support group button click
 */
module.exports.handleSupportGroup = async (ctx) => {
  await ctx.answerCbQuery();

  const groupLink = config.support?.groupLink || 'https://t.me/VPNoodles';

  const text =
    `👥 *Наша группа*\n\n` +
    `Присоединяйтесь к нашей группе для новостей и обновлений!\n\n` +
    `🔗 Ссылка: ${groupLink}`;

  const inline_keyboard = [
    [btnUrl('Открыть группу', groupLink)],
    [btn('Назад', 'help', null, '5875082500023258804')],
  ];

  if (ctx.callbackQuery.message?.photo) {
    await ctx.editMessageCaption(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  } else {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }
};

/**
 * Handle support website button click
 */
module.exports.handleSupportWebsite = async (ctx) => {
  await ctx.answerCbQuery();

  const websiteLink = config.support?.websiteLink || 'https://promo.vpnoodles.ru';

  const text =
    `🌐 *Наш сайт*\n\n` +
    `Посетите наш сайт для получения дополнительной информации.\n\n` +
    `🔗 Ссылка: ${websiteLink}`;

  const inline_keyboard = [
    [btnUrl('Открыть сайт', websiteLink)],
    [btn('Назад', 'help', null, '5875082500023258804')],
  ];

  if (ctx.callbackQuery.message?.photo) {
    await ctx.editMessageCaption(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  } else {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }
};
