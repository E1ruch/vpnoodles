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
    const [row] = await db(TABLE).where({ id }).update(fields).returning('*');
    return row;
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
