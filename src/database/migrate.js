'use strict';

/**
 * Run database migrations.
 * Usage: node src/database/migrate.js [up|down|rollback|status]
 */

require('dotenv').config();
const db = require('./knex');
const logger = require('../utils/logger');

const command = process.argv[2] || 'up';

async function run() {
  try {
    switch (command) {
      case 'up': {
        const [batch, migrations] = await db.migrate.latest({
          directory: './src/database/migrations',
        });
        if (migrations.length === 0) {
          logger.info('Already up to date.');
        } else {
          logger.info(`Batch ${batch} run: ${migrations.length} migration(s)`, { migrations });
        }
        break;
      }

      case 'down':
      case 'rollback': {
        const [batch, migrations] = await db.migrate.rollback({
          directory: './src/database/migrations',
        });
        logger.info(`Rolled back batch ${batch}: ${migrations.length} migration(s)`, {
          migrations,
        });
        break;
      }

      case 'status': {
        const [completed, pending] = await db.migrate.list({
          directory: './src/database/migrations',
        });
        logger.info('Completed migrations:', { completed });
        logger.info('Pending migrations:', { pending });
        break;
      }

      default:
        logger.error(`Unknown command: ${command}. Use: up | down | rollback | status`);
        process.exit(1);
    }
  } catch (err) {
    logger.error('Migration failed', { error: err.message, stack: err.stack });
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

run();
