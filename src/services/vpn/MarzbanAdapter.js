'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Adapter for Marzban VPN panel API.
 * Docs: https://github.com/Gozargah/Marzban
 */
class MarzbanAdapter {
  constructor() {
    this.baseUrl = config.vpnPanel.url;
    this.username = config.vpnPanel.username;
    this.password = config.vpnPanel.password;
    this._token = null;
    this._tokenExpiry = null;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _getToken() {
    if (this._token && this._tokenExpiry && Date.now() < this._tokenExpiry) {
      return this._token;
    }

    const res = await axios.post(`${this.baseUrl}/api/admin/token`, {
      username: this.username,
      password: this.password,
    });

    this._token = res.data.access_token;
    this._tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
    return this._token;
  }

  async _request(method, path, data = null) {
    const token = await this._getToken();
    try {
      const res = await axios({
        method,
        url: `${this.baseUrl}/api${path}`,
        data,
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    } catch (err) {
      logger.error('Marzban API error', {
        method,
        path,
        status: err.response?.status,
        message: err.response?.data?.detail || err.message,
      });
      throw err;
    }
  }

  // ── User management ────────────────────────────────────────────────────────

  /**
   * Create a VPN user in Marzban.
   * @param {string} username - unique username (e.g. "vpn_12345")
   * @param {number} trafficLimitBytes - 0 = unlimited
   * @param {number} expireDays - days until expiry
   */
  async createUser(username, trafficLimitBytes = 0, expireDays = 30) {
    const expireTimestamp = Math.floor(Date.now() / 1000) + expireDays * 86400;

    const payload = {
      username,
      proxies: {
        vless: { flow: 'xtls-rprx-vision' },
      },
      inbounds: {
        vless: ['VLESS TCP REALITY'],
      },
      expire: expireTimestamp,
      data_limit: trafficLimitBytes,
      data_limit_reset_strategy: 'no_reset',
      status: 'active',
    };

    const user = await this._request('POST', '/user', payload);
    logger.info('Marzban user created', { username });
    return user;
  }

  async getUser(username) {
    return this._request('GET', `/user/${username}`);
  }

  async enableUser(username) {
    return this._request('PUT', `/user/${username}`, { status: 'active' });
  }

  async disableUser(username) {
    return this._request('PUT', `/user/${username}`, { status: 'disabled' });
  }

  async deleteUser(username) {
    return this._request('DELETE', `/user/${username}`);
  }

  async resetUserTraffic(username) {
    return this._request('POST', `/user/${username}/reset`);
  }

  /**
   * Extend user expiry by N days from now (or from current expiry if still active).
   */
  async extendUser(username, days) {
    const user = await this.getUser(username);
    const currentExpiry = user.expire || Math.floor(Date.now() / 1000);
    const base =
      currentExpiry > Math.floor(Date.now() / 1000) ? currentExpiry : Math.floor(Date.now() / 1000);
    const newExpiry = base + days * 86400;
    return this._request('PUT', `/user/${username}`, { expire: newExpiry });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getSystemStats() {
    return this._request('GET', '/system');
  }

  async getNodeStats() {
    return this._request('GET', '/nodes');
  }
}

module.exports = new MarzbanAdapter();
