'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Adapter for Remnawave VPN panel API.
 * Docs: https://docs.rw/
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

    const axiosOpts = {
      baseURL: `${this.baseUrl}/api`,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    };
    if (config.vpnPanel.tlsInsecure) {
      axiosOpts.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    this._http = axios.create(axiosOpts);
  }

  /** Remnawave wraps many entities as { response: { ... } } */
  _unwrapPayload(data) {
    if (
      data &&
      typeof data === 'object' &&
      Object.prototype.hasOwnProperty.call(data, 'response') &&
      data.response !== null &&
      typeof data.response === 'object' &&
      !Array.isArray(data.response)
    ) {
      return data.response;
    }
    return data;
  }

  /** No HTTP response — connection dropped, timeout, reset, etc. */
  _isTransientNetworkError(err) {
    if (!err || err.response) return false;
    const c = err.code;
    if (
      c === 'ECONNRESET' ||
      c === 'ECONNREFUSED' ||
      c === 'ETIMEDOUT' ||
      c === 'EPIPE' ||
      c === 'ECONNABORTED'
    ) {
      return true;
    }
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('socket hang up') || msg.includes('network error');
  }

  async _withNetworkRetries(operation, label) {
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastErr = err;
        const retry = attempt < maxAttempts && this._isTransientNetworkError(err);
        if (!retry) throw err;
        const delayMs = 400 * attempt;
        logger.warn('Remnawave network error, retry', {
          label,
          attempt,
          nextInMs: delayMs,
          code: err.code,
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _getToken() {
    if (this._token && this._tokenExpiry && Date.now() < this._tokenExpiry) {
      return this._token;
    }

    const res = await this._withNetworkRetries(
      () =>
        this._http.post('/auth/login', {
          username: this.username,
          password: this.password,
        }),
      'auth/login',
    );

    // Remnawave returns { accessToken, ... }
    this._token = res.data.accessToken || res.data.access_token;
    this._tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
    return this._token;
  }

  async _request(method, path, data = null, params = null) {
    const token = await this._getToken();
    const authHeaders = { Authorization: `Bearer ${token}` };

    try {
      const res = await this._withNetworkRetries(
        () =>
          this._http({
            method,
            url: path,
            data,
            params,
            headers: authHeaders,
          }),
        `${method} ${path}`,
      );
      return res.data;
    } catch (err) {
      // Re-auth on 401
      if (err.response?.status === 401) {
        this._token = null;
        const token2 = await this._getToken();
        const res2 = await this._withNetworkRetries(
          () =>
            this._http({
              method,
              url: path,
              data,
              params,
              headers: { Authorization: `Bearer ${token2}` },
            }),
          `${method} ${path} (after re-auth)`,
        );
        return res2.data;
      }

      logger.error('Remnawave API error', {
        method,
        path,
        status: err.response?.status,
        code: err.code,
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
      // OpenAPI: NO_RESET | DAY | WEEK | MONTH | MONTH_ROLLING (MONTH_DAY is invalid)
      trafficLimitStrategy: trafficLimitBytes ? 'MONTH_ROLLING' : 'NO_RESET',
      status: 'ACTIVE',
    };

    const tid = tgId !== '' && tgId != null ? parseInt(String(tgId), 10) : NaN;
    if (!Number.isNaN(tid)) {
      payload.telegramId = tid;
    }

    const squads = config.vpnPanel.internalSquadUuids || [];
    if (squads.length > 0) {
      payload.activeInternalSquads = squads;
    }

    const raw = await this._request('POST', '/users', payload);
    const user = this._unwrapPayload(raw);
    logger.info('Remnawave user created', { username });
    return user;
  }

  async getUser(username) {
    const raw = await this._request('GET', `/users/by-username/${encodeURIComponent(username)}`);
    return this._unwrapPayload(raw);
  }

  async getUserByUuid(uuid) {
    const raw = await this._request('GET', `/users/${uuid}`);
    return this._unwrapPayload(raw);
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
   * Prefer subscription URL returned by the panel (tokens, CDN, short UUID).
   */
  subscriptionUrlFromUser(user) {
    if (!user || typeof user !== 'object') return '';
    const url = user.subscriptionUrl;
    if (typeof url !== 'string') return '';
    const t = url.trim();
    return t.length > 0 ? t : '';
  }

  /**
   * Fallback subscription link when API did not return subscriptionUrl.
   */
  getSubscriptionUrl(username) {
    const domain = (config.vpnPanel.serverDomain || this.baseUrl || '').replace(/\/+$/, '');
    let subPath = config.vpnPanel.subPath || '/api/sub';
    subPath = subPath.startsWith('/') ? subPath : `/${subPath}`;
    subPath = subPath.replace(/\/+$/, '');
    return `${domain}${subPath}/${encodeURIComponent(username)}`;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getSystemStats() {
    const raw = await this._request('GET', '/system/stats');
    return this._unwrapPayload(raw);
  }

  async getNodes() {
    const raw = await this._request('GET', '/nodes');
    return this._unwrapPayload(raw);
  }

  async getInbounds() {
    const raw = await this._request('GET', '/inbounds');
    return this._unwrapPayload(raw);
  }
}

module.exports = new RemnawaveAdapter();
