'use strict';

const dayjs = require('dayjs');
const db = require('../database/knex');

const TABLE = 'subscriptions';

const Subscription = {
  // ── Finders ────────────────────────────────────────────────────────────────

  async findById(id) {
    return db(TABLE).where({ id }).first();
  },

  /** Get the current active subscription for a user */
  async findActiveByUserId(userId) {
    return db(TABLE)
      .where({ user_id: userId, status: 'active' })
      .where('expires_at', '>', db.fn.now())
      .orderBy('expires_at', 'desc')
      .first();
  },

  async findAllByUserId(userId) {
    return db(TABLE).where({ user_id: userId }).orderBy('created_at', 'desc');
  },

  // ── Create ─────────────────────────────────────────────────────────────────

  async create({ userId, planId, durationDays, trafficLimitBytes = null, autoRenew = false }) {
    const startsAt = dayjs().toDate();
    const expiresAt = dayjs().add(durationDays, 'day').toDate();

    const [row] = await db(TABLE)
      .insert({
        user_id: userId,
        plan_id: planId,
        status: 'active',
        starts_at: startsAt,
        expires_at: expiresAt,
        traffic_limit_bytes: trafficLimitBytes,
        auto_renew: autoRenew,
      })
      .returning('*');
    return row;
  },

  // ── Update ─────────────────────────────────────────────────────────────────

  async extend(id, days) {
    const sub = await Subscription.findById(id);
    if (!sub) throw new Error(`Subscription ${id} not found`);

    const base = dayjs(sub.expires_at).isAfter(dayjs()) ? dayjs(sub.expires_at) : dayjs();
    const newExpiry = base.add(days, 'day').toDate();

    const [row] = await db(TABLE)
      .where({ id })
      .update({ expires_at: newExpiry, status: 'active', updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async cancel(id) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ status: 'cancelled', updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async expire(id) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ status: 'expired', updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async updateTrafficUsed(id, bytesUsed) {
    return db(TABLE)
      .where({ id })
      .update({ traffic_used_bytes: bytesUsed, updated_at: db.fn.now() });
  },

  async markNotified(id) {
    return db(TABLE).where({ id }).update({ notified_expiry: true, updated_at: db.fn.now() });
  },

  // ── Queries for cron jobs ──────────────────────────────────────────────────

  /** Find subscriptions expiring within N days (for notifications) */
  async findExpiringIn(days) {
    const from = dayjs().toDate();
    const to = dayjs().add(days, 'day').toDate();
    return db(TABLE)
      .where({ status: 'active', notified_expiry: false })
      .whereBetween('expires_at', [from, to]);
  },

  /** Find all expired but still marked active */
  async findExpiredActive() {
    return db(TABLE).where({ status: 'active' }).where('expires_at', '<', db.fn.now());
  },

  // ── Stats ──────────────────────────────────────────────────────────────────

  async countActive() {
    const [{ count }] = await db(TABLE).where({ status: 'active' }).count('id as count');
    return parseInt(count, 10);
  },
};

module.exports = Subscription;
