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
  async createPending({ userId, planId, provider, amount, currency }) {
    const payment = await Payment.create({
      userId,
      planId,
      provider,
      amount,
      currency,
    });
    logger.info('Payment created', { paymentId: payment.id, userId, planId, provider });
    return payment;
  },

  /**
   * Handle successful payment:
   * 1. Mark payment as paid
   * 2. Activate/extend subscription
   * 3. Provision VPN config (if new subscription)
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

    // 3. Provision VPN (only for new subscriptions, not extensions)
    try {
      await VpnService.provision(payment.user_id, subscription.id, plan);
      await VpnService.enableForUser(payment.user_id);
    } catch (err) {
      logger.error('VPN provisioning failed after payment', {
        paymentId,
        userId: payment.user_id,
        error: err.message,
      });
      // Non-fatal: subscription is active, VPN can be provisioned manually
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

  /**
   * Handle Telegram Stars payment (pre_checkout_query + successful_payment).
   */
  async handleStarsPayment(ctx) {
    const { successful_payment } = ctx.message;
    const payload = JSON.parse(successful_payment.invoice_payload);

    return PaymentService.handleSuccess({
      paymentId: payload.paymentId,
      providerPaymentId: successful_payment.telegram_payment_charge_id,
    });
  },

  /**
   * Build a Telegram Stars invoice for a plan.
   */
  async buildStarsInvoice(plan, paymentId) {
    return {
      title: `VPN — ${plan.name}`,
      description: `Подписка на ${plan.duration_days} дней. Безлимитный трафик.`,
      payload: JSON.stringify({ paymentId, planId: plan.id }),
      currency: 'XTR',
      prices: [{ label: plan.name, amount: plan.price_stars }],
    };
  },

  async handleFailed(paymentId) {
    await Payment.markFailed(paymentId);
    logger.warn('Payment failed', { paymentId });
  },

  async getHistory(userId) {
    return Payment.findAllByUserId(userId);
  },
};

module.exports = PaymentService;
