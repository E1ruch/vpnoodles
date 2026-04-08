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
    // SSL: set DB_SSL=true only for managed cloud Postgres (RDS, Supabase, etc.)
    // Keep false for local/Docker postgres — it doesn't support SSL by default
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },

  // ── VPN Panel ─────────────────────────────────────────────────────────────
  vpnPanel: {
    type: process.env.VPN_PANEL_TYPE || 'remnawave', // remnawave | marzban | 3xui
    url: process.env.VPN_PANEL_URL || '', // https://your-panel.com (no trailing slash)
    username: process.env.VPN_PANEL_USERNAME || 'admin',
    password: process.env.VPN_PANEL_PASSWORD || '',
    // Public domain for subscription links (can differ from panel URL)
    serverDomain: process.env.VPN_SERVER_DOMAIN || '',
    // Subscription path (Remnawave default: /api/sub, 3x-ui: /sub)
    subPath: process.env.VPN_SUB_PATH || '/api/sub',
    // Legacy / docs only — current Remnawave API uses internal squads (UUIDs), see VPN_INTERNAL_SQUAD_UUIDS
    inboundTags: process.env.VPN_INBOUND_TAGS || '',
    // Remnawave: comma-separated internal squad UUIDs for new users (optional)
    internalSquadUuids: (process.env.VPN_INTERNAL_SQUAD_UUIDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Set true only for self-signed TLS to the panel (default: verify certificate)
    tlsInsecure: process.env.VPN_PANEL_TLS_INSECURE === 'true',
    // 3x-ui specific: inbound ID number
    inboundId: parseInt(process.env.VPN_INBOUND_ID, 10) || 1,
  },

  // ── Payments ──────────────────────────────────────────────────────────────
  payments: {
    starsEnabled: process.env.STARS_ENABLED === 'true',
    yookassa: {
      shopId: process.env.YOOKASSA_SHOP_ID || '',
      secretKey: process.env.YOOKASSA_SECRET_KEY || '',
    },
    // CryptoBot (Crypto Pay) — https://t.me/CryptoBot
    cryptoPay: {
      enabled: process.env.CRYPTO_PAY_ENABLED === 'true',
      token: process.env.CRYPTO_PAY_TOKEN || '',
      url: process.env.CRYPTO_PAY_URL || 'https://pay.crypt.bot',
    },
  },

  // ── Plans ─────────────────────────────────────────────────────────────────
  plans: {
    trialDays: parseInt(process.env.PLAN_TRIAL_DAYS, 10) || 3,
    trialTrafficGb: parseInt(process.env.PLAN_TRIAL_TRAFFIC_GB, 10) || 1,
  },

  // ── Referral ──────────────────────────────────────────────────────────────
  referral: {
    bonusDays: parseInt(process.env.REFERRAL_BONUS_DAYS, 10) || 7,
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  notifications: {
    expiryDaysBefore: parseInt(process.env.NOTIFY_EXPIRY_DAYS_BEFORE, 10) || 3,
  },

  // ── Security ──────────────────────────────────────────────────────────────
  security: {
    jwtSecret: process.env.JWT_SECRET || 'change_me',
    encryptionKey: process.env.ENCRYPTION_KEY || 'change_me_32_chars______________',
  },
};

// ── Validation ────────────────────────────────────────────────────────────────
function validateConfig(cfg) {
  const required = [['telegram.token', cfg.telegram.token]];
  const missing = required.filter(([, val]) => !val).map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file against .env.example',
    );
  }
}

validateConfig(config);

module.exports = config;
