'use strict';

const { Markup } = require('telegraf');
const User = require('../../models/User');
const Subscription = require('../../models/Subscription');
const Payment = require('../../models/Payment');
const VpnService = require('../../services/VpnService');
const SubscriptionService = require('../../services/SubscriptionService');
const UserService = require('../../services/UserService');
const logger = require('../../utils/logger');

/**
 * Admin panel handler.
 * Only accessible to users listed in ADMIN_IDS.
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  if (!ctx.state.isAdmin) {
    return ctx.reply('🚫 Доступ запрещён.');
  }

  const action = ctx.callbackQuery?.data || '';

  // ── Route admin actions ────────────────────────────────────────────────────
  if (action.startsWith('admin_ban_')) {
    return handleBan(ctx, action.replace('admin_ban_', ''));
  }
  if (action.startsWith('admin_unban_')) {
    return handleUnban(ctx, action.replace('admin_unban_', ''));
  }
  if (action.startsWith('admin_extend_')) {
    return handleExtend(ctx, action.replace('admin_extend_', ''));
  }
  if (action === 'admin_stats') {
    return handleStats(ctx);
  }
  if (action === 'admin_broadcast') {
    return ctx.reply('📢 Функция рассылки: введите текст командой /broadcast <текст>');
  }

  // ── Default: show admin menu ───────────────────────────────────────────────
  return showAdminMenu(ctx);
};

async function showAdminMenu(ctx) {
  const [userCount, activeSubCount, revenueRub] = await Promise.all([
    User.count(),
    Subscription.countActive(),
    Payment.totalRevenue('RUB'),
  ]);

  const text =
    `🛠 *Панель администратора*\n\n` +
    `👥 Пользователей: *${userCount}*\n` +
    `✅ Активных подписок: *${activeSubCount}*\n` +
    `💰 Выручка (RUB): *${(revenueRub / 100).toFixed(2)} ₽*\n\n` +
    `Выберите действие:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', 'admin_stats')],
    [Markup.button.callback('📢 Рассылка', 'admin_broadcast')],
    [Markup.button.callback('🔍 Найти пользователя', 'admin_find_user')],
    [Markup.button.callback('◀️ Меню', 'menu')],
  ]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.replyWithMarkdown(text, keyboard);
  }
}

async function handleStats(ctx) {
  const [userCount, activeSubCount, revenueRub, revenueStars] = await Promise.all([
    User.count(),
    Subscription.countActive(),
    Payment.totalRevenue('RUB'),
    Payment.totalRevenue('XTR'),
  ]);

  let vpnStats = {};
  try {
    vpnStats = (await VpnService.getSystemStats()) || {};
  } catch {
    vpnStats = { error: 'Panel unavailable' };
  }

  const text =
    `📊 *Детальная статистика*\n\n` +
    `👥 Всего пользователей: *${userCount}*\n` +
    `✅ Активных подписок: *${activeSubCount}*\n\n` +
    `💰 *Выручка:*\n` +
    `  • RUB: *${(revenueRub / 100).toFixed(2)} ₽*\n` +
    `  • Stars: *${revenueStars} ⭐*\n\n` +
    `🖥 *VPN Panel:*\n` +
    `\`${JSON.stringify(vpnStats, null, 2).slice(0, 300)}\``;

  await ctx.replyWithMarkdown(
    text,
    Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'admin')]]),
  );
}

async function handleBan(ctx, telegramId) {
  try {
    const user = await User.findByTelegramId(parseInt(telegramId, 10));
    if (!user) return ctx.reply('❌ Пользователь не найден.');
    await UserService.ban(user.id);
    await ctx.reply(`✅ Пользователь ${telegramId} заблокирован.`);
  } catch (err) {
    logger.error('Admin ban error', { error: err.message });
    await ctx.reply('⚠️ Ошибка при блокировке.');
  }
}

async function handleUnban(ctx, telegramId) {
  try {
    const user = await User.findByTelegramId(parseInt(telegramId, 10));
    if (!user) return ctx.reply('❌ Пользователь не найден.');
    await UserService.unban(user.id);
    await ctx.reply(`✅ Пользователь ${telegramId} разблокирован.`);
  } catch (err) {
    logger.error('Admin unban error', { error: err.message });
    await ctx.reply('⚠️ Ошибка при разблокировке.');
  }
}

async function handleExtend(ctx, params) {
  // Format: telegramId_days
  const [telegramId, days] = params.split('_');
  try {
    const user = await User.findByTelegramId(parseInt(telegramId, 10));
    if (!user) return ctx.reply('❌ Пользователь не найден.');
    await SubscriptionService.extendByDays(user.id, parseInt(days, 10));
    await ctx.reply(`✅ Подписка пользователя ${telegramId} продлена на ${days} дней.`);
  } catch (err) {
    logger.error('Admin extend error', { error: err.message });
    await ctx.reply('⚠️ Ошибка при продлении.');
  }
}
