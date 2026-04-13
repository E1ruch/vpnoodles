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
  if (plan.price_rub > 0) {
    parts.push(`${(plan.price_rub / 100).toFixed(0)} ₽`);
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

  // ── Handle YooKassa payment: buy_yookassa_<planId> ───────────────────────
  const yookassaMatch = data.match(/^buy_yookassa_(\d+)$/);
  if (yookassaMatch) {
    return handleYooKassaPayment(ctx, user, parseInt(yookassaMatch[1], 10));
  }

  // ── Handle YooKassa check: check_yookassa_<planId> ───────────────────────
  const yookassaCheckMatch = data.match(/^check_yookassa_(\d+)$/);
  if (yookassaCheckMatch) {
    return handleYooKassaCheck(ctx, user, parseInt(yookassaCheckMatch[1], 10));
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
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (ctx.callbackQuery.message?.photo) {
      await ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(planButtons),
      });
    } else {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(planButtons),
      });
    }
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

  if (config.payments.yookassa.enabled && plan.price_rub > 0) {
    buttons.push([
      Markup.button.callback(
        `💳 Оплатить картой (${(plan.price_rub / 100).toFixed(0)} ₽)`,
        `buy_yookassa_${plan.id}`,
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
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (ctx.callbackQuery.message?.photo) {
      await ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } else {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    }
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

  const text =
    `💎 *Оплата криптовалютой*\n\n` +
    `План: *${plan.name}*\n` +
    `Сумма: *$${(plan.price_usd / 100).toFixed(2)}*\n\n` +
    `Выберите валюту:`;

  // Check if the original message has a photo (QR code) - use editMessageCaption for photos
  if (ctx.callbackQuery?.message?.photo) {
    await ctx.editMessageCaption(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } else {
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

// ── Handle CryptoPay payment ───────────────────────────────────────────────

async function handleCryptoPayment(ctx, user, planId, asset) {
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  const hasPhoto = ctx.callbackQuery?.message?.photo;

  try {
    // Check if the original message has a photo (QR code) - use editMessageCaption for photos
    if (hasPhoto) {
      await ctx.editMessageCaption('⏳ Создаём счёт...');
    } else {
      await ctx.editMessageText('⏳ Создаём счёт...');
    }

    const { invoice } = await PaymentService.createCryptoPayInvoice({
      userId: user.id,
      plan,
      asset,
    });

    const invoiceUrl = invoice.bot_invoice_url || invoice.pay_url;

    const text =
      `💎 *Счёт на оплату создан*\n\n` +
      `📋 План: *${plan.name}*\n` +
      `💰 Сумма: *${invoice.amount} ${asset}*\n` +
      `⏰ Действует: *1 час*\n\n` +
      `Нажмите кнопку ниже для оплаты через CryptoBot:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url(`💎 Оплатить ${invoice.amount} ${asset}`, invoiceUrl)],
      [Markup.button.callback('🔄 Проверить оплату', `check_crypto_${plan.id}`)],
      [Markup.button.callback('◀️ Отмена', 'subscribe')],
    ]);

    // After first edit, message is now text-only, so use editMessageText
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  } catch (err) {
    logger.error('CryptoPay invoice creation error', { error: err.message, userId: user.id });
    await ctx.reply('⚠️ Ошибка при создании счёта. Попробуйте позже.');
  }
}

// ── Handle trial activation ────────────────────────────────────────────────

async function handleTrial(ctx, user) {
  try {
    const sub = await SubscriptionService.activateTrial(user.id);

    const hasPhoto = ctx.callbackQuery?.message?.photo;

    if (!sub) {
      const text = '❌ Вы уже использовали пробный период.\n\nВыберите платный план:';
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 Купить подписку', 'subscribe')],
      ]);

      if (hasPhoto) {
        return ctx.editMessageCaption(text, {
          parse_mode: 'Markdown',
          ...keyboard,
        });
      }
      return ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
    }

    const trialPlan = await Plan.findTrial();
    const plan = trialPlan
      ? {
          ...trialPlan,
          duration_days: sub.duration_days ?? trialPlan.duration_days,
          traffic_bytes: sub.traffic_limit_bytes ?? trialPlan.traffic_bytes,
        }
      : { duration_days: sub.duration_days || 7, traffic_bytes: sub.traffic_limit_bytes };

    // isTrial=true → assigns TRIAL_REMNAWAVE_TAG in Remnawave panel
    await VpnService.provision(user.id, sub.id, plan, true);

    const days = plan.duration_days || 7;
    const text =
      `🎉 *Пробный период активирован!*\n\n` +
      `✅ Доступ открыт на *${days} дней*\n\n` +
      `Нажмите "Мой VPN" чтобы получить конфигурацию.`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
      [Markup.button.callback('◀️ Меню', 'menu')],
    ]);

    if (hasPhoto) {
      await ctx.editMessageCaption(text, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
    } else {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...keyboard,
      });
    }
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

// ── Handle YooKassa payment ────────────────────────────────────────────────

async function handleYooKassaPayment(ctx, user, planId) {
  const plan = await Plan.findById(planId);
  if (!plan) return ctx.reply('❌ План не найден.');

  const hasPhoto = ctx.callbackQuery?.message?.photo;

  try {
    if (hasPhoto) {
      await ctx.editMessageCaption('⏳ Создаём счёт...');
    } else {
      await ctx.editMessageText('⏳ Создаём счёт...');
    }

    // Build return URL - redirect back to bot after payment
    const returnUrl = config.telegram.webhookDomain
      ? `${config.telegram.webhookDomain}/payment/success`
      : `https://t.me/${config.telegram.username}`;

    const { confirmationUrl } = await PaymentService.createYooKassaPayment({
      userId: user.id,
      plan,
      returnUrl,
    });

    if (!confirmationUrl) {
      throw new Error('Failed to get confirmation URL from YooKassa');
    }

    const text =
      `💳 *Оплата банковской картой*\n\n` +
      `📋 План: *${plan.name}*\n` +
      `💰 Сумма: *${(plan.price_rub / 100).toFixed(0)} ₽*\n\n` +
      `Нажмите кнопку ниже для перехода к оплате:`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url(`💳 Оплатить ${(plan.price_rub / 100).toFixed(0)} ₽`, confirmationUrl)],
      [Markup.button.callback('🔄 Проверить оплату', `check_yookassa_${plan.id}`)],
      [Markup.button.callback('◀️ Отмена', 'subscribe')],
    ]);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  } catch (err) {
    logger.error('YooKassa payment creation error', { error: err.message, userId: user.id });
    await ctx.reply('⚠️ Ошибка при создании счёта. Попробуйте позже.');
  }
}

// ── Handle YooKassa payment check ──────────────────────────────────────────

async function handleYooKassaCheck(ctx, user, planId) {
  await ctx.answerCbQuery('Проверяем оплату...');

  try {
    const count = await PaymentService.processYooKassaPaid();

    if (count > 0) {
      const text = '✅ Оплата подтверждена! Нажмите "Мой VPN" для получения конфигурации.';
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('📱 Мой VPN', 'my_vpn')]]);

      if (ctx.callbackQuery?.message?.photo) {
        await ctx.editMessageCaption(text, { parse_mode: 'Markdown', ...keyboard });
      } else {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
      }
    } else {
      await ctx.answerCbQuery('⏳ Оплата ещё не поступила. Попробуйте через минуту.', {
        show_alert: true,
      });
    }
  } catch (err) {
    logger.error('YooKassa check error', { error: err.message, userId: user.id });
    await ctx.answerCbQuery('⚠️ Ошибка проверки. Попробуйте позже.', { show_alert: true });
  }
}

// Export showPlanDetail for bot/index.js action registration
module.exports.showPlanDetail = showPlanDetail;
