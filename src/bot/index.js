'use strict';

const { Telegraf, session } = require('telegraf');
const config = require('../config');
const logger = require('../utils/logger');

// ── Proxy agent (optional) ────────────────────────────────────────────────────
// Set HTTPS_PROXY=http://host:port or SOCKS5_PROXY=socks5://host:port in .env
// to route all Telegram API requests through a proxy.
function createAgent() {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const socksProxy = process.env.SOCKS5_PROXY || process.env.socks5_proxy;

  if (socksProxy) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    logger.info(`🔀 Using SOCKS5 proxy: ${socksProxy}`);
    return new SocksProxyAgent(socksProxy);
  }

  if (httpsProxy) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    logger.info(`🔀 Using HTTPS proxy: ${httpsProxy}`);
    return new HttpsProxyAgent(httpsProxy);
  }

  return undefined;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
const authMiddleware = require('./middleware/auth');
const loggerMiddleware = require('./middleware/logger');
const rateLimitMiddleware = require('./middleware/rateLimit');
const userMiddleware = require('./middleware/user');

// ── Scenes ────────────────────────────────────────────────────────────────────
const { stage } = require('./scenes');

// ── Handlers ──────────────────────────────────────────────────────────────────
const startHandler = require('./handlers/start');
const menuHandler = require('./handlers/menu');
const subscribeHandler = require('./handlers/subscribe');
const myVpnHandler = require('./handlers/myVpn');
const profileHandler = require('./handlers/profile');
const devicesHandler = require('./handlers/devices');
const referralHandler = require('./handlers/referral');
const paymentHandler = require('./handlers/payment');
const adminHandler = require('./handlers/admin');
const helpHandler = require('./handlers/help');

