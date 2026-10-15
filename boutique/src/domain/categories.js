'use strict';

/**
 * Catégories arborescentes : ajout, renommage, réorganisation, archivage.
 * Aucune limite de profondeur ni de nombre n'est codée en dur.
 */

const db = require('../db');
const dates = require('../lib/dates');
const { slugify, uniqueSlug, normalizeText } = require('../lib/slug');

function all() {
  return db.all('SELECT * FROM categories ORDER BY position ASC, name ASC');
}

function listActive() {
  return db.all('SELECT * FROM categories WHERE archived = 0 ORDER BY position ASC, name ASC');
}

function get(id) {
  return db.get('SELECT * FROM categories WHERE id = ?', [id]);
}

function getBySlug(slug) {
  return db.get('SELECT * FROM categories WHERE slug = ?', [slug]);
}

/** Arbre complet (parents puis enfants), avec compteur de produits publiés. */
function tree({ includeArchived = false } = {}) {
  const rows = db.all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'published') AS product_count
       FROM categories c
      WHERE (? = 1 OR c.archived = 0)
      ORDER BY c.position ASC, c.name ASC`,
    [includeArchived ? 1 : 0]
  );
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Identifiants de la catégorie et de tous ses descendants. */
function descendantIds(id) {
  const rows = all();
  const childrenOf = new Map();
  for (const r of rows) {
    const list = childrenOf.get(r.parent_id) || [];
    list.push(r.id);
    childrenOf.set(r.parent_id, list);
  }
  const out = [];
  const stack = [Number(id)];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const child of childrenOf.get(cur) || []) stack.push(child);
  }
  return out;
}

/** Fil d'Ariane depuis la racine. */
function breadcrumb(id) {
  const byId = new Map(all().map((r) => [r.id, r]));
  const out = [];
  let cur = byId.get(Number(id));
  let guard = 0;
  while (cur && guard < 20) {
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    guard += 1;
  }
  return out;
}

function slugExists(slug, excludeId = null) {
  const row = db.get('SELECT id FROM categories WHERE slug = ? AND id IS NOT ?', [slug, excludeId]);
  return Boolean(row);
}

function create({ name, parentId = null, description = '', slug = '', position = null, userId = null }) {
  const cleanName = normalizeText(name);
  if (!cleanName) throw Object.assign(new Error('Le nom de la catégorie est obligatoire.'), { status: 400 });
  const parent = parentId ? get(parentId) : null;
  if (parentId && !parent) throw Object.assign(new Error('Catégorie parente introuvable.'), { status: 400 });

  const maxPos = position !== null && position !== undefined
    ? Number(position)
    : (db.get('SELECT COALESCE(MAX(position),0)+1 AS p FROM categories WHERE parent_id IS ?', [parentId || null])?.p ?? 0);

  const id = db.transaction(() => {
    const base = slugify(slug || cleanName);
    const finalSlug = uniqueSlug(base, (s) => slugExists(s));
    const newId = db.insert('categories', {
      parent_id: parent ? parent.id : null,
      name: cleanName,
      slug: finalSlug,
      description: normalizeText(description),
      position: maxPos,
      archived: 0,
    });
    audit(userId, 'category.create', newId, { name: cleanName, slug: finalSlug });
    return newId;
  });
  return get(id);
}

function update(id, fields, userId = null) {
  const existing = get(id);
  if (!existing) throw Object.assign(new Error('Catégorie introuvable.'), { status: 404 });

  const data = {};
  if (fields.name !== undefined) {
    const cleanName = normalizeText(fields.name);
    if (!cleanName) throw Object.assign(new Error('Le nom de la catégorie est obligatoire.'), { status: 400 });
    data.name = cleanName;
    if (fields.slug === undefined) {
      const base = slugify(cleanName);
      data.slug = uniqueSlug(base, (s) => slugExists(s, id));
    }
  }
  if (fields.slug !== undefined) {
    const base = slugify(fields.slug || existing.name);
    data.slug = uniqueSlug(base, (s) => slugExists(s, id));
  }
  if (fields.description !== undefined) data.description = normalizeText(fields.description);
  if (fields.archived !== undefined) data.archived = fields.archived ? 1 : 0;
  if (fields.position !== undefined && fields.position !== null) data.position = Number(fields.position);
  if (fields.image_key !== undefined) data.image_key = String(fields.image_key || '');

  if (fields.parentId !== undefined) {
    const nextParent = fields.parentId ? Number(fields.parentId) : null;
    if (nextParent === Number(id)) throw Object.assign(new Error('Une catégorie ne peut pas être son propre parent.'), { status: 400 });
    if (nextParent) {
      const forbidden = new Set(descendantIds(id));
      if (forbidden.has(nextParent)) {
        throw Object.assign(new Error('Déplacement impossible : la nouvelle catégorie parente est une descendante.'), { status: 400 });
      }
      if (!get(nextParent)) throw Object.assign(new Error('Catégorie parente introuvable.'), { status: 400 });
    }
    data.parent_id = nextParent;
  }

  if (Object.keys(data).length) {
    data.updated_at = dates.nowIso();
    db.update('categories', id, data);
    audit(userId, 'category.update', id, data);
  }
  return get(id);
}

/** Réordonnancement explicite : [{id, position}]. */
function reorder(items, userId = null) {
  db.transaction(() => {
    for (const item of items || []) {
      db.run('UPDATE categories SET position = ?, updated_at = ? WHERE id = ?', [
        Number(item.position) || 0,
        dates.nowIso(),
        Number(item.id),
      ]);
    }
  });
  audit(userId, 'category.reorder', '', { count: (items || []).length });
  return all();
}

function archive(id, userId = null) {
  return update(id, { archived: true }, userId);
}

/** L'archivage d'un parent n'archive pas les enfants : ils remontent d'un niveau. */
function remove(id, userId = null) {
  const existing = get(id);
  if (!existing) return false;
  const productCount = db.get('SELECT COUNT(*) AS c FROM products WHERE category_id = ?', [id])?.c || 0;
  db.transaction(() => {
    db.run('UPDATE categories SET parent_id = ? WHERE parent_id = ?', [existing.parent_id || null, id]);
    if (productCount > 0) db.run('UPDATE products SET category_id = NULL WHERE category_id = ?', [id]);
    db.run('DELETE FROM attribute_templates WHERE category_id = ?', [id]);
    db.run('DELETE FROM categories WHERE id = ?', [id]);
  });
  audit(userId, 'category.delete', id, { name: existing.name, detached_products: productCount });
  return true;
}

/* ------------------------------------------------------------------ */
/* Modèles d'attributs par catégorie                                   */
/* ------------------------------------------------------------------ */
function attributeTemplates(categoryId) {
  if (!categoryId) return [];
  // Hérite des modèles de la catégorie parente (caractéristiques partagées).
  const chain = breadcrumb(categoryId).map((c) => c.id);
  if (!chain.length) return [];
  const placeholders = chain.map(() => '?').join(',');
  return db.all(
    `SELECT * FROM attribute_templates WHERE category_id IN (${placeholders}) ORDER BY position ASC, label ASC`,
    chain
  );
}

function saveAttributeTemplate(categoryId, tpl, userId = null) {
  const key = slugify(tpl.key || tpl.label || '');
  if (!key) throw Object.assign(new Error('La clé de la caractéristique est obligatoire.'), { status: 400 });
  const existing = db.get('SELECT id FROM attribute_templates WHERE category_id = ? AND key = ?', [categoryId, key]);
  const data = {
    category_id: Number(categoryId),
    key,
    label: normalizeText(tpl.label || key),
    type: ['text', 'number', 'select', 'boolean'].includes(tpl.type) ? tpl.type : 'text',
    options: JSON.stringify(Array.isArray(tpl.options) ? tpl.options : []),
    unit: normalizeText(tpl.unit || ''),
    required: tpl.required ? 1 : 0,
    position: Number(tpl.position) || 0,
  };
  if (existing) db.update('attribute_templates', existing.id, data);
  else db.insert('attribute_templates', data);
  audit(userId, 'attribute_template.save', key, { category_id: categoryId });
  return attributeTemplates(categoryId);
}

function deleteAttributeTemplate(id, userId = null) {
  db.run('DELETE FROM attribute_templates WHERE id = ?', [Number(id)]);
  audit(userId, 'attribute_template.delete', id, {});
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */
function audit(userId, action, entityId, detail) {
  try {
    db.insert('audit_log', {
      user_id: userId || null,
      actor: userId ? 'admin' : 'system',
      action,
      entity_type: 'category',
      entity_id: String(entityId ?? ''),
      detail: JSON.stringify(detail || {}),
    });
  } catch { /* l'audit ne doit jamais faire échouer l'opération */ }
}

module.exports = {
  all,
  listActive,
  get,
  getBySlug,
  tree,
  descendantIds,
  breadcrumb,
  create,
  update,
  reorder,
  archive,
  remove,
  attributeTemplates,
  saveAttributeTemplate,
  deleteAttributeTemplate,
};
