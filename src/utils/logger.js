'use strict';

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const config = require('../config');

const { combine, timestamp, printf, colorize, errors, json } = format;

// ── Human-readable format for development ────────────────────────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}] ${stack || message}${metaStr}`;
  }),
);

// ── JSON format for production (structured logging) ───────────────────────────
const prodFormat = combine(timestamp(), errors({ stack: true }), json());

// ── Transports ────────────────────────────────────────────────────────────────
const logTransports = [new transports.Console()];

if (config.app.isProd) {
  logTransports.push(
    new transports.DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d',
      zippedArchive: true,
    }),
    new transports.DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),
  );
}

const logger = createLogger({
  level: config.app.logLevel,
  format: config.app.isDev ? devFormat : prodFormat,
  transports: logTransports,
  exitOnError: false,
});

// ── Message logging helpers ─────────────────────────────────────────────────

/**
 * Log a bot message sent to user.
 * Helps answer: "why did user receive/not receive a message?"
 *
 * @param {string} eventName - e.g., 'payment_success', 'trial_activated'
 * @param {object} context - { userId, paymentId, subscriptionId, etc. }
 * @param {object} messageInfo - { text: string (first 100 chars), buttons: string[] }
 */
logger.logMessage = (eventName, context, messageInfo = {}) => {
  const { userId, paymentId, subscriptionId, telegramId } = context;
  const { text, buttons, chatId } = messageInfo;

  logger.info(`MESSAGE_SENT: ${eventName}`, {
    eventName,
    userId,
    telegramId,
    paymentId,
    subscriptionId,
    chatId,
    textPreview: text ? text.substring(0, 100) : undefined,
    buttons: buttons || undefined,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Log a notification attempt (with idempotency check result).
 *
 * @param {string} type - notification type
 * @param {object} context - { userId, key, created (from idempotency check) }
 * @param {boolean} sent - whether message was actually sent
 */
logger.logNotification = (type, context, sent) => {
  const { userId, key, created } = context;

  logger.info(`NOTIFICATION: ${type}`, {
    type,
    userId,
    key,
    created,
    sent,
    timestamp: new Date().toISOString(),
  });
};

module.exports = logger;
