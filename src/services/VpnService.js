'use strict';

const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const config = require('../config');
const VpnConfig = require('../models/VpnConfig');
const User = require('../models/User');
const logger = require('../utils/logger');

// ── Load the correct panel adapter ────────────────────────────────────────────
function getAdapter() {
  switch (config.vpnPanel.type) {
    case 'marzban':
      return require('./vpn/MarzbanAdapter');
    case '3xui':
      return require('./vpn/ThreeXuiAdapter');
    default:
      throw new Error(`Unknown VPN panel type: ${config.vpnPanel.type}`);
  }
}

const VpnService = {
  /**
   * Provision a new VPN config for a user after subscription activation.
   * Creates the user in the panel and saves config to DB.
   */
  async provision(userId, subscriptionId, plan) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const adapter = getAdapter();
    const panelUsername = `vpn_${user.telegram_id}`;

    let panelUser;
    let configLink;

    if (config.vpnPanel.type === 'marzban') {
      panelUser = await adapter.createUser(
        panelUsername,
        plan.traffic_bytes || 0,
        plan.duration_days,
      );
      // Marzban returns subscription_url which is the config link
      configLink = panelUser.subscription_url || panelUser.links?.[0] || '';
    } else if (config.vpnPanel.type === '3xui') {
      const uuid = uuidv4();
      const expiryTime = Date.now() + plan.duration_days * 86400 * 1000;
      const inboundId = config.vpnPanel.inboundId;

      await adapter.addClient(inboundId, {
        id: uuid,
        email: panelUsername,
        totalGB: plan.traffic_bytes ? plan.traffic_bytes / (1024 * 1024 * 1024) : 0,
        expiryTime,
        tgId: String(user.telegram_id),
        subId: panelUsername, // used for subscription URL
      });

      panelUser = { username: panelUsername, uuid };

      // 3x-ui subscription link — user imports this URL in their VPN client
      // Format: https://your-server.com/sub/<subId>
      if (config.vpnPanel.serverDomain) {
        configLink = `${config.vpnPanel.serverDomain}${config.vpnPanel.subPath}/${panelUsername}`;
      } else {
        // Fallback: use panel URL base
        const panelBase = config.vpnPanel.url.replace(/\/[^/]*$/, ''); // strip path
        configLink = `${panelBase}${config.vpnPanel.subPath}/${panelUsername}`;
      }
    }

    const vpnConfig = await VpnConfig.create({
      userId,
      subscriptionId,
      panelUserId: panelUsername,
      protocol: 'vless',
      configLink,
      serverTag: 'default',
    });

    logger.info('VPN provisioned', { userId, subscriptionId, panelUsername });
    return vpnConfig;
  },

  /**
   * Get active VPN configs for a user with QR codes.
   */
  async getConfigsForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);

    return Promise.all(
      configs.map(async (cfg) => {
        let qrCode = null;
        if (cfg.config_link) {
          try {
            qrCode = await QRCode.toDataURL(cfg.config_link);
          } catch {
            // QR generation is non-critical
          }
        }
        return { ...cfg, qrCode };
      }),
    );
  },

  /**
   * Disable all VPN configs for a user (on subscription expiry/cancel).
   */
  async disableForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);
    const adapter = getAdapter();

    for (const cfg of configs) {
      try {
        if (config.vpnPanel.type === 'marzban') {
          await adapter.disableUser(cfg.panel_user_id);
        } else if (config.vpnPanel.type === '3xui') {
          // 3x-ui: update client with enable=false
          await adapter.updateClient(1, cfg.panel_user_id, { enable: false });
        }
        await VpnConfig.disable(cfg.id);
      } catch (err) {
        logger.error('Failed to disable VPN config', { configId: cfg.id, error: err.message });
      }
    }
  },

  /**
   * Re-enable VPN configs for a user (on subscription renewal).
   */
  async enableForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);
    const adapter = getAdapter();

    for (const cfg of configs) {
      try {
        if (config.vpnPanel.type === 'marzban') {
          await adapter.enableUser(cfg.panel_user_id);
        } else if (config.vpnPanel.type === '3xui') {
          await adapter.updateClient(1, cfg.panel_user_id, { enable: true });
        }
        await VpnConfig.enable(cfg.id);
      } catch (err) {
        logger.error('Failed to enable VPN config', { configId: cfg.id, error: err.message });
      }
    }
  },

  /**
   * Extend VPN user expiry in the panel.
   */
  async extendInPanel(userId, days) {
    const configs = await VpnConfig.findActiveByUserId(userId);
    const adapter = getAdapter();

    for (const cfg of configs) {
      try {
        if (config.vpnPanel.type === 'marzban') {
          await adapter.extendUser(cfg.panel_user_id, days);
        }
        // 3x-ui extension handled via updateClient with new expiryTime
      } catch (err) {
        logger.error('Failed to extend VPN in panel', { configId: cfg.id, error: err.message });
      }
    }
  },

  async getSystemStats() {
    const adapter = getAdapter();
    return adapter.getSystemStats?.() || adapter.getServerStatus?.();
  },
};

module.exports = VpnService;
