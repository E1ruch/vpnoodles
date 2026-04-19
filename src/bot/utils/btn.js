'use strict';

/**
 * Button builder for Telegram Bot API 9.4+
 * Supports styles (primary/success/danger) and custom emoji icons
 *
 * @param {string} text - Button text
 * @param {string} callback_data - Callback data
 * @param {string} [style] - 'primary' | 'success' | 'danger'
 * @param {string} [icon_custom_emoji_id] - Custom emoji ID (must be string!)
 * @returns {object} Button object for inline_keyboard
 */
function btn(text, callback_data, style, icon_custom_emoji_id) {
  const button = { text, callback_data };
  if (style) button.style = style;
  if (icon_custom_emoji_id) button.icon_custom_emoji_id = icon_custom_emoji_id;
  return button;
}

/**
 * URL button builder
 * @param {string} text - Button text
 * @param {string} url - URL to open
 * @returns {object} Button object for inline_keyboard
 */
function btnUrl(text, url) {
  return { text, url };
}

/**
 * Build inline_keyboard markup
 * @param {Array<Array<object>>} buttons - 2D array of button objects
 * @returns {object} reply_markup object
 */
function keyboard(buttons) {
  return { reply_markup: { inline_keyboard: buttons } };
}

module.exports = { btn, btnUrl, keyboard };
