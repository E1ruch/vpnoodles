'use strict';

const db = require('../database/knex');

const TABLE = 'plans';

const Plan = {
  async findById(id) {
    return db(TABLE).where({ id }).first();
  },

  async findBySlug(slug) {
    return db(TABLE).where({ slug }).first();
  },

  async findTrial() {
    return db(TABLE).where({ is_trial: true, is_active: true }).first();
  },

  async findAllActive() {
    return db(TABLE).where({ is_active: true }).orderBy('sort_order', 'asc');
  },

  async findAllPublic() {
    return db(TABLE).where({ is_active: true, is_trial: false }).orderBy('sort_order', 'asc');
  },

  async create(data) {
    const [row] = await db(TABLE).insert(data).returning('*');
    return row;
  },

  async update(id, fields) {
    const [row] = await db(TABLE)
      .where({ id })
      .update({ ...fields, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },

  async deactivate(id) {
    return Plan.update(id, { is_active: false });
  },
};

module.exports = Plan;
