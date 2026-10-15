'use strict';

/**
 * Compte client FACULTATIF.
 *
 * L'achat sans compte reste le parcours principal. Le compte permet seulement :
 *   - retrouver ses commandes et leurs liens de suivi ;
 *   - pré-remplir ses coordonnées ;
 *   - gérer son consentement marketing (distinct et révocable).
 */

const express = require('express');
const db = require('../db');
const users = require('../domain/users');
const orders = require('../domain/orders');
const cart = require('../domain/cart');
const session = require('../lib/session');
const settings = require('../lib/settings');
const dates = require('../lib/dates');
const auth = require('../middleware/auth');
const { flash, notFound } = require('../lib/http');
const { Validator } = require('../lib/validate');

const router = express.Router();

router.get('/compte', (req, res) => {
  if (!req.customer) return res.redirect('/compte/connexion');
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
  const list = orders.listForCustomer(customer.id, 25);
  res.renderPage('account/dashboard', {
    title: 'Mon compte',
    noindex: true,
    canonical: null,
    customer,
    orders: list,
  });
});

/* ------------------------------------------------------------------ */
/* Connexion / inscription                                             */
/* ------------------------------------------------------------------ */
router.get('/compte/connexion', (req, res) => {
  if (req.customer) return res.redirect('/compte');
  res.renderPage('account/login', {
    title: 'Connexion',
    noindex: true,
    canonical: null,
    suite: String(req.query.suite || '/compte'),
    errors: {},
    values: {},
  });
});

router.post('/compte/connexion', auth.authRateLimit('customer-login'), (req, res) => {
  const suite = String(req.body.suite || '/compte');
  // Redirection uniquement interne : bloque toute URL absolue (open redirect).
  const safeSuite = suite.startsWith('/') && !suite.startsWith('//') ? suite : '/compte';
  try {
    const customer = users.loginCustomer({ identifier: req.body.identifier, password: req.body.password });
    session.createCustomerSession(customer, res);
    if (req.cart) cart.mergeInto(customer.id, req.cart.id);
    flash(req, 'success', 'Vous êtes connecté.');
    return res.redirect(safeSuite);
  } catch (err) {
    return res.status(err.status === 401 ? 401 : 400).renderPage('account/login', {
      title: 'Connexion',
      noindex: true,
      canonical: null,
      suite: safeSuite,
      errors: { identifier: err.message },
      values: { identifier: req.body.identifier },
    });
  }
});

router.get('/compte/inscription', (req, res) => {
  res.renderPage('account/register', {
    title: 'Créer un compte',
    noindex: true,
    canonical: null,
    errors: {},
    values: {},
    marketingConsentEnabled: Boolean(settings.get('commerce.marketing_consent_enabled')),
  });
});

router.post('/compte/inscription', auth.authRateLimit('customer-register'), (req, res) => {
  const v = new Validator(req.body);
  v.string('fullName', { required: true, min: 2, max: 120, label: 'Nom complet' });
  const email = v.email('email', { required: false });
  v.phone('phone', { required: !email });
  v.string('password', { required: true, min: 10, max: 200, label: 'Mot de passe' });
  const marketing = v.boolean('marketing', { fallback: false });

  if (!v.valid) {
    return res.status(400).renderPage('account/register', {
      title: 'Créer un compte',
      noindex: true,
      canonical: null,
      errors: v.errors,
      values: req.body,
      marketingConsentEnabled: Boolean(settings.get('commerce.marketing_consent_enabled')),
    });
  }

  try {
    const customer = users.registerCustomer({
      email,
      phone: v.values.phone,
      fullName: v.values.fullName,
      password: v.values.password,
      marketingConsent: marketing && settings.get('commerce.marketing_consent_enabled'),
    });
    session.createCustomerSession(customer, res);
    if (req.cart) cart.mergeInto(customer.id, req.cart.id);
    flash(req, 'success', 'Compte créé. Bienvenue.');
    return res.redirect('/compte');
  } catch (err) {
    return res.status(err.status || 400).renderPage('account/register', {
      title: 'Créer un compte',
      noindex: true,
      canonical: null,
      errors: { [err.code === 'EMAIL_TAKEN' ? 'email' : 'password']: err.message },
      values: req.body,
      marketingConsentEnabled: Boolean(settings.get('commerce.marketing_consent_enabled')),
    });
  }
});

router.post('/compte/deconnexion', (req, res) => {
  if (req.customer) {
    db.run('UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ? AND revoked_at IS NULL', [dates.nowIso(), req.customer.id]);
  }
  session.destroyCustomerSession(res);
  flash(req, 'info', 'Vous êtes déconnecté.');
  return res.redirect('/');
});

