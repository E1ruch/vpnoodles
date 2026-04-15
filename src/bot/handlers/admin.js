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
    return handleBroadcastStart(ctx);
  }
  if (action === 'admin_find_user') {
    return handleFindUserStart(ctx);
  }
  if (action.startsWith('admin_user_')) {
    return handleUserDetail(ctx, action.replace('admin_user_', ''));
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
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (ctx.callbackQuery.message?.photo) {
      await ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    }
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
    const result = await SubscriptionService.extendByDays(user.id, parseInt(days, 10));
    if (!result) {
      return ctx.reply(`⚠️ У пользователя ${telegramId} нет активной подписки для продления.`);
    }
    await ctx.reply(`✅ Подписка пользователя ${telegramId} продлена на ${days} дней.`);
  } catch (err) {
    logger.error('Admin extend error', { error: err.message });
    await ctx.reply('⚠️ Ошибка при продлении.');
  }
}

async function handleFindUserStart(ctx) {
  await ctx.reply(
    '🔍 *Поиск пользователя*\n\n' + 'Введите Telegram ID или username пользователя:',
    { parse_mode: 'Markdown' },
  );
  // В реальном боте здесь нужно использовать scene или ждать следующего сообщения
  // Пока предлагаем использовать команду /user <id>
  await ctx.reply('💡 Используйте команду: `/user <telegram_id>`\n' + 'Пример: `/user 123456789`', {
    parse_mode: 'Markdown',
  });
}

async function handleUserDetail(ctx, telegramId) {
  try {
    const user = await User.findByTelegramId(parseInt(telegramId, 10));
    if (!user) {
      return ctx.reply('❌ Пользователь не найден.');
    }

    const subscription = await Subscription.findActiveByUserId(user.id);
    const payments = await Payment.findAllByUserId(user.id);
    const totalSpent = payments
      .filter((p) => p.status === 'paid')
      .reduce((sum, p) => sum + p.amount, 0);

    const statusEmoji = user.status === 'banned' ? '🚫' : user.status === 'active' ? '✅' : '⚠️';
    const subInfo = subscription
      ? `📅 Подписка до: *${new Date(subscription.expires_at).toLocaleDateString('ru-RU')}*`
      : '📅 Подписка: *нет*';

    const text =
      `👤 *Информация о пользователе*\n\n` +
      `🆔 Telegram ID: *${user.telegram_id}*\n` +
      `👤 Username: *@${user.username || 'не указан'}*\n` +
      `${statusEmoji} Статус: *${user.status}*\n` +
      `${subInfo}\n` +
      `💰 Всего потрачено: *${(totalSpent / 100).toFixed(2)} ₽*\n` +
      `👥 Рефералов: *${user.referral_count || 0}*\n` +
      `📅 Регистрация: *${new Date(user.created_at).toLocaleDateString('ru-RU')}*`;

    const keyboard = Markup.inlineKeyboard([
      [
        user.status === 'banned'
          ? Markup.button.callback('✅ Разблокировать', `admin_unban_${telegramId}`)
          : Markup.button.callback('🚫 Заблокировать', `admin_ban_${telegramId}`),
      ],
      [
        Markup.button.callback('➕ Продлить 7 дней', `admin_extend_${telegramId}_7`),
        Markup.button.callback('➕ Продлить 30 дней', `admin_extend_${telegramId}_30`),
      ],
      [Markup.button.callback('◀️ Назад', 'admin')],
    ]);

    await ctx.replyWithMarkdown(text, keyboard);
  } catch (err) {
    logger.error('Admin user detail error', { error: err.message });
    await ctx.reply('⚠️ Ошибка при получении информации о пользователе.');
  }
}

async function handleBroadcastStart(ctx) {
  await ctx.reply(
    '📢 *Рассылка пользователям*\n\n' +
      'Для отправки рассылки используйте команду:\n' +
      '`/broadcast <текст сообщения>`\n\n' +
      'Пример:\n' +
      '`/broadcast Привет! У нас новые тарифы.`',
    { parse_mode: 'Markdown' },
  );
}

/**
 * Handle /user command for finding users by telegram ID.
 */
async function handleUserCommand(ctx) {
  if (!ctx.state.isAdmin) return;

  const args = ctx.message.text.split(' ').slice(1);
  const telegramId = args[0];

  if (!telegramId) {
    return ctx.reply('Использование: /user <telegram_id>');
  }

  return handleUserDetail(ctx, telegramId);
}

/**
 * Handle /broadcast command for sending messages to all users.
 */
async function handleBroadcastCommand(ctx) {
  if (!ctx.state.isAdmin) return;

  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) {
    return ctx.reply('Использование: /broadcast <текст сообщения>');
  }

  try {
    const users = await User.listPaginated({ page: 1, limit: 1000, status: 'active' });
    let sent = 0;
    let failed = 0;

    await ctx.reply(`📢 Начинаю рассылку для ${users.length} пользователей...`);

    for (const user of users) {
      try {
        await ctx.telegram.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' });
        sent++;
        // Небольшая задержка чтобы не превысить лимиты Telegram
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        failed++;
      }
    }

    await ctx.reply(`✅ Рассылка завершена!\n📤 Отправлено: ${sent}\n❌ Ошибок: ${failed}`);
    logger.info('Broadcast completed', { sent, failed });
  } catch (err) {
    logger.error('Broadcast error', { error: err.message });
    await ctx.reply('⚠️ Ошибка при рассылке.');
  }
}

// Export additional handlers for command registration
module.exports.handleUserCommand = handleUserCommand;
module.exports.handleBroadcastCommand = handleBroadcastCommand;
