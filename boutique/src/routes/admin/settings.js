'use strict';

/** Réglages : établissement, contacts, apparence, commerce, paiements, livraison, pages. */

const express = require('express');
const db = require('../../db');
const settings = require('../../lib/settings');
const shipping = require('../../domain/shipping');
const payments = require('../../domain/payments');
const images = require('../../lib/images');
const money = require('../../lib/money');
const dates = require('../../lib/dates');
const config = require('../../config');
const auth = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const { flash } = require('../../lib/http');
const { Validator, sanitizeHtml, normalizePhone, formatPhone } = require('../../lib/validate');
const { normalizeText } = require('../../lib/slug');

const router = express.Router();

const TABS = [
  { key: 'etablissement', label: 'Établissement', permission: 'settings.read' },
  { key: 'contacts', label: 'Contacts et WhatsApp', permission: 'settings.read' },
  { key: 'commerce', label: 'Commerce', permission: 'settings.read' },
  { key: 'apparence', label: 'Apparence', permission: 'settings.read' },
  { key: 'livraison', label: 'Retrait et livraison', permission: 'settings.read' },
  { key: 'paiements', label: 'Paiements', permission: 'settings.read' },
  { key: 'pages', label: 'Pages et textes', permission: 'settings.read' },
  { key: 'notifications', label: 'Notifications', permission: 'settings.read' },
];

function renderSettings(req, res, tab, extra = {}) {
  const all = settings.load();
  res.render('admin/settings', {
    title: 'Réglages',
    activeNav: 'settings',
    tab: TABS.some((t) => t.key === tab) ? tab : 'etablissement',
    tabs: TABS.filter((t) => require('../../domain/users').can(req.admin.user, t.permission)),
    all,
    schema: settings.SCHEMA,
    zones: shipping.listZones(),
    carriers: shipping.listCarriers(),
    methods: payments.listMethods().map((m) => ({ ...m, state: payments.methodState(m), credentials: config.payments.providers[m.code] || null })),
    pages: db.all('SELECT * FROM pages ORDER BY position ASC'),
    rates: Object.fromEntries(shipping.listZones().map((z) => [z.id, shipping.ratesForZone(z.id)])),
    errors: extra.errors || {},
    values: extra.values || {},
    checklist: settings.completenessChecklist(),
    providerEnvNames: {
      wave: ['WAVE_MERCHANT_ID', 'WAVE_API_KEY'],
      orange_money: ['ORANGE_MONEY_CLIENT_ID', 'ORANGE_MONEY_CLIENT_SECRET'],
      mtn_momo: ['MTN_MOMO_TARGET_ENV', 'MTN_MOMO_SUBSCRIPTION_KEY'],
      moov_money: ['MOOV_MERCHANT_ID', 'MOOV_MERCHANT_SECRET'],
    },
    simulationEnabled: config.payments.simulationEnabled,
    money,
  });
}

router.get('/reglages', auth.requirePermission('settings.read'), (req, res) => {
  renderSettings(req, res, String(req.query.onglet || 'etablissement'));
});

