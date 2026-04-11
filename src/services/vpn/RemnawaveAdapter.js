'use strict';

const https = require('https');
const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

/** Standard UUID v4 string (Remnawave user ids). */
const UUID_STRING_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    this.apiToken = config.vpnPanel.apiToken;
    this.subscriptionToken = config.vpnPanel.subscriptionToken;
    this._token = null;
    this._tokenExpiry = null;

    const axiosOpts = {
      baseURL: `${this.baseUrl}/api`,
      timeout: 15000,
    };
    if (config.vpnPanel.tlsInsecure) {
      axiosOpts.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    this._http = axios.create(axiosOpts);
    this._http.defaults.transformResponse = [
      (data) => {
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      },
    ];
  }

  /**
   * Remnawave wraps many entities as { response: { ... } }; some versions nest twice.
   */
  _unwrapPayload(data) {
    let cur = data;
    for (let depth = 0; depth < 5; depth++) {
      if (
        cur &&
        typeof cur === 'object' &&
        Object.prototype.hasOwnProperty.call(cur, 'response') &&
        cur.response !== null &&
        typeof cur.response === 'object' &&
        !Array.isArray(cur.response)
      ) {
        cur = cur.response;
      } else {
        break;
      }
    }
    return cur;
  }

  /**
   * Last resort: find a UUID string under a key containing "uuid" (nested), for API shape drift.
   */
  _findUuidByKeyRecursive(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = this._findUuidByKeyRecursive(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /uuid/i.test(k) && UUID_STRING_RE.test(v)) {
        return v.trim();
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const found = this._findUuidByKeyRecursive(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * User id for /users/{id} paths — API may use uuid, id, snake_case, or nest under user/data.
   */
  _panelUserId(user) {
    if (!user || typeof user !== 'object') return null;
    const tryObj = (o) => {
      if (!o || typeof o !== 'object') return null;
      const candidates = [
        o.uuid,
        o.id,
        o.userUuid,
        o.user_uuid,
        o.userUUID,
        o.shortUuid,
        o.short_uuid,
      ];
      for (const c of candidates) {
        if (c != null && String(c).trim() !== '') {
          const s = String(c).trim();
          if (UUID_STRING_RE.test(s)) return s;
          // Some stacks return numeric ids — still try path (panel-dependent)
          if (s.length > 0) return s;
        }
      }
      return null;
    };
    return (
      tryObj(user) ||
      tryObj(user.user) ||
      tryObj(user.data) ||
      tryObj(user.result) ||
      this._findUuidByKeyRecursive(user)
    );
  }

  _usersPath(user) {
    const id = this._panelUserId(user);
    if (!id) {
      const keys = user && typeof user === 'object' ? Object.keys(user) : [];
      logger.error('Remnawave user object missing uuid/id', { keys });
      const err = new Error('Remnawave user object missing uuid/id');
      throw err;
    }
    return `/users/${encodeURIComponent(id)}`;
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

  /**
   * Normalized fields from panel user object (camelCase or snake_case).
   */
  snapshotFromUser(user) {
    if (!user || typeof user !== 'object') {
      return {
        tag: '',
        hwidDeviceLimit: null,
        usedTrafficBytes: null,
        trafficLimitBytes: null,
        expireAt: null,
      };
    }
    const used =
      user.usedTrafficBytes ??
      user.used_traffic_bytes ??
      user.consumedTrafficBytes ??
      null;
    const tlim = user.trafficLimitBytes ?? user.traffic_limit_bytes ?? null;
    return {
      tag: user.tag != null ? String(user.tag).trim() : '',
      hwidDeviceLimit:
        user.hwidDeviceLimit !== undefined && user.hwidDeviceLimit !== null
          ? user.hwidDeviceLimit
          : user.hwid_device_limit !== undefined
            ? user.hwid_device_limit
            : null,
      usedTrafficBytes: typeof used === 'number' && Number.isFinite(used) ? used : null,
      trafficLimitBytes: typeof tlim === 'number' && Number.isFinite(tlim) ? tlim : null,
      expireAt: user.expireAt || user.expire_at || null,
    };
  }

  _applyCreateMeta(payload, meta) {
    if (!meta || typeof meta !== 'object') return;
    if (meta.tag != null && String(meta.tag).trim() !== '') {
      payload.tag = String(meta.tag).trim().slice(0, 128);
    }
    const lim = meta.hwidDeviceLimit;
    if (lim != null && Number.isFinite(Number(lim)) && Number(lim) > 0) {
      payload.hwidDeviceLimit = Math.min(65535, Math.floor(Number(lim)));
    }
    if (meta.description != null && String(meta.description).trim() !== '') {
      payload.description = String(meta.description).trim().slice(0, 512);
    }
  }

  /** Fields for PATCH /users/{uuid} (renewal / sync with plan). */
  _patchFromPlanMeta(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const out = {};
    if (meta.tag != null && String(meta.tag).trim() !== '') {
      out.tag = String(meta.tag).trim().slice(0, 128);
    }
    const lim = meta.hwidDeviceLimit;
    if (lim != null && Number.isFinite(Number(lim)) && Number(lim) > 0) {
      out.hwidDeviceLimit = Math.min(65535, Math.floor(Number(lim)));
    }
    if (meta.trafficLimitBytes !== undefined) {
      const t = Number(meta.trafficLimitBytes);
      if (Number.isFinite(t) && t >= 0) {
        out.trafficLimitBytes = t;
        out.trafficLimitStrategy = t > 0 ? 'MONTH_ROLLING' : 'NO_RESET';
      }
    }
    return out;
  }

  async _request(method, path, data = null, params = null, useSubscriptionToken = false) {
    let token;
    if (useSubscriptionToken && this.subscriptionToken) {
      token = this.subscriptionToken;
    } else {
      token = this.apiToken;
    }
    const authHeaders = { Authorization: `Bearer ${token}` };

    try {
      const requestConfig = {
        method,
        url: path,
        params,
        headers: authHeaders,
      };
      if (data !== null && data !== undefined) {
        requestConfig.headers['Content-Type'] = 'application/json';
        requestConfig.data = data;
      }

      const res = await this._withNetworkRetries(
        () => this._http(requestConfig),
        `${method} ${path}`,
      );
      return res.data;
    } catch (err) {
      logger.error('Remnawave API error', {
        method,
        path,
        status: err.response?.status,
        code: err.code,
        message: err.response?.data?.message || err.message,
        responseData: err.response?.data,
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
   * @param {object} [meta] - tag, hwidDeviceLimit, description (panel user tag & HWID limit)
   */
  async createUser(username, trafficLimitBytes = 0, expireDays = 30, tgId = '', meta = {}) {
    const expireAtTimestamp = Math.floor((Date.now() + expireDays * 86400 * 1000) / 1000);
    const trafficLimit = Number(trafficLimitBytes);
    const normalizedTrafficLimit =
      Number.isFinite(trafficLimit) && trafficLimit > 0 ? trafficLimit : 0;

    const payload = {
      username,
      expireAt: new Date(expireAtTimestamp * 1000).toISOString(),
      trafficLimitBytes: normalizedTrafficLimit,
      trafficLimitStrategy: normalizedTrafficLimit > 0 ? 'MONTH_ROLLING' : 'NO_RESET',
      status: 'ACTIVE',
    };

    const tid = tgId !== '' && tgId != null ? parseInt(String(tgId), 10) : NaN;
    if (!Number.isNaN(tid)) {
      payload.telegramId = tid;
    }

    this._applyCreateMeta(payload, meta);

    const configuredSquads = config.vpnPanel.internalSquadUuids || [];
    const squads = configuredSquads.filter((id) => UUID_STRING_RE.test(String(id)));
    if (configuredSquads.length > squads.length) {
      logger.warn('Ignoring invalid VPN internal squad UUIDs');
    }
    if (squads.length > 0) {
      payload.activeInternalSquads = squads;
    }

    const raw = await this._request('POST', '/users', payload);
    const user = this._unwrapPayload(raw);
    logger.info('Remnawave user created', { username });
    return user;
  }

  async getUser(username) {
    const raw = await this._request(
      'GET',
      `/users/by-username/${encodeURIComponent(username)}`,
      null,
      null,
      false,
    );
    if (raw === 'null' || raw === null) {
      const err = new Error('User not found');
      err.response = { status: 404 };
      throw err;
    }
    return this._unwrapPayload(raw);
  }

  async getUserByUuid(uuid) {
    const raw = await this._request('GET', `/users/${uuid}`);
    return this._unwrapPayload(raw);
  }

  async enableUser(username) {
    const user = await this.getUser(username);
    return this._request('PATCH', this._usersPath(user), { status: 'ACTIVE' });
  }

  async disableUser(username) {
    const user = await this.getUser(username);
    return this._request('PATCH', this._usersPath(user), { status: 'DISABLED' });
  }

  async deleteUser(username) {
    const user = await this.getUser(username);
    return this._request('DELETE', this._usersPath(user));
  }

  async resetUserTraffic(username) {
    const user = await this.getUser(username);
    return this._request('POST', `${this._usersPath(user)}/reset-traffic`);
  }

  /**
   * Extend user expiry by N days from now (or from current expiry if still active).
   * @param {object} [meta] - optional tag, hwidDeviceLimit, trafficLimitBytes (sync with plan)
   */
  async extendUser(username, days, meta = {}) {
    const user = await this.getUser(username);
    const exp =
      user.expireAt || user.expire_at
        ? new Date(user.expireAt || user.expire_at).getTime()
        : Date.now();
    const currentExpiry = Number.isFinite(exp) ? exp : Date.now();
    const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
    const newExpireAt = new Date(base + days * 86400 * 1000).toISOString();
    const body = { expireAt: newExpireAt, ...this._patchFromPlanMeta(meta) };
    return this._request('PATCH', this._usersPath(user), body);
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
