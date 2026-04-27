'use strict';

require('dotenv').config();

const config = {
  // ── App ──────────────────────────────────────────────────────────────────
  app: {
    env: process.env.NODE_ENV || 'development',
    isDev: (process.env.NODE_ENV || 'development') === 'development',
    isProd: process.env.NODE_ENV === 'production',
    logLevel: process.env.LOG_LEVEL || 'info',
    port: parseInt(process.env.PORT, 10) || 3000,
  },

  // ── Telegram ─────────────────────────────────────────────────────────────
  telegram: {
    token: process.env.BOT_TOKEN,
    username: process.env.BOT_USERNAME || 'vpnoodles_bot',
    adminIds: (process.env.ADMIN_IDS || '')
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter(Boolean),
    mode: process.env.BOT_MODE || 'polling', // polling | webhook
    webhookDomain: process.env.WEBHOOK_DOMAIN || '',
  },

  // ── Database (PostgreSQL) ─────────────────────────────────────────────────
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'vpnoodles',
    user: process.env.DB_USER || 'vpnoodles_user',
    password: process.env.DB_PASSWORD || '',
    pool: {
      min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
      max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
    },
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },

  // ── VPN Panel — Remnawave ─────────────────────────────────────────────────
  vpnPanel: {
    url: (process.env.VPN_PANEL_URL || '').replace(/\/+$/, ''),

    // ── Auth: API Token (preferred) ──────────────────────────────────────
    // Get from Remnawave panel → Settings → API Tokens
    // If set, username/password are NOT used (token auth is more reliable)
    apiToken: process.env.VPN_API_TOKEN || '',

    // Fallback: username/password login (used only if VPN_API_TOKEN is empty)
    username: process.env.VPN_PANEL_USERNAME || 'admin',
    password: process.env.VPN_PANEL_PASSWORD || '',

    // ── Subscription URL ─────────────────────────────────────────────────
    // Public domain for subscription links (can differ from panel URL)
    // e.g. https://sub.yourdomain.com
    serverDomain: (process.env.VPN_SERVER_DOMAIN || '').replace(/\/+$/, ''),
    // Subscription path — Remnawave default: /api/sub
    subPath: process.env.VPN_SUB_PATH || '/api/sub',

    // ── TLS ──────────────────────────────────────────────────────────────
    // Set true only if your panel uses a self-signed certificate
    tlsInsecure: process.env.VPN_TLS_INSECURE === 'true',

    // ── Trial tag ────────────────────────────────────────────────────────
    // Tag assigned to trial users in Remnawave (for filtering in panel)
    trialTag: process.env.TRIAL_REMNAWAVE_TAG || 'trial_user',

    // ── User tag prefix ──────────────────────────────────────────────────
    // Optional prefix for plan tags in Remnawave, e.g. "vpnoodles"
    // Result: "vpnoodles-basic_1m"
    userTagPrefix: process.env.VPN_USER_TAG_PREFIX || '',
    defaultSquad: process.env.VPN_DEFAULT_SQUAD || '', // Optional default squad for new users in Remnawave
  },

  // ── Payments ──────────────────────────────────────────────────────────────
  payments: {
    starsEnabled: process.env.STARS_ENABLED === 'true',

    // CryptoBot (Crypto Pay) — https://t.me/CryptoBot → /pay → Create App
    cryptoPay: {
      enabled: process.env.CRYPTO_PAY_ENABLED === 'true',
      token: process.env.CRYPTO_PAY_TOKEN || '',
      url: process.env.CRYPTO_PAY_URL || 'https://pay.crypt.bot',
    },

    // YooKassa (optional)
    yookassa: {
      enabled: process.env.YOOKASSA_ENABLED === 'true',
      shopId: process.env.YOOKASSA_SHOP_ID || '',
      secretKey: process.env.YOOKASSA_SECRET_KEY || '',
    },
  },

  // ── Trial ─────────────────────────────────────────────────────────────────
  plans: {
    trialDays: parseInt(process.env.PLAN_TRIAL_DAYS, 10) || 7,
    trialTrafficGb: parseInt(process.env.PLAN_TRIAL_TRAFFIC_GB, 10) || 10,
  },

  // ── Referral ──────────────────────────────────────────────────────────────
  referral: {
    bonusDays: parseInt(process.env.REFERRAL_BONUS_DAYS, 10) || 7,
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  notifications: {
    expiryDaysBefore: parseInt(process.env.NOTIFY_EXPIRY_DAYS_BEFORE, 10) || 3,
    trafficThreshold80: parseInt(process.env.NOTIFY_TRAFFIC_THRESHOLD_80, 10) || 80,
    deviceLimitEnabled: process.env.NOTIFY_DEVICE_LIMIT_ENABLED !== 'false',
  },

  // ── Support ──────────────────────────────────────────────────────────────
  supportText:
    process.env.SUPPORT_TEXT || '📞 Для связи с поддержкой напишите @your_support_username',

  support: {
    groupLink: process.env.SUPPORT_GROUP_LINK || 'https://t.me/vpnoodles',
    websiteLink: process.env.SUPPORT_WEBSITE_LINK || 'https://vpnoodles.ru',
  },

  // ── Security ──────────────────────────────────────────────────────────────
  security: {
    jwtSecret: process.env.JWT_SECRET || 'change_me',
    encryptionKey: process.env.ENCRYPTION_KEY || 'change_me_32_chars______________',
  },
};

// ── Validation ────────────────────────────────────────────────────────────────
function validateConfig(cfg) {
  const required = [['BOT_TOKEN', cfg.telegram.token]];
  const missing = required.filter(([, val]) => !val).map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file against .env.example',
    );
  }

  // Warn about unconfigured VPN panel (non-fatal — bot can run without it)
  if (!cfg.vpnPanel.url || cfg.vpnPanel.url.includes('your-')) {
    console.warn(
      '[config] WARNING: VPN_PANEL_URL is not configured. VPN provisioning will be skipped.',
    );
  }

  const hasAuth = cfg.vpnPanel.apiToken || (cfg.vpnPanel.username && cfg.vpnPanel.password);
  if (cfg.vpnPanel.url && !hasAuth) {
    console.warn(
      '[config] WARNING: VPN panel URL is set but no auth configured. Set VPN_API_TOKEN or VPN_PANEL_USERNAME+VPN_PANEL_PASSWORD.',
    );
  }
}

validateConfig(config);

module.exports = config;
