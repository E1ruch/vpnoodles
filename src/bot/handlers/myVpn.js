'use strict';

const { Markup } = require('telegraf');
const VpnService = require('../../services/VpnService');
const SubscriptionService = require('../../services/SubscriptionService');
const logger = require('../../utils/logger');

function protocolLabel(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value === 'subscription') return 'VLESS (подписка)';
  if (value === 'vless') return 'VLESS';
  if (value === 'vmess') return 'VMess';
  if (value === 'trojan') return 'Trojan';
  return String(protocol || 'Неизвестно');
}

function formatTrafficUsed(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '';
  const b = Number(bytes);
  if (b < 1024) return `${Math.round(b)} Б`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`;
  const mb = b / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
  const gb = b / (1024 * 1024 * 1024);
  return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} ГБ`;
}

function serverLabel(cfg) {
  const fromNode = String(cfg.server_label || '').trim();
  if (fromNode) return fromNode;

  const fromPanelTag = String(cfg.panel_snapshot?.tag || '').trim();
  if (fromPanelTag) return fromPanelTag;

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
      // Check if the original message has a photo (QR code) - use editMessageCaption for photos
      if (ctx.callbackQuery.message?.photo) {
        return ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
      }
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
      const link = String(cfg.config_link || '').trim();
      const connectRow =
        link.startsWith('http://') || link.startsWith('https://')
          ? [[Markup.button.url('🚀 Подключиться', link)]]
          : [];

      const snap = cfg.panel_snapshot;
      let panelExtra = '';
      if (snap) {
        if (snap.hwidDeviceLimit != null && snap.hwidDeviceLimit !== '') {
          panelExtra += `\n📱 Лимит устройств (панель): ${snap.hwidDeviceLimit}`;
        }
        if (snap.usedTrafficBytes != null) {
          const u = formatTrafficUsed(snap.usedTrafficBytes);
          if (u) {
            panelExtra += `\n📊 Использовано трафика: ${u}`;
            if (snap.trafficLimitBytes != null && snap.trafficLimitBytes > 0) {
              panelExtra += ` / лимит ${formatTrafficUsed(snap.trafficLimitBytes)}`;
            }
          }
        }
      }

      const configText =
        `🔑 *Конфигурация #${cfg.id}*\n` +
        `📡 Протокол: \`${protocolLabel(cfg.protocol)}\`\n` +
        `🖥 Сервер: \`${serverLabel(cfg)}\`\n` +
        `${panelExtra ? `${panelExtra}\n` : ''}` +
        `\n📋 *Ссылка для подключения:*\n` +
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
              ...connectRow,
              [Markup.button.callback('🔄 Обновить конфиг', 'my_vpn')],
              [Markup.button.callback('💳 Продлить', 'subscribe')],
            ]),
          },
        );
      } else {
        await ctx.replyWithMarkdown(
          configText,
          Markup.inlineKeyboard([
            ...connectRow,
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
