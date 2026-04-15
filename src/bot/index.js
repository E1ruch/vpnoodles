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
const referralHandler = require('./handlers/referral');
const paymentHandler = require('./handlers/payment');
const adminHandler = require('./handlers/admin');

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
  bot.action('profile', profileHandler);
  bot.action('referral', referralHandler);

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