async function createBot() {
  const agent = createAgent();
  const bot = new Telegraf(config.telegram.token, {
    telegram: { agent },
  });

  // ── Session ───────────────────────────────────────────────────────────────
  // We use Telegraf's built-in in-memory session for both dev and prod.
  // Session data is lightweight (scene state only) — Redis is used separately
  // for rate limiting and caching via src/database/redis.js.
  // For multi-instance prod deployments, swap to a custom store below.
  bot.use(session());

  // ── Global middleware (order matters) ─────────────────────────────────────
  bot.use(loggerMiddleware);
  bot.use(rateLimitMiddleware);
  bot.use(userMiddleware);
  bot.use(authMiddleware);
  bot.use(stage.middleware());

  // ── Commands ──────────────────────────────────────────────────────────────
  bot.start(startHandler);
  bot.command('menu', menuHandler);
  bot.command('vpn', myVpnHandler);
  bot.command('profile', profileHandler);
  bot.command('subscribe', subscribeHandler);
  bot.command('referral', referralHandler);
  bot.command('admin', adminHandler);
  bot.command('user', adminHandler.handleUserCommand);
  bot.command('broadcast', adminHandler.handleBroadcastCommand);

  // ── Callback queries ──────────────────────────────────────────────────────
  bot.action('menu', menuHandler);
  bot.action(/^admin/, adminHandler); // Handles admin, admin_stats, admin_broadcast, etc.
  bot.action('subscribe', subscribeHandler);
  bot.action('trial', subscribeHandler); // "Попробовать бесплатно"
  bot.action('my_vpn', myVpnHandler);
  bot.action(/^show_qr_(\d+)$/, async (ctx) => {
    const configId = ctx.match[1];
    return myVpnHandler.showQr(ctx, configId);
  });
  bot.action(/^copy_link_(\d+)$/, async (ctx) => {
    const configId = ctx.match[1];
    return myVpnHandler.copyLink(ctx, configId);
  });
  bot.action(/^show_qr_image_(\d+)$/, async (ctx) => {
    const configId = ctx.match[1];
    return myVpnHandler.showQrImage(ctx, configId);
  });

  // Device management callbacks
  bot.action('my_devices', async (ctx) => {
    await ctx.answerCbQuery();
    return devicesHandler.showDevices(ctx, 1);
  });
  bot.action(/^my_devices_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10);
    return devicesHandler.showDevices(ctx, page);
  });
  bot.action(/^device_info_(.+)$/, async (ctx) => {
    const token = ctx.match[1];
    return devicesHandler.showDeviceInfo(ctx, token);
  });
  bot.action(/^device_delete_confirm_(.+)$/, async (ctx) => {
    const token = ctx.match[1];
    return devicesHandler.confirmDeleteDevice(ctx, token);
  });
  bot.action(/^device_delete_(.+)$/, async (ctx) => {
    const token = ctx.match[1];
    return devicesHandler.deleteDevice(ctx, token);
  });
  bot.action('noop', async (ctx) => {
    // No-op callback for pagination indicator
    await ctx.answerCbQuery();
  });
  bot.action('profile', profileHandler);
  bot.action('profile_payments', profileHandler.showPayments);
  bot.action('referral', referralHandler);
  bot.action('use_bonus_days', referralHandler.handleUseBonusDays);

  // Stars payments
  bot.action(/^buy_plan_(\d+)$/, subscribeHandler);

  // CryptoPay — show plan detail with payment options
  bot.action(/^show_plan_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const planId = parseInt(ctx.match[1], 10);
    return subscribeHandler.showPlanDetail(ctx, planId);
  });

  // CryptoPay — show asset picker
  bot.action(/^buy_crypto_(\d+)$/, subscribeHandler);

  // CryptoPay — handle asset selection
  bot.action(/^crypto_(\d+)_([A-Z]+)$/, subscribeHandler);

  // YooKassa — handle payment initiation
  bot.action(/^buy_yookassa_(\d+)$/, subscribeHandler);

  // YooKassa — handle asset selection
  bot.action(/^check_yookassa_(\d+)$/, subscribeHandler);

  // CryptoPay — manual check payment status
  bot.action(/^check_crypto_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Проверяем оплату...');
    const PaymentService = require('../services/PaymentService');
    try {
      const count = await PaymentService.processCryptoPayPaid();
      if (count > 0) {
        const text = '✅ Оплата подтверждена! Нажмите "Мой VPN" для получения конфигурации.';
        const keyboard = require('telegraf').Markup.inlineKeyboard([
          [require('telegraf').Markup.button.callback('📱 Мой VPN', 'my_vpn')],
        ]);

        // Check if the original message has a photo (QR code) - use editMessageCaption for photos
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
      await ctx.answerCbQuery('⚠️ Ошибка проверки. Попробуйте позже.', { show_alert: true });
    }
  });

  // ── Payment reminder callbacks ──────────────────────────────────────────────
  bot.action(/^remind_pay_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const paymentId = parseInt(ctx.match[1], 10);
    const Payment = require('../models/Payment');

    try {
      const payment = await Payment.findById(paymentId);

      // Check if payment exists and belongs to user
      if (!payment || payment.user_id !== ctx.state.user.id) {
        return ctx.editMessageText('❌ Платёж не найден.', {
          parse_mode: 'Markdown',
          ...require('telegraf').Markup.inlineKeyboard([
            [require('telegraf').Markup.button.callback('◀️ Меню', 'menu')],
          ]),
        });
      }

      // Check payment status
      if (payment.status === 'paid') {
        return ctx.editMessageText('✅ Этот платёж уже был оплачен.', {
          parse_mode: 'Markdown',
          ...require('telegraf').Markup.inlineKeyboard([
            [require('telegraf').Markup.button.callback('📱 Мой VPN', 'my_vpn')],
            [require('telegraf').Markup.button.callback('◀️ Меню', 'menu')],
          ]),
        });
      }

      if (payment.status === 'canceled') {
        return ctx.editMessageText('⏰ Время на оплату истекло. Выберите план заново.', {
          parse_mode: 'Markdown',
          ...require('telegraf').Markup.inlineKeyboard([
            [require('telegraf').Markup.button.callback('💳 Выбрать план', 'subscribe')],
            [require('telegraf').Markup.button.callback('◀️ Меню', 'menu')],
          ]),
        });
      }

      // Payment is still pending - show pending invoice
      return subscribeHandler.showPendingInvoice(ctx, payment);
    } catch (err) {
      logger.error('Failed to handle remind_pay callback', {
        paymentId,
        error: err.message,
      });
      return ctx.editMessageText('⚠️ Ошибка. Попробуйте позже.', {
        parse_mode: 'Markdown',
        ...require('telegraf').Markup.inlineKeyboard([
          [require('telegraf').Markup.button.callback('◀️ Меню', 'menu')],
        ]),
      });
    }
  });

  // ── Cancel payment callback ────────────────────────────────────────────────
  bot.action(/^cancel_payment_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const paymentId = parseInt(ctx.match[1], 10);
    const Payment = require('../models/Payment');
    const { Markup } = require('telegraf');

    try {
      const payment = await Payment.findById(paymentId);

      // Check if payment exists and belongs to user
      if (!payment || payment.user_id !== ctx.state.user.id) {
        return ctx.editMessageText('❌ Платёж не найден.', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Меню', 'menu')]]),
        });
      }

      // Cancel payment if still pending (idempotent)
      const canceled = await Payment.cancelIfPending(paymentId);

      if (canceled) {
        logger.info('Payment canceled by user', { paymentId, userId: ctx.state.user.id });
      }

      return ctx.editMessageText(
        '✅ *Платёж отменён*\n\nВы можете выбрать новый план в любое время.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💳 Выбрать план', 'subscribe')],
            [Markup.button.callback('◀️ Меню', 'menu')],
          ]),
        },
      );
    } catch (err) {
      logger.error('Failed to cancel payment', { paymentId, error: err.message });
      return ctx.editMessageText('⚠️ Ошибка. Попробуйте позже.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Меню', 'menu')]]),
      });
    }
  });

  // ── Pay Stars from pending invoice ──────────────────────────────────────────
  bot.action(/^pay_stars_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const paymentId = parseInt(ctx.match[1], 10);
    const Payment = require('../models/Payment');
    const Plan = require('../models/Plan');
    const PaymentService = require('../services/PaymentService');

    try {
      const payment = await Payment.findById(paymentId);

      // Check if payment exists and belongs to user
      if (!payment || payment.user_id !== ctx.state.user.id) {
        return ctx.reply('❌ Платёж не найден.');
      }

      // Check payment status
      if (payment.status === 'paid') {
        return ctx.reply('✅ Этот платёж уже был оплачен.');
      }

      if (payment.status === 'canceled') {
        return ctx.reply('⏰ Время на оплату истекло. Выберите план заново.', {
          parse_mode: 'Markdown',
          ...require('telegraf').Markup.inlineKeyboard([
            [require('telegraf').Markup.button.callback('💳 Выбрать план', 'subscribe')],
          ]),
        });
      }

      const plan = await Plan.findById(payment.plan_id);
      if (!plan) {
        return ctx.reply('❌ План не найден.');
      }

      // Send Stars invoice
      const invoice = await PaymentService.buildStarsInvoice(plan, payment.id);
      await ctx.replyWithInvoice(invoice);
    } catch (err) {
      logger.error('Failed to pay stars from pending', { paymentId, error: err.message });
      await ctx.reply('⚠️ Ошибка. Попробуйте позже.');
    }
  });

  // Support callback
  bot.action('support', async (ctx) => {
    await ctx.answerCbQuery();
    const supportText =
      config.supportText || 'Для связи с поддержкой напишите @your_support_username';
    return ctx.editMessageText(supportText, {
      parse_mode: 'Markdown',
      ...require('telegraf').Markup.inlineKeyboard([
        [require('telegraf').Markup.button.callback('◀️ Меню', 'menu')],
      ]),
    });
  });

  // Help section callbacks
  bot.action('help', helpHandler);
  bot.action('support_contact', helpHandler.handleSupportContact);
  bot.action('support_group', helpHandler.handleSupportGroup);
  bot.action('support_website', helpHandler.handleSupportWebsite);

  // ── Payments ──────────────────────────────────────────────────────────────
  bot.on('pre_checkout_query', paymentHandler.preCheckout);
  bot.on('successful_payment', paymentHandler.successfulPayment);

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    logger.error('Bot error', {
      error: err.message,
      stack: err.stack,
      updateType: ctx.updateType,
      userId: ctx.from?.id,
    });

    ctx.reply('⚠️ Произошла ошибка. Попробуйте позже или напишите в поддержку.').catch(() => {});
  });

  return bot;
}

module.exports = { createBot };
