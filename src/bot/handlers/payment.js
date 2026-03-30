'use strict';

const { Markup } = require('telegraf');
const PaymentService = require('../../services/PaymentService');
const logger = require('../../utils/logger');

module.exports = {
  /**
   * Pre-checkout query handler — must answer within 10 seconds
   */
  preCheckout: async (ctx) => {
    try {
      // Validate the payment payload
      const payload = JSON.parse(ctx.preCheckoutQuery.invoice_payload);
      if (!payload.paymentId || !payload.planId) {
        return ctx.answerPreCheckoutQuery(false, 'Неверные данные платежа.');
      }
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      logger.error('Pre-checkout error', { error: err.message });
      await ctx.answerPreCheckoutQuery(false, 'Ошибка обработки платежа.');
    }
  },

  /**
   * Successful payment handler — activate subscription
   */
  successfulPayment: async (ctx) => {
    const user = ctx.state.user;

    try {
      const result = await PaymentService.handleStarsPayment(ctx);

      if (!result) {
        return ctx.reply('✅ Платёж уже был обработан ранее.');
      }

      const { subscription } = result;
      const expiryDate = new Date(subscription.expires_at).toLocaleDateString('ru-RU');

      await ctx.replyWithMarkdown(
        `🎉 *Оплата прошла успешно!*\n\n` +
          `✅ Ваша подписка активирована\n` +
          `📅 Действует до: *${expiryDate}*\n\n` +
          `Нажмите "Мой VPN" чтобы получить конфигурацию.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('📱 Мой VPN', 'my_vpn')],
          [Markup.button.callback('◀️ Меню', 'menu')],
        ]),
      );

      logger.info('Stars payment processed', {
        userId: user.id,
        subscriptionId: subscription.id,
      });
    } catch (err) {
      logger.error('Successful payment handler error', {
        error: err.message,
        userId: user?.id,
      });
      await ctx.reply(
        '⚠️ Платёж получен, но возникла ошибка при активации. Обратитесь в поддержку.',
      );
    }
  },
};
