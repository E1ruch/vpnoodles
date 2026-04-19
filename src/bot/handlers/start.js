'use strict';

const SubscriptionService = require('../../services/SubscriptionService');
const User = require('../../models/User');

// Хелпер для создания callback-кнопки с опциональным стилем
function btn(text, callback_data, style, icon_custom_emoji_id) {
  const button = { text, callback_data };
  if (style) button.style = style;
  if (icon_custom_emoji_id) button.icon_custom_emoji_id = icon_custom_emoji_id;
  return button;
}

module.exports = async (ctx) => {
  const user = ctx.state.user;
  const name = ctx.from.first_name || 'друг';

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

  let inline_keyboard;

  if (activeSub) {
    inline_keyboard = [
      [btn('📱 Моя конфигурация VPN', 'my_vpn', 'primary', '5967574255670399788')],
      [btn('🔄 Продлить подписку', 'subscribe', 'success')],
      [btn('👤 Профиль', 'profile'), btn('👥 Реферал', 'referral')],
    ];
  } else if (!trialUsed) {
    inline_keyboard = [
      [btn('🎁 Попробовать бесплатно', 'trial', 'success')],
      [btn('💳 Приобрести подписку', 'subscribe', 'primary')],
      [btn('👤 Профиль', 'profile')],
    ];
  } else {
    inline_keyboard = [
      [btn('💳 Купить подписку', 'subscribe', 'primary')],
      [btn('👤 Профиль', 'profile'), btn('👥 Реферал', 'referral')],
    ];
  }

  await ctx.replyWithMarkdown(welcomeText, {
    reply_markup: { inline_keyboard },
  });
};
