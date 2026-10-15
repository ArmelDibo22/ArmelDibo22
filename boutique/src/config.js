'use strict';

/**
 * Configuration applicative.
 * Toute valeur sensible provient exclusivement de l'environnement (.env / secrets de l'hébergeur).
 * Aucun secret n'est stocké en base de données ni exposé au navigateur.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* Chargement minimaliste du fichier .env (sans dépendance externe)    */
/* ------------------------------------------------------------------ */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const env = process.env;

function str(key, fallback = '') {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key, fallback) {
  const v = parseInt(env[key], 10);
  return Number.isFinite(v) ? v : fallback;
}

function bool(key, fallback = false) {
  const v = (env[key] || '').toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function abs(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/**
 * Chemin de stockage selon le mode.
 *
 * En mode démonstration, les variables réelles (DATABASE_PATH, MEDIA_DIR…) sont
 * délibérément IGNORÉES : un `.env` qui définit DATABASE_PATH pointerait sinon la
 * démo sur la base de production. Seules les variables DEMO_* font foi.
 */
function storagePath(realKey, demoKey, realDefault, demoDefault) {
  return abs(DEMO ? str(demoKey, demoDefault) : str(realKey, realDefault));
}

function randomSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Démonstration : base et médias séparés des données réelles          */
/* ------------------------------------------------------------------ */
const DEMO = bool('DEMO', false);

const NODE_ENV = str('NODE_ENV', 'development');
const isProduction = NODE_ENV === 'production';

if (isProduction && DEMO) {
  throw new Error('Le mode DEMO est interdit lorsque NODE_ENV=production.');
}

if (DEMO) {
  const realDb = path.isAbsolute(str('DATABASE_PATH', 'data/boutique.sqlite'))
    ? str('DATABASE_PATH', 'data/boutique.sqlite')
    : path.join(ROOT, str('DATABASE_PATH', 'data/boutique.sqlite'));
  const demoDb = path.isAbsolute(str('DEMO_DATABASE_PATH', 'data/demo.sqlite'))
    ? str('DEMO_DATABASE_PATH', 'data/demo.sqlite')
    : path.join(ROOT, str('DEMO_DATABASE_PATH', 'data/demo.sqlite'));
  if (path.resolve(realDb) === path.resolve(demoDb)) {
    throw new Error(
      'Mode DEMO : DEMO_DATABASE_PATH pointe sur la base réelle. ' +
      'Les données de démonstration doivent rester dans un fichier séparé.'
    );
  }
}

let appSecret = str('APP_SECRET', '');
const insecureSecret =
  !appSecret || appSecret.startsWith('change-me') || appSecret.length < 32;
if (insecureSecret) {
  if (isProduction) {
    throw new Error(
      'APP_SECRET absent ou trop faible : générez un secret avec ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"`'
    );
  }
  // En développement uniquement : secret éphémère persisté localement pour ne pas
  // invalider les sessions à chaque redémarrage.
  const devSecretFile = abs('data/.dev-secret');
  try {
    fs.mkdirSync(path.dirname(devSecretFile), { recursive: true });
    appSecret = fs.existsSync(devSecretFile)
      ? fs.readFileSync(devSecretFile, 'utf8').trim()
      : randomSecret();
    if (!fs.existsSync(devSecretFile)) {
      fs.writeFileSync(devSecretFile, appSecret, { mode: 0o600 });
    }
  } catch {
    appSecret = appSecret || randomSecret();
  }
}

const config = {
  root: ROOT,
  env: NODE_ENV,
  isProduction,
  isDemo: DEMO,
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  trustProxy: bool('TRUST_PROXY', false),
  publicUrl: str('PUBLIC_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/$/, ''),

  secrets: {
    app: appSecret,
    insecureSecret,
    paymentWebhook: str('PAYMENT_WEBHOOK_SECRET', ''),
  },

  db: {
    path: storagePath('DATABASE_PATH', 'DEMO_DATABASE_PATH', 'data/boutique.sqlite', 'data/demo.sqlite'),
    busyTimeoutMs: int('DB_BUSY_TIMEOUT_MS', 5000),
  },

  storage: {
    mediaDir: storagePath('MEDIA_DIR', 'DEMO_MEDIA_DIR', 'data/media', 'data/demo-media'),
    importDir: storagePath('IMPORT_DIR', 'DEMO_IMPORT_DIR', 'data/imports', 'data/demo-imports'),
    backupDir: storagePath('BACKUP_DIR', 'DEMO_BACKUP_DIR', 'data/backups', 'data/demo-backups'),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
    allowedImageTypes: str('ALLOWED_IMAGE_TYPES', 'image/jpeg,image/png,image/webp,image/avif')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  payments: {
    simulationEnabled: bool('PAYMENT_SIMULATION_ENABLED', !isProduction),
    simulationPath: str('PAYMENT_SIMULATION_PATH', '/paiements/simuler'),
    providers: {
      wave: { merchantId: str('WAVE_MERCHANT_ID'), apiKey: str('WAVE_API_KEY') },
      orange_money: {
        clientId: str('ORANGE_MONEY_CLIENT_ID'),
        clientSecret: str('ORANGE_MONEY_CLIENT_SECRET'),
      },
      mtn_momo: {
        targetEnv: str('MTN_MOMO_TARGET_ENV'),
        subscriptionKey: str('MTN_MOMO_SUBSCRIPTION_KEY'),
      },
      moov_money: { merchantId: str('MOOV_MERCHANT_ID'), merchantSecret: str('MOOV_MERCHANT_SECRET') },
    },
  },

  commerce: {
    cartReservationMinutes: int('CART_RESERVATION_MINUTES', 15),
    orderReservationMinutes: int('ORDER_RESERVATION_MINUTES', 90),
    catalogPageSize: int('CATALOG_PAGE_SIZE', 24),
    marketingConsentEnabled: bool('MARKETING_CONSENT_ENABLED', true),
  },

  bootstrapAdmin: {
    email: str('ADMIN_EMAIL', 'admin@leprivilege.example'),
    password: str('ADMIN_PASSWORD', ''),
    name: str('ADMIN_NAME', 'Administrateur'),
  },

  security: {
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    bcryptRounds: int('SCRYPT_N', 16384),
    rateLimit: {
      windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
      max: int('RATE_LIMIT_MAX', 240),
      authMax: int('RATE_LIMIT_AUTH_MAX', 10),
      // Fenêtre de 10 minutes (voir middleware/auth.js). Le plafond est volontairement
      // large : la protection contre les commandes en double repose sur la clé
      // d'idempotence et l'empreinte du panier, pas sur ce compteur. Une valeur trop
      // basse pénaliserait des clients légitimes partageant une même adresse IP
      // publique (CGNAT des opérateurs mobiles).
      checkoutMax: int('RATE_LIMIT_CHECKOUT_MAX', 60),
      webhookMax: int('RATE_LIMIT_WEBHOOK_MAX', 300),
    },
  },
};

/** Retourne true si au moins un identifiant marchand est renseigné pour un moyen. */
function providerCredentials(code) {
  const p = config.payments.providers[code];
  if (!p) return null;
  const filled = Object.values(p).filter((v) => v && String(v).trim());
  return { configured: filled.length === Object.values(p).length && filled.length > 0, values: p };
}

config.providerCredentials = providerCredentials;

module.exports = config;
