'use strict';

const QRCode = require('qrcode');
const config = require('../config');
const VpnConfig = require('../models/VpnConfig');
const User = require('../models/User');
const logger = require('../utils/logger');
const adapter = require('./vpn/RemnawaveAdapter');

/**
 * Build panel meta (tag, description, trafficLimitBytes) from a plan object.
 * For trial plans — use the dedicated trial tag from config.
 */
function buildPanelMeta(plan, isTrial = false) {
  const meta = {};

  // Tag: trial plans get a dedicated tag; paid plans get prefix-slug tag
  // IMPORTANT: Remnawave requires tags in UPPERCASE (only A-Z, 0-9, underscore)
  if (isTrial) {
    const trialTag = config.vpnPanel.trialTag || 'TRIAL_USER';
    if (trialTag) meta.tag = String(trialTag).toUpperCase();
  } else {
    const prefix = (config.vpnPanel.userTagPrefix || '').trim().toUpperCase();
    const slug = plan?.slug ? String(plan.slug).trim().toUpperCase() : '';
    // Use underscore instead of hyphen (Remnawave allows only A-Z, 0-9, _)
    if (prefix && slug) meta.tag = `${prefix}_${slug}`.replace(/-/g, '_').slice(0, 128);
    else if (slug) meta.tag = slug.replace(/-/g, '_').slice(0, 128);
    else if (prefix) meta.tag = prefix.replace(/-/g, '_').slice(0, 128);
  }

  // Traffic limit: null = unlimited, so we pass 0 (Remnawave treats 0 as unlimited)
  if (plan?.traffic_bytes !== undefined && plan.traffic_bytes !== null) {
    const t = Number(plan.traffic_bytes);
    if (Number.isFinite(t) && t >= 0) meta.trafficLimitBytes = t;
  } else {
    // Unlimited plan — explicitly set to 0 (unlimited in Remnawave)
    meta.trafficLimitBytes = 0;
  }

  // Device limit
  if (plan?.max_devices !== undefined && plan.max_devices !== null) {
    const d = Number(plan.max_devices);
    if (Number.isFinite(d) && d >= 0) meta.hwidDeviceLimit = d;
  }

  // Description
  if (plan?.name) {
    meta.description = `VPNoodles — ${String(plan.name).slice(0, 480)}`;
  }

  return meta;
}

/**
 * Check if the VPN panel is configured.
 * Returns false (and logs a warning) if URL is missing or still a placeholder.
 */
function isPanelConfigured() {
  const url = config.vpnPanel.url || '';
  return url.length > 0 && !url.includes('your-');
}

const VpnService = {
  /**
   * Provision a new VPN config for a user after subscription activation.
   *
   * @param {number} userId
   * @param {number} subscriptionId
   * @param {object} plan           - plan row from DB (duration_days, traffic_bytes, slug, name)
   * @param {boolean} [isTrial]     - true → assign trial tag in Remnawave
   */
  async provision(userId, subscriptionId, plan, isTrial = false) {
    if (!isPanelConfigured()) {
      logger.warn('VPN panel not configured — skipping provision', { userId });
      return null;
    }

    const user = await User.findById(userId);
    if (!user) throw new Error(`User not found: ${userId}`);

    const panelUsername = `vpn_${user.telegram_id}`;
    const panelMeta = buildPanelMeta(plan, isTrial);

    let panelUser;

    try {
      // Try to get existing panel user
      panelUser = await adapter.getUser(panelUsername);

      // Reset traffic on renewal (so user starts fresh with new plan)
      try {
        await adapter.resetUserTraffic(panelUsername);
        logger.info('Remnawave user traffic reset', { panelUsername });
      } catch (resetErr) {
        logger.warn('Failed to reset traffic (non-critical)', {
          panelUsername,
          error: resetErr.message,
        });
      }

      // User exists — extend expiry and sync meta (tag, traffic) in one PATCH
      panelUser = await adapter.extendUser(panelUsername, plan.duration_days, {
        ...panelMeta,
        status: 'ACTIVE',
      });
      logger.info('Remnawave user extended', { panelUsername, tag: panelMeta.tag });
    } catch (err) {
      if (err.response?.status === 404) {
        // User doesn't exist — create new
        panelUser = await adapter.createUser(
          panelUsername,
          plan.traffic_bytes || 0,
          plan.duration_days,
          String(user.telegram_id),
          panelMeta,
        );
        logger.info('Remnawave user created', { panelUsername, tag: panelMeta.tag });
      } else {
        // Unexpected error — log and rethrow
        logger.error('Remnawave provision failed', {
          panelUsername,
          status: err.response?.status,
          message: err.message,
        });
        throw err;
      }
    }

    // Get subscription URL (prefer panel-provided URL)
    const configLink =
      adapter.subscriptionUrlFromUser(panelUser) || adapter.getSubscriptionUrl(panelUsername);

    if (!configLink) {
      logger.warn('VPN config link is empty after provision', { panelUsername });
    }

    // Save or update vpn_config in DB
    const existing = await VpnConfig.findActiveByUserId(userId);
    let vpnConfig;

    if (existing && existing.length > 0) {
      vpnConfig = await VpnConfig.update(existing[0].id, {
        config_link: configLink,
        status: 'active',
        server_tag: panelMeta.tag || 'default',
      });
    } else {
      vpnConfig = await VpnConfig.create({
        userId,
        subscriptionId,
        panelUserId: panelUsername,
        protocol: 'subscription',
        configLink,
        serverTag: panelMeta.tag || 'default',
      });
    }

    logger.info('VPN provisioned', {
      userId,
      subscriptionId,
      panelUsername,
      tag: panelMeta.tag,
      configLink,
    });

    return vpnConfig;
  },

  /**
   * Get active VPN configs for a user, enriched with QR code and panel snapshot.
   */
  async getConfigsForUser(userId) {
    const configs = await VpnConfig.findActiveByUserId(userId);

    return Promise.all(
      configs.map(async (cfg) => {
        let qrCode = null;
        let panel_snapshot = null;

        // Fetch live stats from panel (non-critical)
        if (isPanelConfigured() && cfg.panel_user_id) {
          try {
            const panelUser = await adapter.getUser(cfg.panel_user_id);
            panel_snapshot = adapter.snapshotFromUser(panelUser);
          } catch (err) {
            logger.warn('Failed to fetch panel snapshot', {
              panelUserId: cfg.panel_user_id,
              error: err.message,
            });
          }
        }

        // Generate QR code (non-critical)
        if (cfg.config_link) {
          try {
            qrCode = await QRCode.toDataURL(cfg.config_link);
          } catch {
            // QR generation is non-critical
          }
        }

        return { ...cfg, qrCode, panel_snapshot };
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
        if (isPanelConfigured()) {
          await adapter.disableUser(cfg.panel_user_id);
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

    for (const cfg of configs) {
      try {
        if (isPanelConfigured()) {
          await adapter.enableUser(cfg.panel_user_id);
        }
        await VpnConfig.enable(cfg.id);
      } catch (err) {
        logger.error('Failed to enable VPN config', { configId: cfg.id, error: err.message });
      }
    }
  },

  /**
   * Extend VPN user expiry in the panel (used by cron for renewals).
   */
  async extendInPanel(userId, days) {
    if (!isPanelConfigured()) return;
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
    if (!isPanelConfigured()) return null;
    return adapter.getSystemStats();
  },
};

module.exports = VpnService;
