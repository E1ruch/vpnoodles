'use strict';

const Payment = require('../models/Payment');
const SubscriptionService = require('./SubscriptionService');
const VpnService = require('./VpnService');
const UserService = require('./UserService');
const Plan = require('../models/Plan');
const logger = require('../utils/logger');

const PaymentService = {
  /**
   * Create a pending payment record before sending invoice.
   */
  async createPending({ userId, planId, provider, amount, currency, metadata = {} }) {
    const payment = await Payment.create({
      userId,
      planId,
      provider,
      amount,
      currency,
      metadata,
    });
    logger.info('Payment created', { paymentId: payment.id, userId, planId, provider });
    return payment;
  },

  /**
   * Handle successful payment:
   * 1. Mark payment as paid
   * 2. Activate/extend subscription
   * 3. Provision VPN config
   * 4. Apply referral bonus
   */
  async handleSuccess({ paymentId, providerPaymentId }) {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw new Error(`Payment ${paymentId} not found`);
    if (payment.status === 'paid') {
      logger.warn('Payment already processed', { paymentId });
      return null;
    }

    // 1. Mark paid
    await Payment.markPaid(paymentId, providerPaymentId);

    // 2. Activate subscription
    const plan = await Plan.findById(payment.plan_id);
    const subscription = await SubscriptionService.activate(payment.user_id, plan.id);

    // If this user had deferred referral bonuses (no active sub earlier), apply them now.
    await UserService.applyPendingReferralBonusesForReferrer(payment.user_id);

    // 3. Provision VPN (errors are logged inside provision; does not throw)
    await VpnService.provision(payment.user_id, subscription.id, plan);
    await VpnService.enableForUser(payment.user_id);

    // 4. Apply referral bonus (first payment only)
    await UserService.applyReferralBonus(payment.user_id);

    logger.info('Payment handled successfully', {
      paymentId,
      userId: payment.user_id,
      subscriptionId: subscription.id,
    });

    return { payment, subscription };
  },

  // ── Telegram Stars ─────────────────────────────────────────────────────────

  async handleStarsPayment(ctx) {
    const { successful_payment } = ctx.message;
    const payload = JSON.parse(successful_payment.invoice_payload);

    return PaymentService.handleSuccess({
      paymentId: payload.paymentId,
      providerPaymentId: successful_payment.telegram_payment_charge_id,
    });
  },

  async buildStarsInvoice(plan, paymentId) {
    return {
      title: `VPN — ${plan.name}`,
      description: `Подписка на ${plan.duration_days} дней. Безлимитный трафик.`,
      payload: JSON.stringify({ paymentId, planId: plan.id }),
      currency: 'XTR',
      prices: [{ label: plan.name, amount: plan.price_stars }],
    };
  },

  // ── CryptoPay (CryptoBot) ──────────────────────────────────────────────────

  /**
   * Create a CryptoPay invoice for a plan.
   * @param {object} opts
   * @param {number} opts.userId
   * @param {object} opts.plan
   * @param {string} opts.asset  - crypto asset, e.g. 'USDT'
   */
  async createCryptoPayInvoice({ userId, plan, asset = 'USDT' }) {
    const CryptoPayService = require('./CryptoPayService');

    const amount = CryptoPayService.formatAmount(plan.price_usd, asset);

    // Create pending payment record first
    // Note: amount column is integer (cents), so we store plan.price_usd there
    // Real crypto amount is stored in metadata for display
    const payment = await PaymentService.createPending({
      userId,
      planId: plan.id,
      provider: 'cryptopay',
      amount: plan.price_usd, // in cents (integer)
      currency: asset,
      metadata: { asset, displayAmount: amount }, // real amount for display
    });

    const invoice = await CryptoPayService.createInvoice({
      asset,
      amount,
      description: `VPNoodles — ${plan.name} (${plan.duration_days} дней)`,
      payload: JSON.stringify({ paymentId: payment.id, planId: plan.id, userId }),
      expiresIn: 3600, // 1 hour
    });

    // Save invoice ID to payment metadata for polling
    await Payment.update(payment.id, {
      provider_payment_id: String(invoice.invoice_id),
      metadata: JSON.stringify({
        asset,
        displayAmount: amount, // real amount for display (e.g. "1.99")
        invoiceId: invoice.invoice_id,
        invoiceUrl: invoice.bot_invoice_url,
      }),
    });

    logger.info('CryptoPay invoice created', {
      paymentId: payment.id,
      invoiceId: invoice.invoice_id,
      asset,
      amount,
    });

    return { payment, invoice };
  },

  /**
   * Poll CryptoPay for paid invoices and process them.
   * Called by cron every minute.
   * @returns {number} count of processed payments
   */
  async processCryptoPayPaid() {
    const CryptoPayService = require('./CryptoPayService');
    if (!CryptoPayService.enabled) return 0;

    // Get all pending cryptopay payments from DB
    const pendingPayments = await Payment.findPendingByProvider('cryptopay');
    if (!pendingPayments.length) return 0;

    const invoiceIds = pendingPayments
      .map((p) => {
        try {
          return parseInt(p.provider_payment_id, 10);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (!invoiceIds.length) return 0;

    // Fetch paid invoices from CryptoPay
    let paidInvoices;
    try {
      const result = await CryptoPayService.getInvoices('paid', invoiceIds);
      paidInvoices = result.items || [];
    } catch (err) {
      logger.error('CryptoPay poll failed', { error: err.message });
      return 0;
    }

    let processed = 0;
    for (const invoice of paidInvoices) {
      const payment = pendingPayments.find(
        (p) => p.provider_payment_id === String(invoice.invoice_id),
      );
      if (!payment) continue;

      try {
        await PaymentService.handleSuccess({
          paymentId: payment.id,
          providerPaymentId: String(invoice.invoice_id),
        });
        processed++;
        logger.info('CryptoPay invoice processed', {
          invoiceId: invoice.invoice_id,
          paymentId: payment.id,
        });
      } catch (err) {
        logger.error('CryptoPay invoice processing failed', {
          invoiceId: invoice.invoice_id,
          error: err.message,
        });
      }
    }

    return processed;
  },

  // ── YooKassa ──────────────────────────────────────────────────────────────

  /**
   * Create a YooKassa payment for a plan.
   * @param {object} opts
   * @param {number} opts.userId
   * @param {object} opts.plan
   * @param {string} opts.returnUrl - URL to redirect after payment
   */
  async createYooKassaPayment({ userId, plan, returnUrl }) {
    const YooKassaService = require('./YooKassaService');

    if (!YooKassaService.enabled) {
      throw new Error('YooKassa is not configured');
    }

    const amount = YooKassaService.formatAmount(plan.price_rub);

    // Create pending payment record first
    const payment = await PaymentService.createPending({
      userId,
      planId: plan.id,
      provider: 'yookassa',
      amount: plan.price_rub,
      currency: 'RUB',
      metadata: {},
    });

    const yooPayment = await YooKassaService.createPayment({
      amount,
      description: `VPNoodles — ${plan.name} (${plan.duration_days} дней)`,
      metadata: { paymentId: payment.id, planId: plan.id, userId },
      returnUrl,
    });

    // Save YooKassa payment ID to payment record
    await Payment.update(payment.id, {
      provider_payment_id: yooPayment.id,
      metadata: JSON.stringify({
        yookassaPaymentId: yooPayment.id,
        status: yooPayment.status,
      }),
    });

    const confirmationUrl = YooKassaService.getConfirmationUrl(yooPayment);

    logger.info('YooKassa payment created', {
      paymentId: payment.id,
      yookassaPaymentId: yooPayment.id,
      amount,
      confirmationUrl,
    });

    return { payment, yooPayment, confirmationUrl };
  },

  /**
   * Handle YooKassa webhook notification.
   * @param {object} payload - webhook payload from YooKassa
   * @returns {object|null} - { payment, subscription } or null if already processed
   */
  async handleYooKassaWebhook(payload) {
    const YooKassaService = require('./YooKassaService');

    const { type, payment: yooPayment } = YooKassaService.parseWebhookEvent(payload);

    if (type !== 'payment.succeeded') {
      logger.info('YooKassa webhook ignored', { type, paymentId: yooPayment?.id });
      return null;
    }

    const metadata = yooPayment.metadata || {};
    const paymentId = metadata.paymentId;

    if (!paymentId) {
      logger.error('YooKassa webhook missing paymentId in metadata', {
        yookassaPaymentId: yooPayment.id,
      });
      return null;
    }

    const result = await PaymentService.handleSuccess({
      paymentId,
      providerPaymentId: yooPayment.id,
    });

    if (result) {
      logger.info('YooKassa webhook processed', {
        paymentId,
        yookassaPaymentId: yooPayment.id,
        userId: result.payment.user_id,
      });
    }

    return result;
  },

  /**
   * Poll YooKassa for pending payments (fallback if webhook fails).
   * Called by cron every minute.
   * @returns {number} count of processed payments
   */
  async processYooKassaPaid() {
    const YooKassaService = require('./YooKassaService');
    if (!YooKassaService.enabled) return 0;

    // Get all pending yookassa payments from DB
    const pendingPayments = await Payment.findPendingByProvider('yookassa');
    if (!pendingPayments.length) return 0;

    let processed = 0;

    for (const payment of pendingPayments) {
      try {
        // Knex may return metadata as object (auto-parsed JSON) or string
        const metadata =
          typeof payment.metadata === 'string'
            ? JSON.parse(payment.metadata)
            : payment.metadata || {};
        const yookassaPaymentId = payment.provider_payment_id || metadata.yookassaPaymentId;

        if (!yookassaPaymentId) continue;

        const yooPayment = await YooKassaService.getPayment(yookassaPaymentId);

        if (yooPayment.status === 'succeeded') {
          await PaymentService.handleSuccess({
            paymentId: payment.id,
            providerPaymentId: yookassaPaymentId,
          });
          processed++;
          logger.info('YooKassa payment processed via polling', {
            paymentId: payment.id,
            yookassaPaymentId,
          });
        } else if (yooPayment.status === 'canceled') {
          await PaymentService.handleFailed(payment.id);
          logger.info('YooKassa payment canceled', { paymentId: payment.id });
        }
      } catch (err) {
        logger.error('YooKassa polling error for payment', {
          paymentId: payment.id,
          error: err.message,
        });
      }
    }

    return processed;
  },

  // ── Common ─────────────────────────────────────────────────────────────────

  async handleFailed(paymentId) {
    await Payment.markFailed(paymentId);
    logger.warn('Payment failed', { paymentId });
  },

  async getHistory(userId) {
    return Payment.findAllByUserId(userId);
  },
};

module.exports = PaymentService;
