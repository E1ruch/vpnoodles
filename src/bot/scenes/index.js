'use strict';

const { Scenes } = require('telegraf');

/**
 * Scene registry.
 * Add new scenes here as the bot grows.
 *
 * Example scenes to add in the future:
 *  - supportScene   (multi-step support ticket)
 *  - broadcastScene (admin broadcast wizard)
 *  - onboardingScene (guided setup for new users)
 */

const stage = new Scenes.Stage([
  // scenes will be registered here
  // e.g.: require('./support'), require('./broadcast')
]);

module.exports = { stage };
