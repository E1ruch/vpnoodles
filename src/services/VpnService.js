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
    case 'remnawave':
      return require('./vpn/RemnawaveAdapter');
    case 'marzban':
      return require('./vpn/MarzbanAdapter');
    case '3xui':
      return require('./vpn/ThreeXuiAdapter');
    default:
      throw new Error(`Unknown VPN panel type: ${config.vpnPanel.type}`);
  }
}

function getHostname(link) {
  try {
    const value = String(link || '').trim();
    if (!value.startsWith('http://') && !value.startsWith('https://')) return '';
    return new URL(value).hostname || '';
  } catch {
    return '';
  }
}

function pickNodeLabel(node) {
  const candidates = [
    node?.name,
    node?.country,
    node?.countryName,
    node?.title,
    node?.remark,
    node?.tag,
    node?.hostname,
  ];
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }
  return '';
}

function addHost(hostsSet, raw) {
  const value = String(raw || '').trim();
  if (!value) return;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const h = getHostname(value);
    if (h) hostsSet.add(h.toLowerCase());
    return;
  }
  const normalized = value.replace(/^\*\./, '').split('/')[0].trim();
  if (normalized) hostsSet.add(normalized.toLowerCase());
}

function extractNodeHosts(node) {
  const hosts = new Set();
  const singleFields = ['host', 'hostname', 'domain', 'address', 'server'];
  const arrayFields = ['hosts', 'domains', 'addresses', 'servers', 'urls'];

  for (const field of singleFields) addHost(hosts, node?.[field]);
  for (const field of arrayFields) {
    const arr = node?.[field];
    if (Array.isArray(arr)) {
      for (const item of arr) addHost(hosts, item);
    }
  }

  return hosts;
}

function buildNodeLabelByHost(nodes) {
  const map = new Map();
  const list = Array.isArray(nodes) ? nodes : [];
  for (const node of list) {
    const label = pickNodeLabel(node);
    if (!label) continue;
    const hosts = extractNodeHosts(node);
    for (const h of hosts) {
      if (!map.has(h)) map.set(h, label);
    }
  }
  return map;
}

const VpnService = {
  /**
   * Provision a new VPN config for a user after subscription activation.
   * Creates the user in the panel and saves config to DB.
   */
  async provision(userId, subscriptionId, plan) {
    try {
      // Skip if VPN panel not configured (placeholder URL)
      if (
        config.vpnPanel.url === 'https://your-remnawave-panel.com' ||
        config.vpnPanel.url === 'https://your-panel.com' ||
        !config.vpnPanel.url
      ) {
        logger.warn('VPN panel not configured, skipping provision', { userId });
        return;
      }

      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const adapter = getAdapter();
      const panelUsername = `vpn_${user.telegram_id}`;

      let configLink = '';

      if (config.vpnPanel.type === 'remnawave') {
        // Check if user already exists in panel (re-subscription case)
        let panelUser;
        try {
          panelUser = await adapter.getUser(panelUsername);
          // User exists — extend expiry
          await adapter.extendUser(panelUsername, plan.duration_days);
          await adapter.enableUser(panelUsername);
          logger.info('Remnawave user extended', { panelUsername });
        } catch (err) {
          if (err.response?.status === 404) {
            // User doesn't exist — create new
            panelUser = await adapter.createUser(
              panelUsername,
              plan.traffic_bytes || 0,
              plan.duration_days,
              String(user.telegram_id),
            );
            logger.info('Remnawave user created', { panelUsername });
          } else {
            throw err;
          }
        }

        configLink =
          adapter.subscriptionUrlFromUser(panelUser) || adapter.getSubscriptionUrl(panelUsername);
      } else if (config.vpnPanel.type === 'marzban') {
        const panelUser = await adapter.createUser(
          panelUsername,
          plan.traffic_bytes || 0,
          plan.duration_days,
        );
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
          subId: panelUsername,
        });

        if (config.vpnPanel.serverDomain) {
          configLink = `${config.vpnPanel.serverDomain}${config.vpnPanel.subPath}/${panelUsername}`;
        } else {
          const panelBase = config.vpnPanel.url.replace(/\/[^/]*$/, '');
          configLink = `${panelBase}${config.vpnPanel.subPath}/${panelUsername}`;
        }
      }

      // Save or update vpn_config in DB
      const existing = await VpnConfig.findActiveByUserId(userId);
      let vpnConfig;

      if (existing && existing.length > 0) {
        // Update existing config link
        vpnConfig = await VpnConfig.update(existing[0].id, {
          config_link: configLink,
          status: 'active',
        });
      } else {
        vpnConfig = await VpnConfig.create({
          userId,
          subscriptionId,
          panelUserId: panelUsername,
          protocol: config.vpnPanel.type === 'remnawave' ? 'subscription' : 'vless',
          configLink,
          serverTag: 'default',
        });
      }

      logger.info('VPN provisioned', { userId, subscriptionId, panelUsername, configLink });
      return vpnConfig;
    } catch (err) {
      logger.error('VPN provision failed', {
        error: err.message,
        userId,
        status: err.response?.status,
        code: err.code,
      });
      // Don't throw — subscription is still active, VPN can be provisioned later
    }
  },

  /**
   * Get active VPN configs for a user with QR codes.
   */
  async getConfigsForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);
    const adapter = getAdapter();
    let nodeLabelByHost = new Map();
    let defaultNodeLabel = '';

    try {
      const nodes = await adapter.getNodes?.();
      nodeLabelByHost = buildNodeLabelByHost(nodes);
      if (Array.isArray(nodes) && nodes.length === 1) {
        defaultNodeLabel = pickNodeLabel(nodes[0]);
      }
    } catch (err) {
      logger.warn('Failed to load nodes for display labels', { error: err.message });
    }

    return Promise.all(
      configs.map(async (cfg) => {
        let qrCode = null;
        const host = getHostname(cfg.config_link);
        const serverLabel = host
          ? nodeLabelByHost.get(host.toLowerCase()) || defaultNodeLabel
          : defaultNodeLabel;
        if (cfg.config_link) {
          try {
            qrCode = await QRCode.toDataURL(cfg.config_link);
          } catch {
            // QR generation is non-critical
          }
        }
        return { ...cfg, qrCode, server_label: serverLabel };
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
        await adapter.disableUser(cfg.panel_user_id);
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
        await adapter.enableUser(cfg.panel_user_id);
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
        await adapter.extendUser(cfg.panel_user_id, days);
      } catch (err) {
        logger.error('Failed to extend VPN in panel', { configId: cfg.id, error: err.message });
      }
    }
  },

  async getSystemStats() {
    const adapter = getAdapter();
    return adapter.getSystemStats?.();
  },
};

module.exports = VpnService;
