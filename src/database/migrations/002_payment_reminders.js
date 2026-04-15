'use strict';

/**
 * Migration — adds reminder tracking fields to payments table
 *
 * Fields:
 * - reminder_30_sent_at: timestamp when 30-min reminder was sent
 * - reminder_50_sent_at: timestamp when 50-min reminder was sent
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('payments', (t) => {
    t.timestamp('reminder_30_sent_at').nullable();
    t.timestamp('reminder_50_sent_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('payments', (t) => {
    t.dropColumn('reminder_30_sent_at');
    t.dropColumn('reminder_50_sent_at');
  });
};
