'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Adapter for 3x-ui panel API.
 * Docs: https://github.com/MHSanaei/3x-ui
 */
class ThreeXuiAdapter {
  constructor() {
    this.baseUrl = config.vpnPanel.url;
    this.username = config.vpnPanel.username;
    this.password = config.vpnPanel.password;
    this._cookie = null;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _login() {
    const res = await axios.post(
      `${this.baseUrl}/login`,
      { username: this.username, password: this.password },
      { withCredentials: true },
    );

    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      this._cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    }
    return this._cookie;
  }

  async _request(method, path, data = null) {
    if (!this._cookie) await this._login();

    try {
      const res = await axios({
        method,
        url: `${this.baseUrl}${path}`,
        data,
        headers: { Cookie: this._cookie },
      });

      // Re-login if session expired
      if (res.data?.msg === 'login' || res.status === 401) {
        this._cookie = null;
        await this._login();
        return this._request(method, path, data);
      }

      return res.data;
    } catch (err) {
      logger.error('3x-ui API error', {
        method,
        path,
        status: err.response?.status,
        message: err.message,
      });
      throw err;
    }
  }

  // ── Inbound / Client management ────────────────────────────────────────────

  async getInbounds() {
    return this._request('GET', '/panel/api/inbounds/list');
  }

  /**
   * Add a client to an inbound.
   * @param {number} inboundId
   * @param {object} clientSettings - { id (uuid), email, totalGB, expiryTime (ms timestamp) }
   */
  async addClient(inboundId, clientSettings) {
    const payload = {
      id: inboundId,
      settings: JSON.stringify({
        clients: [
          {
            id: clientSettings.id,
            email: clientSettings.email,
            totalGB: clientSettings.totalGB || 0,
            expiryTime: clientSettings.expiryTime || 0,
            enable: true,
            tgId: clientSettings.tgId || '',
            subId: clientSettings.subId || '',
          },
        ],
      }),
    };

    const result = await this._request('POST', '/panel/api/inbounds/addClient', payload);
    logger.info('3x-ui client added', { email: clientSettings.email });
    return result;
  }

  async updateClient(inboundId, uuid, clientSettings) {
    const payload = {
      id: inboundId,
      settings: JSON.stringify({ clients: [{ id: uuid, ...clientSettings }] }),
    };
    return this._request('POST', `/panel/api/inbounds/updateClient/${uuid}`, payload);
  }

  async deleteClient(inboundId, uuid) {
    return this._request('POST', `/panel/api/inbounds/${inboundId}/delClient/${uuid}`);
  }

  async getClientTraffic(email) {
    return this._request('GET', `/panel/api/inbounds/getClientTraffics/${email}`);
  }

  async resetClientTraffic(inboundId, email) {
    return this._request('POST', `/panel/api/inbounds/${inboundId}/resetClientTraffic/${email}`);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getServerStatus() {
    return this._request('GET', '/panel/api/server/status');
  }
}

module.exports = new ThreeXuiAdapter();
