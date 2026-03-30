'use strict';

const { Markup } = require('telegraf');
const SubscriptionService = require('../../services/SubscriptionService');

/**
 * /start handler — welcome message + main menu
 */
module.exports = async (ctx) => {
  const user = ctx.state.user;
  const name = ctx.from.first_name || 'друг';

  const activeSub = await SubscriptionService.getActive(user.id);

  const welcomeText = activeSub
    ? `👋 С возвращением, *${name}*!\n\n` +
      `✅ Ваша подписка активна до *${new Date(activeSub.expires_at).toLocaleDateString('ru-RU')}*\n\n` +
      `Используйте меню ниже для управления VPN.`
    : `🌐 Добро пожаловать в *VPNoodles*, *${name}*!\n\n` +
      `🔒 Быстрый, надёжный и безопасный VPN прямо в Telegram.\n\n` +
      `✨ *Что вы получаете:*\n` +
      `• Безлимитный трафик\n` +
      `• Протоколы VLESS / VMess / Trojan\n` +
      `• До 10 устройств одновременно\n` +
      `• Поддержка 24/7\n\n` +
      `🎁 Попробуйте *бесплатно 3 дня* — без карты!`;

  const keyboard = activeSub
    ? Markup.inlineKeyboard([
        [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
        [Markup.button.callback('🔄 Продлить подписку', 'subscribe')],
        [
          Markup.button.callback('👤 Профиль', 'profile'),
          Markup.button.callback('👥 Реферал', 'referral'),
        ],
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback('🎁 Попробовать бесплатно', 'trial')],
        [Markup.button.callback('💳 Купить подписку', 'subscribe')],
        [Markup.button.callback('👤 Профиль', 'profile')],
      ]);

  await ctx.replyWithMarkdown(welcomeText, keyboard);
};
