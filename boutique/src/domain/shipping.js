'use strict';

/**
 * Retrait, zones de livraison, transporteurs et tarifs.
 *
 * Règle de probité : lorsqu'aucun tarif ne s'applique à une destination, la
 * réponse est `quote` (« Livraison sur devis »). Un tarif inconnu n'est JAMAIS
 * présenté comme une livraison gratuite.
 */

const db = require('../db');
const config = require('../config');
const dates = require('../lib/dates');
const { normalizeText } = require('../lib/slug');

/* ------------------------------------------------------------------ */
/* Transporteurs                                                       */
/* ------------------------------------------------------------------ */
function listCarriers({ includeDisabled = true } = {}) {
  return db.all(
    'SELECT * FROM carriers WHERE (? = 1 OR enabled = 1) ORDER BY position ASC, name ASC',
    [includeDisabled ? 1 : 0]
  );
}

function getCarrier(id) {
  return db.get('SELECT * FROM carriers WHERE id = ?', [Number(id)]);
}

function getCarrierByCode(code) {
  return db.get('SELECT * FROM carriers WHERE code = ?', [String(code)]);
}

function saveCarrier(input, userId = null) {
  const name = normalizeText(input.name);
  if (!name) throw Object.assign(new Error('Le nom du transporteur est obligatoire.'), { status: 400 });
  const code = normalizeText(input.code || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const data = {
    name,
    code,
    contact: normalizeText(input.contact || '').slice(0, 200),
    tracking_url_template: normalizeText(input.tracking_url_template || '').slice(0, 500),
    enabled: input.enabled ? 1 : 0,
    position: Number(input.position) || 0,
  };
  const existing = input.id ? getCarrier(input.id) : getCarrierByCode(code);
  const id = existing
    ? (db.update('carriers', existing.id, data), existing.id)
    : db.insert('carriers', data);
  audit(userId, existing ? 'carrier.update' : 'carrier.create', id, { name });
  return getCarrier(id);
}

function deleteCarrier(id, userId = null) {
  const used = db.get('SELECT COUNT(*) AS c FROM orders WHERE carrier_id = ?', [Number(id)]).c;
  if (used) throw Object.assign(new Error('Transporteur utilisé par des commandes : désactivez-le au lieu de le supprimer.'), { status: 409 });
  db.run('DELETE FROM carriers WHERE id = ?', [Number(id)]);
  audit(userId, 'carrier.delete', id, {});
  return true;
}

function trackingUrl(carrier, reference) {
  if (!carrier || !carrier.tracking_url_template || !reference) return '';
  return String(carrier.tracking_url_template)
    .replaceAll('{reference}', encodeURIComponent(reference))
    .replaceAll('{ref}', encodeURIComponent(reference));
}

/* ------------------------------------------------------------------ */
/* Zones                                                               */
/* ------------------------------------------------------------------ */
function listZones({ enabledOnly = false } = {}) {
  return db.all(
    `SELECT z.*, c.name AS carrier_name
       FROM shipping_zones z LEFT JOIN carriers c ON c.id = z.default_carrier_id
      WHERE (? = 0 OR z.enabled = 1)
      ORDER BY z.position ASC, z.name ASC`,
    [enabledOnly ? 1 : 0]
  );
}

function getZone(idOrCode) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === '') return null;
  const asNumber = Number(idOrCode);
  if (Number.isInteger(asNumber) && asNumber > 0) {
    return db.get('SELECT * FROM shipping_zones WHERE id = ?', [asNumber]);
  }
  return db.get('SELECT * FROM shipping_zones WHERE code = ?', [String(idOrCode)]);
}

function pickupZone() {
  return db.get("SELECT * FROM shipping_zones WHERE kind = 'pickup' AND enabled = 1 ORDER BY position ASC LIMIT 1");
}

function deliveryZones() {
  return db.all("SELECT * FROM shipping_zones WHERE kind != 'pickup' AND enabled = 1 ORDER BY position ASC");
}

