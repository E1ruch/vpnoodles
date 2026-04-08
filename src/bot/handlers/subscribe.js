'use strict';

const { Markup } = require('telegraf');
const Plan = require('../../models/Plan');
const SubscriptionService = require('../../services/SubscriptionService');
const PaymentService = require('../../services/PaymentService');
const VpnService = require('../../services/VpnService');
const config = require('../../config');
const logger = require('../../utils/logger');

function formatBytes(bytes) {
  if (!bytes) return 'Безлимит';
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(0)} ГБ`;
}

function formatPrice(plan) {
  const parts = [];
  if (config.payments.starsEnabled && plan.price_stars > 0) {
    parts.push(`${plan.price_stars} ⭐`);
  }
  if (config.payments.cryptoPay.enabled && plan.price_usd > 0) {
    parts.push(`$${(plan.price_usd / 100).toFixed(2)}`);
  }
  return parts.join(' / ') || 'Бесплатно';
}

/**
 * Subscribe handler — shows plans and handles plan selection + payment
 */
module.exports = async (ctx) => {
  if (ctx.callbackQuery) await ctx.answerCbQuery();

  const user = ctx.state.user;
  const data = ctx.callbackQuery?.data || '';

  // ── Handle trial activation ────────────────────────────────────────────────
  if (data === 'trial') {
    return handleTrial(ctx, user);
  }

  // ── Handle crypto asset selection: crypto_<planId>_<asset> ────────────────
  const cryptoMatch = data.match(/^crypto_(\d+)_([A-Z]+)$/);
  if (cryptoMatch) {
    return handleCryptoPayment(ctx, user, parseInt(cryptoMatch[1], 10), cryptoMatch[2]);
  }

  // ── Show crypto asset picker: buy_crypto_<planId> ─────────────────────────
  const cryptoPicker = data.match(/^buy_crypto_(\d+)$/);
  if (cryptoPicker) {
    return showCryptoAssetPicker(ctx, parseInt(cryptoPicker[1], 10));
  }

  // ── Handle Stars plan purchase: buy_plan_<planId> ─────────────────────────
  const planMatch = data.match(/^buy_plan_(\d+)$/);
  if (planMatch) {
    return handlePlanPurchase(ctx, user, parseInt(planMatch[1], 10));
  }

  // ── Show plans list ────────────────────────────────────────────────────────
  const plans = await Plan.findAllPublic();

  if (!plans.length) {
    return ctx.reply('😔 Планы временно недоступны. Попробуйте позже.');
  }

  const planButtons = plans.map((plan) => [
    Markup.button.callback(`${plan.name} — ${formatPrice(plan)}`, `show_plan_${plan.id}`),
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
          `💰 ${formatPrice(p)}\n`,
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

// ── Show plan detail with payment options ──────────────────────────────────

async function showPlanDetail(ctx, planId) {
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  const buttons = [];

  if (config.payments.starsEnabled && plan.price_stars > 0) {
    buttons.push([
      Markup.button.callback(`⭐ Оплатить ${plan.price_stars} Stars`, `buy_plan_${plan.id}`),
    ]);
  }

  if (config.payments.cryptoPay.enabled && plan.price_usd > 0) {
    buttons.push([
      Markup.button.callback(
        `💎 Оплатить криптой ($${(plan.price_usd / 100).toFixed(2)})`,
        `buy_crypto_${plan.id}`,
      ),
    ]);
  }

  buttons.push([Markup.button.callback('◀️ Назад к планам', 'subscribe')]);

  const text =
    `📋 *${plan.name}*\n\n` +
    `📅 Срок: *${plan.duration_days} дней*\n` +
    `📦 Трафик: *${formatBytes(plan.traffic_bytes)}*\n` +
    `📱 Устройств: *${plan.max_devices}*\n\n` +
    `*Выберите способ оплаты:*`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } else {
    await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  }
}

// ── Show crypto asset picker ───────────────────────────────────────────────

async function showCryptoAssetPicker(ctx, planId) {
  const CryptoPayService = require('../../services/CryptoPayService');
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  const assets = CryptoPayService.getSupportedAssets();
  const buttons = assets.map((a) => [
    Markup.button.callback(`${a.name}`, `crypto_${planId}_${a.asset}`),
  ]);
  buttons.push([Markup.button.callback('◀️ Назад', `show_plan_${planId}`)]);

  await ctx.editMessageText(
    `💎 *Оплата криптовалютой*\n\n` +
      `План: *${plan.name}*\n` +
      `Сумма: *$${(plan.price_usd / 100).toFixed(2)}*\n\n` +
      `Выберите валюту:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    },
  );
}

// ── Handle CryptoPay payment ───────────────────────────────────────────────

async function handleCryptoPayment(ctx, user, planId, asset) {
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  try {
    await ctx.editMessageText('⏳ Создаём счёт...');

    const { invoice } = await PaymentService.createCryptoPayInvoice({
      userId: user.id,
      plan,
      asset,
    });

    const invoiceUrl = invoice.bot_invoice_url || invoice.pay_url;

    await ctx.editMessageText(
      `💎 *Счёт на оплату создан*\n\n` +
        `📋 План: *${plan.name}*\n` +
        `💰 Сумма: *${invoice.amount} ${asset}*\n` +
        `⏰ Действует: *1 час*\n\n` +
        `Нажмите кнопку ниже для оплаты через CryptoBot:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url(`💎 Оплатить ${invoice.amount} ${asset}`, invoiceUrl)],
          [Markup.button.callback('🔄 Проверить оплату', `check_crypto_${plan.id}`)],
          [Markup.button.callback('◀️ Отмена', 'subscribe')],
        ]),
      },
    );
  } catch (err) {
    logger.error('CryptoPay invoice creation error', { error: err.message, userId: user.id });
    await ctx.reply('⚠️ Ошибка при создании счёта. Попробуйте позже.');
  }
}

// ── Handle trial activation ────────────────────────────────────────────────

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

// ── Handle Stars plan purchase ─────────────────────────────────────────────

async function handlePlanPurchase(ctx, user, planId) {
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  try {
    const payment = await PaymentService.createPending({
      userId: user.id,
      planId: plan.id,
      provider: 'stars',
      amount: plan.price_stars,
      currency: 'XTR',
    });

    const invoice = await PaymentService.buildStarsInvoice(plan, payment.id);
    await ctx.replyWithInvoice(invoice);
  } catch (err) {
    logger.error('Plan purchase error', { error: err.message, userId: user.id, planId });
    await ctx.reply('⚠️ Ошибка при создании счёта. Попробуйте позже.');
  }
}

// Export showPlanDetail for bot/index.js action registration
module.exports.showPlanDetail = showPlanDetail;
