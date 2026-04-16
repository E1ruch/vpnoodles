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
 * Escape special characters for Telegram Markdown
 */
function escapeMarkdown(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Build full config text with link (for connection display)
 */
function buildFullConfigText(cfg) {
  const snap = cfg.panel_snapshot;
  let extraInfo = '';

  if (snap) {
    if (snap.hwidDeviceLimit != null && snap.hwidDeviceLimit !== '') {
      extraInfo += `\n📱 Устройств: до ${snap.hwidDeviceLimit}`;
    }
    if (snap.usedTrafficBytes != null) {
      const u = formatTrafficUsed(snap.usedTrafficBytes);
      if (u) {
        extraInfo += `\n📊 Трафик: ${u}`;
        if (snap.trafficLimitBytes != null && snap.trafficLimitBytes > 0) {
          extraInfo += ` из ${formatTrafficUsed(snap.trafficLimitBytes)}`;
        }
      }
    }
  }

  // Don't show full link in text - it contains special chars that break Markdown
  // User will get the link via button
  return (
    `🖥 *${escapeMarkdown(serverLabel(cfg))}*\n` +
    `📡 Протокол: ${protocolLabel(cfg.protocol)}${extraInfo}\n\n` +
    `💡 Нажмите кнопку ниже для получения ссылки`
  );
}

/**
 * My VPN handler — shows subscription info with connection button
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
      [Markup.button.callback('◀️ Назад', 'menu')],
    ]);

    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.message?.photo) {
        return ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
      }
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
    return ctx.replyWithMarkdown(text, keyboard);
  }

  const configs = await VpnService.getConfigsForUser(user.id);

  if (!configs.length) {
    const text =
      `📱 *Мой VPN*\n\n` +
      `⏳ Ваша конфигурация создаётся...\n` +
      `Обычно это занимает 1-2 минуты.`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Проверить', 'my_vpn')],
      [Markup.button.callback('◀️ Назад', 'menu')],
    ]);

    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.message?.photo) {
        await ctx.deleteMessage().catch(() => {});
        return ctx.replyWithMarkdown(text, keyboard);
      }
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
    return ctx.replyWithMarkdown(text, keyboard);
  }

  const daysLeft = Math.ceil((new Date(activeSub.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

  // Get first config (subscription link)
  const mainConfig = configs[0];
  const snap = mainConfig.panel_snapshot;

  // Build user-friendly message
  let messageText =
    `📱 *Мой VPN*\n\n` +
    `✅ Подписка активна до ${new Date(activeSub.expires_at).toLocaleDateString('ru-RU')}\n` +
    `📅 Осталось: *${daysLeft} ${daysLeft === 1 ? 'день' : daysLeft < 5 ? 'дня' : 'дней'}*\n\n` +
    `🔗 *Ваша подписка:*\n` +
    `🖥 ${escapeMarkdown(serverLabel(mainConfig))}`;

  // Add device limit if available
  if (snap?.hwidDeviceLimit != null && snap.hwidDeviceLimit !== '') {
    messageText += ` • 📱 До ${snap.hwidDeviceLimit} устройств`;
  }

  // Add traffic info if available
  if (
    snap?.usedTrafficBytes != null &&
    snap?.trafficLimitBytes != null &&
    snap.trafficLimitBytes > 0
  ) {
    const used = formatTrafficUsed(snap.usedTrafficBytes);
    const limit = formatTrafficUsed(snap.trafficLimitBytes);
    if (used && limit) {
      messageText += `\n📊 Трафик: ${used} / ${limit}`;
    }
  }

  messageText += `\n\n💡 Нажмите кнопку ниже для получения ссылки`;

  // Build keyboard
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📷 Запросить подключение', `show_qr_${mainConfig.id}`)],
    [Markup.button.callback('💳 Продлить подписку', 'subscribe')],
    [Markup.button.callback('◀️ В меню', 'menu')],
  ]);

  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message?.photo) {
      await ctx.deleteMessage().catch(() => {});
      return ctx.replyWithMarkdown(messageText, keyboard);
    }
    return ctx.editMessageText(messageText, { parse_mode: 'Markdown', ...keyboard });
  }

  return ctx.replyWithMarkdown(messageText, keyboard);
};

/**
 * Show connection details with QR option
 */
module.exports.showQr = async (ctx, configId) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;

  const configs = await VpnService.getConfigsForUser(user.id);
  const cfg = configs.find((c) => c.id === parseInt(configId, 10));

  if (!cfg) {
    return ctx.answerCbQuery('⚠️ Конфигурация не найдена', { show_alert: true });
  }

  const link = String(cfg.config_link || '').trim();
  const isSubscription = link.startsWith('http://') || link.startsWith('https://');

  const configText = buildFullConfigText(cfg);

  const keyboardRows = [];

  // Add "Connect" button for subscription links
  if (isSubscription) {
    keyboardRows.push([Markup.button.url('🚀 Открыть в приложении', link)]);
  }

  // Add QR button if QR code exists
  if (cfg.qrCode) {
    keyboardRows.push([Markup.button.callback('📷 Открыть QR-код', `show_qr_image_${cfg.id}`)]);
  }

  keyboardRows.push([Markup.button.callback('📋 Скопировать ссылку', `copy_link_${cfg.id}`)]);
  keyboardRows.push([Markup.button.callback('◀️ К списку', 'my_vpn')]);
  keyboardRows.push([Markup.button.callback('🏠 В меню', 'menu')]);

  const keyboard = Markup.inlineKeyboard(keyboardRows);

  if (ctx.callbackQuery?.message?.photo) {
    return ctx.editMessageCaption(configText, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  }

  await ctx.deleteMessage().catch(() => {});
  return ctx.replyWithMarkdown(configText, keyboard);
};

/**
 * Show QR code image
 */
module.exports.showQrImage = async (ctx, configId) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;

  const configs = await VpnService.getConfigsForUser(user.id);
  const cfg = configs.find((c) => c.id === parseInt(configId, 10));

  if (!cfg || !cfg.qrCode) {
    return ctx.answerCbQuery('⚠️ QR-код недоступен', { show_alert: true });
  }

  const link = String(cfg.config_link || '').trim();
  const isSubscription = link.startsWith('http://') || link.startsWith('https://');

  const configText = buildFullConfigText(cfg);

  const keyboardRows = [];

  if (isSubscription) {
    keyboardRows.push([Markup.button.url('🚀 Открыть в приложении', link)]);
  }

  keyboardRows.push([Markup.button.callback('📋 Скопировать ссылку', `copy_link_${cfg.id}`)]);
  keyboardRows.push([Markup.button.callback('◀️ К списку', 'my_vpn')]);
  keyboardRows.push([Markup.button.callback('🏠 В меню', 'menu')]);

  const keyboard = Markup.inlineKeyboard(keyboardRows);

  const qrBuffer = Buffer.from(cfg.qrCode.split(',')[1], 'base64');

  if (ctx.callbackQuery?.message?.photo) {
    return ctx.editMessageCaption(configText, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  }

  await ctx.deleteMessage().catch(() => {});
  return ctx.replyWithPhoto(
    { source: qrBuffer },
    {
      caption: configText,
      parse_mode: 'Markdown',
      ...keyboard,
    },
  );
};

/**
 * Copy link handler - shows link in alert
 */
module.exports.copyLink = async (ctx, configId) => {
  const user = ctx.state.user;

  const configs = await VpnService.getConfigsForUser(user.id);
  const cfg = configs.find((c) => c.id === parseInt(configId, 10));

  if (!cfg) {
    return ctx.answerCbQuery('⚠️ Конфигурация не найдена', { show_alert: true });
  }

  const link = String(cfg.config_link || '').trim();

  // Show link in alert so user can copy it
  return ctx.answerCbQuery(`Ссылка: ${link}`, { show_alert: true });
};
