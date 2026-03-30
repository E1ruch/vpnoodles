'use strict';

const db = require('../database/knex');

const TABLE = 'vpn_configs';

const VpnConfig = {
  async findById(id) {
    return db(TABLE).where({ id }).first();
  },

  async findActiveByUserId(userId) {
    return db(TABLE).where({ user_id: userId, status: 'active' }).orderBy('created_at', 'desc');
  },

  async findByPanelUserId(panelUserId) {
    return db(TABLE).where({ panel_user_id: panelUserId }).first();
  },

  async create({
    userId,
    subscriptionId,
    panelUserId,
    protocol = 'vless',
    configLink,
    configJson,
    serverTag,
  }) {
    const [row] = await db(TABLE)
      .insert({
        user_id: userId,
        subscription_id: subscriptionId,
        panel_user_id: panelUserId,
        protocol,
        config_link: configLink,
        config_json: configJson ? JSON.stringify(configJson) : null,
        server_tag: serverTag,
        status: 'active',
      })
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

  async disable(id) {
    return VpnConfig.update(id, { status: 'disabled' });
  },

  async enable(id) {
    return VpnConfig.update(id, { status: 'active' });
  },

  async deleteByUserId(userId) {
    return db(TABLE)
      .where({ user_id: userId })
      .update({ status: 'deleted', updated_at: db.fn.now() });
  },
};

module.exports = VpnConfig;
