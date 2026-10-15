/* ============================================================================
   Administration — interactions.
   Objectif : l'exploitant peut tout faire sans connaissance technique.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document;

  function csrfToken() {
    var meta = doc.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function toast(message, tone) {
    var wrap = doc.querySelector('.flashes');
    if (!wrap) {
      wrap = doc.createElement('div');
      wrap.className = 'flashes';
      doc.body.appendChild(wrap);
    }
    var el = doc.createElement('div');
    el.className = 'alert alert--' + (tone || 'success');
    var span = doc.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  /* --- Navigation mobile --------------------------------------------------- */
  function initNav() {
    var nav = doc.querySelector('[data-admin-nav]');
    var toggle = doc.querySelector('[data-admin-nav-toggle]');
    if (!nav || !toggle) return;
    toggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', open ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', String(!open));
    });
  }

  /* --- Confirmation des actions sensibles ---------------------------------- */
  function initConfirm() {
    doc.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-confirm]');
      if (!form) return;
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-confirm-action]');
      if (!btn) return;
      if (!window.confirm(btn.getAttribute('data-confirm-action'))) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  /* --- Répéteurs (variantes, caractéristiques, composants de kit) ---------- */
  function initRepeaters() {
    doc.addEventListener('click', function (e) {
      var add = e.target.closest('[data-repeater-add]');
      if (add) {
        var repeater = add.closest('[data-repeater]');
        var tpl = repeater.querySelector('template');
        var list = repeater.querySelector('[data-repeater-list]');
        if (tpl && list) {
          var node = tpl.content.firstElementChild.cloneNode(true);
          list.appendChild(node);
          var first = node.querySelector('input,select,textarea');
          if (first) first.focus();
          reindex(repeater);
        }
        return;
      }

      var remove = e.target.closest('[data-repeater-remove]');
      if (remove) {
        var row = remove.closest('[data-repeater-row]');
        var repeater2 = remove.closest('[data-repeater]');
        if (row) row.remove();
        if (repeater2) { reindex(repeater2); markDirty(repeater2); }
      }
    });

    doc.addEventListener('input', function (e) {
      var repeater = e.target.closest('[data-repeater]');
      if (repeater) markDirty(repeater);
    });

    function markDirty(repeater) {
      var count = repeater.querySelectorAll('[data-repeater-row]').length;
      var out = repeater.querySelector('[data-repeater-count]');
      if (out) out.textContent = String(count);
    }

    function reindex(repeater) {
      var rows = repeater.querySelectorAll('[data-repeater-row]');
      Array.prototype.forEach.call(rows, function (row, i) {
        Array.prototype.forEach.call(row.querySelectorAll('[data-index]'), function (el) {
          var name = el.getAttribute('name') || '';
          el.setAttribute('name', name.replace(/\[\d+\]/, '[' + i + ']'));
          var forAttr = el.getAttribute('data-index');
          if (forAttr) {
            var label = row.querySelector('label[for="' + forAttr + '"]');
            if (label) label.setAttribute('for', forAttr + '-' + i);
          }
        });
      });
      markDirty(repeater);
    }
  }

  /* --- Sélection multiple -------------------------------------------------- */
  function initBulk() {
    var table = doc.querySelector('[data-bulk-table]');
    if (!table) return;
    var selectAll = table.querySelector('[data-select-all]');
    var boxes = function () { return table.querySelectorAll('[data-bulk-id]'); };
    var bar = doc.querySelector('[data-bulk-bar]');
    var counter = doc.querySelector('[data-bulk-count]');

    function refresh() {
      var checked = Array.prototype.filter.call(boxes(), function (b) { return b.checked; });
      if (counter) counter.textContent = String(checked.length);
      if (bar) bar.hidden = checked.length === 0;
      if (selectAll) selectAll.checked = checked.length > 0 && checked.length === boxes().length;
      Array.prototype.forEach.call(boxes(), function (b) {
        var row = b.closest('tr');
        if (row) row.dataset.selected = b.checked ? 'true' : 'false';
      });
    }

    if (selectAll) {
      selectAll.addEventListener('change', function () {
        Array.prototype.forEach.call(boxes(), function (b) { b.checked = selectAll.checked; });
        refresh();
      });
    }
    table.addEventListener('change', function (e) { if (e.target.matches('[data-bulk-id]')) refresh(); });
    refresh();
  }

  /* --- Assistant d'import -------------------------------------------------- */
  function initImportWizard() {
    var wizard = doc.querySelector('[data-import-wizard]');
    if (!wizard) return;
    var jobId = wizard.getAttribute('data-job-id');

    // Pré-remplissage automatique des associations de colonnes
    var autoBtn = doc.querySelector('[data-import-autofill]');
    if (autoBtn) {
      autoBtn.addEventListener('click', function (e) {
        e.preventDefault();
        var headers = JSON.parse(wizard.getAttribute('data-headers') || '[]');
        var suggestions = JSON.parse(wizard.getAttribute('data-suggestions') || '{}');
        Array.prototype.forEach.call(wizard.querySelectorAll('[data-mapping-field]'), function (select) {
          var field = select.getAttribute('data-mapping-field');
          var column = suggestions[field];
          if (column && headers.indexOf(column) !== -1) select.value = column;
          var row = select.closest('.mapping-row');
          if (row) row.setAttribute('data-mapped', String(Boolean(column)));
        });
        toast('Colonnes associées automatiquement. Vérifiez avant de lancer l’aperçu.');
      });
    }
    wizard.addEventListener('change', function (e) {
      var select = e.target.closest('[data-mapping-field]');
      if (!select) return;
      var row = select.closest('.mapping-row');
      if (row) row.setAttribute('data-mapped', String(Boolean(select.value)));
    });

    // Exécution par lots avec progression
    var runBtn = doc.querySelector('[data-import-run]');
    if (!runBtn) return;
    var bar = doc.querySelector('[data-import-bar]');
    var meta = doc.querySelector('[data-import-meta]');
    var running = false;

    function setProgress(p) {
      if (bar) bar.style.width = p.percent + '%';
      if (meta) {
        meta.textContent = p.processed + ' / ' + p.total + ' ligne(s) traitée(s) — ' +
          p.counts.ok + ' réussie(s), ' + p.counts.error + ' rejetée(s), ' + p.counts.pending + ' en attente';
      }
      var pct = doc.querySelector('[data-import-percent]');
      if (pct) pct.textContent = Math.round(p.percent) + ' %';
    }

    function runBatch() {
      if (running) return;
      running = true;
      runBtn.disabled = true;
      runBtn.innerHTML = '<span class="spinner"></span> Import en cours…';

      fetch('/admin/import/' + jobId + '/executer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ batch_size: wizard.getAttribute('data-batch-size') || 50 }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.data.error || 'Échec du traitement du lot.');
          setProgress(res.data);
          if (res.data.done) {
            if (bar) bar.setAttribute('data-state', 'done');
            runBtn.innerHTML = 'Import terminé — voir le rapport';
            runBtn.disabled = false;
            runBtn.classList.remove('btn');
            runBtn.classList.add('btn', 'btn--accent');
            runBtn.setAttribute('data-href', '/admin/import/' + jobId + '/rapport');
            toast('Import terminé : ' + res.data.counts.ok + ' ligne(s) traitée(s), ' + res.data.counts.error + ' rejetée(s).', res.data.counts.error ? 'warn' : 'success');
            return;
          }
          setTimeout(runBatch, 60);
        })
        .catch(function (err) {
          toast(err.message, 'error');
          runBtn.disabled = false;
          runBtn.textContent = 'Reprendre l’import';
        })
        .finally(function () { running = false; });
    }

    runBtn.addEventListener('click', function (e) {
      if (runBtn.getAttribute('data-href')) { e.preventDefault(); window.location.href = runBtn.getAttribute('data-href'); return; }
      e.preventDefault();
      runBatch();
    });
  }

  /* --- Caisse : calcul serveur à chaque frappe ----------------------------- */
  function initPos() {
    var form = doc.querySelector('[data-pos-form]');
    if (!form) return;

    var outSubtotal = doc.querySelector('[data-pos-subtotal]');
    var outDiscount = doc.querySelector('[data-pos-discount]');
    var outTotal = doc.querySelector('[data-pos-total]');
    var outItems = doc.querySelector('[data-pos-items]');
    var outProblems = doc.querySelector('[data-pos-problems]');
    var outCount = doc.querySelector('[data-pos-count]');
    var timer = null;

    function rows() {
      return Array.prototype.slice.call(form.querySelectorAll('[data-pos-line]'));
    }

    function collect() {
      return rows()
        .map(function (row) {
          var product = row.querySelector('[data-pos-field="product"]');
          var qty = row.querySelector('[data-pos-field="qty"]');
          var price = row.querySelector('[data-pos-field="price"]');
          var variant = row.querySelector('[data-pos-field="variant"]');
          if (!product || !product.value) return null;
          return {
            productId: Number(product.value),
            variantId: variant && variant.value ? Number(variant.value) : null,
            qty: Number(qty ? qty.value : 1) || 1,
            unitPrice: price && price.value !== '' ? Number(price.value) : undefined,
          };
        })
        .filter(Boolean);
    }

    function render(data) {
      if (outSubtotal) outSubtotal.textContent = data.subtotalLabel || '';
      if (outDiscount) {
        outDiscount.textContent = data.discount > 0 ? '− ' + (data.discountLabel || '') : '';
        var discountRow = outDiscount.closest('.summary-row');
        if (discountRow) discountRow.hidden = !(data.discount > 0);
      }
      if (outTotal) outTotal.textContent = data.totalLabel || '';
      if (outCount) outCount.textContent = String((data.items || []).length);
      if (outItems) {
        outItems.innerHTML = '';
        (data.items || []).forEach(function (it) {
          var tr = doc.createElement('tr');
          var cells = [
            it.name + (it.optionsLabel ? ' — ' + it.optionsLabel : '') + (it.adjusted ? ' (prix corrigé)' : ''),
            '× ' + it.qty,
            it.unitPriceLabel,
            it.lineTotalLabel,
          ];
          cells.forEach(function (text, i) {
            var td = doc.createElement('td');
            if (i > 0) td.className = 'num';
            td.textContent = text;
            tr.appendChild(td);
          });
          outItems.appendChild(tr);
        });
      }
      if (outProblems) {
        outProblems.innerHTML = '';
        (data.problems || []).forEach(function (message) {
          var el = doc.createElement('div');
          el.className = 'alert alert--error';
          var span = doc.createElement('span');
          span.textContent = typeof message === 'string' ? message : (message.message || 'Ligne refusée.');
          el.appendChild(span);
          outProblems.appendChild(el);
        });
      }
    }

    function recalc() {
      var lines = collect();
      if (!lines.length) {
        if (outProblems) outProblems.innerHTML = '';
        if (outItems) outItems.innerHTML = '';
        if (outSubtotal) outSubtotal.textContent = money0();
        if (outTotal) outTotal.textContent = money0();
        if (outCount) outCount.textContent = '0';
        return;
      }
      var discountField = form.querySelector('[name="discount"]');
      fetch('/admin/caisse/calcul', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ lines: lines, discount: discountField ? discountField.value : 0 }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.data.error || 'Calcul impossible.');
          render(res.data);
        })
        .catch(function (err) {
          if (outProblems) {
            outProblems.innerHTML = '';
            var el = doc.createElement('div');
            el.className = 'alert alert--warn';
            var span = doc.createElement('span');
            span.textContent = err.message;
            el.appendChild(span);
            outProblems.appendChild(el);
          }
        });
    }

    function money0() { return '0 FCFA'; }

    form.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(recalc, 350); });
    form.addEventListener('change', recalc);

    function addLine(product, variant) {
      var tpl = doc.querySelector('[data-pos-line-template]');
      var list = doc.querySelector('[data-pos-lines]');
      if (!tpl || !list) return;
      var node = tpl.content.firstElementChild.cloneNode(true);
      Array.prototype.forEach.call(node.querySelectorAll('[data-pos-field]'), function (el) {
        var key = el.getAttribute('data-pos-field');
        if (key === 'product') el.value = product.id;
        if (key === 'sku') el.value = product.sku || '';
        if (key === 'qty') el.value = '1';
        if (key === 'price') el.value = '';
        if (key === 'variant') el.value = variant ? variant.id : '';
      });
      var nameEl = node.querySelector('[data-pos-name]');
      if (nameEl) {
        nameEl.textContent = product.name + (variant && variant.label ? ' — ' + variant.label : '') +
          (product.sku ? ' · ' + product.sku : '');
      }
      var priceHint = node.querySelector('[data-pos-catalog-price]');
      if (priceHint) priceHint.textContent = product.priceLabel || '';
      var removeBtn = node.querySelector('[data-pos-remove]');
      if (removeBtn) removeBtn.addEventListener('click', function () { node.remove(); recalc(); });
      list.appendChild(node);
      var qty = node.querySelector('[data-pos-field="qty"]');
      if (qty) qty.focus();
      recalc();
    }

    // Recherche d'article avec autocomplétion
    var search = doc.querySelector('[data-pos-search]');
    var results = doc.querySelector('[data-pos-results]');
    if (search && results) {
      var sTimer = null;
      search.addEventListener('input', function () {
        clearTimeout(sTimer);
        var q = search.value.trim();
        if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
        sTimer = setTimeout(function () {
          fetch('/admin/api/produits/recherche?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              results.innerHTML = '';
              results.hidden = !(data.items && data.items.length);
              (data.items || []).forEach(function (p) {
                var wrap = doc.createElement('div');
                wrap.className = 'pos-result';
                var head = doc.createElement('button');
                head.type = 'button';
                head.className = 'pos-result-main';
                var name = doc.createElement('span');
                name.className = 'pr-name';
                name.textContent = p.name + (p.sku ? ' · ' + p.sku : '');
                var price = doc.createElement('span');
                price.className = 'pr-price';
                price.textContent = p.priceLabel;
                head.append(name, price);
                head.addEventListener('click', function () {
                  results.hidden = true; results.innerHTML = ''; search.value = '';
                  addLine(p, null);
                });
                wrap.appendChild(head);
                if (p.variants && p.variants.length) {
                  var vbox = doc.createElement('div');
                  vbox.className = 'pr-variants';
                  p.variants.forEach(function (v) {
                    var b = doc.createElement('button');
                    b.type = 'button';
                    b.textContent = v.label || v.sku || 'variante';
                    b.addEventListener('click', function () {
                      results.hidden = true; results.innerHTML = ''; search.value = '';
                      addLine(p, v);
                    });
                    vbox.appendChild(b);
                  });
                  wrap.appendChild(vbox);
                }
                results.appendChild(wrap);
              });
            })
            .catch(function () { results.hidden = true; });
        }, 220);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { results.hidden = true; results.innerHTML = ''; }
      });
    }

    recalc();
  }

  /* --- Réglages : aperçu de palette ---------------------------------------- */
  function initTheme() {
    var panel = doc.querySelector('[data-theme-panel]');
    if (!panel) return;
    var preview = doc.querySelector('[data-theme-preview]');
    function apply() {
      if (!preview) return;
      Array.prototype.forEach.call(panel.querySelectorAll('input[type="color"], input[data-theme-var]'), function (input) {
        var name = input.getAttribute('data-theme-var');
        if (name) preview.style.setProperty('--' + name, input.value);
      });
      var radius = panel.querySelector('[name="theme_radius"]');
      if (radius && preview) preview.style.setProperty('--radius', radius.value + 'px');
    }
    panel.addEventListener('input', apply);
    apply();
  }

  /* --- Commande : sélection du transporteur selon la zone ------------------- */
  function initOrder() {
    var form = doc.querySelector('[data-delivery-form]');
    if (!form) return;
    var zone = form.querySelector('[name="zone_id"]');
    var carrier = form.querySelector('[name="carrier_id"]');
    if (!zone || !carrier) return;
    var map = JSON.parse(form.getAttribute('data-zone-carriers') || '{}');
    zone.addEventListener('change', function () {
      var allowed = map[zone.value] || null;
      Array.prototype.forEach.call(carrier.options, function (opt) {
        if (!opt.value) return;
        opt.disabled = Boolean(allowed && allowed.indexOf(Number(opt.value)) === -1);
      });
    });
  }

  /* --- Envoi AJAX générique (statut rapide) -------------------------------- */
  function initAjaxForms() {
    doc.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-ajax]');
      if (!form) return;
      e.preventDefault();
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      var payload = {};
      Array.prototype.forEach.call(new FormData(form).entries(), function (entry) { payload[entry[0]] = entry[1]; });
      fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (res.data.reload) { window.location.reload(); return; }
          toast(res.data.message || (res.ok ? 'Enregistré.' : 'Opération refusée.'), res.ok ? 'success' : 'error');
        })
        .catch(function () { toast('Erreur réseau.', 'error'); })
        .finally(function () { if (btn) btn.disabled = false; });
    });
  }

  /* --- Formulaire produit : confort de saisie ------------------------------- */
  function initProductForm() {
    var form = doc.getElementById('form-produit');
    if (!form) return;

    // Suivi de stock : masque les quantités si le suivi est désactivé.
    var track = form.querySelector('[data-track-stock]');
    var stockFields = form.querySelector('[data-stock-fields]');
    function syncTrack() { if (stockFields) stockFields.hidden = !track.checked; }
    if (track) { track.addEventListener('change', syncTrack); syncTrack(); }

    // Kit : affiche la zone de composition.
    var kitToggle = form.querySelector('[data-kit-toggle]');
    var kitBlock = form.querySelector('[data-kit-block]');
    function syncKit() { if (kitBlock) kitBlock.hidden = !kitToggle.checked; }
    if (kitToggle) { kitToggle.addEventListener('change', syncKit); syncKit(); }

    // Caractéristique pré-définie par la catégorie : ajoute une ligne remplie.
    form.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-attribute-template]');
      if (!btn) return;
      var tpl;
      try { tpl = JSON.parse(btn.getAttribute('data-attribute-template')); } catch (err) { return; }
      var panel = btn.closest('.panel');
      var repeater = panel && panel.querySelector('[data-repeater]');
      if (!repeater) return;
      var add = repeater.querySelector('[data-repeater-add]');
      if (add) add.click();
      var rows = repeater.querySelectorAll('[data-repeater-row]');
      var last = rows[rows.length - 1];
      if (!last) return;
      Array.prototype.forEach.call(last.querySelectorAll('input'), function (el) {
        var name = el.getAttribute('name') || '';
        if (/\[label\]/.test(name)) el.value = tpl.label || '';
        else if (/\[key\]/.test(name)) el.value = tpl.key || '';
        else if (/\[unit\]/.test(name)) el.value = tpl.unit || '';
        else if (/\[value\]/.test(name)) el.focus();
      });
    });

    // Rechargement du modèle de caractéristiques quand la catégorie change.
    var categorySelect = form.querySelector('[data-category-select]');
    var tplBox = form.querySelector('[data-category-templates]');
    if (categorySelect && tplBox) {
      categorySelect.addEventListener('change', function () {
        var id = categorySelect.value;
        if (!id) { tplBox.hidden = true; tplBox.innerHTML = ''; return; }
        fetch('/admin/api/categories/' + id + '/attributs', { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            tplBox.innerHTML = '';
            var items = data.items || [];
            if (!items.length) { tplBox.hidden = true; return; }
            tplBox.hidden = false;
            var title = doc.createElement('strong');
            title.textContent = 'Caractéristiques proposées pour cette catégorie :';
            tplBox.appendChild(title);
            var row = doc.createElement('div');
            row.className = 'btn-row';
            row.style.marginTop = '6px';
            items.forEach(function (t) {
              var b = doc.createElement('button');
              b.type = 'button';
              b.className = 'btn btn--sm btn--quiet';
              b.textContent = '+ ' + (t.label || t.key);
              b.setAttribute('data-attribute-template', JSON.stringify({ key: t.key, label: t.label, unit: t.unit || '', type: t.type || 'text' }));
              row.appendChild(b);
            });
            tplBox.appendChild(row);
          })
          .catch(function () { tplBox.hidden = true; });
      });
    }

    // Sélecteur de composants de kit.
    var search = form.querySelector('[data-kit-search]');
    var results = form.querySelector('[data-kit-results]');
    var lines = form.querySelector('[data-kit-lines]');
    var lineTpl = form.querySelector('[data-kit-line-template]');
    if (search && results && lines && lineTpl) {
      var timer = null;
      var index = lines.querySelectorAll('[data-kit-line]').length;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        var q = search.value.trim();
        if (q.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
        timer = setTimeout(function () {
          fetch('/admin/api/produits/recherche?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              results.innerHTML = '';
              results.hidden = !(data.items || []).length;
              (data.items || []).forEach(function (p) {
                var b = doc.createElement('button');
                b.type = 'button';
                b.className = 'pos-result-main';
                b.style.width = '100%';
                var name = doc.createElement('span');
                name.className = 'pr-name';
                name.textContent = p.name + (p.sku ? ' · ' + p.sku : '');
                var price = doc.createElement('span');
                price.className = 'pr-price';
                price.textContent = p.priceLabel;
                b.append(name, price);
                b.addEventListener('click', function () {
                  var node = lineTpl.content.firstElementChild.cloneNode(true);
                  Array.prototype.forEach.call(node.querySelectorAll('[data-kit-field]'), function (el) {
                    var key = el.getAttribute('data-kit-field');
                    if (key === 'product') el.value = p.id;
                    if (key === 'variant') el.value = '';
                    if (key === 'qty') el.value = '1';
                    el.name = (el.getAttribute('name') || '').replace(/\[\d+\]/, '[' + index + ']');
                  });
                  var nameEl = node.querySelector('[data-kit-name]');
                  if (nameEl) nameEl.textContent = p.name + (p.sku ? ' · ' + p.sku : '');
                  var rm = node.querySelector('[data-kit-remove]');
                  if (rm) rm.addEventListener('click', function () { node.remove(); });
                  lines.appendChild(node);
                  index += 1;
                  results.hidden = true;
                  results.innerHTML = '';
                  search.value = '';
                });
                results.appendChild(b);
              });
            })
            .catch(function () { results.hidden = true; });
        }, 220);
      });
    }
  }

  /* --- Sélection de média --------------------------------------------------- */
  function initMediaPicker() {
    doc.addEventListener('click', function (e) {
      var tile = e.target.closest('[data-media-pick]');
      if (!tile) return;
      e.preventDefault();
      var input = doc.querySelector('[data-media-target]');
      var preview = doc.querySelector('[data-media-preview]');
      if (input) input.value = tile.getAttribute('data-media-pick');
      if (preview) {
        preview.innerHTML = '';
        var img = doc.createElement('img');
        img.src = '/media/' + encodeURIComponent(tile.getAttribute('data-media-pick')) + '?s=medium';
        img.alt = '';
        preview.appendChild(img);
      }
      Array.prototype.forEach.call(doc.querySelectorAll('[data-media-pick]'), function (t) { t.removeAttribute('aria-pressed'); });
      tile.setAttribute('aria-pressed', 'true');
    });
  }

  /* --- Réglages › Livraison : simulateur de frais --------------------------- */
  /* Le calcul reste effectué côté serveur : cet appel ne fait qu'afficher le   */
  /* résultat exact que verrait le client, sans rien enregistrer.               */
  function initShippingSim() {
    var form = doc.querySelector('form[data-shipping-sim]');
    if (!form) return;
    var out = doc.querySelector('[data-shipping-sim-result]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!out) return;
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      out.textContent = 'Calcul en cours…';
      fetch(form.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrfToken(),
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams(new FormData(form)).toString(),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          out.innerHTML = '';
          var box = doc.createElement('div');
          box.className = 'sim-result';
          box.setAttribute('data-state', d.status === 'quote' ? 'quote' : d.status === 'free' ? 'free' : 'priced');
          var amount = doc.createElement('div');
          amount.className = 'sim-amount';
          amount.textContent = d.amountLabel || 'Livraison sur devis';
          box.appendChild(amount);
          var note = doc.createElement('div');
          note.className = 'sim-note';
          var parts = [];
          if (d.etaText) parts.push(d.etaText);
          if (d.message) parts.push(d.message);
          if (d.reason && d.status === 'quote') parts.push('Motif : ' + d.reason);
          if (d.status === 'quote') parts.push('Aucun frais inconnu n\u2019est pr\u00e9sent\u00e9 comme gratuit : le client devra accepter le devis avant paiement.');
          note.textContent = parts.join(' \u00b7 ');
          box.appendChild(note);
          out.appendChild(box);
        })
        .catch(function () { out.textContent = 'Calcul impossible pour le moment.'; })
        .finally(function () { if (btn) btn.disabled = false; });
    });
  }

  doc.addEventListener('DOMContentLoaded', function () {
    initNav();
    initConfirm();
    initRepeaters();
    initBulk();
    initImportWizard();
    initPos();
    initTheme();
    initOrder();
    initAjaxForms();
    initMediaPicker();
    initProductForm();
    initShippingSim();

    // Récapitulatifs : impression automatique à l'ouverture (hors écran tactile).
    if (doc.body.hasAttribute('data-print-auto')) {
      setTimeout(function () { window.print(); }, 300);
    }

    // Filtres : replier les groupes non utilisés
    Array.prototype.forEach.call(doc.querySelectorAll('details[data-filter-group]'), function (d) {
      if (!d.hasAttribute('open') && d.querySelectorAll('input:checked').length) d.open = true;
    });
  });
})();
