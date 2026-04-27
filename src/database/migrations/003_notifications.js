'use strict';

/**
 * Migration — creates notifications table for deduplication
 *
 * This table tracks all sent notifications to prevent duplicates.
 * Each notification type has a unique key per user/subscription.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('notifications', (t) => {
    t.bigIncrements('id').primary();

    // Who receives the notification
    t.bigInteger('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');

    // Notification type: trial_expired, subscription_expiring, traffic_limit, device_limit, etc.
    t.string('type', 64).notNullable();

    // Unique key for deduplication (e.g., subscription_id, or composite key)
    t.string('key', 128).notNullable();

    // When notification was sent
    t.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());

    // Additional metadata (JSON)
    t.jsonb('metadata').defaultTo('{}');

    // Unique constraint: one notification of type per key per user
    t.unique(['user_id', 'type', 'key']);

    // Indexes for common queries
    t.index(['user_id', 'type']);
    t.index('sent_at');
  });

  // Add trial notification tracking to subscriptions table
  // This is for quick lookup without joining notifications table
  await knex.schema.alterTable('subscriptions', (t) => {
    t.boolean('notified_trial_expired').notNullable().defaultTo(false);
    t.boolean('notified_traffic_80').notNullable().defaultTo(false);
    t.boolean('notified_traffic_100').notNullable().defaultTo(false);
    t.boolean('notified_device_limit').notNullable().defaultTo(false);
  });

  // Add trial start time to users (for more precise trial expiry tracking)
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('trial_started_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('trial_started_at');
  });

  await knex.schema.alterTable('subscriptions', (t) => {
    t.dropColumn('notified_trial_expired');
    t.dropColumn('notified_traffic_80');
    t.dropColumn('notified_traffic_100');
    t.dropColumn('notified_device_limit');
  });

  await knex.schema.dropTableIfExists('notifications');
};
