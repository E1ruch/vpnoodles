'use strict';

/**
 * Seed default plans into the database.
 * Usage: node src/database/seed.js
 */

require('dotenv').config();
const db = require('./knex');
const logger = require('../utils/logger');

const defaultPlans = [
  {
    name: '🎁 Пробный',
    slug: 'trial',
    duration_days: 3,
    traffic_bytes: 1 * 1024 * 1024 * 1024, // 1 GB
    price_stars: 0,
    price_rub: 0,
    price_usd: 0,
    max_devices: 1,
    is_active: true,
    is_trial: true,
    sort_order: 0,
  },
  {
    name: '🔹 Базовый — 1 месяц',
    slug: 'basic_1m',
    duration_days: 30,
    traffic_bytes: null, // unlimited
    price_stars: 150,
    price_rub: 14900, // 149 RUB
    price_usd: 199, // $1.99
    max_devices: 1,
    is_active: true,
    is_trial: false,
    sort_order: 1,
  },
  {
    name: '🔷 Стандарт — 3 месяца',
    slug: 'standard_3m',
    duration_days: 90,
    traffic_bytes: null,
    price_stars: 400,
    price_rub: 39900, // 399 RUB
    price_usd: 499, // $4.99
    max_devices: 2,
    is_active: true,
    is_trial: false,
    sort_order: 2,
  },
  {
    name: '💎 Про — 6 месяцев',
    slug: 'pro_6m',
    duration_days: 180,
    traffic_bytes: null,
    price_stars: 700,
    price_rub: 69900, // 699 RUB
    price_usd: 899, // $8.99
    max_devices: 5,
    is_active: true,
    is_trial: false,
    sort_order: 3,
  },
  {
    name: '🏆 Годовой',
    slug: 'annual',
    duration_days: 365,
    traffic_bytes: null,
    price_stars: 1200,
    price_rub: 119900, // 1199 RUB
    price_usd: 1499, // $14.99
    max_devices: 10,
    is_active: true,
    is_trial: false,
    sort_order: 4,
  },
];

async function run() {
  try {
    logger.info('Seeding plans...');

    for (const plan of defaultPlans) {
      await db('plans')
        .insert(plan)
        .onConflict('slug')
        .merge([
          'name',
          'duration_days',
          'traffic_bytes',
          'price_stars',
          'price_rub',
          'price_usd',
          'max_devices',
          'sort_order',
          'updated_at',
        ]);
    }

    logger.info(`✅ Seeded ${defaultPlans.length} plans`);
  } catch (err) {
    logger.error('Seed failed', { error: err.message });
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

run();