/* ------------------------------------------------------------------ */
/* Établissement                                                       */
/* ------------------------------------------------------------------ */
router.post('/reglages/etablissement', auth.requirePermission('settings.write'), upload.singleImage, async (req, res, next) => {
  try {
    const v = new Validator(req.body);
    v.string('store_name', { required: true, max: 200, label: 'Nom' });
    v.string('store_short_name', { max: 120, label: 'Nom court' });
    v.string('store_tagline', { max: 200, label: 'Signature' });
    v.string('store_city', { required: true, max: 120, label: 'Ville' });
    v.string('store_region', { max: 120, label: 'Région' });
    v.string('store_country', { max: 120, label: 'Pays' });
    v.string('store_country_code', { max: 4, label: 'Code pays' });
    v.string('store_address', { max: 300, label: 'Adresse' });
    v.boolean('store_address_confirmed');
    v.url('store_maps_url', { label: 'Lien Google Maps' });
    v.string('store_maps_lat', { max: 20, label: 'Latitude' });
    v.string('store_maps_lng', { max: 20, label: 'Longitude' });
    v.enum('store_hours_status', ['unconfirmed', 'confirmed'], { fallback: 'unconfirmed', label: 'Statut des horaires' });
    v.string('store_registration', { max: 120, label: 'Immatriculation' });
    v.string('ui_home_intro', { max: 600, label: 'Texte d’accueil' });
    v.throwIfInvalid('Réglages établissement');

    settings.setMany({
      'store.name': v.values.store_name,
      'store.short_name': v.values.store_short_name,
      'store.tagline': v.values.store_tagline,
      'store.city': v.values.store_city,
      'store.region': v.values.store_region,
      'store.country': v.values.store_country,
      'store.country_code': (v.values.store_country_code || 'CI').toUpperCase(),
      'store.address': v.values.store_address,
      'store.address_confirmed': Boolean(v.values.store_address_confirmed),
      'store.maps_url': v.values.store_maps_url,
      'store.maps_lat': v.values.store_maps_lat,
      'store.maps_lng': v.values.store_maps_lng,
      'store.hours_status': v.values.store_hours_status,
      'store.registration': v.values.store_registration,
      'ui.home_intro': v.values.ui_home_intro,
    }, req.admin.user.id);

    // Horaires
    const hours = [];
    const rawHours = req.body.hours || {};
    const keys = Object.keys(rawHours.open || rawHours.day || {});
    for (const k of keys) {
      const day = normalizeText(rawHours.day?.[k] || '');
      if (!day) continue;
      hours.push({
        day,
        open: normalizeText(rawHours.open?.[k] || ''),
        close: normalizeText(rawHours.close?.[k] || ''),
        closed: rawHours.closed?.[k] === '1' || rawHours.closed?.[k] === 'on',
        note: normalizeText(rawHours.note?.[k] || ''),
      });
    }
    settings.set('store.hours', hours, req.admin.user.id);

    // Logo
    if (req.file) {
      const stored = await images.storeImage(req.file.buffer, { mime: req.file.mimetype });
      const mediaId = db.insert('media_files', {
        kind: 'image',
        file_key: stored.fileKey,
        filename: String(req.file.originalname || '').slice(0, 200),
        mime: stored.sourceMime,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
        alt: `${settings.get('store.name')} — logo`,
        created_by: req.admin.user.id,
      });
      settings.set('store.logo_key', stored.fileKey, req.admin.user.id);
      settings.set('store.logo_status', 'official', req.admin.user.id);
      db.insert('audit_log', {
        user_id: req.admin.user.id, actor: 'admin', action: 'settings.logo', entity_type: 'media',
        entity_id: String(mediaId), detail: JSON.stringify({ key: stored.fileKey }),
      });
    }
    if (req.body.logo_reset === '1') {
      settings.set('store.logo_key', '', req.admin.user.id);
      settings.set('store.logo_status', 'typographic', req.admin.user.id);
    }

    flash(req, 'success', 'Réglages de l’établissement enregistrés.');
    return res.redirect('/admin/reglages?onglet=etablissement');
  } catch (err) {
    if (err.name === 'ValidationError') {
      flash(req, 'error', err.message);
      return renderSettings(req, res, 'etablissement', { errors: err.errors || {} });
    }
    return next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Contacts et WhatsApp                                                */
/* ------------------------------------------------------------------ */
router.post('/reglages/contacts', auth.requirePermission('settings.write'), (req, res) => {
  const raw = req.body.contacts || {};
  const keys = Object.keys(raw.value || raw.label || {});
  const contacts = [];
  const errors = {};
  for (const k of keys) {
    const value = normalizeText(raw.value?.[k] || '');
    const label = normalizeText(raw.label?.[k] || '');
    const type = ['phone', 'email', 'address', 'other'].includes(raw.type?.[k]) ? raw.type[k] : 'phone';
    if (!value && !label) continue;
    if (type === 'phone') {
      const norm = normalizePhone(value);
      if (!norm) {
        errors[`contact_${k}`] = `Numéro invalide : « ${value} ». Format attendu : 07 58 11 38 57 ou +225 07 58 11 38 57.`;
        continue;
      }
      contacts.push({
        id: raw.id?.[k] || `c${Date.now()}${k}`,
        label: label || 'Téléphone',
        type,
        value: norm,
        display: formatPhone(norm),
        is_primary: raw.is_primary === k || raw.is_primary === String(k),
        whatsapp_enabled: raw.whatsapp_enabled?.[k] === '1' || raw.whatsapp_enabled?.[k] === 'on',
        visible: raw.visible?.[k] !== '0',
      });
    } else {
      contacts.push({
        id: raw.id?.[k] || `c${Date.now()}${k}`,
        label: label || (type === 'email' ? 'E-mail' : 'Information'),
        type,
        value,
        display: value,
        is_primary: raw.is_primary === k,
        whatsapp_enabled: false,
        visible: raw.visible?.[k] !== '0',
      });
    }
  }
  if (!contacts.length) {
    flash(req, 'error', 'Conservez au moins un contact.');
    return renderSettings(req, res, 'contacts', { errors });
  }
  // Garantit un contact principal.
  if (!contacts.some((c) => c.is_primary)) contacts[0].is_primary = true;
  else {
    let seen = false;
    for (const c of contacts) {
      if (c.is_primary) {
        if (seen) c.is_primary = false;
        seen = true;
      }
    }
  }

  settings.set('store.contacts', contacts, req.admin.user.id);
  settings.set('whatsapp.enabled', req.body.whatsapp_enabled === '1', req.admin.user.id);
  settings.set('whatsapp.disclaimer', normalizeText(req.body.whatsapp_disclaimer || '').slice(0, 400), req.admin.user.id);
  settings.set('whatsapp.prefill_mode', ['question', 'cart', 'order'].includes(req.body.whatsapp_prefill_mode) ? req.body.whatsapp_prefill_mode : 'question', req.admin.user.id);

  db.insert('audit_log', {
    user_id: req.admin.user.id, actor: 'admin', action: 'settings.contacts', entity_type: 'settings',
    entity_id: 'contacts', detail: JSON.stringify({ count: contacts.length, whatsapp: req.body.whatsapp_enabled === '1' }),
  });
  flash(req, 'success', 'Contacts enregistrés. Le contact principal est utilisé partout sur le site.');
  return res.redirect('/admin/reglages?onglet=contacts');
});

/* ------------------------------------------------------------------ */
/* Commerce                                                            */
/* ------------------------------------------------------------------ */
router.post('/reglages/commerce', auth.requirePermission('settings.write'), (req, res, next) => {
  try {
    const v = new Validator(req.body);
    v.enum('currency', ['XOF'], { fallback: 'XOF', label: 'Devise' });
    v.string('currency_label', { max: 12, label: 'Libellé de devise' });
    v.boolean('guest_checkout', { fallback: true });
    v.boolean('email_required');
    v.boolean('marketing_consent_enabled', { fallback: true });
    v.amount('min_order_amount', { min: 0, fallback: 0, label: 'Montant minimum' });
    v.integer('max_qty_per_line', { min: 1, max: 100000, fallback: 999, label: 'Quantité maximale par ligne' });
    v.boolean('ui_maintenance');
    v.string('ui_maintenance_message', { max: 500, label: 'Message de maintenance' });
    v.boolean('ui_demo_banner');
    v.string('order_prefix', { max: 8, label: 'Préfixe de référence' });
    v.string('pos_prefix', { max: 8, label: 'Préfixe de vente' });
    v.boolean('backup_auto_enabled');
    v.integer('backup_retention', { min: 1, max: 365, fallback: 14, label: 'Conservation des sauvegardes' });
    v.throwIfInvalid('Réglages commerce');

    settings.setMany({
      'commerce.currency': v.values.currency,
      'commerce.currency_label': v.values.currency_label || 'FCFA',
      'commerce.guest_checkout': v.values.guest_checkout,
      'commerce.email_required': v.values.email_required,
      'commerce.marketing_consent_enabled': v.values.marketing_consent_enabled,
      'commerce.min_order_amount': v.values.min_order_amount || 0,
      'commerce.max_qty_per_line': v.values.max_qty_per_line,
      'commerce.order_prefix': (v.values.order_prefix || 'PRV').toUpperCase(),
      'commerce.pos_prefix': (v.values.pos_prefix || 'VT').toUpperCase(),
      'ui.maintenance': v.values.ui_maintenance,
      'ui.maintenance_message': v.values.ui_maintenance_message,
      'ui.demo_banner': v.values.ui_demo_banner,
      'backup.auto_enabled': v.values.backup_auto_enabled,
      'backup.retention': v.values.backup_retention,
    }, req.admin.user.id);
    flash(req, 'success', 'Réglages commerciaux enregistrés.');
    return res.redirect('/admin/reglages?onglet=commerce');
  } catch (err) {
    if (err.name === 'ValidationError') {
      flash(req, 'error', err.message);
      return renderSettings(req, res, 'commerce', { errors: err.errors || {} });
    }
    return next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Apparence (palette modifiable)                                      */
/* ------------------------------------------------------------------ */
router.post('/reglages/apparence', auth.requirePermission('settings.write'), (req, res, next) => {
  try {
    const keys = ['primary', 'primary_dark', 'primary_soft', 'accent', 'accent_soft', 'ink', 'background', 'surface', 'border'];
    const values = {};
    for (const key of keys) {
      const raw = String(req.body[`theme_${key}`] || '').trim();
      if (!raw) continue;
      const check = settings.validate(`theme.${key}`, raw);
      if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
      values[`theme.${key}`] = raw;
    }
    const radius = Math.max(0, Math.min(28, Number(req.body.theme_radius) || 10));
    values['theme.radius'] = radius;
    values['theme.density'] = req.body.theme_density === 'compact' ? 'compact' : 'comfortable';
    settings.setMany(values, req.admin.user.id);
    if (req.body.theme_reset === '1') {
      for (const key of Object.keys(settings.SCHEMA)) {
        if (key.startsWith('theme.')) settings.set(key, settings.SCHEMA[key].default, req.admin.user.id);
      }
      flash(req, 'info', 'Palette réinitialisée.');
    } else {
      flash(req, 'success', 'Apparence enregistrée.');
    }
    return res.redirect('/admin/reglages?onglet=apparence');
  } catch (err) {
    flash(req, 'error', err.message);
    return renderSettings(req, res, 'apparence');
  }
});

/* ------------------------------------------------------------------ */
/* Retrait et livraison                                                */
/* ------------------------------------------------------------------ */
router.post('/reglages/livraison', auth.requirePermission('settings.write'), (req, res) => {
  try {
    settings.set('shipping.pickup_note', normalizeText(req.body.pickup_note || '').slice(0, 600), req.admin.user.id);
    settings.set('shipping.quote_note', normalizeText(req.body.quote_note || '').slice(0, 800), req.admin.user.id);
    settings.set('shipping.rates_confirmed', req.body.rates_confirmed === '1', req.admin.user.id);
    flash(req, 'success', 'Textes de livraison enregistrés.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=livraison');
});

router.post('/reglages/livraison/zones', auth.requirePermission('settings.write'), (req, res) => {
  try {
    shipping.saveZone({
      id: req.body.id || null,
      code: req.body.code,
      name: req.body.name,
      kind: req.body.kind,
      enabled: req.body.enabled === '1',
      position: Number(req.body.position) || 0,
      requires_quote: req.body.requires_quote === '1',
      free_over: req.body.free_over === '' ? null : money.toCents(req.body.free_over),
      eta_text: req.body.eta_text,
      conditions_text: req.body.conditions_text,
      cod_allowed: req.body.cod_allowed === '1',
      default_carrier_id: req.body.default_carrier_id || null,
    }, req.admin.user.id);
    flash(req, 'success', 'Zone enregistrée.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=livraison#zones');
});

router.post('/reglages/livraison/zones/:id/supprimer', auth.requirePermission('settings.write'), (req, res) => {
  try {
    shipping.deleteZone(Number(req.params.id), req.admin.user.id);
    flash(req, 'info', 'Zone supprimée.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=livraison#zones');
});

router.post('/reglages/livraison/tarifs', auth.requirePermission('settings.write'), (req, res) => {
  try {
    shipping.saveRate({
      id: req.body.id || null,
      zone_id: req.body.zone_id,
      carrier_id: req.body.carrier_id || null,
      label: req.body.label,
      min_weight_g: req.body.min_weight_g,
      max_weight_g: req.body.max_weight_g,
      min_subtotal: req.body.min_subtotal === '' ? 0 : money.toCents(req.body.min_subtotal),
      max_subtotal: req.body.max_subtotal === '' ? null : money.toCents(req.body.max_subtotal),
      price: money.toCents(req.body.price) || 0,
      per_extra_kg: money.toCents(req.body.per_extra_kg) || 0,
      enabled: req.body.enabled !== '0',
      position: Number(req.body.position) || 0,
      note: req.body.note,
    }, req.admin.user.id);
    flash(req, 'success', 'Tarif enregistré. La zone n’est plus « sur devis » pour les colis correspondants.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=livraison#tarifs');
});

router.post('/reglages/livraison/tarifs/:id/supprimer', auth.requirePermission('settings.write'), (req, res) => {
  shipping.deleteRate(Number(req.params.id), req.admin.user.id);
  flash(req, 'info', 'Tarif supprimé.');
  return res.redirect('/admin/reglages?onglet=livraison#tarifs');
});

router.post('/reglages/livraison/transporteurs', auth.requirePermission('settings.write'), (req, res) => {
  try {
    shipping.saveCarrier({
      id: req.body.id || null,
      name: req.body.name,
      code: req.body.code,
      contact: req.body.contact,
      tracking_url_template: req.body.tracking_url_template,
      enabled: req.body.enabled === '1',
      position: Number(req.body.position) || 0,
    }, req.admin.user.id);
    flash(req, 'success', 'Transporteur enregistré.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=livraison#transporteurs');
});

router.post('/reglages/livraison/transporteurs/:id/supprimer', auth.requirePermission('settings.write'), (req, res) => {
  try {
    shipping.deleteCarrier(Number(req.params.id), req.admin.user.id);
    flash(req, 'info', 'Transporteur supprimé.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=livraison#transporteurs');
});

/** Simulateur de frais : vérifie ce que paierait un client, sans rien enregistrer. */
router.post('/reglages/livraison/simuler', auth.requirePermission('settings.read'), (req, res) => {
  const result = shipping.resolveShipping({
    zoneId: req.body.zone_id,
    subtotal: money.toCents(req.body.subtotal) || 0,
    weightG: Math.max(0, Number(req.body.weight_g) || 0),
  });
  res.json({
    ok: true,
    status: result.status,
    amount: result.amount,
    amountLabel: result.amount === null ? 'Livraison sur devis' : money.format(result.amount),
    reason: result.reason,
    message: result.message,
    etaText: result.etaText,
  });
});

/* ------------------------------------------------------------------ */
/* Paiements                                                           */
/* ------------------------------------------------------------------ */
router.post('/reglages/paiements/:code', auth.requirePermission('settings.write'), (req, res) => {
  try {
    const code = String(req.params.code);
    const modes = Array.isArray(req.body.modes) ? req.body.modes : String(req.body.modes || '').split(',').filter(Boolean);
    const zoneCodes = Array.isArray(req.body.zone_codes) ? req.body.zone_codes : String(req.body.zone_codes || '').split(',').filter(Boolean);
    payments.saveMethod(code, {
      name: req.body.name,
      enabled: req.body.enabled === '1',
      simulated: req.body.simulated === '1',
      position: req.body.position,
      instructions: req.body.instructions,
      merchant_ref: req.body.merchant_ref,
      color: req.body.color,
      modes,
      zone_codes: zoneCodes,
    }, req.admin.user.id);
    flash(req, 'success', `Moyen de paiement « ${code} » enregistré.`);
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/admin/reglages?onglet=paiements');
});

router.get('/reglages/paiements/notifications', auth.requirePermission('settings.read'), (req, res) => {
  const webhook = require('../../domain/payments/webhook');
  res.render('admin/webhooks', {
    title: 'Notifications de paiement',
    activeNav: 'settings',
    events: webhook.recentEvents(100),
    stats: webhook.stats(),
    secretConfigured: Boolean(config.secrets.paymentWebhook),
    simulationEnabled: config.payments.simulationEnabled,
    endpoint: `${config.publicUrl}/webhooks/<passerelle>`,
  });
});

/* ------------------------------------------------------------------ */
/* Pages éditables                                                     */
/* ------------------------------------------------------------------ */
router.post('/reglages/pages/:slug', auth.requirePermission('settings.write'), (req, res) => {
  const page = db.get('SELECT * FROM pages WHERE slug = ?', [String(req.params.slug)]);
  if (!page) {
    flash(req, 'error', 'Page introuvable.');
    return res.redirect('/admin/reglages?onglet=pages');
  }
  db.update('pages', page.id, {
    title: normalizeText(req.body.title || page.title).slice(0, 200),
    body: sanitizeHtml(String(req.body.body || '')),
    meta_description: normalizeText(req.body.meta_description || '').slice(0, 400),
    published: req.body.published === '1' ? 1 : 0,
    needs_review: req.body.needs_review === '1' ? 1 : 0,
    updated_at: dates.nowIso(),
    updated_by: req.admin.user.id,
  });
  const flagKey = { 'livraison-retours': 'legal.shipping_reviewed', confidentialite: 'legal.privacy_reviewed', conditions: 'legal.terms_reviewed' }[page.slug];
  if (flagKey && req.body.needs_review !== '1') settings.set(flagKey, true, req.admin.user.id);
  flash(req, 'success', `Page « ${page.title} » enregistrée.`);
  return res.redirect('/admin/reglages?onglet=pages');
});

router.post('/reglages/pages', auth.requirePermission('settings.write'), (req, res) => {
  const slug = require('../../lib/slug').slugify(req.body.slug || req.body.title || 'page');
  const existing = db.get('SELECT id FROM pages WHERE slug = ?', [slug]);
  if (existing) {
    flash(req, 'error', 'Cette page existe déjà.');
    return res.redirect('/admin/reglages?onglet=pages');
  }
  db.insert('pages', {
    slug,
    title: normalizeText(req.body.title || 'Nouvelle page').slice(0, 200),
    body: sanitizeHtml(String(req.body.body || '')),
    published: req.body.published === '1' ? 1 : 0,
    needs_review: 1,
    position: Number(req.body.position) || 0,
  });
  flash(req, 'success', 'Page créée.');
  return res.redirect('/admin/reglages?onglet=pages');
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
router.post('/reglages/notifications', auth.requirePermission('settings.write'), (req, res) => {
  settings.setMany({
    'notifications.email_enabled': req.body.email_enabled === '1',
    'notifications.sms_enabled': req.body.sms_enabled === '1',
    'notifications.whatsapp_enabled': req.body.whatsapp_enabled === '1',
    'notifications.from_name': normalizeText(req.body.from_name || '').slice(0, 120),
  }, req.admin.user.id);
  flash(req, 'success', 'Préférences de notification enregistrées. Les connecteurs (e-mail, SMS) restent à brancher : les messages sont pour l’instant journalisés.');
  return res.redirect('/admin/reglages?onglet=notifications');
});

module.exports = router;
