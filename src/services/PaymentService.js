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

    // 3. Provision VPN
    try {
      await VpnService.provision(payment.user_id, subscription.id, plan);
      await VpnService.enableForUser(payment.user_id);
    } catch (err) {
      logger.error('VPN provisioning failed after payment', {
        paymentId,
        userId: payment.user_id,
        error: err.message,
      });
    }

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
    const payment = await PaymentService.createPending({
      userId,
      planId: plan.id,
      provider: 'cryptopay',
      amount: plan.price_usd,
      currency: asset,
      metadata: { asset },
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
