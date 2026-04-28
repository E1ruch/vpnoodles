'use strict';

const { Markup } = require('telegraf');
const VpnService = require('../../services/VpnService');
const SubscriptionService = require('../../services/SubscriptionService');
const Plan = require('../../models/Plan');
const logger = require('../../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Escape special characters for Telegram MarkdownV2
 */
function escapeMarkdown(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format bytes to human-readable
 */
function formatTraffic(bytes) {
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

/**
 * Format days with correct Russian pluralization
 */
function formatDaysLeft(days) {
  if (days === 1) return '1 день';
  if (days >= 2 && days <= 4) return `${days} дня`;
  return `${days} дней`;
}

/**
 * Get server display name (user-friendly)
 */
function getServerName(cfg) {
  // Try to get hostname from subscription URL
  const link = String(cfg.config_link || '').trim();
  if (link.startsWith('http://') || link.startsWith('https://')) {
    try {
      const url = new URL(link);
      if (url.hostname) return url.hostname;
    } catch {
      // Ignore
    }
  }
  // Fallback to tag or generic name
  const tag = String(cfg.server_tag || '').trim();
  if (tag && tag.toLowerCase() !== 'default') return tag;
  return 'VPN';
}

/**
 * Build keyboard for "no subscription" state
 */
function buildNoSubKeyboard(hasTrial) {
  const buttons = [];
  buttons.push([Markup.button.callback('💳 Оформить подписку', 'subscribe')]);
  if (hasTrial) {
    buttons.push([Markup.button.callback('🎁 Попробовать бесплатно', 'trial')]);
  }
  buttons.push([Markup.button.callback('◀️ Меню', 'menu')]);
  return Markup.inlineKeyboard(buttons);
}

/**
 * Build keyboard for "config creating" state
 */
function buildCreatingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Обновить', 'my_vpn')],
    [Markup.button.callback('◀️ Меню', 'menu')],
  ]);
}

/**
 * Build keyboard for "config ready" state
 */
function buildReadyKeyboard(configId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Подключить VPN', `show_qr_${configId}`)],
    [Markup.button.callback('📋 Копировать ссылку', `copy_link_${configId}`)],
    [Markup.button.callback('💳 Продлить подписку', 'subscribe')],
    [Markup.button.callback('◀️ Меню', 'menu')],
  ]);
}

/**
 * Build keyboard for config details view
 */
function buildConfigDetailsKeyboard(configId, hasQr, isSubscription) {
  const buttons = [];

  // Primary action: connect
  if (isSubscription) {
    buttons.push([Markup.button.callback('🚀 Подключить VPN', `show_qr_${configId}`)]);
  }

  // Secondary: copy link
  buttons.push([Markup.button.callback('📋 Копировать ссылку', `copy_link_${configId}`)]);

  // Navigation
  buttons.push([Markup.button.callback('◀️ К подписке', 'my_vpn')]);

  return Markup.inlineKeyboard(buttons);
}

// ── Main Handler ──────────────────────────────────────────────────────────────

