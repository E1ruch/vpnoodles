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

  // ── Database ─────────────────────────────────────────────────────────────
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
  },

  // ── Redis ─────────────────────────────────────────────────────────────────
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
    sessionTtl: parseInt(process.env.SESSION_TTL, 10) || 86400,
  },

  // ── VPN Panel ─────────────────────────────────────────────────────────────
  vpnPanel: {
    url: process.env.VPN_PANEL_URL || '',
    username: process.env.VPN_PANEL_USERNAME || 'admin',
    password: process.env.VPN_PANEL_PASSWORD || '',
    type: process.env.VPN_PANEL_TYPE || 'marzban', // marzban | 3xui | outline
  },

  // ── Payments ──────────────────────────────────────────────────────────────
  payments: {
    starsEnabled: process.env.STARS_ENABLED === 'true',
    yookassa: {
      shopId: process.env.YOOKASSA_SHOP_ID || '',
      secretKey: process.env.YOOKASSA_SECRET_KEY || '',
    },
    cryptomus: {
      apiKey: process.env.CRYPTOMUS_API_KEY || '',
      merchantId: process.env.CRYPTOMUS_MERCHANT_ID || '',
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