/* ------------------------------------------------------------------ */
/* Commandes du compte                                                 */
/* ------------------------------------------------------------------ */
router.get('/compte/commandes', auth.requireCustomer, (req, res) => {
  const list = orders.listForCustomer(req.customer.id, 100);
  res.renderPage('account/orders', {
    title: 'Mes commandes',
    noindex: true,
    canonical: null,
    orders: list.map((o) => orders.loadFull(o.id)),
  });
});

router.get('/compte/commande/:reference', auth.requireCustomer, (req, res, next) => {
  const order = orders.getByReference(req.params.reference);
  // Isolation stricte : un client ne peut pas consulter la commande d'un autre.
  if (!order || order.customer_id !== req.customer.id) return next(notFound('Commande introuvable.'));
  const full = orders.loadFull(order.id);
  res.renderPage('account/order', {
    title: `Commande ${order.reference}`,
    noindex: true,
    canonical: null,
    order: full,
    steps: require('./tracking').buildSteps(full),
  });
});

/* ------------------------------------------------------------------ */
/* Paramètres du compte                                                */
/* ------------------------------------------------------------------ */
router.get('/compte/parametres', auth.requireCustomer, (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
  res.renderPage('account/settings', {
    title: 'Mes informations',
    noindex: true,
    canonical: null,
    customer,
    errors: {},
    marketingConsentEnabled: Boolean(settings.get('commerce.marketing_consent_enabled')),
  });
});

router.post('/compte/parametres', auth.requireCustomer, (req, res) => {
  const customer = db.get('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
  const v = new Validator(req.body);
  v.string('fullName', { required: true, min: 2, max: 120, label: 'Nom complet' });
  v.phone('phone', { required: false });
  const marketing = v.boolean('marketing', { fallback: false });

  if (!v.valid) {
    return res.status(400).renderPage('account/settings', {
      title: 'Mes informations',
      noindex: true,
      canonical: null,
      customer,
      errors: v.errors,
      marketingConsentEnabled: Boolean(settings.get('commerce.marketing_consent_enabled')),
    });
  }

  const previousConsent = Boolean(customer.marketing_consent);
  db.update('customers', customer.id, {
    full_name: v.values.fullName,
    phone: v.values.phone || customer.phone,
    marketing_consent: marketing && settings.get('commerce.marketing_consent_enabled') ? 1 : 0,
    consent_at: marketing ? dates.nowIso() : null,
    updated_at: dates.nowIso(),
  });
  if (previousConsent !== Boolean(marketing)) {
    db.insert('audit_log', {
      user_id: null,
      actor: 'customer',
      action: marketing ? 'consent.granted' : 'consent.withdrawn',
      entity_type: 'customer',
      entity_id: String(customer.id),
      detail: JSON.stringify({ channel: 'account' }),
    });
  }
  flash(req, 'success', 'Informations mises à jour.');
  return res.redirect('/compte/parametres');
});

router.post('/compte/mot-de-passe', auth.requireCustomer, auth.authRateLimit('customer-password'), (req, res) => {
  try {
    users.updateCustomerPassword(req.customer.id, req.body.current_password, req.body.new_password);
    flash(req, 'success', 'Mot de passe modifié.');
  } catch (err) {
    flash(req, 'error', err.message);
  }
  return res.redirect('/compte/parametres');
});

/** Suppression du compte : anonymisation, les commandes restent pour la comptabilité. */
router.post('/compte/supprimer', auth.requireCustomer, (req, res) => {
  const id = req.customer.id;
  db.transaction(() => {
    db.run('UPDATE customer_sessions SET revoked_at = ? WHERE customer_id = ?', [dates.nowIso(), id]);
    db.update('customers', id, {
      email: null,
      phone: '',
      full_name: 'Compte supprimé',
      password_hash: '',
      marketing_consent: 0,
      notes: 'Compte supprimé à la demande du client.',
      updated_at: dates.nowIso(),
    });
    db.insert('audit_log', {
      user_id: null,
      actor: 'customer',
      action: 'customer.deleted',
      entity_type: 'customer',
      entity_id: String(id),
      detail: JSON.stringify({ at: dates.nowIso() }),
    });
  });
  session.destroyCustomerSession(res);
  flash(req, 'info', 'Votre compte a été supprimé. Vos commandes restent consultables via leur lien de suivi.');
  return res.redirect('/');
});

module.exports = router;