/**
 * My VPN handler — shows subscription status and connection options
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const activeSub = await SubscriptionService.getActive(user.id);

  // ── State 1: No active subscription ────────────────────────────────────────
  if (!activeSub) {
    const text =
      `📱 *Мой VPN*\n\n` +
      `❌ У вас нет активной подписки\n\n` +
      `Для доступа к VPN оформите подписку\\.`;

    // Check if user has trial available
    const User = require('../../models/User');
    const hasTrial = !(await User.hasUsedTrial(user.id));

    const keyboard = buildNoSubKeyboard(hasTrial);

    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.message?.photo) {
        return ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
      }
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
    return ctx.replyWithMarkdown(text, keyboard);
  }

  // ── Get configs with self-heal ──────────────────────────────────────────────
  let configs = await VpnService.getConfigsForUser(user.id);

  // Self-heal: if user has active subscription but no VPN config, try to provision
  if (!configs.length && activeSub) {
    logger.info('Self-heal: attempting VPN provision', {
      userId: user.id,
      subscriptionId: activeSub.id,
    });

    try {
      const plan = await Plan.findById(activeSub.plan_id);
      if (plan) {
        await VpnService.provision(user.id, activeSub.id, plan, plan.is_trial || false);
        // Re-fetch configs after provision attempt
        configs = await VpnService.getConfigsForUser(user.id);
        logger.info('Self-heal: provision completed', {
          userId: user.id,
          configsCreated: configs.length,
        });
      }
    } catch (err) {
      logger.error('Self-heal: provision failed', {
        userId: user.id,
        error: err.message,
      });
    }
  }

  // ── State 2: Config creating ───────────────────────────────────────────────
  if (!configs.length) {
    const daysLeft = Math.ceil(
      (new Date(activeSub.expires_at) - new Date()) / (1000 * 60 * 60 * 24),
    );
    const expiresDate = new Date(activeSub.expires_at).toLocaleDateString('ru-RU');

    const text =
      `📱 *Мой VPN*\n\n` +
      `✅ Подписка: до ${expiresDate} \\(${formatDaysLeft(daysLeft)}\\)\n\n` +
      `⏳ *Создаём конфигурацию\\.\\.\\.*\n` +
      `Обычно это занимает 1–2 минуты\\.\n\n` +
      `Нажмите "Обновить" через минуту\\.`;

    const keyboard = buildCreatingKeyboard();

    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.message?.photo) {
        await ctx.deleteMessage().catch(() => {});
        return ctx.replyWithMarkdown(text, keyboard);
      }
      return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
    return ctx.replyWithMarkdown(text, keyboard);
  }

  // ── State 3: Config ready ───────────────────────────────────────────────────
  const daysLeft = Math.ceil((new Date(activeSub.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
  const expiresDate = new Date(activeSub.expires_at).toLocaleDateString('ru-RU');
  const mainConfig = configs[0];
  const snap = mainConfig.panel_snapshot;

  // Build status line
  let statusText = `✅ Подписка: до ${expiresDate} \\(${formatDaysLeft(daysLeft)}\\)`;

  // Add device info if available
  if (snap?.hwidDeviceLimit != null && snap.hwidDeviceLimit > 0) {
    const used = snap.usedDevices || 0;
    statusText += `\n📱 Устройств: ${used} из ${snap.hwidDeviceLimit}`;
  }

  // Add traffic info if available
  if (snap?.usedTrafficBytes != null && snap?.trafficLimitBytes > 0) {
    const used = formatTraffic(snap.usedTrafficBytes);
    const limit = formatTraffic(snap.trafficLimitBytes);
    statusText += `\n📊 Трафик: ${used} / ${limit}`;
  }

  const serverName = escapeMarkdown(getServerName(mainConfig));

  const text =
    `📱 *Мой VPN*\n\n` +
    `${statusText}\n\n` +
    `🔗 *Как подключиться:*\n` +
    `1\\. Нажмите "Подключить VPN"\n` +
    `2\\. Выберите приложение для подключения\n` +
    `3\\. Подтвердите добавление конфигурации\n\n` +
    `💡 Сервер: ${serverName}`;

  const keyboard = buildReadyKeyboard(mainConfig.id);

  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message?.photo) {
      await ctx.deleteMessage().catch(() => {});
      return ctx.replyWithMarkdown(text, keyboard);
    }
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  return ctx.replyWithMarkdown(text, keyboard);
};

// ── Show Config Details (QR/Connect) ──────────────────────────────────────────

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
  const serverName = escapeMarkdown(getServerName(cfg));
  const snap = cfg.panel_snapshot;

  // Build info text
  let infoText = `🖥 *${serverName}*\n\n`;

  if (snap?.hwidDeviceLimit != null && snap.hwidDeviceLimit > 0) {
    infoText += `📱 Устройств: до ${snap.hwidDeviceLimit}\n`;
  }

  if (snap?.usedTrafficBytes != null && snap?.trafficLimitBytes > 0) {
    infoText += `📊 Трафик: ${formatTraffic(snap.usedTrafficBytes)} / ${formatTraffic(snap.trafficLimitBytes)}\n`;
  }

  infoText += `\n💡 Нажмите кнопку ниже для подключения`;

  const keyboardRows = [];

  // Primary: open in app
  if (isSubscription) {
    keyboardRows.push([Markup.button.url('🚀 Открыть в приложении', link)]);
  }

  // Secondary: copy link
  keyboardRows.push([Markup.button.callback('📋 Копировать ссылку', `copy_link_${cfg.id}`)]);

  // Navigation
  keyboardRows.push([Markup.button.callback('◀️ К подписке', 'my_vpn')]);

  const keyboard = Markup.inlineKeyboard(keyboardRows);

  if (ctx.callbackQuery?.message?.photo) {
    return ctx.editMessageCaption(infoText, { parse_mode: 'Markdown', ...keyboard });
  }

  await ctx.deleteMessage().catch(() => {});
  return ctx.replyWithMarkdown(infoText, keyboard);
};

// ── Show QR Code Image ────────────────────────────────────────────────────────

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
  const serverName = escapeMarkdown(getServerName(cfg));

  const text =
    `🖥 *${serverName}*\n\n` +
    `📱 Отсканируйте QR-код в VPN-приложении\n\n` +
    `💡 Или нажмите "Копировать ссылку"`;

  const keyboardRows = [];

  if (isSubscription) {
    keyboardRows.push([Markup.button.url('🚀 Открыть в приложении', link)]);
  }

  keyboardRows.push([Markup.button.callback('📋 Копировать ссылку', `copy_link_${cfg.id}`)]);
  keyboardRows.push([Markup.button.callback('◀️ К подписке', 'my_vpn')]);

  const keyboard = Markup.inlineKeyboard(keyboardRows);
  const qrBuffer = Buffer.from(cfg.qrCode.split(',')[1], 'base64');

  if (ctx.callbackQuery?.message?.photo) {
    return ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
  }

  await ctx.deleteMessage().catch(() => {});
  return ctx.replyWithPhoto(
    { source: qrBuffer },
    { caption: text, parse_mode: 'Markdown', ...keyboard },
  );
};

// ── Copy Link Handler ────────────────────────────────────────────────────────

module.exports.copyLink = async (ctx, configId) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery('📋 Ссылка отправлена ниже');

  const user = ctx.state.user;
  const configs = await VpnService.getConfigsForUser(user.id);
  const cfg = configs.find((c) => c.id === parseInt(configId, 10));

  if (!cfg) {
    return ctx.answerCbQuery('⚠️ Конфигурация не найдена', { show_alert: true });
  }

  const link = String(cfg.config_link || '').trim();

  // Plain text message without Markdown to avoid escaping issues with URLs
  const text =
    `📋 Ваша ссылка для подключения:\n\n` +
    `${link}\n\n` +
    `💡 Скопируйте ссылку выше (долгий тап → Копировать)\n` +
    `Вставьте её в VPN-приложение для подключения.`;

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('◀️ К подписке', 'my_vpn')]]);

  return ctx.reply(text, keyboard);
};
