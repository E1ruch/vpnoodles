'use strict';

const { Markup } = require('telegraf');
const VpnService = require('../../services/VpnService');
const SubscriptionService = require('../../services/SubscriptionService');
const logger = require('../../utils/logger');

function protocolLabel(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value === 'subscription') return 'Подписка';
  if (value === 'vless') return 'VLESS';
  if (value === 'vmess') return 'VMess';
  if (value === 'trojan') return 'Trojan';
  return String(protocol || 'Неизвестно');
}

function serverLabel(cfg) {
  const tag = String(cfg.server_tag || '').trim();
  if (tag && tag.toLowerCase() !== 'default') {
    return tag;
  }

  // For subscription links show host instead of technical "default".
  try {
    const link = String(cfg.config_link || '').trim();
    if (link.startsWith('http://') || link.startsWith('https://')) {
      const url = new URL(link);
      if (url.hostname) return url.hostname;
    }
  } catch {
    // Ignore URL parse issues and fallback to generic name.
  }

  return 'Основной сервер';
}

/**
 * My VPN handler — shows active configs and QR codes
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;

  const activeSub = await SubscriptionService.getActive(user.id);

  if (!activeSub) {
    const text =
      `📱 *Мой VPN*\n\n` +
      `❌ У вас нет активной подписки.\n\n` +
      `Оформите подписку, чтобы получить доступ к VPN.`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💳 Купить подписку', 'subscribe')],
      [Markup.button.callback('🎁 Попробовать бесплатно', 'trial')],
      [Markup.button.callback('◀️ Меню', 'menu')],
    ]);

    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
    return ctx.replyWithMarkdown(text, keyboard);
  }

  const configs = await VpnService.getConfigsForUser(user.id);

  if (!configs.length) {
    return ctx.reply(
      '⚙️ Ваша конфигурация VPN ещё создаётся. Попробуйте через минуту.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить', 'my_vpn')]]),
    );
  }

  const daysLeft = Math.ceil((new Date(activeSub.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

  // Send subscription status
  const statusText =
    `📱 *Мой VPN*\n\n` +
    `✅ Подписка активна\n` +
    `📅 Истекает: *${new Date(activeSub.expires_at).toLocaleDateString('ru-RU')}* (через ${daysLeft} дн.)\n\n` +
    `Ваши конфигурации:`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(statusText, { parse_mode: 'Markdown' });
  } else {
    await ctx.replyWithMarkdown(statusText);
  }

  // Send each config with QR code
  for (const cfg of configs) {
    try {
      const configText =
        `🔑 *Конфигурация #${cfg.id}*\n` +
        `📡 Протокол: \`${protocolLabel(cfg.protocol)}\`\n` +
        `🖥 Сервер: \`${serverLabel(cfg)}\`\n\n` +
        `📋 *Ссылка для подключения:*\n` +
        `\`${cfg.config_link || 'Генерируется...'}\``;

      if (cfg.qrCode) {
        // Send QR code as photo
        const qrBuffer = Buffer.from(cfg.qrCode.split(',')[1], 'base64');
        await ctx.replyWithPhoto(
          { source: qrBuffer },
          {
            caption: configText,
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Обновить конфиг', 'my_vpn')],
              [Markup.button.callback('💳 Продлить', 'subscribe')],
            ]),
          },
        );
      } else {
        await ctx.replyWithMarkdown(
          configText,
          Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Обновить', 'my_vpn')],
            [Markup.button.callback('💳 Продлить', 'subscribe')],
          ]),
        );
      }
    } catch (err) {
      logger.error('Error sending VPN config', { configId: cfg.id, error: err.message });
    }
  }
};
