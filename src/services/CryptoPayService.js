'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * CryptoBot (Crypto Pay) integration.
 * Docs: https://help.crypt.bot/crypto-pay-api
 *
 * Flow:
 *  1. createInvoice()  → get invoice URL → send to user
 *  2. Cron polls getInvoices(status='paid') every minute
 *  3. On paid invoice → handleSuccess() → activate subscription
 */
class CryptoPayService {
  constructor() {
    this.token = config.payments.cryptoPay.token;
    this.baseUrl = (config.payments.cryptoPay.url || 'https://pay.crypt.bot').replace(/\/$/, '');
    this.enabled = config.payments.cryptoPay.enabled;

    this._http = axios.create({
      baseURL: `${this.baseUrl}/api`,
      timeout: 10000,
      headers: {
        'Crypto-Pay-API-Token': this.token,
        'Content-Type': 'application/json',
      },
    });
  }

  // ── Internal request helper ────────────────────────────────────────────────

  async _request(method, endpoint, params = {}) {
    try {
      const res = await this._http({
        method,
        url: endpoint,
        params: method === 'GET' ? params : undefined,
        data: method !== 'GET' ? params : undefined,
      });
      if (!res.data.ok) {
        throw new Error(`CryptoPay API error: ${JSON.stringify(res.data.error)}`);
      }
      return res.data.result;
    } catch (err) {
      logger.error('CryptoPay API error', {
        endpoint,
        status: err.response?.status,
        message: err.response?.data?.error || err.message,
      });
      throw err;
    }
  }

  // ── API methods ────────────────────────────────────────────────────────────

  /**
   * Create a payment invoice.
   * @param {object} opts
   * @param {string} opts.asset       - 'USDT' | 'TON' | 'BTC' | 'ETH' | 'LTC' | 'BNB' | 'TRX' | 'USDC'
   * @param {string} opts.amount      - amount as string, e.g. '1.99'
   * @param {string} opts.description - shown to user
   * @param {string} opts.payload     - your metadata (max 4096 chars), stored as-is
   * @param {number} opts.expiresIn   - seconds until expiry (default 3600 = 1h)
   */
  async createInvoice({ asset, amount, description, payload, expiresIn = 3600 }) {
    return this._request('POST', '/createInvoice', {
      asset,
      amount: String(amount),
      description,
      payload,
      expires_in: expiresIn,
      allow_comments: false,
      allow_anonymous: false,
    });
  }

  /**
   * Get invoices filtered by status.
   * @param {'active'|'paid'|'expired'} status
   * @param {number[]} [invoiceIds] - optional filter by IDs
   */
  async getInvoices(status = 'paid', invoiceIds = []) {
    const params = { status };
    if (invoiceIds.length) params.invoice_ids = invoiceIds.join(',');
    return this._request('GET', '/getInvoices', params);
  }

  /**
   * Get app info (to verify token is valid).
   */
  async getMe() {
    return this._request('GET', '/getMe');
  }

  // ── Supported assets ──────────────────────────────────────────────────────

  /**
   * Returns list of assets available for payment with their display names.
   */
  getSupportedAssets() {
    return [
      { asset: 'USDT', name: 'USDT (TRC-20 / TON)' },
      { asset: 'TON', name: 'TON' },
      { asset: 'BTC', name: 'Bitcoin' },
      { asset: 'ETH', name: 'Ethereum' },
      { asset: 'LTC', name: 'Litecoin' },
      { asset: 'USDC', name: 'USDC' },
      { asset: 'BNB', name: 'BNB' },
      { asset: 'TRX', name: 'TRON' },
    ];
  }

  /**
   * Convert plan price (USD cents) to crypto amount string.
   * For simplicity we use USDT 1:1 with USD.
   * @param {number} priceUsdCents
   * @param {string} asset
   */
  formatAmount(priceUsdCents, asset) {
    const usd = priceUsdCents / 100;
    // For stablecoins use exact USD value; for others use USD value too
    // (CryptoPay handles conversion internally when user pays)
    return usd.toFixed(2);
  }
}

module.exports = new CryptoPayService();
