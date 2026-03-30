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

module.exports = logger;
