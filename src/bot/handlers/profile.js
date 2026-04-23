'use strict';

const SubscriptionService = require('../../services/SubscriptionService');
const PaymentService = require('../../services/PaymentService');
const { btn } = require('../utils/btn');

/**
 * Escape special characters for Telegram Markdown
 */
function escapeMarkdown(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format amount with currency
 */
function formatAmount(amount, currency) {
  if (currency === 'XTR') {
    return `${amount} ⭐`;
  }
  if (currency === 'RUB') {
    return `${(amount / 100).toFixed(2)} ₽`;
  }
  return `${amount} ${currency}`;
}

/**
 * Get provider label in Russian
 */
function providerLabel(provider) {
  const labels = {
    stars: 'Telegram Stars',
    cryptopay: 'CryptoPay',
    yookassa: 'ЮKassa',
  };
  return labels[provider] || provider;
}

/**
 * Get status label in Russian
 */
function statusLabel(status) {
  const labels = {
    paid: '✅ Оплачен',
    pending: '⏳ Ожидает',
    failed: '❌ Ошибка',
    canceled: '🚫 Отменён',
    refunded: '↩️ Возврат',
  };
  return labels[status] || status;
}

/**
 * Profile handler — shows user info, subscription status
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

  const inline_keyboard = [
    [btn('История платежей', 'profile_payments', null, '5967390100357648692')],
    [btn('Управление устройствами', 'my_devices', null, '5845947563601041174')],
    [btn('Продлить подписку', 'subscribe', 'primary', '5983399041197675256')],
    [btn('Реферальная программа', 'referral', null, '5944970130554359187')],
    [btn('Меню', 'menu', null, '5875082500023258804')],
  ];

  if (ctx.callbackQuery) {
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
 * Show payment history
 */
module.exports.showPayments = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const payments = await PaymentService.getHistory(user.id);

  // Take only last 10 payments
  const recentPayments = payments.slice(0, 10);

  if (recentPayments.length === 0) {
    const text =
      `💳 *История платежей*\n\n` +
      `📭 История платежей пуста.\n\n` +
      `Оформите подписку, чтобы начать пользоваться VPN.`;

    const inline_keyboard = [[btn('Назад в профиль', 'profile', null, '5875082500023258804')]];

    if (ctx.callbackQuery?.message?.photo) {
      return ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard },
      });
    }
    return ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }

  let text = `💳 *История платежей*\n\n`;

  recentPayments.forEach((payment, index) => {
    const date = new Date(payment.created_at).toLocaleDateString('ru-RU');
    const amount = formatAmount(payment.amount, payment.currency);
    const status = statusLabel(payment.status);
    const provider = providerLabel(payment.provider);

    text += `${index + 1}\\. ${date} • ${amount}\n`;
    text += `   ${status} • _${escapeMarkdown(provider)}_\n\n`;
  });

  const inline_keyboard = [[btn('Назад в профиль', 'profile', null, '5875082500023258804')]];

  if (ctx.callbackQuery?.message?.photo) {
    return ctx.editMessageCaption(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });
  }

  return ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard },
  });
};
