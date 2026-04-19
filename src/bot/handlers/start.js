'use strict';

const SubscriptionService = require('../../services/SubscriptionService');
const User = require('../../models/User');
const { btn, keyboard } = require('../utils/btn');

/**
 * /start handler — welcome message + main menu
 */
module.exports = async (ctx) => {
  const user = ctx.state.user;
  const name = ctx.from.first_name || 'друг';

  // Handle referral link: /start ref_<telegram_id>
  const startPayload = ctx.message?.text?.split(' ')[1];
  if (startPayload?.startsWith('ref_')) {
    const referrerId = parseInt(startPayload.replace('ref_', ''), 10);
    if (referrerId && referrerId !== user.telegram_id) {
      await User.setReferrer(user.id, referrerId).catch(() => {});
    }
  }

  const [activeSub, trialUsed] = await Promise.all([
    SubscriptionService.getActive(user.id),
    User.hasUsedTrial(user.id),
  ]);

  const welcomeText = activeSub
    ? `👋 С возвращением, *${name}*!\n\n` +
      `✅ Ваша подписка активна до *${new Date(activeSub.expires_at).toLocaleDateString('ru-RU')}*\n\n` +
      `Используйте меню ниже для управления VPN.`
    : `🌐 Добро пожаловать в *VPNoodles*, *${name}*!\n\n` +
      `🔒 Быстрый, надёжный и безопасный VPN прямо в Telegram!\n\n` +
      `✨ *Что вы получаете:*\n` +
      `• Безлимитный трафик\n` +
      `• Протоколы VLESS / VMess / Trojan\n` +
      `• До 10 устройств одновременно\n` +
      `• Поддержка 24/7\n\n` +
      (trialUsed
        ? `💳 Выберите план и начните пользоваться VPN!`
        : `🎁 Попробуйте *бесплатно 7 дней* — без карты!`);

  let inlineKeyboard;
  if (activeSub) {
    // Active subscriber — main actions highlighted
    inlineKeyboard = [
      [btn('Моя конфигурация VPN', 'my_vpn', 'primary', '5967574255670399788')], //📱
      [btn('Продлить подписку', 'subscribe', 'primary', '5897958754267174109')], //🔄
      [
        btn('Профиль', 'profile', '5920344347152224466'),
        btn('Реферал', 'referral', '5944970130554359187'),
      ], //👤 👥
    ];
  } else if (!trialUsed) {
    // New user — trial is the main success action
    inlineKeyboard = [
      [btn('Попробовать бесплатно', 'trial', 'success', '5875180111744995604')], //🎁
      [btn('Приобрести подписку', 'subscribe', 'primary', '5983399041197675256')], //💳
      [btn('Профиль', 'profile', '5920344347152224466')], //👤
    ];
  } else {
    // Trial used — only paid options
    inlineKeyboard = [
      [btn('💳 Купить подписку', 'subscribe', 'primary', '5983399041197675256')], //💳
      [
        btn('Профиль', 'profile', '5920344347152224466'),
        btn('Реферал', 'referral', '5944970130554359187'),
      ],
    ];
  }

  await ctx.replyWithMarkdown(welcomeText, keyboard(inlineKeyboard));
};
