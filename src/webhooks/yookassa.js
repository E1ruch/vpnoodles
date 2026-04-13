'use strict';

const PaymentService = require('../services/PaymentService');
const YooKassaService = require('../services/YooKassaService');
const logger = require('../utils/logger');

/**
 * YooKassa webhook handler.
 * This handler receives notifications from YooKassa when payment status changes.
 *
 * To enable webhooks:
 * 1. Go to YooKassa dashboard → Settings → Webhooks
 * 2. Add webhook URL: https://yourdomain.com/webhook/yookassa
 * 3. Select events: payment.succeeded, payment.canceled
 *
 * @param {object} req - Express-like request object
 * @param {object} res - Express-like response object
 * @returns {Promise<void>}
 */
async function handleYooKassaWebhook(req, res) {
  try {
    // Get raw body for signature verification
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const signature = req.headers['x-signature'] || '';

    // Verify signature (optional but recommended for production)
    // Note: YooKassa uses different signature method, this is simplified
    // For full security, implement proper signature verification

    const payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body);

    logger.info('YooKassa webhook received', {
      type: payload.type,
      event: payload.event,
    });

    // Process the webhook
    const result = await PaymentService.handleYooKassaWebhook(payload);

    // Always respond with 200 OK to acknowledge receipt
    res.status(200).json({ received: true });

    return result;
  } catch (err) {
    logger.error('YooKassa webhook error', {
      error: err.message,
      stack: err.stack,
    });

    // Still return 200 to avoid retries for non-recoverable errors
    res.status(200).json({ received: false, error: err.message });
  }
}

/**
 * Setup YooKassa webhook route on an Express app.
 * @param {object} app - Express app instance
 */
function setupYooKassaWebhook(app) {
  if (!YooKassaService.enabled) {
    logger.info('YooKassa webhook skipped (not enabled)');
    return;
  }

  // Webhook endpoint for YooKassa
  app.post('/webhook/yookassa', handleYooKassaWebhook);

  logger.info('YooKassa webhook endpoint registered at /webhook/yookassa');
}

module.exports = {
  handleYooKassaWebhook,
  setupYooKassaWebhook,
};
