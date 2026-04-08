'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Adapter for Remnawave VPN panel API.
 * Docs: https://remnawave.github.io/docs
 *
 * Remnawave uses JWT Bearer auth.
 * Base URL example: https://your-server.com  (no trailing slash)
 * API prefix: /api
 */
class RemnawaveAdapter {
  constructor() {
    this.baseUrl = config.vpnPanel.url; // e.g. https://your-server.com
    this.username = config.vpnPanel.username;
    this.password = config.vpnPanel.password;
    this._token = null;
    this._tokenExpiry = null;

    // axios instance with base config
    this._http = axios.create({
      baseURL: `${this.baseUrl}/api`,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      // Allow self-signed certs (common for VPS panels)
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _getToken() {
    if (this._token && this._tokenExpiry && Date.now() < this._tokenExpiry) {
      return this._token;
    }

    const res = await this._http.post('/auth/login', {
      username: this.username,
      password: this.password,
    });

    // Remnawave returns { accessToken, ... }
    this._token = res.data.accessToken || res.data.access_token;
    this._tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
    return this._token;
  }

  async _request(method, path, data = null, params = null) {
    const token = await this._getToken();
    try {
      const res = await this._http({
        method,
        url: path,
        data,
        params,
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    } catch (err) {
      // Re-auth on 401
      if (err.response?.status === 401) {
        this._token = null;
        const token2 = await this._getToken();
        const res2 = await this._http({
          method,
          url: path,
          data,
          params,
          headers: { Authorization: `Bearer ${token2}` },
        });
        return res2.data;
      }

      logger.error('Remnawave API error', {
        method,
        path,
        status: err.response?.status,
        message: err.response?.data?.message || err.message,
      });
      throw err;
    }
  }

  // ── User management ────────────────────────────────────────────────────────

  /**
   * Create a VPN user in Remnawave.
   * @param {string} username - unique username (e.g. "vpn_12345")
   * @param {number} trafficLimitBytes - 0 = unlimited
   * @param {number} expireDays - days until expiry
   * @param {string} [tgId] - Telegram user ID (optional)
   */
  async createUser(username, trafficLimitBytes = 0, expireDays = 30, tgId = '') {
    const expireAt = new Date(Date.now() + expireDays * 86400 * 1000).toISOString();

    const payload = {
      username,
      expireAt,
      trafficLimitBytes: trafficLimitBytes || 0,
      trafficLimitStrategy: trafficLimitBytes ? 'MONTH_DAY' : 'NO_RESET',
      status: 'ACTIVE',
      telegramId: tgId ? String(tgId) : undefined,
      // Use all active inbounds by default (Remnawave handles this)
      activeUserInbounds: config.vpnPanel.inboundTags
        ? config.vpnPanel.inboundTags.split(',').map((t) => t.trim())
        : [],
    };

    const user = await this._request('POST', '/users', payload);
    logger.info('Remnawave user created', { username });
    return user;
  }

  async getUser(username) {
    return this._request('GET', `/users/by-username/${username}`);
  }

  async getUserByUuid(uuid) {
    return this._request('GET', `/users/${uuid}`);
  }

  async enableUser(username) {
    const user = await this.getUser(username);
    return this._request('PATCH', `/users/${user.uuid}`, { status: 'ACTIVE' });
  }

  async disableUser(username) {
    const user = await this.getUser(username);
    return this._request('PATCH', `/users/${user.uuid}`, { status: 'DISABLED' });
  }

  async deleteUser(username) {
    const user = await this.getUser(username);
    return this._request('DELETE', `/users/${user.uuid}`);
  }

  async resetUserTraffic(username) {
    const user = await this.getUser(username);
    return this._request('POST', `/users/${user.uuid}/reset-traffic`);
  }

  /**
   * Extend user expiry by N days from now (or from current expiry if still active).
   */
  async extendUser(username, days) {
    const user = await this.getUser(username);
    const currentExpiry = user.expireAt ? new Date(user.expireAt).getTime() : Date.now();
    const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
    const newExpireAt = new Date(base + days * 86400 * 1000).toISOString();
    return this._request('PATCH', `/users/${user.uuid}`, { expireAt: newExpireAt });
  }

  /**
   * Get subscription link for a user (for VPN client import).
   * Remnawave provides a sub URL per user.
   */
  getSubscriptionUrl(username) {
    const subPath = config.vpnPanel.subPath || '/sub';
    const domain = config.vpnPanel.serverDomain || this.baseUrl;
    return `${domain}${subPath}/${username}`;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getSystemStats() {
    return this._request('GET', '/system/stats');
  }

  async getNodes() {
    return this._request('GET', '/nodes');
  }

  async getInbounds() {
    return this._request('GET', '/inbounds');
  }
}

module.exports = new RemnawaveAdapter();
