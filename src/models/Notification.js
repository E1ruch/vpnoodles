'use strict';

const db = require('../database/knex');

const TABLE = 'notifications';

const Notification = {
  /**
   * Check if a notification was already sent.
   * @param {number} userId
   * @param {string} type - notification type (trial_expired, subscription_expiring, etc.)
   * @param {string} key - unique key (e.g., subscription_id, 'trial')
   * @returns {Promise<boolean>}
   */
  async wasSent(userId, type, key) {
    const row = await db(TABLE).where({ user_id: userId, type, key }).first();
    return !!row;
  },

  /**
   * Mark notification as sent (idempotent).
   * Uses ON CONFLICT to handle race conditions.
   * @param {number} userId
   * @param {string} type
   * @param {string} key
   * @param {object} metadata - optional metadata
   * @returns {Promise<boolean>} true if newly inserted, false if already exists
   */
  async markSent(userId, type, key, metadata = {}) {
    try {
      await db(TABLE)
        .insert({
          user_id: userId,
          type,
          key,
          metadata: JSON.stringify(metadata),
        })
        .onConflict(['user_id', 'type', 'key'])
        .ignore();
      return true;
    } catch (err) {
      // If insert failed, notification already exists
      return false;
    }
  },

  /**
   * Atomically mark notification as sent if not already.
   * Returns true if the notification was newly created.
   * @param {number} userId
   * @param {string} type
   * @param {string} key
   * @param {object} metadata
   * @returns {Promise<{created: boolean, record: object|null}>}
   */
  async createIfNotExists(userId, type, key, metadata = {}) {
    const existing = await db(TABLE).where({ user_id: userId, type, key }).first();

    if (existing) {
      return { created: false, record: existing };
    }

    try {
      const [record] = await db(TABLE)
        .insert({
          user_id: userId,
          type,
          key,
          metadata: JSON.stringify(metadata),
        })
        .returning('*');
      return { created: true, record };
    } catch (err) {
      // Race condition: another process inserted it
      const existing = await db(TABLE).where({ user_id: userId, type, key }).first();
      return { created: false, record: existing };
    }
  },

  /**
   * Get all notifications for a user.
   * @param {number} userId
   * @param {object} opts - filter options
   * @returns {Promise<array>}
   */
  async findByUserId(userId, { type, limit = 50 } = {}) {
    const query = db(TABLE).where({ user_id: userId }).orderBy('sent_at', 'desc').limit(limit);

    if (type) {
      query.where({ type });
    }

    return query;
  },

  /**
   * Delete old notifications (cleanup).
   * @param {number} daysOld - delete notifications older than N days
   * @returns {Promise<number>} count of deleted rows
   */
  async deleteOld(daysOld = 90) {
    const threshold = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    const result = await db(TABLE).where('sent_at', '<', threshold).delete();
    return result;
  },
};

module.exports = Notification;
