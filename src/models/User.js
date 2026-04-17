'use strict';

const db = require('../database/knex');

const TABLE = 'users';

const User = {
  // ── Finders ────────────────────────────────────────────────────────────────

  async findById(id) {
    return db(TABLE).where({ id }).first();
  },

  async findByTelegramId(telegramId) {
    return db(TABLE).where({ telegram_id: telegramId }).first();
  },

  // ── Create / Update ────────────────────────────────────────────────────────

  /**
   * Upsert a user from Telegram context.
   * Returns the user row (created or updated).
   */
  async upsert({ telegramId, username, firstName, lastName, languageCode, referredBy }) {
    const existing = await User.findByTelegramId(telegramId);

    if (existing) {
      const updates = {
        username: username || existing.username,
        first_name: firstName || existing.first_name,
        last_name: lastName || existing.last_name,
        language_code: languageCode || existing.language_code,
        updated_at: db.fn.now(),
      };

      // Allow attaching a referrer later, but only once and never self-referral.
      if (!existing.referred_by && referredBy && Number(referredBy) !== Number(existing.id)) {
        updates.referred_by = referredBy;
      }

      const [updated] = await db(TABLE)
        .where({ telegram_id: telegramId })
        .update(updates)
        .returning('*');
      return updated;
    }

    const [created] = await db(TABLE)
      .insert({
        telegram_id: telegramId,
        username,
        first_name: firstName,
        last_name: lastName,
        language_code: languageCode || 'ru',
        referred_by: referredBy || null,
      })
      .returning('*');
    return created;
  },

  async update(id, fields) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ ...fields, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async ban(id) {
    return User.update(id, { status: 'banned' });
  },

  async unban(id) {
    return User.update(id, { status: 'active' });
  },

  async markTrialUsed(id) {
    return User.update(id, { trial_used_at: db.fn.now() });
  },

  async incrementReferralCount(id) {
    return db(TABLE).where({ id }).increment('referral_count', 1);
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async count() {
    const [{ count }] = await db(TABLE).count('id as count');
    return parseInt(count, 10);
  },

  async listPaginated({ page = 1, limit = 20, status } = {}) {
    const query = db(TABLE).orderBy('created_at', 'desc');
    if (status) query.where({ status });
    return query.limit(limit).offset((page - 1) * limit);
  },

  async hasUsedTrial(id) {
    const user = await User.findById(id);
    return !!user?.trial_used_at;
  },

  async setReferrer(id, referrerTelegramId) {
    // Only set if not already set
    const user = await User.findById(id);
    if (!user || user.referred_by) return;
    const referrer = await User.findByTelegramId(referrerTelegramId);
    if (!referrer) return;
    await User.update(id, { referred_by: referrer.id });

    const insertedRows = await db('referrals')
      .insert({
        referrer_id: referrer.id,
        referred_id: id,
        bonus_days: 0,
      })
      .onConflict(['referrer_id', 'referred_id'])
      .ignore()
      .returning('id');

    if (Array.isArray(insertedRows) && insertedRows.length > 0) {
      await User.incrementReferralCount(referrer.id);
    }
  },
};

module.exports = User;
