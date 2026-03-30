'use strict';

const { Markup } = require('telegraf');
const Plan = require('../../models/Plan');
const SubscriptionService = require('../../services/SubscriptionService');
const PaymentService = require('../../services/PaymentService');
const VpnService = require('../../services/VpnService');
const logger = require('../../utils/logger');

function formatBytes(bytes) {
  if (!bytes) return 'Безлимит';
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(0)} ГБ`;
}

/**
 * Subscribe handler — shows plans and handles plan selection + payment
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;

  // ── Handle plan purchase ───────────────────────────────────────────────────
  const match = ctx.match;
  if (match && match[1]) {
    const planId = parseInt(match[1], 10);
    return handlePlanPurchase(ctx, user, planId);
  }

  // ── Handle trial activation ────────────────────────────────────────────────
  if (ctx.callbackQuery?.data === 'trial') {
    return handleTrial(ctx, user);
  }

  // ── Show plans list ────────────────────────────────────────────────────────
  const plans = await Plan.findAllPublic();

  if (!plans.length) {
    return ctx.reply('😔 Планы временно недоступны. Попробуйте позже.');
  }

  const planButtons = plans.map((plan) => [
    Markup.button.callback(
      `${plan.name} — ${plan.price_stars}⭐ / ${(plan.price_rub / 100).toFixed(0)}₽`,
      `buy_plan_${plan.id}`,
    ),
  ]);

  planButtons.push([Markup.button.callback('◀️ Назад', 'menu')]);

  const text =
    `💳 *Выберите план подписки*\n\n` +
    plans
      .map(
        (p) =>
          `*${p.name}*\n` +
          `📅 ${p.duration_days} дней\n` +
          `📦 Трафик: ${formatBytes(p.traffic_bytes)}\n` +
          `📱 Устройств: ${p.max_devices}\n` +
          `💰 ${p.price_stars}⭐ / ${(p.price_rub / 100).toFixed(0)}₽\n`,
      )
      .join('\n─────────────\n');

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(planButtons),
    });
  } else {
    await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(planButtons));
  }
};

async function handleTrial(ctx, user) {
  try {
    const sub = await SubscriptionService.activateTrial(user.id);

    if (!sub) {
      return ctx.editMessageText(
        '❌ Вы уже использовали пробный период.\n\nВыберите платный план:',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('💳 Купить подписку', 'subscribe')]]),
        },
      );
    }

    // Provision VPN
    const plan = { duration_days: sub.duration_days || 3, traffic_bytes: sub.traffic_limit_bytes };
    await VpnService.provision(user.id, sub.id, plan).catch((err) =>
      logger.error('VPN provision failed for trial', { error: err.message }),
    );

    await ctx.editMessageText(
      `🎉 *Пробный период активирован!*\n\n` +
        `✅ Доступ открыт на *3 дня*\n\n` +
        `Нажмите "Мой VPN" чтобы получить конфигурацию.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
          [Markup.button.callback('◀️ Меню', 'menu')],
        ]),
      },
    );
  } catch (err) {
    logger.error('Trial activation error', { error: err.message, userId: user.id });
    await ctx.reply('⚠️ Ошибка активации. Попробуйте позже.');
  }
}

async function handlePlanPurchase(ctx, user, planId) {
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  try {
    // Create pending payment
    const payment = await PaymentService.createPending({
      userId: user.id,
      planId: plan.id,
      provider: 'stars',
      amount: plan.price_stars,
      currency: 'XTR',
    });

    // Build and send Stars invoice
    const invoice = await PaymentService.buildStarsInvoice(plan, payment.id);

    await ctx.replyWithInvoice(invoice);
  } catch (err) {
    logger.error('Plan purchase error', { error: err.message, userId: user.id, planId });
    await ctx.reply('⚠️ Ошибка при создании счёта. Попробуйте позже.');
  }
}
