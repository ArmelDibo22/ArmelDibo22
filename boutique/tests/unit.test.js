'use strict';

/**
 * Tests unitaires des briques transverses : argent, slugs, validation,
 * signatures, dates, réglages et garde-fou SQL.
 */

const test = require('node:test');
const assert = require('node:assert');

const { boot } = require('./helpers/boot');
const T = boot(__filename, { seed: false });

const money = require('../src/lib/money');
const slug = require('../src/lib/slug');
const validate = require('../src/lib/validate');
const security = require('../src/lib/security');
const dates = require('../src/lib/dates');
const settings = require('../src/lib/settings');

test('argent : le XOF est manipulé en entiers, sans décimale', () => {
  assert.strictEqual(money.toCents('12 500'), 12500);
  assert.strictEqual(money.toCents('12500,50'), 12500, 'la partie décimale est ignorée');
  assert.strictEqual(money.toCents('1 500 FCFA'), 1500);
  assert.strictEqual(money.toCents(1500), 1500);
  assert.strictEqual(money.toCents(''), null);
  assert.strictEqual(money.toCents('abc'), null);
  // `Intl.NumberFormat('fr-FR')` sépare les milliers par une espace fine
  // insécable (U+202F) : on compare sur une forme normalisée.
  const flat = (v) => money.format(v).replace(/[\u00a0\u202f\u2009]/g, ' ');
  assert.strictEqual(flat(12500), '12 500 FCFA');
  assert.strictEqual(flat(0), '0 FCFA');
  assert.ok(!/[.,]\d/.test(money.format(12500)), 'aucune décimale n’est affichée en XOF');
  assert.strictEqual(money.plain(12500), '12500');
  assert.strictEqual(money.add(1000, 2500, 'x'), 3500, 'une valeur non entière est ignorée');
  assert.ok(money.isValidAmount(0));
  assert.ok(!money.isValidAmount(1.5), 'un montant fractionnaire est invalide');
  assert.ok(!money.isValidAmount(-1));
});

test('slugs : accents et casse normalisés, HTML retiré', () => {
  assert.strictEqual(slug.slugify('Cahier 200 pages — format A4'), 'cahier-200-pages-format-a4');
  assert.strictEqual(slug.slugify('  Clé  USB  32 Go '), 'cle-usb-32-go');
  assert.strictEqual(slug.normalizeText('  Café   crème '), 'Café crème');
  assert.strictEqual(slug.stripHtml('<p>Bonjour <strong>monde</strong></p>'), 'Bonjour monde');
  assert.ok(slug.excerpt('Un texte beaucoup trop long pour être affiché en entier', 20).length <= 23);
});

test('téléphone ivoirien : normalisation E.164 et affichage', () => {
  assert.strictEqual(validate.normalizePhone('07 58 11 38 57'), '+2250758113857');
  assert.strictEqual(validate.normalizePhone('+225 07 58 11 38 57'), '+2250758113857');
  assert.strictEqual(validate.normalizePhone('002250758113857'), '+2250758113857');
  assert.strictEqual(validate.formatPhone('+2250758113857'), '+225 07 58 11 38 57');
  assert.strictEqual(validate.normalizePhone('12345'), '', 'un numéro trop court est refusé');
  assert.strictEqual(validate.normalizePhone(''), '');
});

test('validation : e-mail, HTML assaini, Validator', () => {
  assert.ok(validate.isEmail('client@example.ci'));
  assert.ok(!validate.isEmail('pas-un-email'));
  assert.ok(!validate.isEmail('a@b,c@d'), 'les listes d’adresses sont refusées');

  const dirty = '<p onclick="alert(1)">Texte</p><script>alert(2)</script>';
  const clean = validate.sanitizeHtml(dirty);
  assert.ok(!/onclick/i.test(clean), 'les gestionnaires d’événements sont retirés');
  assert.ok(!/<script/i.test(clean), 'les scripts sont retirés');
  assert.match(clean, /Texte/);

  const v = new validate.Validator({ nom: '  Konan  ', prix: '1500', email: 'invalide' });
  v.string('nom', { required: true, max: 60 });
  v.integer('prix', { min: 0 });
  v.email('email', { required: false });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.email, 'l’e-mail invalide est signalé');
  assert.strictEqual(v.values.nom, 'Konan');
  assert.strictEqual(v.values.prix, 1500);
});