function saveZone(input, userId = null) {
  const name = normalizeText(input.name);
  const code = normalizeText(input.code || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  if (!name || !code) throw Object.assign(new Error('Le nom et le code de la zone sont obligatoires.'), { status: 400 });
  const kinds = ['pickup', 'local', 'region', 'national', 'international'];
  const data = {
    code,
    name,
    kind: kinds.includes(input.kind) ? input.kind : 'local',
    enabled: input.enabled === undefined ? 1 : (input.enabled ? 1 : 0),
    position: Number(input.position) || 0,
    requires_quote: input.requires_quote ? 1 : 0,
    free_over: input.free_over === '' || input.free_over == null ? null : Math.max(0, Math.round(Number(input.free_over))),
    eta_text: normalizeText(input.eta_text || '').slice(0, 300),
    conditions_text: normalizeText(input.conditions_text || '').slice(0, 800),
    cod_allowed: input.cod_allowed ? 1 : 0,
    default_carrier_id: input.default_carrier_id ? Number(input.default_carrier_id) : null,
    updated_at: dates.nowIso(),
  };
  const existing = input.id ? db.get('SELECT * FROM shipping_zones WHERE id = ?', [Number(input.id)]) : getZone(code);
  let id;
  if (existing) {
    db.update('shipping_zones', existing.id, data);
    id = existing.id;
  } else {
    id = db.insert('shipping_zones', data);
  }
  audit(userId, existing ? 'zone.update' : 'zone.create', id, { code, name });
  return db.get('SELECT * FROM shipping_zones WHERE id = ?', [id]);
}

function deleteZone(id, userId = null) {
  const used = db.get('SELECT COUNT(*) AS c FROM orders WHERE zone_id = ?', [Number(id)]).c;
  if (used) throw Object.assign(new Error('Zone utilisée par des commandes : désactivez-la au lieu de la supprimer.'), { status: 409 });
  db.transaction(() => {
    db.run('DELETE FROM shipping_rates WHERE zone_id = ?', [Number(id)]);
    db.run('DELETE FROM shipping_zones WHERE id = ?', [Number(id)]);
  });
  audit(userId, 'zone.delete', id, {});
  return true;
}

/* ------------------------------------------------------------------ */
/* Tarifs                                                              */
/* ------------------------------------------------------------------ */
function ratesForZone(zoneId) {
  return db.all(
    `SELECT r.*, c.name AS carrier_name FROM shipping_rates r
       LEFT JOIN carriers c ON c.id = r.carrier_id
      WHERE r.zone_id = ? ORDER BY r.position ASC, r.min_weight_g ASC, r.min_subtotal ASC`,
    [Number(zoneId)]
  );
}

function saveRate(input, userId = null) {
  const zone = getZone(input.zone_id);
  if (!zone) throw Object.assign(new Error('Zone de livraison introuvable.'), { status: 400 });
  const data = {
    zone_id: zone.id,
    carrier_id: input.carrier_id ? Number(input.carrier_id) : null,
    label: normalizeText(input.label || '').slice(0, 160),
    min_weight_g: Math.max(0, Math.round(Number(input.min_weight_g) || 0)),
    max_weight_g: input.max_weight_g === '' || input.max_weight_g == null ? null : Math.max(0, Math.round(Number(input.max_weight_g))),
    min_subtotal: Math.max(0, Math.round(Number(input.min_subtotal) || 0)),
    max_subtotal: input.max_subtotal === '' || input.max_subtotal == null ? null : Math.max(0, Math.round(Number(input.max_subtotal))),
    price: Math.max(0, Math.round(Number(input.price) || 0)),
    per_extra_kg: Math.max(0, Math.round(Number(input.per_extra_kg) || 0)),
    enabled: input.enabled === undefined ? 1 : (input.enabled ? 1 : 0),
    position: Number(input.position) || 0,
    note: normalizeText(input.note || '').slice(0, 300),
  };
  const id = input.id ? (db.update('shipping_rates', Number(input.id), data), Number(input.id)) : db.insert('shipping_rates', data);
  // Un tarif réel saisi rend la zone chiffrable (sauf choix explicite contraire).
  if (data.enabled && zone.requires_quote) {
    db.run('UPDATE shipping_zones SET requires_quote = 0, updated_at = ? WHERE id = ?', [dates.nowIso(), zone.id]);
  }
  audit(userId, input.id ? 'rate.update' : 'rate.create', id, { zone: zone.code, price: data.price });
  return db.get('SELECT * FROM shipping_rates WHERE id = ?', [id]);
}

function deleteRate(id, userId = null) {
  db.run('DELETE FROM shipping_rates WHERE id = ?', [Number(id)]);
  audit(userId, 'rate.delete', id, {});
  return true;
}

/* ------------------------------------------------------------------ */
/* Résolution du coût de livraison (calcul SERVEUR uniquement)          */
/* ------------------------------------------------------------------ */
/**
 * @param {object} params
 * @param {number|string} params.zoneId
 * @param {number} params.subtotal montant du panier après remise (FCFA)
 * @param {number} params.weightG poids total (grammes)
 * @returns {{status:'free'|'priced'|'quote', amount:number, zone:object, rate:object|null,
 *            etaText:string, conditionsText:string, codAllowed:boolean, reason:string}}
 */
function resolveShipping({ zoneId, subtotal = 0, weightG = 0 }) {
  const zone = getZone(zoneId);
  if (!zone || !zone.enabled) {
    return {
      status: 'quote',
      amount: null,
      zone: null,
      rate: null,
      etaText: '',
      conditionsText: '',
      codAllowed: false,
      reason: 'ZONE_INCONNUE',
      message: 'Mode de réception indisponible.',
    };
  }

  const base = {
    zone,
    etaText: zone.eta_text || '',
    conditionsText: zone.conditions_text || '',
    codAllowed: Boolean(zone.cod_allowed),
    rate: null,
  };

  // Retrait en boutique : aucun frais (seul cas « gratuit » assumé).
  if (zone.kind === 'pickup') {
    return { ...base, status: 'free', amount: 0, reason: 'PICKUP', message: 'Retrait en boutique : aucun frais.' };
  }

  // Zone explicitement marquée « sur devis » : aucun tarif inventé.
  if (zone.requires_quote) {
    return { ...base, status: 'quote', amount: null, reason: 'ZONE_QUOTE', message: 'Livraison sur devis.' };
  }

  const rates = ratesForZone(zone.id).filter((r) => r.enabled);
  const match = rates.find((r) => {
    if (weightG < (r.min_weight_g || 0)) return false;
    if (r.max_weight_g != null && weightG > r.max_weight_g) return false;
    if (subtotal < (r.min_subtotal || 0)) return false;
    if (r.max_subtotal != null && subtotal > r.max_subtotal) return false;
    return true;
  });

  if (!match) {
    return { ...base, status: 'quote', amount: null, reason: 'NO_RATE', message: 'Livraison sur devis.' };
  }

  let amount = Math.max(0, Math.round(Number(match.price) || 0));
  if (match.per_extra_kg > 0 && weightG > match.min_weight_g) {
    const extraKg = (weightG - match.min_weight_g) / 1000;
    amount += Math.round(extraKg * match.per_extra_kg);
  }

  // Franchise éventuelle : uniquement si elle est explicitement configurée.
  if (zone.free_over != null && subtotal >= zone.free_over && amount > 0) {
    return { ...base, status: 'free', amount: 0, rate: match, reason: 'FREE_OVER', message: 'Livraison offerte à partir du seuil défini par la boutique.' };
  }

  return { ...base, status: 'priced', amount, rate: match, reason: 'RATE', message: match.label || 'Frais de livraison' };
}

/** Zones proposées pour un mode de réception donné, triées et filtrées. */
function optionsForMode(mode) {
  if (mode === 'pickup') {
    const zone = pickupZone();
    return zone ? [zone] : [];
  }
  return deliveryZones();
}

/** Cohérence moyen de paiement / zone / mode (règle appliquée côté serveur). */
function methodAllowedFor(method, { mode, zone }) {
  if (!method || !method.enabled) return { ok: false, reason: 'Moyen de paiement indisponible.' };
  const modes = safeParse(method.modes, ['pickup', 'delivery']);
  if (modes.length && !modes.includes(mode)) {
    return { ok: false, reason: `Ce moyen de paiement n'est pas disponible pour le mode « ${mode === 'pickup' ? 'retrait' : 'livraison'} ».` };
  }
  const zones = safeParse(method.zone_codes, []);
  if (zones.length && zone && !zones.includes(zone.code)) {
    return { ok: false, reason: `Ce moyen de paiement n'est pas disponible pour la zone « ${zone.name} ».` };
  }
  if (method.code === 'pay_on_delivery' && zone && !zone.cod_allowed) {
    return { ok: false, reason: "Le paiement à la livraison n'est pas proposé pour cette destination." };
  }
  if (['wave', 'orange_money', 'mtn_momo', 'moov_money'].includes(method.code) && !method.configured) {
    // Un Mobile Money sans identifiants marchands n'est utilisable qu'en bac à sable,
    // hors production : sinon on proposerait un moyen incapable d'encaisser.
    const sandboxUsable = Boolean(method.simulated) && config.payments.simulationEnabled && !config.isProduction;
    if (!sandboxUsable) {
      return { ok: false, reason: `${method.name} n'est pas encore connecté : choisissez un autre moyen.` };
    }
  }
  return { ok: true };
}

function safeParse(value, fallback) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function audit(userId, action, entityId, detail) {
  try {
    db.insert('audit_log', {
      user_id: userId || null,
      actor: userId ? 'admin' : 'system',
      action,
      entity_type: 'shipping',
      entity_id: String(entityId ?? ''),
      detail: JSON.stringify(detail || {}),
    });
  } catch { /* noop */ }
}

module.exports = {
  listCarriers,
  getCarrier,
  getCarrierByCode,
  saveCarrier,
  deleteCarrier,
  trackingUrl,
  listZones,
  getZone,
  pickupZone,
  deliveryZones,
  saveZone,
  deleteZone,
  ratesForZone,
  saveRate,
  deleteRate,
  resolveShipping,
  optionsForMode,
  methodAllowedFor,
};
