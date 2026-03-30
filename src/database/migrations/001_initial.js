'use strict';

/**
 * Initial migration — creates all core tables:
 *  users, plans, subscriptions, payments, referrals, vpn_configs, audit_logs
 */

exports.up = async function (knex) {
  // ── users ──────────────────────────────────────────────────────────────────
  await knex.schema.createTable('users', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('telegram_id').notNullable().unique();
    t.string('username', 64);
    t.string('first_name', 128);
    t.string('last_name', 128);
    t.string('language_code', 8).defaultTo('ru');
    t.string('status', 32).notNullable().defaultTo('active'); // active | banned | deleted
    t.boolean('is_admin').notNullable().defaultTo(false);
    t.bigInteger('referred_by').references('id').inTable('users').onDelete('SET NULL');
    t.integer('referral_count').notNullable().defaultTo(0);
    t.timestamp('trial_used_at');
    t.timestamps(true, true); // created_at, updated_at
  });

  // ── plans ──────────────────────────────────────────────────────────────────
  await knex.schema.createTable('plans', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable(); // e.g. "Basic", "Pro", "Trial"
    t.string('slug', 32).notNullable().unique(); // e.g. "basic", "pro", "trial"
    t.integer('duration_days').notNullable(); // subscription length
    t.bigInteger('traffic_bytes'); // null = unlimited
    t.integer('price_stars').notNullable().defaultTo(0); // Telegram Stars
    t.integer('price_rub').notNullable().defaultTo(0); // RUB (kopecks)
    t.integer('price_usd').notNullable().defaultTo(0); // USD (cents)
    t.integer('max_devices').notNullable().defaultTo(1);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('is_trial').notNullable().defaultTo(false);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  // ── subscriptions ──────────────────────────────────────────────────────────
  await knex.schema.createTable('subscriptions', (t) => {
    t.increments('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('plan_id').notNullable().references('id').inTable('plans').onDelete('RESTRICT');
    t.string('status', 32).notNullable().defaultTo('active'); // active | expired | cancelled | pending
    t.timestamp('starts_at').notNullable();
    t.timestamp('expires_at').notNullable();
    t.bigInteger('traffic_used_bytes').notNullable().defaultTo(0);
    t.bigInteger('traffic_limit_bytes'); // null = unlimited
    t.boolean('auto_renew').notNullable().defaultTo(false);
    t.boolean('notified_expiry').notNullable().defaultTo(false);
    t.timestamps(true, true);

    t.index(['user_id', 'status']);
    t.index('expires_at');
  });

  // ── payments ───────────────────────────────────────────────────────────────
  await knex.schema.createTable('payments', (t) => {
    t.increments('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('plan_id').references('id').inTable('plans').onDelete('SET NULL');
    t.integer('subscription_id').references('id').inTable('subscriptions').onDelete('SET NULL');
    t.string('provider', 32).notNullable(); // stars | yookassa | cryptomus | manual
    t.string('provider_payment_id', 256); // external payment ID
    t.string('status', 32).notNullable().defaultTo('pending'); // pending | paid | failed | refunded
    t.integer('amount').notNullable(); // in smallest unit (kopecks / cents / stars)
    t.string('currency', 8).notNullable().defaultTo('XTR'); // XTR=Stars, RUB, USD
    t.jsonb('metadata').defaultTo('{}');
    t.timestamps(true, true);

    t.index(['user_id', 'status']);
    t.index('provider_payment_id');
  });

  // ── referrals ──────────────────────────────────────────────────────────────
  await knex.schema.createTable('referrals', (t) => {
    t.increments('id').primary();
    t.bigInteger('referrer_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('referred_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('bonus_days').notNullable().defaultTo(0);
    t.boolean('bonus_applied').notNullable().defaultTo(false);
    t.timestamp('bonus_applied_at');
    t.timestamps(true, true);

    t.unique(['referrer_id', 'referred_id']);
  });

  // ── vpn_configs ────────────────────────────────────────────────────────────
  await knex.schema.createTable('vpn_configs', (t) => {
    t.increments('id').primary();
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('subscription_id').references('id').inTable('subscriptions').onDelete('SET NULL');
    t.string('panel_user_id', 256); // ID in VPN panel (Marzban/3x-ui)
    t.string('protocol', 32).notNullable().defaultTo('vless'); // vless | vmess | trojan | ss
    t.text('config_link'); // vless:// or vmess:// link
    t.text('config_json'); // full JSON config
    t.string('server_tag', 64); // which server/inbound
    t.string('status', 32).notNullable().defaultTo('active'); // active | disabled | deleted
    t.timestamps(true, true);

    t.index(['user_id', 'status']);
  });

  // ── audit_logs ─────────────────────────────────────────────────────────────
  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 128).notNullable();
    t.jsonb('payload').defaultTo('{}');
    t.string('ip', 64);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['user_id', 'action']);
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('vpn_configs');
  await knex.schema.dropTableIfExists('referrals');
  await knex.schema.dropTableIfExists('payments');
  await knex.schema.dropTableIfExists('subscriptions');
  await knex.schema.dropTableIfExists('plans');
  await knex.schema.dropTableIfExists('users');
};