test('signature HMAC : vérification constante et rejet des altérations', () => {
  const secret = 'secret-de-test';
  const body = Buffer.from(JSON.stringify({ amount: 1500 }), 'utf8');
  const signature = security.signWebhookPayload(body, secret);
  assert.ok(security.verifyWebhookSignature(body, signature, secret));
  assert.ok(!security.verifyWebhookSignature(body, signature, 'autre-secret'));
  assert.ok(!security.verifyWebhookSignature(Buffer.from('{"amount":9999}'), signature, secret));
  assert.ok(!security.verifyWebhookSignature(body, '', secret), 'une signature absente est refusée');
  assert.ok(security.safeEqual('abc', 'abc'));
  assert.ok(!security.safeEqual('abc', 'abd'));
  assert.ok(!security.safeEqual('abc', 'abcd'));
});

test('dates : conversion ISO <-> champ de formulaire', () => {
  assert.strictEqual(dates.toDateInput('2026-03-05T14:30:00.000Z'), '2026-03-05');
  assert.strictEqual(dates.fromInput('2026-03-05'), '2026-03-05T00:00:00.000Z');
  assert.strictEqual(dates.fromInput('2026-03-05', { endOfDay: true }), '2026-03-05T23:59:59.000Z');
  assert.strictEqual(dates.fromInput(''), null);
  assert.match(dates.todayInTz(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(dates.isPast(dates.addDays(dates.nowIso(), -1)));
  assert.ok(dates.isFuture(dates.addDays(dates.nowIso(), 1)));
});

test('réglages : typage, bornes et refus des valeurs hors schéma', () => {
  settings.ensureDefaults();
  assert.strictEqual(settings.get('commerce.currency'), 'XOF');
  // Les entiers sont bornés silencieusement (coerce), jamais stockés hors limites.
  assert.strictEqual(settings.validate('theme.radius', '999').value, 28, 'ramené au maximum');
  assert.strictEqual(settings.validate('theme.radius', '-5').value, 0, 'ramené au minimum');
  assert.strictEqual(settings.validate('theme.radius', 12).value, 12);
  assert.strictEqual(settings.validate('theme.radius', 'abc').value, settings.SCHEMA['theme.radius'].default);
  assert.strictEqual(settings.validate('theme.density', 'geant').ok, false, 'valeur hors énumération');
  assert.strictEqual(settings.validate('theme.primary', 'bleu').ok, false, 'couleur invalide');
  assert.strictEqual(settings.validate('theme.primary', '#14294F').ok, true);
  assert.strictEqual(settings.validate('reglage.inconnu', 1).ok, false, 'clé inconnue refusée');
  settings.set('theme.radius', 999);
  assert.strictEqual(settings.get('theme.radius'), 28, 'set() applique le bornage avant écriture');
  settings.set('theme.radius', 10);
  assert.strictEqual(settings.validate('commerce.guest_checkout', 'oui').ok, true);
  assert.ok(Array.isArray(settings.SCHEMA['store.contacts'].default));
  const checklist = settings.completenessChecklist();
  assert.ok(checklist.length >= 5);
  assert.ok(checklist.every((c) => typeof c.label === 'string' && typeof c.done === 'boolean'));
});

test('garde-fou SQL : un nombre de paramètres incohérent est signalé explicitement', () => {
  assert.strictEqual(T.db.countPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 2);
  assert.strictEqual(T.db.countPlaceholders("SELECT * FROM t WHERE a = '?' AND b = ?"), 1,
    "un '?' dans une chaîne SQL n'est pas un marqueur");
  assert.strictEqual(T.db.countPlaceholders("SELECT * FROM t WHERE a = 'pourquoi ?'"), 0);

  assert.throws(
    () => T.db.all('SELECT * FROM sqlite_master WHERE name = ? AND type = ?', ['table']),
    (err) => err.code === 'SQL_PARAM_MISMATCH' && /2 marqueur/.test(err.message)
  );
  // Cas réel corrigé : un paramètre lié sans marqueur correspondant.
  assert.throws(
    () => T.db.get('SELECT 1 WHERE 1 = 1', ['active']),
    (err) => err.code === 'SQL_PARAM_MISMATCH'
  );
  assert.doesNotThrow(() => T.db.get('SELECT 1 AS n WHERE ?', [1]));
});
