'use strict';

const https = require('https');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');

/** Standard UUID v4 string (Remnawave user ids). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Adapter for Remnawave VPN panel API.
 * Docs: https://docs.remnawave.com/
 *
 * Auth priority:
 *   1. VPN_API_TOKEN  — static API token from panel Settings → API Tokens (preferred)
 *   2. VPN_PANEL_USERNAME + VPN_PANEL_PASSWORD — JWT login (fallback)
 *
 * Base URL: VPN_PANEL_URL (no trailing slash), e.g. https://panel.yourdomain.com
 * API prefix: /api
 */
class RemnawaveAdapter {
  constructor() {
    this.baseUrl = config.vpnPanel.url;
    this.apiToken = config.vpnPanel.apiToken;
    this.username = config.vpnPanel.username;
    this.password = config.vpnPanel.password;

    // JWT session (used only when apiToken is empty)
    this._jwtToken = null;
    this._jwtExpiry = null;

    const axiosOpts = {
      baseURL: `${this.baseUrl}/api`,
      timeout: 15000,
      // Force JSON parsing regardless of Content-Type header
      // (Remnawave sometimes returns text/plain or application/octet-stream)
      transformResponse: [
        (data) => {
          if (typeof data === 'string') {
            try {
              return JSON.parse(data);
            } catch {
              return data;
            }
          }
          return data;
        },
      ],
    };

    if (config.vpnPanel.tlsInsecure) {
      axiosOpts.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    this._http = axios.create(axiosOpts);
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  /**
   * Returns the Bearer token to use for requests.
   * If VPN_API_TOKEN is set — use it directly (no login needed).
   * Otherwise — login with username/password and cache the JWT.
   */
  async _getBearerToken() {
    // Static API token — always preferred
    if (this.apiToken) {
      return this.apiToken;
    }

    // JWT session — reuse if still valid
    if (this._jwtToken && this._jwtExpiry && Date.now() < this._jwtExpiry) {
      return this._jwtToken;
    }

    // Login to get JWT
    const res = await this._http.post('/auth/login', {
      username: this.username,
      password: this.password,
    });

    const token =
      res.data?.accessToken ||
      res.data?.access_token ||
      res.data?.response?.accessToken ||
      res.data?.response?.access_token;

    if (!token) {
      throw new Error('Remnawave login failed: no token in response');
    }

    this._jwtToken = token;
    this._jwtExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
    logger.info('Remnawave JWT refreshed');
    return this._jwtToken;
  }

  // ── Network helpers ────────────────────────────────────────────────────────

  _isTransientError(err) {
    if (err.response) return false;
    const c = err.code;
    return (
      c === 'ECONNRESET' ||
      c === 'ECONNREFUSED' ||
      c === 'ETIMEDOUT' ||
      c === 'EPIPE' ||
      c === 'ECONNABORTED' ||
      String(err.message).toLowerCase().includes('socket hang up')
    );
  }

  async _withRetry(fn, label) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < 3 && this._isTransientError(err)) {
          const delay = 400 * attempt;
          logger.warn('Remnawave transient error, retrying', {
            label,
            attempt,
            delay,
            code: err.code,
          });
          await new Promise((r) => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
    throw lastErr;
  }

  // ── Core request ───────────────────────────────────────────────────────────

  async _request(method, path, data = null, params = null) {
    const doRequest = async () => {
      const token = await this._getBearerToken();
      const reqConfig = {
        method,
        url: path,
        params,
        headers: { Authorization: `Bearer ${token}` },
      };
      if (data !== null && data !== undefined) {
        reqConfig.headers['Content-Type'] = 'application/json';
        reqConfig.data = data;
      }
      const res = await this._http(reqConfig);
      return res.data;
    };

    try {
      return await this._withRetry(doRequest, `${method} ${path}`);
    } catch (err) {
      // On 401 with JWT — clear cached token and retry once
      if (err.response?.status === 401 && !this.apiToken) {
        this._jwtToken = null;
        this._jwtExpiry = null;
        logger.warn('Remnawave 401 — clearing JWT cache, retrying once');
        try {
          return await doRequest();
        } catch (retryErr) {
          logger.error('Remnawave request failed after token refresh', {
            method,
            path,
            status: retryErr.response?.status,
            message: retryErr.response?.data?.message || retryErr.message,
          });
          throw retryErr;
        }
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

  // ── Response unwrapping ────────────────────────────────────────────────────

  /**
   * Remnawave wraps responses as { response: { ... } }.
   * Unwrap up to 3 levels deep.
   */
  _unwrap(data) {
    let cur = data;
    for (let i = 0; i < 3; i++) {
      if (cur && typeof cur === 'object' && !Array.isArray(cur) && 'response' in cur) {
        cur = cur.response;
      } else {
        break;
      }
    }
    return cur;
  }

  /**
   * Extract user UUID from panel response (handles various field names).
   */
  _extractUuid(user) {
    if (!user || typeof user !== 'object') return null;
    const candidates = [user.uuid, user.id, user.userUuid, user.user_uuid];
    for (const c of candidates) {
      if (c && UUID_RE.test(String(c))) return String(c);
    }
    return null;
  }

  _userPath(user) {
    const id = this._extractUuid(user);
    if (!id) {
      // Log full object (truncated) to diagnose the actual field name
      let preview = '';
      try {
        preview = JSON.stringify(user).slice(0, 500);
      } catch {
        preview = String(user);
      }
      logger.error('Cannot build user path — no UUID in panel response', {
        keys: Object.keys(user || {}),
        preview,
      });
      throw new Error('Remnawave: user UUID not found in response');
    }
    return `/users/${id}`;
  }

  // ── Snapshot helper ────────────────────────────────────────────────────────

  /**
   * Normalize panel user object to a consistent shape.
   * Used by VpnService and myVpn handler to display traffic/expiry.
   */
  snapshotFromUser(user) {
    if (!user || typeof user !== 'object') {
      return { tag: '', usedTrafficBytes: null, trafficLimitBytes: null, expireAt: null };
    }
    const used = user.usedTrafficBytes ?? user.used_traffic_bytes ?? null;
    const limit = user.trafficLimitBytes ?? user.traffic_limit_bytes ?? null;
    return {
      tag: user.tag ? String(user.tag).trim() : '',
      usedTrafficBytes: typeof used === 'number' ? used : null,
      trafficLimitBytes: typeof limit === 'number' ? limit : null,
      expireAt: user.expireAt || user.expire_at || null,
    };
  }

  // ── User management ────────────────────────────────────────────────────────

  /**
   * Create a VPN user in Remnawave.
   *
   * @param {string} username        - unique username, e.g. "vpn_394112994"
   * @param {number} trafficBytes    - traffic limit in bytes; 0 = unlimited
   * @param {number} expireDays      - days until expiry
   * @param {string} [tgId]          - Telegram user ID (stored in panel for reference)
   * @param {object} [meta]          - optional: { tag, description, hwidDeviceLimit }
   */
  async createUser(username, trafficBytes = 0, expireDays = 30, tgId = '', meta = {}) {
    // 1. Подготовка даты (ГИГИЕНА ДАННЫХ)
    // Если expireDays не передан или <= 0, используем 30 дней по умолчанию,
    // чтобы избежать null, который вызывает "Validation failed".
    const days = expireDays && expireDays > 0 ? expireDays : 30;
    const expireAt = new Date(Date.now() + days * 86400 * 1000).toISOString();

    // 2. Подготовка объекта (аналогично Postman)
    const payload = {
      username,
      expireAt,
    };

    // --- Squad UUID (Исправлено: используем массив activeInternalSquads) ---
    if (config.vpnPanel.defaultSquad) {
      // API ожидает массив UUID, даже если он один
      payload.activeInternalSquads = [config.vpnPanel.defaultSquad];
    }

    // --- Количество устройств (Исправлено: добавляем только если указано в тарифе) ---

    // 3. Добавляем опциональные поля ТОЛЬКО если они есть
    const traffic = Number(trafficBytes);
    if (Number.isFinite(traffic) && traffic > 0) {
      payload.trafficLimitBytes = traffic;
      payload.trafficLimitStrategy = 'MONTH_ROLLING';
    }

    const tid = parseInt(String(tgId || ''), 10);
    if (!Number.isNaN(tid) && tid > 0) {
      payload.telegramId = tid;
    }

    if (meta.tag && String(meta.tag).trim()) {
      payload.tag = String(meta.tag).trim();
    }

    if (meta.description && String(meta.description).trim()) {
      payload.description = String(meta.description).trim();
    }

    if (meta.hwidDeviceLimit !== undefined && meta.hwidDeviceLimit !== null) {
      const d = Number(meta.hwidDeviceLimit);
      if (Number.isFinite(d) && d >= 0) {
        payload.hwidDeviceLimit = d;
      }
    }

    // 4. Логирование для отладки (посмотрим, что реально улетает)
    logger.info('Creating Remnawave user with payload', { payload });

    try {
      const raw = await this._request('POST', '/users', payload);
      const user = this._unwrap(raw);
      logger.info('Remnawave user created successfully', { username });
      return user;
    } catch (err) {
      // Если ошибка повторится, мы увидим детали в логе
      logger.error('Failed to create Remnawave user', {
        status: err.response?.status,
        data: err.response?.data,
        payloadSent: payload,
      });
      throw err;
    }
  }
  /**
   * Get user by username.
   * Throws with err.response.status === 404 if not found.
   */
  async getUser(username) {
    let raw;
    try {
      raw = await this._request('GET', `/users/by-username/${encodeURIComponent(username)}`);
    } catch (err) {
      // HTTP 404 from panel — user doesn't exist
      if (err.response?.status === 404) throw err;
      throw err;
    }

    // Remnawave returns null / "null" / { response: null } when user not found
    if (raw === null || raw === 'null' || raw === undefined) {
      const err = new Error(`User not found: ${username}`);
      err.response = { status: 404 };
      throw err;
    }

    const unwrapped = this._unwrap(raw);

    // After unwrap — check if result is null/empty (another "not found" variant)
    if (unwrapped === null || unwrapped === undefined) {
      const err = new Error(`User not found: ${username}`);
      err.response = { status: 404 };
      throw err;
    }

    // Debug log — log top-level keys to help diagnose UUID field name
    if (process.env.NODE_ENV !== 'production') {
      const keys = unwrapped && typeof unwrapped === 'object' ? Object.keys(unwrapped) : [];
      logger.debug('Remnawave getUser response keys', { username, keys });
    }

    return unwrapped;
  }

  async enableUser(username) {
    // PATCH /users with uuid and username in body (per Remnawave API docs)
    const user = await this.getUser(username);
    const raw = await this._request('PATCH', '/users', {
      uuid: this._extractUuid(user),
      username: user.username || username,
      status: 'ACTIVE',
    });
    return this._unwrap(raw);
  }

  async disableUser(username) {
    // PATCH /users with uuid and username in body (per Remnawave API docs)
    const user = await this.getUser(username);
    const raw = await this._request('PATCH', '/users', {
      uuid: this._extractUuid(user),
      username: user.username || username,
      status: 'DISABLED',
    });
    return this._unwrap(raw);
  }

  async deleteUser(username) {
    const user = await this.getUser(username);
    return this._request('DELETE', this._userPath(user));
  }

  async resetUserTraffic(username) {
    const user = await this.getUser(username);
    return this._request('POST', `${this._userPath(user)}/reset-traffic`);
  }

  /**
   * Extend user expiry by N days.
   * Extends from current expiry if still in the future, otherwise from now.
   *
   * @param {object} [meta] - optional: { tag, trafficLimitBytes } to sync with plan
   */
  async extendUser(username, days, meta = {}) {
    const user = await this.getUser(username);

    const rawExpiry = user.expireAt || user.expire_at;
    const currentExpiry = rawExpiry ? new Date(rawExpiry).getTime() : Date.now();
    const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
    const newExpireAt = new Date(base + days * 86400 * 1000).toISOString();

    const body = { expireAt: newExpireAt };

    // Sync status if provided (e.g. re-enable on renewal)
    if (meta.status === 'ACTIVE' || meta.status === 'DISABLED') {
      body.status = meta.status;
    }

    // Sync tag if provided
    if (meta.tag && String(meta.tag).trim()) {
      body.tag = String(meta.tag).trim().slice(0, 128);
    }

    // Sync traffic limit if provided (0 = unlimited)
    if (meta.trafficLimitBytes !== undefined) {
      const t = Number(meta.trafficLimitBytes);
      if (Number.isFinite(t) && t >= 0) {
        body.trafficLimitBytes = t;
        body.trafficLimitStrategy = t > 0 ? 'MONTH_ROLLING' : 'NO_RESET';
      }
    }

    // Sync device limit if provided
    if (meta.hwidDeviceLimit !== undefined) {
      const d = Number(meta.hwidDeviceLimit);
      if (Number.isFinite(d) && d >= 0) {
        body.hwidDeviceLimit = d;
      }
    }

    // Sync description if provided
    if (meta.description && String(meta.description).trim()) {
      body.description = String(meta.description).trim().slice(0, 500);
    }

    // PATCH /users with uuid and username in body (per Remnawave API docs)
    const raw = await this._request('PATCH', '/users', {
      uuid: this._extractUuid(user),
      username: user.username || username,
      ...body,
    });
    return this._unwrap(raw);
  }

  /**
   * Get subscription URL for a user.
   * Prefers the URL returned by the panel (subscriptionUrl field).
   * Falls back to constructing it from VPN_SERVER_DOMAIN + VPN_SUB_PATH.
   */
  subscriptionUrlFromUser(user) {
    const url = user?.subscriptionUrl || user?.subscription_url || '';
    return typeof url === 'string' ? url.trim() : '';
  }

  getSubscriptionUrl(username) {
    const domain = (config.vpnPanel.serverDomain || this.baseUrl).replace(/\/+$/, '');
    const subPath = (config.vpnPanel.subPath || '/api/sub').replace(/\/+$/, '');
    const path = subPath.startsWith('/') ? subPath : `/${subPath}`;
    return `${domain}${path}/${encodeURIComponent(username)}`;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getSystemStats() {
    const raw = await this._request('GET', '/system/stats');
    return this._unwrap(raw);
  }

  async getNodes() {
    const raw = await this._request('GET', '/nodes');
    return this._unwrap(raw);
  }

  async getInbounds() {
    const raw = await this._request('GET', '/inbounds');
    return this._unwrap(raw);
  }

  // ── HWID Device Management ─────────────────────────────────────────────────

  /**
   * Get list of HWID devices from the panel.
   * API endpoint: GET /api/hwid/devices
   *
   * @param {object} opts - pagination options
   * @param {number} opts.size - page size (default 20)
   * @param {number} opts.start - start offset (default 1)
   * @returns {Promise<object>} - { devices: [...], total: number } or similar
   */
  async getHwidDevices({ size = 20, start = 1 } = {}) {
    const raw = await this._request('GET', '/hwid/devices', null, { size, start });
    const data = this._unwrap(raw);

    // Safe parsing: API may return different structures
    // Try to extract devices array from various possible keys
    let devices = [];
    let total = 0;

    if (Array.isArray(data)) {
      // Direct array response
      devices = data;
      total = data.length;
    } else if (data && typeof data === 'object') {
      // Object with devices array
      devices = data.devices || data.deviceList || data.items || data.list || [];
      total = data.total || data.totalCount || data.count || devices.length;
    }

    // Normalize devices: ensure each device has consistent fields
    devices = devices
      .map((d) => {
        if (!d || typeof d !== 'object') return null;
        return {
          hwid: d.hwid || d.deviceId || d.id || d.device_id || '',
          userUuid: d.userUuid || d.user_uuid || d.uuid || d.userId || '',
          deviceName: d.deviceName || d.device_name || d.name || d.hostname || '',
          lastConnected: d.lastConnected || d.last_connected || d.lastSeen || d.last_seen || null,
          createdAt: d.createdAt || d.created_at || null,
          ip: d.ip || d.ipAddress || d.ip_address || '',
        };
      })
      .filter(Boolean);

    logger.debug('Remnawave getHwidDevices result', {
      devicesCount: devices.length,
      total,
      size,
      start,
    });

    return { devices, total };
  }

  /**
   * Delete a specific HWID device.
   * API endpoint: POST /api/hwid/devices/delete
   *
   * @param {object} opts - delete options
   * @param {string} opts.userUuid - user UUID in panel
   * @param {string} opts.hwid - device HWID to delete
   * @returns {Promise<boolean>} - true if deleted successfully
   */
  async deleteHwidDevice({ userUuid, hwid }) {
    if (!userUuid || !hwid) {
      throw new Error('deleteHwidDevice requires userUuid and hwid');
    }

    logger.info('Deleting HWID device', { userUuid, hwid });

    try {
      const raw = await this._request('POST', '/hwid/devices/delete', {
        userUuid,
        hwid,
      });

      const data = this._unwrap(raw);

      // API may return boolean or object with success field
      const success = data === true || data?.success === true || data?.deleted === true;

      logger.info('HWID device deleted', { userUuid, hwid, success });

      return true;
    } catch (err) {
      logger.error('Failed to delete HWID device', {
        userUuid,
        hwid,
        status: err.response?.status,
        message: err.response?.data?.message || err.message,
      });
      throw err;
    }
  }
}

module.exports = new RemnawaveAdapter();
