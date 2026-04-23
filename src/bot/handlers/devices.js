'use strict';

const SubscriptionService = require('../../services/SubscriptionService');
const VpnService = require('../../services/VpnService');
const { btn } = require('../utils/btn');

/**
 * Escape special characters for Telegram Markdown
 */
function escapeMarkdown(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format device name for display
 */
function formatDeviceName(device, index) {
  const name =
    device.deviceName ||
    device.deviceModel ||
    device.platform ||
    device.hwid?.slice(0, 8) ||
    `Устройство ${index + 1}`;
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
 * Show devices list for user
 */
module.exports.showDevices = async (ctx, page = 1) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;

  // Check for active subscription first
  const activeSub = await SubscriptionService.getActive(user.id);
  if (!activeSub) {
    const text = '❌ У вас нет активной подписки.';
    const inline_keyboard = [
      [btn('Купить подписку', 'subscribe', 'success', '5983399041197675256')], //💳
      [btn('Назад', 'profile', null, '5875082500023258804')], //◀️
    ];
    return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  }

  const result = await VpnService.getDevicesForUser(user.id, { page, size: 5 });

  if (!result) {
    const text =
      `📱 *Мои устройства*\n\n` +
      `⚠️ Не удалось получить информацию об устройствах.\n` +
      `Возможно, VPN панель недоступна.`;
    const inline_keyboard = [
      [btn('Повторить', 'my_devices', 'primary', '5846024087033353251')], //🔄
      [btn('Назад', 'profile', null, '5875082500023258804')], //◀️
    ];
    return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  }

  const { devices, allDevices, limit, used, free, totalPages } = result;

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
        btn(name.slice(0, 20), `device_info_${token}`, null, '5967574255670399788'),
      ]); //📱
    }
  });

  // Pagination buttons
  const paginationRow = [];
  if (page > 1) {
    paginationRow.push(btn('◀️', `my_devices_page_${page - 1}`));
  }
  if (totalPages > 1) {
    paginationRow.push(btn(`${page}/${totalPages}`, 'noop'));
  }
  if (page < totalPages) {
    paginationRow.push(btn('▶️', `my_devices_page_${page + 1}`));
  }
  if (paginationRow.length > 0) {
    keyboardRows.push(paginationRow);
  }

  keyboardRows.push([btn('Назад', 'profile', null, '5875082500023258804')]); //◀️

  return ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboardRows },
  });
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
    const inline_keyboard = [[btn('К списку', 'my_devices', null, '5960551395730919906')]]; //◀️
    return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  }

  const { device } = result;

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

  const inline_keyboard = [
    [btn('Удалить устройство', `device_delete_confirm_${token}`, 'danger', '5879937509579820068')], //🗑
    [btn('К списку', 'my_devices', null, '5960551395730919906')], //◀️
    [btn('В меню', 'menu', null, '5875082500023258804')], //🏠
  ];

  return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
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

  const inline_keyboard = [
    [btn('Да, удалить', `device_delete_${token}`, 'danger', '5879937509579820068')], //🗑
    [btn('Отмена', `device_info_${token}`, null, '5875082500023258804')], //❌
  ];

  return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
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
    const inline_keyboard = [[btn('К списку', 'my_devices', null, '5960551395730919906')]]; //◀️
    return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  }

  // Clear device tokens from session to force refresh
  if (ctx.session?.deviceTokens) {
    delete ctx.session.deviceTokens[token];
  }

  const text =
    `✅ *Устройство удалено*\n\n` +
    `Устройство успешно отключено от VPN.\n` +
    `Список устройств обновлён.`;

  const inline_keyboard = [
    [btn('К списку устройств', 'my_devices', 'primary', '5960551395730919906')], //📱
    [btn('В профиль', 'profile', null, '5920344347152224466')], //👤
  ];

  return ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
};
