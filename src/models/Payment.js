'use strict';

const db = require('../database/knex');

const TABLE = 'payments';

const Payment = {
  async findById(id) {
    return db(TABLE).where({ id }).first();
  },

  async findByProviderPaymentId(providerPaymentId) {
    return db(TABLE).where({ provider_payment_id: providerPaymentId }).first();
  },

  async findAllByUserId(userId) {
    return db(TABLE).where({ user_id: userId }).orderBy('created_at', 'desc');
  },

  async create({
    userId,
    planId,
    subscriptionId = null,
    provider,
    providerPaymentId = null,
    amount,
    currency = 'XTR',
    metadata = {},
  }) {
    const [row] = await db(TABLE)
      .insert({
        user_id: userId,
        plan_id: planId,
        subscription_id: subscriptionId,
        provider,
        provider_payment_id: providerPaymentId,
        status: 'pending',
        amount,
        currency,
        metadata: JSON.stringify(metadata),
      })
      .returning('*');
    return row;
  },

  async markPaid(id, providerPaymentId = null) {
    const fields = { status: 'paid', updated_at: db.fn.now() };
    if (providerPaymentId) fields.provider_payment_id = providerPaymentId;
    // Atomic update: only mark as paid if currently pending
    const [row] = await db(TABLE).where({ id, status: 'pending' }).update(fields).returning('*');
    return row;
  },

  /**
   * Atomically mark payment as paid. Returns null if already processed.
   * Prevents duplicate processing from webhook + polling.
   */
  async markPaidIfPending(id, providerPaymentId = null) {
    const fields = { status: 'paid', updated_at: db.fn.now() };
    if (providerPaymentId) fields.provider_payment_id = providerPaymentId;
    const [row] = await db(TABLE).where({ id, status: 'pending' }).update(fields).returning('*');
    return row || null;
  },

  async markFailed(id) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ status: 'failed', updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async markRefunded(id) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ status: 'refunded', updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async update(id, fields) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ ...fields, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async findPendingByProvider(provider) {
    return db(TABLE)
      .where({ provider, status: 'pending' })
      .whereNotNull('provider_payment_id')
      .orderBy('created_at', 'asc');
  },

  async findRecentPaidByProvider(provider, minutes = 2) {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return db(TABLE)
      .where({ provider, status: 'paid' })
      .where('updated_at', '>=', since)
      .orderBy('updated_at', 'desc');
  },

  // ── Payment Reminders ────────────────────────────────────────────────────────

  /**
   * Find pending payments that need 30-minute reminder.
   * Created 30-50 minutes ago, reminder not sent yet.
   */
  async findPendingFor30MinReminder() {
    const now = new Date();
    const minAge = new Date(now - 50 * 60 * 1000); // 50 min ago
    const maxAge = new Date(now - 30 * 60 * 1000); // 30 min ago

    return db(TABLE)
      .where({ status: 'pending' })
      .where('created_at', '<=', maxAge)
      .where('created_at', '>=', minAge)
      .whereNull('reminder_30_sent_at');
  },

  /**
   * Find pending payments that need 50-minute reminder.
   * Created 50-60 minutes ago, reminder not sent yet.
   */
  async findPendingFor50MinReminder() {
    const now = new Date();
    const minAge = new Date(now - 60 * 60 * 1000); // 60 min ago
    const maxAge = new Date(now - 50 * 60 * 1000); // 50 min ago

    return db(TABLE)
      .where({ status: 'pending' })
      .where('created_at', '<=', maxAge)
      .where('created_at', '>=', minAge)
      .whereNull('reminder_50_sent_at');
  },

  /**
   * Find pending payments that are expired (60+ minutes old).
   */
  async findExpiredPending() {
    const threshold = new Date(Date.now() - 60 * 60 * 1000);
    return db(TABLE).where({ status: 'pending' }).where('created_at', '<=', threshold);
  },

  /**
   * Find active pending payment for a user.
   * Returns the most recent pending payment or null.
   */
  async findPendingByUserId(userId) {
    return db(TABLE)
      .where({ user_id: userId, status: 'pending' })
      .orderBy('created_at', 'desc')
      .first();
  },

  /**
   * Find pending payment for a user by provider.
   * Returns the most recent pending payment for this provider or null.
   */
  async findPendingByUserIdAndProvider(userId, provider) {
    return db(TABLE)
      .where({ user_id: userId, provider, status: 'pending' })
      .orderBy('created_at', 'desc')
      .first();
  },

  /**
   * Mark 30-minute reminder as sent.
   * Uses atomic update to prevent race conditions.
   * @returns {boolean} true if updated, false if already sent
   */
  async markReminder30Sent(id) {
    const result = await db(TABLE)
      .where({ id, reminder_30_sent_at: null })
      .update({ reminder_30_sent_at: db.fn.now(), updated_at: db.fn.now() });
    return result > 0;
  },

  /**
   * Mark 50-minute reminder as sent.
   * Uses atomic update to prevent race conditions.
   * @returns {boolean} true if updated, false if already sent
   */
  async markReminder50Sent(id) {
    const result = await db(TABLE)
      .where({ id, reminder_50_sent_at: null })
      .update({ reminder_50_sent_at: db.fn.now(), updated_at: db.fn.now() });
    return result > 0;
  },

  /**
   * Cancel expired payment atomically.
   * Only cancels if status is still 'pending'.
   * @returns {object|null} updated payment or null if already processed
   */
  async cancelIfPending(id) {
    const [row] = await db(TABLE)
      .where({ id, status: 'pending' })
      .update({ status: 'canceled', updated_at: db.fn.now() })
      .returning('*');
    return row || null;
  },

  // ── Stats ──────────────────────────────────────────────────────────────────

  async totalRevenue(currency = 'RUB') {
    const [{ sum }] = await db(TABLE).where({ status: 'paid', currency }).sum('amount as sum');
    return parseInt(sum || 0, 10);
  },

  async countByStatus(status) {
    const [{ count }] = await db(TABLE).where({ status }).count('id as count');
    return parseInt(count, 10);
  },
};

module.exports = Payment;
