'use strict';

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * YooKassa integration.
 * Docs: https://yookassa.ru/developers/api
 *
 * Flow:
 *  1. createPayment() → get confirmation URL → send to user
 *  2. YooKassa sends webhook to /webhook/yookassa when payment succeeds
 *  3. On webhook → handleSuccess() → activate subscription
 */
class YooKassaService {
  constructor() {
    this.shopId = config.payments.yookassa.shopId;
    this.secretKey = config.payments.yookassa.secretKey;
    this.enabled = !!(this.shopId && this.secretKey);
    this.baseUrl = 'https://api.yookassa.ru/v3';

    if (this.enabled) {
      this._http = axios.create({
        baseURL: this.baseUrl,
        timeout: 30000,
        auth: {
          username: this.shopId,
          password: this.secretKey,
        },
        headers: {
          'Content-Type': 'application/json',
          'Idempotence-Key': '', // Will be set per request
        },
      });
    }
  }

  // ── Internal request helper ────────────────────────────────────────────────

  async _request(method, endpoint, params = {}, idempotenceKey = null) {
    if (!this.enabled) {
      throw new Error('YooKassa is not configured');
    }

    try {
      const res = await this._http({
        method,
        url: endpoint,
        params: method === 'GET' ? params : undefined,
        data: method === 'POST' ? params : undefined,
        headers: {
          'Idempotence-Key': idempotenceKey || crypto.randomUUID(),
        },
      });

      return res.data;
    } catch (err) {
      logger.error('YooKassa API error', {
        endpoint,
        status: err.response?.status,
        message: err.response?.data?.description || err.message,
        code: err.response?.data?.code,
      });
      throw err;
    }
  }

  // ── API methods ────────────────────────────────────────────────────────────

  /**
   * Create a payment.
   * @param {object} opts
   * @param {number} opts.amount - amount in rubles (e.g. 199.00)
   * @param {string} opts.description - payment description
   * @param {string} opts.metadata - your metadata (will be returned in webhook)
   * @param {string} opts.returnUrl - URL to redirect after payment
   * @param {string} opts.confirmationType - 'redirect' (default) or 'embedded'
   */
  async createPayment({ amount, description, metadata, returnUrl, confirmationType = 'redirect' }) {
    const payment = await this._request(
      'POST',
      '/payments',
      {
        amount: {
          value: String(amount.toFixed(2)),
          currency: 'RUB',
        },
        confirmation: {
          type: confirmationType,
          return_url: returnUrl,
        },
        capture: true,
        description,
        metadata,
      },
      metadata.paymentId?.toString() || crypto.randomUUID(),
    );

    logger.info('YooKassa payment created', {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount.value,
    });

    return payment;
  }

  /**
   * Get payment by ID.
   * @param {string} paymentId - YooKassa payment ID
   */
  async getPayment(paymentId) {
    return this._request('GET', `/payments/${paymentId}`);
  }

  /**
   * Cancel a payment.
   * @param {string} paymentId - YooKassa payment ID
   */
  async cancelPayment(paymentId) {
    return this._request('POST', `/payments/${paymentId}/cancel`);
  }

  // ── Webhook ────────────────────────────────────────────────────────────────

  /**
   * Verify webhook signature.
   * @param {string} body - raw request body as string
   * @param {string} signature - X-Signature header value
   * @returns {boolean}
   */
  verifyWebhookSignature(body, signature) {
    if (!this.secretKey) return false;

    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.secretKey)
        .update(body)
        .digest('hex');

      return signature === expectedSignature;
    } catch (err) {
      logger.error('YooKassa webhook signature verification error', { error: err.message });
      return false;
    }
  }

  /**
   * Parse webhook event.
   * @param {object} payload - parsed JSON body
   * @returns {object} - { type, event, payment }
   */
  parseWebhookEvent(payload) {
    const { type, event } = payload;

    if (type === 'notification' && event === 'payment.succeeded') {
      return {
        type: 'payment.succeeded',
        payment: payload.object,
      };
    }

    if (type === 'notification' && event === 'payment.canceled') {
      return {
        type: 'payment.canceled',
        payment: payload.object,
      };
    }

    if (type === 'notification' && event === 'payment.waiting_for_capture') {
      return {
        type: 'payment.waiting_for_capture',
        payment: payload.object,
      };
    }

    return { type: event || type, payment: payload.object };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Convert plan price (RUB kopecks) to rubles.
   * @param {number} priceRubKopecks - price in kopecks (e.g. 19900 = 199.00 RUB)
   * @returns {number}
   */
  formatAmount(priceRubKopecks) {
    return priceRubKopecks / 100;
  }

  /**
   * Get confirmation URL from payment object.
   * @param {object} payment - YooKassa payment object
   * @returns {string|null}
   */
  getConfirmationUrl(payment) {
    if (payment.confirmation?.type === 'redirect') {
      return payment.confirmation.confirmation_url;
    }
    return null;
  }
}

module.exports = new YooKassaService();
