/* ============================================================================
   Boutique — améliorations progressives.
   Le parcours d'achat fonctionne entièrement sans JavaScript : ce fichier
   n'ajoute que du confort (panier sans rechargement, galerie, suggestions).
   Aucune donnée métier n'est stockée dans le navigateur.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document;

  function csrfToken() {
    var meta = doc.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : '';
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().then(function (data) {
        return { ok: r.ok, status: r.status, data: data };
      });
    });
  }

  /* --- Messages flash : disparition automatique ------------------------- */
  function initFlashes() {
    var wrap = doc.querySelector('.flashes');
    if (!wrap) return;
    Array.prototype.forEach.call(wrap.children, function (el, i) {
      setTimeout(function () {
        el.style.transition = 'opacity .3s ease, transform .3s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';
        setTimeout(function () { el.remove(); }, 320);
      }, 4200 + i * 700);
    });
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-dismiss]');
      if (btn) btn.closest('.alert').remove();
    });
  }

  /* --- Compteur de panier ------------------------------------------------ */
  function setCartCount(n) {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-cart-count]'), function (el) {
      el.textContent = n > 0 ? String(n) : '';
      el.setAttribute('data-zero', n > 0 ? 'false' : 'true');
    });
    var live = doc.querySelector('[data-cart-live]');
    if (live) live.textContent = n > 0 ? n + ' article' + (n > 1 ? 's' : '') + ' au panier' : 'Panier vide';
  }

  function toast(message, tone) {
    var wrap = doc.querySelector('.flashes');
    if (!wrap) {
      wrap = doc.createElement('div');
      wrap.className = 'flashes';
      wrap.setAttribute('aria-live', 'polite');
      doc.body.appendChild(wrap);
    }
    var el = doc.createElement('div');
    el.className = 'alert alert--' + (tone || 'success');
    el.setAttribute('role', 'status');
    el.innerHTML = '<span></span>';
    el.firstChild.textContent = message;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s ease';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    }, 4000);
  }

  /* --- Ajout au panier sans rechargement --------------------------------- */
  function initAddToCart() {
    doc.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-cart-form]');
      if (!form) return;
      e.preventDefault();
      var button = form.querySelector('[type="submit"]');
      var payload = {};
      Array.prototype.forEach.call(new FormData(form).entries(), function (entry) { payload[entry[0]] = entry[1]; });
      if (button) { button.disabled = true; button.dataset.label = button.innerHTML; button.innerHTML = '<span class="spinner"></span> Ajout…'; }

      post('/panier/ajouter', payload)
        .then(function (res) {
          if (!res.ok) throw new Error(res.data.error || "Ajout impossible.");
          setCartCount(res.data.itemCount || 0);
          toast(res.data.message || 'Article ajouté au panier.', 'success');
          if (form.dataset.redirect === 'cart') window.location.href = '/panier';
        })
        .catch(function (err) { toast(err.message, 'error'); })
        .finally(function () {
          if (button) { button.disabled = false; button.innerHTML = button.dataset.label || 'Ajouter'; }
        });
    });

    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-cart-remove]');
      if (!btn) return;
      e.preventDefault();
      var id = btn.getAttribute('data-cart-remove');
      post('/panier/supprimer/' + encodeURIComponent(id))
        .then(function (res) {
          if (!res.ok) throw new Error(res.data.error || 'Suppression impossible.');
          var line = btn.closest('[data-cart-line]');
          if (line) line.remove();
          setCartCount(res.data.itemCount || 0);
          if (!doc.querySelector('[data-cart-line]')) window.location.reload();
        })
        .catch(function (err) { toast(err.message, 'error'); });
    });
  }

  /* --- Sélecteur de quantité --------------------------------------------- */
  function initQty() {
    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-qty-step]');
      if (!btn) return;
      e.preventDefault();
      var wrap = btn.closest('.qty-input');
      var input = wrap && wrap.querySelector('input');
      if (!input) return;
      var step = Number(btn.getAttribute('data-qty-step'));
      var min = Number(input.min || 1);
      var max = Number(input.max || 9999);
      var next = Math.min(max, Math.max(min, (Number(input.value) || min) + step));
      input.value = String(next);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /* --- Fiche produit : variantes, galerie, onglets ------------------------ */
  function initProductPage() {
    var root = doc.querySelector('[data-product-page]');
    if (!root) return;

    var variantData = {};
    try { variantData = JSON.parse(root.getAttribute('data-variants') || '{}'); } catch (err) { variantData = {}; }

    var priceEl = root.querySelector('[data-price]');
    var compareEl = root.querySelector('[data-compare-price]');
    var availEl = root.querySelector('[data-availability]');
    var skuEl = root.querySelector('[data-sku]');
    var addBtn = root.querySelector('[data-add-button]');

    function currentVariant() {
      var checked = root.querySelector('input[name="variantId"]:checked');
      return checked ? checked.value : '';
    }

    function refresh() {
      var id = currentVariant();
      var v = variantData[id];
      if (!v) return;
      if (priceEl) priceEl.textContent = v.priceLabel;
      if (compareEl) {
        compareEl.textContent = v.compareAtLabel || '';
        compareEl.hidden = !v.compareAtLabel;
      }
      if (availEl) {
        availEl.className = 'availability availability--' + v.availabilityStatus;
        availEl.textContent = v.availabilityLabel;
      }
      if (skuEl) skuEl.textContent = v.sku || '—';
      if (addBtn) {
        addBtn.disabled = !v.purchasable;
        addBtn.title = v.purchasable ? '' : (v.reason || 'Article indisponible');
      }
      var qty = root.querySelector('input[name="qty"]');
      if (qty && v.available != null) qty.max = String(Math.max(1, v.available));
    }

    root.addEventListener('change', function (e) {
      if (e.target.name === 'variantId') refresh();
    });

    // Galerie
    var main = root.querySelector('[data-gallery-main]');
    root.addEventListener('click', function (e) {
      var thumb = e.target.closest('[data-thumb]');
      if (!thumb || !main) return;
      main.src = thumb.getAttribute('data-full');
      main.alt = thumb.getAttribute('data-alt') || main.alt;
      Array.prototype.forEach.call(root.querySelectorAll('[data-thumb]'), function (b) { b.setAttribute('aria-current', 'false'); });
      thumb.setAttribute('aria-current', 'true');
    });
    if (main) {
      main.addEventListener('click', function () {
        var full = main.getAttribute('data-zoom');
        if (full) window.open(full, '_blank', 'noopener');
      });
    }

    // Onglets
    var tabs = root.querySelectorAll('[role="tab"]');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        var target = doc.getElementById(tab.getAttribute('aria-controls'));
        Array.prototype.forEach.call(tabs, function (t) {
          t.setAttribute('aria-selected', String(t === tab));
          t.tabIndex = t === tab ? 0 : -1;
        });
        Array.prototype.forEach.call(root.querySelectorAll('[role="tabpanel"]'), function (p) {
          p.hidden = p !== target;
        });
        if (target) target.hidden = false;
      });
      tab.addEventListener('keydown', function (e) {
        var list = Array.prototype.slice.call(tabs);
        var i = list.indexOf(tab);
        if (e.key === 'ArrowRight') { list[(i + 1) % list.length].focus(); e.preventDefault(); }
        if (e.key === 'ArrowLeft') { list[(i - 1 + list.length) % list.length].focus(); e.preventDefault(); }
      });
    });
    refresh();
  }

  /* --- Suggestions de recherche ------------------------------------------- */
  function initSearch() {
    var form = doc.querySelector('[data-search-form]');
    if (!form) return;
    var input = form.querySelector('input[type="search"], input[name="q"]');
    var box = form.querySelector('[data-suggest]');
    if (!input || !box) return;
    var timer = null;
    var items = [];
    var active = -1;

    function close() { box.setAttribute('data-open', 'false'); box.innerHTML = ''; items = []; active = -1; }

    function render(list) {
      if (!list.length) return close();
      box.innerHTML = list.map(function (it, i) {
        var img = it.image_key ? '<img src="/media/' + encodeURIComponent(it.image_key) + '?s=thumb" alt="" loading="lazy" width="36" height="36">' : '<span class="s-img"></span>';
        return '<a href="/produit/' + encodeURIComponent(it.slug) + '" role="option" data-i="' + i + '">' + img +
          '<span class="s-name"></span><span class="s-price"></span></a>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('a'), function (a, i) {
        a.querySelector('.s-name').textContent = list[i].name;
        a.querySelector('.s-price').textContent = (list[i].price > 0) ? new Intl.NumberFormat('fr-FR').format(list[i].price) + ' FCFA' : '';
      });
      items = list;
      box.setAttribute('data-open', 'true');
      input.setAttribute('aria-expanded', 'true');
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(function () {
        fetch('/api/suggestions?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (data) { render(data.items || []); })
          .catch(close);
      }, 180);
    });

    input.addEventListener('keydown', function (e) {
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        Array.prototype.forEach.call(box.querySelectorAll('a'), function (a, i) {
          a.setAttribute('aria-selected', String(i === active));
        });
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        window.location.href = box.querySelectorAll('a')[active].href;
      } else if (e.key === 'Escape') { close(); }
    });

    doc.addEventListener('click', function (e) { if (!form.contains(e.target)) close(); });
  }

  /* --- Tiroir de catégories (mobile) -------------------------------------- */
  function initDrawer() {
    var drawer = doc.querySelector('[data-drawer]');
    if (!drawer) return;
    function open() { drawer.setAttribute('data-open', 'true'); doc.body.style.overflow = 'hidden'; var f = drawer.querySelector('a,button'); if (f) f.focus(); }
    function close() { drawer.setAttribute('data-open', 'false'); doc.body.style.overflow = ''; }
    doc.addEventListener('click', function (e) {
      if (e.target.closest('[data-drawer-open]')) { e.preventDefault(); open(); }
      else if (e.target.closest('[data-drawer-close]') || e.target.classList.contains('drawer-backdrop')) { close(); }
    });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer.getAttribute('data-open') === 'true') close(); });
  }

  /* --- Filtres : tri et pagination sans bouton « Appliquer » --------------- */
  function initAutoSubmit() {
    doc.addEventListener('change', function (e) {
      var el = e.target.closest('[data-auto-submit]');
      if (el && el.form) el.form.submit();
    });
  }

  /* --- Tunnel : recalcul des frais côté serveur, affichage en direct -------- */
  function initCheckout() {
    var form = doc.querySelector('[data-checkout-form]');
    if (!form) return;

    var pickupBlock = form.querySelector('[data-block="pickup"]');
    var deliveryBlock = form.querySelector('[data-block="delivery"]');
    var methodsBox = form.querySelector('[data-methods]');
    var sumShipping = form.querySelector('[data-sum-shipping]');
    var sumTotal = form.querySelector('[data-sum-total]');
    var sumEta = form.querySelector('[data-sum-eta]');
    var quoteBox = form.querySelector('[data-quote-box]');
    var shippingNote = form.querySelector('[data-shipping-note]');
    var expectedTotal = form.querySelector('[data-expected-total]');
    var expectedZone = form.querySelector('[data-expected-zone]');
    var busy = false;

    function selectedMode() {
      var m = form.querySelector('input[name="mode"]:checked');
      return m ? m.value : 'pickup';
    }

    function selectedZone() {
      var z = form.querySelector('input[name="zone"]:checked');
      return z ? z.value : '';
    }

    function selectedMethod() {
      var p = form.querySelector('input[name="paiement"]:checked');
      return p ? p.value : '';
    }

    function refreshBlocks() {
      var mode = selectedMode();
      if (pickupBlock) pickupBlock.hidden = mode !== 'pickup';
      if (deliveryBlock) deliveryBlock.hidden = mode !== 'delivery';
      form.setAttribute('data-mode', mode);
      // Les champs de livraison ne sont exigés que si la livraison est choisie.
      Array.prototype.forEach.call(deliveryBlock ? deliveryBlock.querySelectorAll('input,textarea') : [], function (el) {
        if (el.type === 'radio') return;
        if (mode !== 'delivery') el.removeAttribute('required');
        else if (el.dataset.required === 'delivery') el.setAttribute('required', '');
      });
    }

    function recalc() {
      if (busy) return;
      busy = true;
      var params = new URLSearchParams({
        mode: selectedMode(),
        zone: selectedZone(),
        paiement: selectedMethod(),
      });
      if (sumTotal) sumTotal.setAttribute('aria-busy', 'true');

      fetch('/commande/frais?' + params.toString(), {
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.ok) throw new Error((data && data.error) || 'Recalcul impossible.');

          if (sumShipping) sumShipping.textContent = data.mode === 'pickup' ? 'Sans frais' : data.shipping.amountLabel;
          if (sumTotal) sumTotal.textContent = data.totalLabel;
          if (sumEta) {
            sumEta.textContent = data.shipping.etaText || '';
            var etaRow = sumEta.closest('.summary-row');
            if (etaRow) etaRow.hidden = !data.shipping.etaText;
          }
          if (quoteBox) quoteBox.hidden = !data.quoteRequired;
          if (shippingNote) {
            shippingNote.textContent = data.mode === 'pickup'
              ? 'Vous réglez votre commande selon le moyen choisi, puis retirez vos articles en boutique.'
              : (data.quoteRequired
                ? 'Aucun tarif de livraison n\u2019est défini pour cette destination : votre commande sera enregistrée « sur devis ». Vous devrez accepter le montant proposé avant le paiement.'
                : 'Frais de livraison inclus dans le total ci-dessus, calculés selon la destination et le poids du colis.');
          }
          if (expectedTotal) expectedTotal.value = data.quoteRequired ? '' : String(data.total);
          if (expectedZone && data.zone) expectedZone.value = String(data.zone.id);
          if (methodsBox && data.methodsHtml) methodsBox.innerHTML = data.methodsHtml;
        })
        .catch(function (err) {
          toast('Frais non recalculés : ' + err.message, 'error');
        })
        .finally(function () {
          busy = false;
          if (sumTotal) sumTotal.removeAttribute('aria-busy');
        });
    }

    form.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name === 'mode') { refreshBlocks(); recalc(); }
      else if (t.name === 'zone') { recalc(); }
      else if (t.name === 'paiement') { refreshMethodHints(); }
    });

    function refreshMethodHints() {
      Array.prototype.forEach.call(form.querySelectorAll('[data-method-hint]'), function (h) {
        h.hidden = h.getAttribute('data-method-hint') !== selectedMethod();
      });
    }

    // Anti double envoi : le bouton est neutralisé dès la soumission.
    // La clé d'idempotence côté serveur garantit qu'un renvoi du formulaire ne
    // crée pas une seconde commande.
    form.addEventListener('submit', function () {
      var btn = form.querySelector('[type="submit"]');
      if (!btn) return;
      btn.disabled = true;
      btn.dataset.label = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> Enregistrement…';
      // Rend la main si le navigateur a bloqué l'envoi (champ requis manquant).
      setTimeout(function () {
        if (btn.disabled && btn.dataset.label) { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
      }, 6000);
    });

    refreshBlocks();
    refreshMethodHints();
  }

  /* --- Barre mobile : focus sur la recherche ------------------------------- */
  function initMobileSearch() {
    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-focus-search]');
      if (!btn) return;
      e.preventDefault();
      var input = doc.querySelector('[data-search-form] input[type="search"], [data-search-form] input[name="q"]');
      if (!input) return;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      input.focus({ preventScroll: true });
    });
  }

  /* --- Panier : mise à jour de quantité ------------------------------------ */
  function initCartLines() {
    doc.addEventListener('change', function (e) {
      var input = e.target.closest('[data-cart-qty]');
      if (!input) return;
      var lineId = input.getAttribute('data-cart-qty');
      var form = input.closest('form');
      if (form) form.submit();
    });
  }

  function initPrint() {
    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-print]');
      if (!btn) return;
      e.preventDefault();
      window.print();
    });
  }

  function initCopy() {
    doc.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-copy]');
      if (!btn) return;
      e.preventDefault();
      var text = btn.getAttribute('data-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          var old = btn.textContent;
          btn.textContent = 'Copié';
          setTimeout(function () { btn.textContent = old; }, 1600);
        });
      }
    });
  }

  doc.addEventListener('DOMContentLoaded', function () {
    initFlashes();
    initAddToCart();
    initQty();
    initProductPage();
    initSearch();
    initDrawer();
    initAutoSubmit();
    initCheckout();
    initMobileSearch();
    initCartLines();
    initPrint();
    initCopy();

    // Image en chargement progressif : minuscule floue puis version complète.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var img = entry.target;
          if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
          io.unobserve(img);
        });
      }, { rootMargin: '200px' });
      Array.prototype.forEach.call(doc.querySelectorAll('img[data-src]'), function (img) { io.observe(img); });
    }
  });
})();
