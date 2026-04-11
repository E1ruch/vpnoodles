'use strict';

const QRCode = require('qrcode');
const config = require('../config');
const VpnConfig = require('../models/VpnConfig');
const User = require('../models/User');
const logger = require('../utils/logger');
const adapter = require('./vpn/RemnawaveAdapter');

/** Tag, HWID limit, traffic — synced with Remnawave from plan (and optional VPN_USER_TAG_PREFIX). */
function buildPanelMetaFromPlan(plan) {
  if (!plan) return {};
  const prefix = (config.vpnPanel.userTagPrefix || '').trim();
  const slug = plan.slug != null ? String(plan.slug).trim() : '';
  let tag = '';
  if (prefix && slug) tag = `${prefix}-${slug}`;
  else if (slug) tag = slug;
  else if (prefix) tag = prefix;

  const meta = {};
  if (tag) meta.tag = tag.slice(0, 128);

  const md = plan.max_devices;
  if (md != null && Number.isFinite(Number(md)) && Number(md) > 0) {
    meta.hwidDeviceLimit = Math.min(65535, Math.floor(Number(md)));
  }

  const tb = plan.traffic_bytes;
  if (tb !== undefined && tb !== null) {
    const t = Number(tb);
    if (Number.isFinite(t) && t >= 0) meta.trafficLimitBytes = t;
  }

  if (plan.name) meta.description = `VPNoodles — ${String(plan.name).slice(0, 480)}`;

  return meta;
}

function serverTagFromPanelUser(panelUser, plan) {
  const snap = adapter.snapshotFromUser(panelUser);
  if (snap.tag) return String(snap.tag).slice(0, 64);
  if (plan?.slug) return String(plan.slug).slice(0, 64);
  return 'default';
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

      const panelUsername = `vpn_${user.telegram_id}`;
      const panelMeta = buildPanelMetaFromPlan(plan);

      let configLink = '';
      let panelUser;

      try {
        panelUser = await adapter.getUser(panelUsername);
        await adapter.extendUser(panelUsername, plan.duration_days, panelMeta);
        await adapter.enableUser(panelUsername);
        logger.info('Remnawave user extended', { panelUsername });
      } catch (err) {
        if (err.response?.status === 404) {
          panelUser = await adapter.createUser(
            panelUsername,
            plan.traffic_bytes || 0,
            plan.duration_days,
            String(user.telegram_id),
            panelMeta,
          );
          logger.info('Remnawave user created', { panelUsername });
        } else {
          throw err;
        }
      }

      configLink =
        adapter.subscriptionUrlFromUser(panelUser) || adapter.getSubscriptionUrl(panelUsername);

      const serverTag = serverTagFromPanelUser(panelUser, plan);

      const existing = await VpnConfig.findActiveByUserId(userId);
      let vpnConfig;

      if (existing && existing.length > 0) {
        vpnConfig = await VpnConfig.update(existing[0].id, {
          config_link: configLink,
          status: 'active',
          server_tag: serverTag,
        });
      } else {
        vpnConfig = await VpnConfig.create({
          userId,
          subscriptionId,
          panelUserId: panelUsername,
          protocol: 'subscription',
          configLink,
          serverTag,
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
    }
  },

  /**
   * Get active VPN configs for a user with QR codes.
   */
  async getConfigsForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);
    let nodeLabelByHost = new Map();
    let defaultNodeLabel = '';

    try {
      const nodes = await adapter.getNodes();
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

        let panel_snapshot = null;
        try {
          const panelUser = await adapter.getUser(cfg.panel_user_id);
          panel_snapshot = adapter.snapshotFromUser(panelUser);
        } catch (err) {
          logger.warn('Failed to refresh user from panel', {
            panelUserId: cfg.panel_user_id,
            error: err.message,
          });
        }

        if (cfg.config_link) {
          try {
            qrCode = await QRCode.toDataURL(cfg.config_link);
          } catch {
            // QR generation is non-critical
          }
        }
        return { ...cfg, qrCode, server_label: serverLabel, panel_snapshot };
      }),
    );
  },

  /**
   * Disable all VPN configs for a user (on subscription expiry/cancel).
   */
  async disableForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);

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

    for (const cfg of configs) {
      try {
        await adapter.extendUser(cfg.panel_user_id, days);
      } catch (err) {
        logger.error('Failed to extend VPN in panel', { configId: cfg.id, error: err.message });
      }
    }
  },

  async getSystemStats() {
    return adapter.getSystemStats();
  },
};

module.exports = VpnService;
