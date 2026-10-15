'use strict';

/**
 * Réglages de la boutique, stockés en base (table `settings`) et modifiables
 * depuis l'administration — aucune valeur métier n'est codée en dur.
 *
 * Principe de probité : seules les informations CONFIRMÉES par l'exploitant sont
 * pré-remplies. Tout le reste est vide et marqué « à compléter ».
 */

const db = require('../db');

/* ------------------------------------------------------------------ */
/* Schéma : valeur par défaut, type, contraintes                       */
/* ------------------------------------------------------------------ */
const SCHEMA = {
  // --- Identité de l'établissement (données confirmées) ---
  'store.name': { type: 'string', default: 'ETS LE PRIVILÈGE DAOUKRO', max: 200 },
  'store.short_name': { type: 'string', default: 'ETS LE PRIVILÈGE', max: 120 },
  'store.tagline': { type: 'string', default: '', max: 200 },
  'store.city': { type: 'string', default: 'Daoukro', max: 120 },
  'store.region': { type: 'string', default: 'Iffou', max: 120 },
  'store.country': { type: 'string', default: "Côte d'Ivoire", max: 120 },
  'store.country_code': { type: 'string', default: 'CI', max: 4 },
  // Adresse précise NON confirmée dans cet environnement (fiche Google inaccessible) :
  // laissée vide volontairement, à renseigner dans l'administration.
  'store.address': { type: 'string', default: '', max: 300 },
  'store.address_confirmed': { type: 'boolean', default: false },
  'store.maps_url': {
    type: 'string',
    default:
      'https://www.google.com/maps/place/ETS+Le+Privil%C3%A8ge+Daoukro/@7.0545761,-3.9597324,17z/data=!3m1!4b1!4m6!3m5!1s0xfc6893074cdfe31:0x92e83d2c93e6ab62!8m2!3d7.0545761!4d-3.9597324!16s%2Fg%2F11jt0cgz4b',
    max: 1200,
  },
  'store.maps_lat': { type: 'string', default: '7.0545761', max: 20 },
  'store.maps_lng': { type: 'string', default: '-3.9597324', max: 20 },
  'store.hours_status': { type: 'enum', default: 'unconfirmed', values: ['unconfirmed', 'confirmed'] },
  'store.hours': { type: 'json', default: [] },
  'store.registration': { type: 'string', default: '', max: 120 }, // RCCM / CC / n° contribuable
  'store.logo_key': { type: 'string', default: '', max: 200 },
  'store.logo_status': { type: 'enum', default: 'typographic', values: ['typographic', 'official'] },
  'store.favicon_key': { type: 'string', default: '', max: 200 },

  // --- Contacts (le numéro fourni est conservé ; d'autres peuvent être ajoutés) ---
  'store.contacts': {
    type: 'json',
    default: [
      {
        id: 'c1',
        label: 'Téléphone boutique',
        type: 'phone',
        value: '+2250758113857',
        display: '+225 07 58 11 38 57',
        is_primary: true,
        whatsapp_enabled: false, // non confirmé : à activer explicitement
        visible: true,
      },
    ],
  },

  // --- Commerce ---
  'commerce.currency': { type: 'string', default: 'XOF', max: 8 },
  'commerce.currency_label': { type: 'string', default: 'FCFA', max: 12 },
  'commerce.timezone': { type: 'string', default: 'Africa/Abidjan', max: 60 },
  'commerce.locale': { type: 'string', default: 'fr-FR', max: 12 },
  'commerce.guest_checkout': { type: 'boolean', default: true },
  'commerce.email_required': { type: 'boolean', default: false },
  'commerce.min_order_amount': { type: 'integer', default: 0, min: 0 },
  'commerce.max_qty_per_line': { type: 'integer', default: 999, min: 1, max: 100000 },
  'commerce.marketing_consent_enabled': { type: 'boolean', default: true },
  'commerce.order_prefix': { type: 'string', default: 'PRV', max: 8 },
  'commerce.pos_prefix': { type: 'string', default: 'VT', max: 8 },

  // --- Thème (modifiable pour s'aligner sur le logo officiel) ---
  'theme.primary': { type: 'color', default: '#14294F' },
  'theme.primary_dark': { type: 'color', default: '#0C1B36' },
  'theme.primary_soft': { type: 'color', default: '#EAF0F9' },
  'theme.accent': { type: 'color', default: '#B8892B' },
  'theme.accent_soft': { type: 'color', default: '#FBF3E1' },
  'theme.ink': { type: 'color', default: '#101B2E' },
  'theme.background': { type: 'color', default: '#FFFFFF' },
  'theme.surface': { type: 'color', default: '#F6F8FB' },
  'theme.border': { type: 'color', default: '#E2E7EF' },
  'theme.radius': { type: 'integer', default: 10, min: 0, max: 28 },
  'theme.density': { type: 'enum', default: 'comfortable', values: ['compact', 'comfortable'] },

  // --- Messages d'interface ---
  'ui.demo_banner': { type: 'boolean', default: false },
  'ui.maintenance': { type: 'boolean', default: false },
  'ui.maintenance_message': { type: 'string', default: '', max: 500 },
  'ui.home_intro': { type: 'string', default: '', max: 600 },

  // --- Expédition / retrait ---
  'shipping.pickup_note': {
    type: 'string',
    default: 'Retrait en boutique à Daoukro après confirmation de la commande. Aucun frais de retrait.',
    max: 600,
  },
  'shipping.quote_note': {
    type: 'string',
    default:
      "Aucun tarif n'est encore défini pour cette destination : votre commande est transmise comme demande de devis. Nous vous contactons au téléphone indiqué pour convenir du montant définitif avant tout paiement.",
    max: 800,
  },
  'shipping.rates_confirmed': { type: 'boolean', default: false },

  // --- Notifications (connecteurs à brancher) ---
  'notifications.email_enabled': { type: 'boolean', default: false },
  'notifications.sms_enabled': { type: 'boolean', default: false },
  'notifications.whatsapp_enabled': { type: 'boolean', default: false },
  'notifications.from_name': { type: 'string', default: 'ETS LE PRIVILÈGE DAOUKRO', max: 120 },

  // --- WhatsApp ---
  'whatsapp.enabled': { type: 'boolean', default: false }, // dépend du contact marqué WhatsApp
  'whatsapp.prefill_mode': {
    type: 'enum',
    default: 'question',
    values: ['question', 'cart', 'order'],
  },
  'whatsapp.disclaimer': {
    type: 'string',
    default: "Ouvrir WhatsApp transmet une question ou un récapitulatif : cela ne confirme ni une commande, ni un paiement.",
    max: 400,
  },

  // --- Textes légaux ---
  'legal.terms_reviewed': { type: 'boolean', default: false },
  'legal.privacy_reviewed': { type: 'boolean', default: false },
  'legal.shipping_reviewed': { type: 'boolean', default: false },

  // --- Sauvegardes ---
  'backup.auto_enabled': { type: 'boolean', default: false },
  'backup.retention': { type: 'integer', default: 14, min: 1, max: 365 },
};

