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
 * Format device name for display
 */
function formatDeviceName(device, index) {
  const name = device.deviceName || device.hwid?.slice(0, 8) || `Устройство ${index + 1}`;
  return escapeMarkdown(name);
}

/**
 * Format device last connected date
 */
function formatLastConnected(dateStr) {
  if (!dateStr) return 'неизвестно';
  try {
    const date = new Date(dateStr);
    return (
      date.toLocaleDateString('ru-RU') +
      ' ' +
      date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    );
  } catch {
    return 'неизвестно';
  }
}

/**
 * Store device tokens in session for callback routing
 * (HWID can be longer than 64 bytes, so we use short tokens)
 */
function storeDeviceTokens(ctx, devices) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.deviceTokens) ctx.session.deviceTokens = {};

  devices.forEach((device, index) => {
    const token = `${index}_${Date.now().toString(36)}`;
    ctx.session.deviceTokens[token] = device.hwid;
  });

  return ctx.session.deviceTokens;
}

/**
 * Get HWID from token stored in session
 */
function getHwidFromToken(ctx, token) {
  return ctx.session?.deviceTokens?.[token] || null;
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
    [Markup.button.callback('📱 Мои устройства', 'my_devices')],
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

/**
 * Show devices list for user
 */
module.exports.showDevices = async (ctx, page = 1) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;

  // Check for active subscription first
  const activeSub = await SubscriptionService.getActive(user.id);
  if (!activeSub) {
    const text = '❌ У вас нет активной подписки.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💳 Купить подписку', 'subscribe')],
      [Markup.button.callback('◀️ Назад', 'my_vpn')],
    ]);
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  const result = await VpnService.getDevicesForUser(user.id, { page, size: 5 });

  if (!result) {
    const text =
      `📱 *Мои устройства*\n\n` +
      `⚠️ Не удалось получить информацию об устройствах.\n` +
      `Возможно, VPN панель недоступна.`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Повторить', 'my_devices')],
      [Markup.button.callback('◀️ Назад', 'my_vpn')],
    ]);
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  const { devices, allDevices, limit, used, free, totalPages, userUuid } = result;

  // Store device tokens in session for callback routing
  storeDeviceTokens(ctx, allDevices);

  // Build message text
  let text =
    `📱 *Мои устройства*\n\n` +
    `📊 Лимит устройств: *${limit === 0 ? 'Без ограничений' : limit}*\n` +
    `✅ Подключено: *${used}*\n` +
    `🆓 Свободно: *${limit === 0 ? '∞' : free}*\n\n`;

  if (devices.length === 0) {
    text += `📭 Устройств пока нет.\n\nПодключите первое устройство через VPN клиент.`;
  } else {
    text += `📋 *Список устройств:*\n`;

    devices.forEach((device, index) => {
      const globalIndex = (page - 1) * 5 + index;
      const name = formatDeviceName(device, globalIndex);
      const lastSeen = formatLastConnected(device.lastConnected);
      text += `\n${globalIndex + 1}\\. ${name}\n   _Последняя активность: ${lastSeen}_`;
    });
  }

  // Build keyboard with device buttons
  const keyboardRows = [];

  // Device buttons (one per device)
  devices.forEach((device, index) => {
    const globalIndex = (page - 1) * 5 + index;
    const token = Object.keys(ctx.session.deviceTokens || {}).find(
      (t) => ctx.session.deviceTokens[t] === device.hwid,
    );
    if (token) {
      const name =
        device.deviceName || device.hwid?.slice(0, 12) || `Устройство ${globalIndex + 1}`;
      keyboardRows.push([
        Markup.button.callback(`📱 ${name.slice(0, 20)}`, `device_info_${token}`),
      ]);
    }
  });

  // Pagination buttons
  const paginationRow = [];
  if (page > 1) {
    paginationRow.push(Markup.button.callback('◀️', `my_devices_page_${page - 1}`));
  }
  if (totalPages > 1) {
    paginationRow.push(Markup.button.callback(`${page}/${totalPages}`, 'noop'));
  }
  if (page < totalPages) {
    paginationRow.push(Markup.button.callback('▶️', `my_devices_page_${page + 1}`));
  }
  if (paginationRow.length > 0) {
    keyboardRows.push(paginationRow);
  }

  keyboardRows.push([Markup.button.callback('◀️ Назад', 'my_vpn')]);

  const keyboard = Markup.inlineKeyboard(keyboardRows);

  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
};

/**
 * Show device details
 */
module.exports.showDeviceInfo = async (ctx, token) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const hwid = getHwidFromToken(ctx, token);

  if (!hwid) {
    return ctx.answerCbQuery('⚠️ Информация об устройстве устарела. Обновите список.', {
      show_alert: true,
    });
  }

  const result = await VpnService.getDeviceByHwidForUser(user.id, hwid);

  if (!result) {
    const text = '⚠️ Устройство не найдено или не принадлежит вам.';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('◀️ К списку', 'my_devices')]]);
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  const { device, limit } = result;

  const name = formatDeviceName(device, 0);
  const lastSeen = formatLastConnected(device.lastConnected);
  const created = formatLastConnected(device.createdAt);

  const text =
    `📱 *Устройство*\n\n` +
    `📛 Название: *${name}*\n` +
    `🆔 ID: \`${escapeMarkdown(device.hwid?.slice(0, 16) || 'N/A')}...\`\n` +
    `📅 Подключено: ${created}\n` +
    `🕐 Последняя активность: ${lastSeen}\n` +
    (device.ip ? `🌐 IP: \`${escapeMarkdown(device.ip)}\`\n` : '') +
    `\n` +
    `⚠️ Удаление устройства отключит его от VPN.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🗑 Удалить устройство', `device_delete_confirm_${token}`)],
    [Markup.button.callback('◀️ К списку', 'my_devices')],
    [Markup.button.callback('🏠 В меню', 'menu')],
  ]);

  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
};

/**
 * Confirm device deletion
 */
module.exports.confirmDeleteDevice = async (ctx, token) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const hwid = getHwidFromToken(ctx, token);

  if (!hwid) {
    return ctx.answerCbQuery('⚠️ Информация об устройстве устарела. Обновите список.', {
      show_alert: true,
    });
  }

  const text =
    `🗑 *Удаление устройства*\n\n` +
    `⚠️ Вы уверены, что хотите удалить это устройство?\n\n` +
    `После удаления устройство будет отключено от VPN и потребуется повторное подключение.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Да, удалить', `device_delete_${token}`)],
    [Markup.button.callback('❌ Отмена', `device_info_${token}`)],
  ]);

  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
};

/**
 * Delete device
 */
module.exports.deleteDevice = async (ctx, token) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const hwid = getHwidFromToken(ctx, token);

  if (!hwid) {
    return ctx.answerCbQuery('⚠️ Информация об устройстве устарела. Обновите список.', {
      show_alert: true,
    });
  }

  const result = await VpnService.deleteDeviceForUser(user.id, hwid);

  if (!result.success) {
    const text = `❌ *Ошибка*\n\n${result.error || 'Не удалось удалить устройство.'}`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('◀️ К списку', 'my_devices')]]);
    return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  }

  // Clear device tokens from session to force refresh
  if (ctx.session?.deviceTokens) {
    delete ctx.session.deviceTokens[token];
  }

  const text =
    `✅ *Устройство удалено*\n\n` +
    `Устройство успешно отключено от VPN.\n` +
    `Список устройств обновлён.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📱 К списку устройств', 'my_devices')],
    [Markup.button.callback('◀️ Мой VPN', 'my_vpn')],
  ]);

  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
};
