'use strict';

/** Import et export du catalogue : assistant complet, du fichier au rapport. */

const express = require('express');
const db = require('../../db');
const imports = require('../../domain/imports');
const products = require('../../domain/products');
const categories = require('../../domain/categories');
const auth = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const dates = require('../../lib/dates');
const { flash, notFound, isAjax } = require('../../lib/http');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Tableau de bord de l'import                                         */
/* ------------------------------------------------------------------ */
router.get('/import', auth.requirePermission('imports.run'), (req, res) => {
  res.render('admin/imports/index', {
    title: 'Import et export du catalogue',
    activeNav: 'imports',
    jobs: imports.listJobs(20),
    columns: imports.COLUMNS,
    limits: { maxRows: imports.MAX_ROWS, maxFileBytes: imports.MAX_FILE_BYTES },
    productCounts: products.counts(),
    categories: categories.all(),
  });
});

router.post('/import/televerser', auth.requirePermission('imports.run'), upload.importUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      flash(req, 'error', 'Aucun fichier reçu. Formats acceptés : .xlsx et .csv.');
      return res.redirect('/admin/import');
    }
    const result = await imports.createJob({ file: req.file, userId: req.admin.user.id });
    flash(req, 'success', `Fichier lu : ${result.rowCount} ligne(s) détectée(s). Associez maintenant les colonnes.`);
    return res.redirect(`/admin/import/${result.job.id}`);
  } catch (err) {
    if (err.status) {
      flash(req, 'error', err.message);
      return res.redirect('/admin/import');
    }
    return next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Assistant : association des colonnes, aperçu, exécution              */
/* ------------------------------------------------------------------ */
router.get('/export/catalogue.:format', auth.requirePermission('imports.export'), async (req, res, next) => {
  try {
    const format = req.params.format === 'csv' ? 'csv' : 'xlsx';
    const file = await imports.exportCatalog({
      format,
      filters: {
        statuses: req.query.statut ? [String(req.query.statut)] : ['published', 'draft', 'archived'],
        categoryIds: req.query.categorie ? categories.descendantIds(Number(req.query.categorie)) : null,
      },
    });
    db.insert('audit_log', {
      user_id: req.admin.user.id,
      actor: 'admin',
      action: 'catalog.export',
      entity_type: 'catalog',
      entity_id: format,
      detail: JSON.stringify({ count: file.count }),
    });
    res
      .setHeader('Content-Type', file.mime)
      .setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(file.buffer);
  } catch (err) { next(err); }
});

/** Réindexation de la recherche (après un import massif ou une restauration). */

router.get('/import/modele.:format', auth.requirePermission('imports.run'), async (req, res, next) => {
  try {
    const format = req.params.format === 'csv' ? 'csv' : 'xlsx';
    const file = await imports.buildTemplate(format);
    res
      .setHeader('Content-Type', file.mime)
      .setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(file.buffer);
  } catch (err) { next(err); }
});

router.get('/import/:id', auth.requirePermission('imports.run'), async (req, res, next) => {
  const job = imports.getJob(Number(req.params.id));
  if (!job) return next(notFound('Lot d’import introuvable.'));

  try {
    // Les en-têtes d'origine sont relus depuis le fichier conservé : après
    // l'aperçu, les lignes stockées contiennent des champs normalisés.
    const source = await imports.headersFor(job.id, { sampleSize: 5 });
    const headers = source.headers;
    const storedMapping = job.mapping && Object.keys(job.mapping).length ? job.mapping : imports.suggestMapping(headers);

    res.render('admin/imports/wizard', {
      title: `Import — ${job.filename}`,
      activeNav: 'imports',
      job,
      headers,
      sample: source.sample,
      sourceAvailable: source.available,
      suggestions: imports.suggestMapping(headers),
      storedMapping,
      previewSummary: imports.previewSummary(job.id),
      previewRows: imports.jobRows(job.id, { limit: 8 }),
      progress: imports.progress(job.id),
      columns: imports.COLUMNS,
      categories: categories.tree({ includeArchived: true }),
      errorRows: imports.jobRows(job.id, { status: 'error', limit: 100 }),
      duplicateRows: imports.jobRows(job.id, { status: 'duplicate', limit: 100 }),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/import/:id/colonnes', auth.requirePermission('imports.run'), (req, res, next) => {
  try {
    const job = imports.getJob(Number(req.params.id));
    if (!job) return next(notFound('Lot d’import introuvable.'));

    const mapping = {};
    const rawMapping = req.body.mapping || {};
    for (const [field, column] of Object.entries(rawMapping)) {
      if (column && imports.COLUMNS.some((c) => c.key === field)) mapping[field] = String(column);
    }
    const mode = ['create', 'update', 'upsert'].includes(req.body.mode) ? req.body.mode : 'create';
    const clearColumns = Array.isArray(req.body.clear_columns) ? req.body.clear_columns : String(req.body.clear_columns || '').split(',').filter(Boolean);

    const result = imports.preview(job.id, {
      mapping,
      mode,
      options: {
        blankPolicy: req.body.blank_policy === 'clear' ? 'clear' : 'keep',
        clearColumns,
        statusForNew: req.body.status_for_new === 'published' ? 'published' : 'draft',
        createMissingCategories: req.body.create_categories !== '0',
        createMissingBrands: req.body.create_brands !== '0',
        generateMissingSku: req.body.generate_sku === '1',
        confirmImported: req.body.confirm_imported === '1',
        allowMissingPrice: req.body.allow_missing_price === '1',
        batchSize: Math.max(1, Math.min(500, Number(req.body.batch_size) || 50)),
      },
    });

    flash(
      req,
      result.summary.invalid ? 'warn' : 'success',
      `Aperçu terminé : ${result.summary.willCreate} création(s), ${result.summary.willUpdate} mise(s) à jour, ${result.summary.willSkip} ignorée(s), ${result.summary.invalid} rejetée(s).`
    );
    return res.redirect(`/admin/import/${job.id}#apercu`);
  } catch (err) {
    if (err.status) {
      flash(req, 'error', err.message);
      return res.redirect(`/admin/import/${req.params.id}`);
    }
    return next(err);
  }
});

/** Exécute UN lot. L'interface appelle cette route en boucle et affiche la progression. */
router.post('/import/:id/executer', auth.requirePermission('imports.run'), (req, res, next) => {
  try {
    const job = imports.getJob(Number(req.params.id));
    if (!job) return next(notFound('Lot d’import introuvable.'));
    const progress = imports.runBatch(job.id, {
      userId: req.admin.user.id,
      batchSize: Number(req.body.batch_size) || null,
    });
    if (isAjax(req)) return res.json({ ok: true, ...progress });
    flash(req, progress.done ? 'success' : 'info', progress.done
      ? `Import terminé : ${progress.counts.ok} ligne(s) traitée(s), ${progress.counts.error} rejetée(s).`
      : `Lot traité : ${progress.processed}/${progress.total} ligne(s).`);
    return res.redirect(`/admin/import/${job.id}#progression`);
  } catch (err) {
    if (isAjax(req)) return res.status(err.status || 500).json({ ok: false, error: err.message });
    flash(req, 'error', err.message);
    return res.redirect(`/admin/import/${req.params.id}`);
  }
});

router.get('/import/:id/progression', auth.requirePermission('imports.run'), (req, res, next) => {
  const progress = imports.progress(Number(req.params.id));
  if (!progress) return next(notFound('Lot d’import introuvable.'));
  res.json({ ok: true, ...progress });
});

router.get('/import/:id/rapport', auth.requirePermission('imports.run'), (req, res, next) => {
  const job = imports.getJob(Number(req.params.id));
  if (!job) return next(notFound('Lot d’import introuvable.'));
  const statusFilter = ['ok', 'error', 'duplicate', 'skipped', 'pending'].includes(req.query.statut) ? String(req.query.statut) : '';
  res.render('admin/imports/report', {
    title: `Rapport d’import — ${job.filename}`,
    activeNav: 'imports',
    job,
    progress: imports.progress(job.id),
    summary: imports.previewSummary(job.id),
    rows: imports.jobRows(job.id, { status: statusFilter || null, limit: 500 }),
    statusFilter,
  });
});

router.post('/import/:id/annuler', auth.requirePermission('imports.run'), (req, res) => {
  imports.cancelJob(Number(req.params.id), req.admin.user.id);
  flash(req, 'info', 'Import annulé. Les lignes déjà traitées restent enregistrées.');
  return res.redirect('/admin/import');
});

/** Relance les lignes en erreur après correction du fichier source. */
router.post('/import/:id/relancer-erreurs', auth.requirePermission('imports.run'), (req, res) => {
  const job = imports.getJob(Number(req.params.id));
  if (!job) { flash(req, 'error', 'Lot introuvable.'); return res.redirect('/admin/import'); }
  const result = db.run("UPDATE import_rows SET status = 'pending', message = '' WHERE job_id = ? AND status = 'error'", [job.id]);
  db.run("UPDATE import_jobs SET status = 'mapped', processed = processed - ?, error_count = 0 WHERE id = ?", [Number(result.changes), job.id]);
  flash(req, 'info', `${result.changes} ligne(s) remise(s) en file d’attente.`);
  return res.redirect(`/admin/import/${job.id}#progression`);
});

/* ------------------------------------------------------------------ */
/* Modèles et exports                                                  */
/* ------------------------------------------------------------------ */


router.post('/import/reindexer', auth.requirePermission('imports.run'), (req, res) => {
  const count = products.reindexAll();
  flash(req, 'success', `Index de recherche reconstruit pour ${count} produit(s).`);
  return res.redirect('/admin/import');
});

module.exports = router;