const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.default]));

let cache = null;
let cacheStamp = 0;

function invalidate() {
  cache = null;
}

function coerce(spec, raw) {
  if (raw === undefined || raw === null) return spec.default;
  switch (spec.type) {
    case 'boolean':
      return raw === true || raw === 1 || raw === '1' || raw === 'true';
    case 'integer': {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return spec.default;
      const min = spec.min ?? -Infinity;
      const max = spec.max ?? Infinity;
      return Math.min(max, Math.max(min, n));
    }
    case 'json': {
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return spec.default;
      }
    }
    case 'enum':
      return spec.values.includes(raw) ? raw : spec.default;
    case 'color': {
      const v = String(raw);
      return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : spec.default;
    }
    default:
      return String(raw).slice(0, spec.max ?? 5000);
  }
}

function validate(key, value) {
  const spec = SCHEMA[key];
  if (!spec) return { ok: false, error: `Réglage inconnu : ${key}` };
  const coerced = coerce(spec, value);
  if (spec.type === 'enum' && !spec.values.includes(String(value))) {
    return { ok: false, error: `Valeur invalide pour ${key}`, value: coerced };
  }
  if (spec.type === 'color' && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || ''))) {
    return { ok: false, error: `Couleur invalide pour ${key}`, value: coerced };
  }
  return { ok: true, value: coerced };
}

/** Charge tous les réglages (mise en cache courte, invalidée à chaque écriture). */
function load() {
  const stamp = Date.now();
  if (cache && stamp - cacheStamp < 1500) return cache;
  const values = { ...DEFAULTS };
  try {
    if (db.tableExists('settings')) {
      for (const row of db.all('SELECT key, value FROM settings')) {
        if (!(row.key in SCHEMA)) continue;
        let parsed;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          parsed = row.value;
        }
        values[row.key] = coerce(SCHEMA[row.key], parsed);
      }
    }
  } catch {
    // Table absente avant migration : valeurs par défaut.
  }
  cache = values;
  cacheStamp = stamp;
  return values;
}

