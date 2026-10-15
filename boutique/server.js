'use strict';

/**
 * Point d'entrée du serveur.
 *
 * Démarrage : migrations → réglages par défaut → application → tâches de fond.
 * Arrêt propre : fermeture du serveur HTTP puis de la base (checkpoint WAL).
 */

const config = require('./src/config');
const db = require('./src/db');
const logger = require('./src/lib/logger');
const settings = require('./src/lib/settings');
const { createApp, startBackgroundTasks } = require('./src/app');

function boot() {
  const started = Date.now();

  db.migrate();
  settings.ensureDefaults();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const info = {
      adresse: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      urlPublique: config.publicUrl,
      environnement: config.env,
      base: config.db.path,
      demo: config.isDemo,
      ms: Date.now() - started,
    };
    logger.info('serveur démarré', info);
    console.log('');
    console.log('  ETS LE PRIVILÈGE DAOUKRO — boutique');
    console.log(`  ▸ Boutique      ${info.adresse}`);
    console.log(`  ▸ Administration ${info.adresse}/admin`);
    console.log(`  ▸ Base de données ${info.base}`);
    console.log(`  ▸ Environnement   ${info.environnement}${info.demo ? ' (démonstration)' : ''}`);
    if (!config.secrets.paymentWebhook) {
      console.log('  ⚠ PAYMENT_WEBHOOK_SECRET absent : les notifications de paiement seront rejetées.');
    }
    console.log('');
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const stopTasks = startBackgroundTasks({ intervalMinutes: Number(process.env.MAINTENANCE_INTERVAL_MINUTES || 5) });

  const shutdown = (signal) => {
    logger.info('arrêt demandé', { signal });
    stopTasks();
    server.close(() => {
      try {
        db.run('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch { /* noop */ }
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('promesse rejetée', { reason: String(reason).slice(0, 500) }));
  process.on('uncaughtException', (err) => {
    logger.error('exception non interceptée', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) boot();

module.exports = { boot };
