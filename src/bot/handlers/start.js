'use strict';

const { Markup } = require('telegraf');
const SubscriptionService = require('../../services/SubscriptionService');
const User = require('../../models/User');

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

  let keyboard;
  if (activeSub) {
    keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
      [Markup.button.callback('🔄 Продлить подписку', 'subscribe')],
      [
        Markup.button.callback('👤 Профиль', 'profile'),
        Markup.button.callback('👥 Реферал', 'referral'),
      ],
    ]);
  } else if (!trialUsed) {
    // New user — show trial button
    keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🎁 Попробовать бесплатно', 'trial')],
      [Markup.button.callback('💳 Приобрести подписку', 'subscribe')],
      [Markup.button.callback('👤 Профиль', 'profile')],
    ]);
  } else {
    // Trial already used — only paid options
    keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('\uD83D\uDCB3 Купить подписку', 'subscribe')],
      [
        Markup.button.callback('👤 Профиль', 'profile'),
        Markup.button.callback('👥 Реферал', 'referral'),
      ],
    ]);
  }

  await ctx.replyWithMarkdown(welcomeText, keyboard);
};