function get(key, fallback) {
  const values = load();
  if (!(key in values)) return fallback !== undefined ? fallback : DEFAULTS[key];
  return values[key];
}

function set(key, value, userId = null) {
  const check = validate(key, value);
  if (!check.ok) throw new Error(check.error);
  db.run(
    `INSERT INTO settings (key, value, updated_at, updated_by)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, JSON.stringify(check.value), userId]
  );
  invalidate();
  return check.value;
}

function setMany(entries, userId = null) {
  const out = {};
  db.transaction(() => {
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) continue;
      out[k] = set(k, v, userId);
    }
  });
  return out;
}

/** Écrit les valeurs par défaut manquantes (appelé au seed / à la migration). */
function ensureDefaults(userId = null) {
  const existing = new Set();
  if (db.tableExists('settings')) {
    for (const row of db.all('SELECT key FROM settings')) existing.add(row.key);
  }
  const missing = Object.entries(SCHEMA).filter(([k]) => !existing.has(k));
  if (!missing.length) return 0;
  db.transaction(() => {
    for (const [key, spec] of missing) {
      db.run(
        `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
        [key, JSON.stringify(spec.default), userId]
      );
    }
  });
  invalidate();
  return missing.length;
}

/* ------------------------------------------------------------------ */
/* Vues dérivées pratiques                                             */
/* ------------------------------------------------------------------ */
function primaryContact(type = null) {
  const contacts = get('store.contacts') || [];
  const list = contacts.filter((c) => c.visible !== false);
  if (type) {
    const typed = list.filter((c) => c.type === type);
    return typed.find((c) => c.is_primary) || typed[0] || null;
  }
  return list.find((c) => c.is_primary) || list[0] || null;
}

function whatsappContact() {
  const contacts = get('store.contacts') || [];
  return contacts.find((c) => c.type === 'phone' && c.whatsapp_enabled && c.visible !== false) || null;
}

function phoneDisplay() {
  const c = primaryContact('phone');
  return c ? c.display || c.value : '';
}

/** Vrai si au moins une information essentielle manque encore. */
/** Comptage tolérant aux erreurs : la checklist ne doit jamais planter une page. */
function safeCount(sql) {
  try {
    const row = db.get(sql);
    return Number((row && row.n) || 0);
  } catch {
    return 0;
  }
}

function completenessChecklist() {
  const items = [];
  const push = (label, done, hint) => items.push({ label, done: Boolean(done), hint: hint || '' });
  push("Adresse précise renseignée", get('store.address_confirmed') && String(get('store.address')).trim(), "Relever l'adresse sur la fiche Google Maps puis la saisir dans Réglages › Établissement.");
  push('Horaires d\'ouverture confirmés', get('store.hours_status') === 'confirmed' && (get('store.hours') || []).length, 'Saisir les jours et heures réels.');
  push('Logo officiel intégré', get('store.logo_status') === 'official', "Téléverser le logo dans Réglages › Apparence.");
  push('Tarifs de livraison définis', get('shipping.rates_confirmed'), 'Configurer les zones et tarifs dans Réglages › Livraison.');
  push(
    'Au moins un moyen de paiement activé',
    safeCount("SELECT COUNT(*) AS n FROM payment_methods WHERE enabled = 1 AND (kind = 'cash' OR configured = 1 OR simulated = 1)") > 0,
    'Activer un moyen dans Réglages › Paiements. Un moyen Mobile Money non connecté ne peut être activé qu’en mode démonstration.'
  );
  push('Conditions de vente validées', get('legal.terms_reviewed'), 'Relire et publier la page Conditions de vente.');
  push('Politique de confidentialité validée', get('legal.privacy_reviewed'), 'Relire et publier la page Confidentialité.');
  push('Information livraison / retours validée', get('legal.shipping_reviewed'), 'Relire et publier la page Livraison et retours.');
  return items;
}

module.exports = {
  SCHEMA,
  DEFAULTS,
  load,
  get,
  set,
  setMany,
  ensureDefaults,
  validate,
  invalidate,
  primaryContact,
  whatsappContact,
  phoneDisplay,
  completenessChecklist,
};
