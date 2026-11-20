/* MPC Scan & Shop — customer-side script. No framework; works on older Android browsers. */
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('mpc-data').textContent);
  var S = DATA.strings;
  var LANG = DATA.lang;
  var BASKET_KEY = 'mpc.basket.v1';
  var TICKETS_KEY = 'mpc.tickets.v1';

  // ---------- helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function money(paise) {
    var neg = paise < 0; paise = Math.abs(paise);
    var r = Math.floor(paise / 100), p = paise % 100;
    return (neg ? '-' : '') + '₹' + r.toLocaleString('en-IN') + (p ? '.' + (p < 10 ? '0' : '') + p : '');
  }
  function grams(g) { return g >= 1000 ? (g / 1000).toString().replace(/\.?0+$/, '') + ' kg' : g + ' g'; }
  function weightAmount(pricePerKg, g) { return Math.floor((2 * pricePerKg * g + 1000) / 2000); } // half-up, integer paise
  function nameOf(it) { return LANG === 'ta' && it.name_ta ? it.name_ta : it.name; }
  function randKey() {
    var a = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function load(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) || dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  var toastTimer;
  function toast(msg) {
    var t = $('[data-toast]');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* ignore */ } }

  // ---------- basket model ----------
  function getBasket() {
    var b = load(BASKET_KEY, null);
    if (!b || !b.lines) b = { branch: null, lines: {}, order: [], checkoutKey: null, pending: false };
    if (!b.order) b.order = Object.keys(b.lines);
    return b;
  }
  function setBasket(b) { b.updated = Date.now(); save(BASKET_KEY, b); renderBasketChrome(); syncCards(); }
  function basketBranch(b) { return b.branch || (DATA.branch && DATA.branch.slug) || DATA.defaultBranch; }
  function lineTotal(l) {
    if (l.sold_by === 'weight') return l.est_grams ? weightAmount(l.price, l.est_grams) : 0;
    return l.price * l.qty;
  }
  function summary(b) {
    var count = 0, total = 0, estimated = false;
    b.order.forEach(function (id) {
      var l = b.lines[id]; if (!l) return;
      count += l.sold_by === 'weight' ? 1 : l.qty;
      total += lineTotal(l);
      if (l.sold_by === 'weight') estimated = true;
    });
    return { count: count, total: total, estimated: estimated };
  }
  function addItem(item, opts) {
    opts = opts || {};
    var b = getBasket();
    if (!b.branch) b.branch = basketBranch(b);
    if (b.checkoutKey && !b.pending) b.checkoutKey = null; // basket changed after a failed attempt: new attempt
    var id = String(item.id);
    var l = b.lines[id];
    if (!l) {
      l = { id: item.id, name: item.name, name_ta: item.name_ta, pack: item.pack, sold_by: item.sold_by, price: item.price, max: item.max || 20, slug: item.slug, qty: 0, est_grams: null, barcode: null };
      b.lines[id] = l; b.order.push(id);
    }
    if (item.sold_by === 'weight') {
      l.qty = 1;
      if (opts.grams !== undefined) l.est_grams = opts.grams;
    } else {
      var want = l.qty + (opts.qty || 1);
      if (want > l.max) { toast(LANG === 'ta' ? 'அதிகபட்ச அளவு ' + l.max : 'Maximum ' + l.max + ' per basket'); want = l.max; }
      l.qty = want;
    }
    if (opts.barcode) l.barcode = opts.barcode;
    l.price = item.price;
    setBasket(b);
    return l;
  }
  function setQty(id, qty) {
    var b = getBasket();
    var l = b.lines[String(id)]; if (!l) return;
    if (qty <= 0) { delete b.lines[String(id)]; b.order = b.order.filter(function (x) { return x !== String(id); }); }
    else l.qty = Math.min(qty, l.max);
    if (b.checkoutKey && !b.pending) b.checkoutKey = null;
    setBasket(b);
  }

  // ---------- chrome: badge, sticky basket bar ----------
  function renderBasketChrome() {
    var s = summary(getBasket());
    $all('[data-basket-count]').forEach(function (e) { e.textContent = s.count; e.hidden = s.count === 0; });
    var bar = $('[data-basket-bar]');
    if (bar) {
      bar.hidden = s.count === 0;
      var sum = $('[data-basket-summary]', bar);
      if (sum) sum.textContent = s.count + ' ' + (s.count === 1 ? S.item : S.items) + ' · ' + (s.estimated ? '~' : '') + money(s.total);
    }
    renderActiveTicket();
  }
  function renderActiveTicket() {
    var dock = $('[data-dock]');
    if (!dock || $('[data-ticket]')) return;
    var tickets = load(TICKETS_KEY, []).filter(function (t) { return Date.now() - t.at < 4 * 3600e3 && !t.closed; });
    var old = $('[data-active-ticket]');
    if (old) old.remove();
    if (!tickets.length) return;
    var t = tickets[tickets.length - 1];
    dock.insertBefore(el('a', { class: 'ticket-pill', href: '/t/' + t.token, 'data-active-ticket': '' }, [
      S.order + ' ' + t.code + (t.counter ? ' · ' + S.go_to_counter + ' ' + t.counter : ''),
    ]), dock.firstChild);
  }

  // ---------- product cards: Add -> stepper ----------
  function stepper(item, l) {
    var wrap = el('div', { class: 'stepper', role: 'group', 'aria-label': S.quantity + ': ' + nameOf(item) });
    if (item.sold_by === 'weight') {
      wrap.appendChild(el('button', { type: 'button', class: 'step-weight', onclick: function () { openWeightSheet(item); } },
        [l.est_grams ? '~' + grams(l.est_grams) : S.weigh_at_counter]));
      wrap.appendChild(el('button', { type: 'button', class: 'step-btn', 'aria-label': S.remove, onclick: function () { setQty(item.id, 0); } }, ['×']));
      return wrap;
    }
    wrap.appendChild(el('button', { type: 'button', class: 'step-btn', 'aria-label': '−', onclick: function () { setQty(item.id, l.qty - 1); } }, ['−']));
    wrap.appendChild(el('span', { class: 'step-qty', 'aria-live': 'polite', text: String(l.qty) }));
    wrap.appendChild(el('button', { type: 'button', class: 'step-btn', 'aria-label': '+', onclick: function () { addItem(item); } }, ['+']));
    return wrap;
  }
  function syncCards() {
    var b = getBasket();
    $all('[data-item]').forEach(function (card) {
      var slot = $('[data-qty-slot]', card); if (!slot) return;
      var item = JSON.parse(card.getAttribute('data-item'));
      var l = b.lines[String(item.id)];
      if (!slot._addBtn) slot._addBtn = $('[data-add]', slot);
      slot.innerHTML = '';
      if (l) slot.appendChild(stepper(item, l));
      else if (slot._addBtn) slot.appendChild(slot._addBtn);
    });
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-add]');
    if (!btn) return;
    var card = btn.closest('[data-item]');
    var item = JSON.parse(card.getAttribute('data-item'));
    if (item.sold_by === 'weight') openWeightSheet(item);
    else { addItem(item); buzz(); toast(S.added + ' · ' + nameOf(item) + (item.pack ? ' ' + item.pack : '')); }
  });

  // ---------- weight sheet for loose produce ----------
  function openWeightSheet(item, preset) {
    var opts = [250, 500, 1000, 2000];
    var sheet = el('div', { class: 'sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ws-h' });
    function close() { sheet.remove(); }
    var box = el('div', { class: 'sheet' }, [
      el('h2', { id: 'ws-h', text: nameOf(item) }),
      el('p', { class: 'muted', text: money(item.price) + ' / kg · ' + S.choose_weight }),
      el('div', { class: 'weight-opts' }, opts.map(function (g) {
        return el('button', { type: 'button', class: 'btn btn-secondary', onclick: function () { addItem(item, { grams: g, barcode: preset && preset.barcode }); buzz(); toast(S.added + ' · ' + nameOf(item) + ' ~' + grams(g)); close(); } },
          [grams(g) + ' · ~' + money(weightAmount(item.price, g))]);
      })),
      el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: function () { addItem(item, { grams: null, barcode: preset && preset.barcode }); buzz(); toast(S.added + ' · ' + nameOf(item)); close(); } }, [S.weigh_at_counter]),
      el('p', { class: 'muted small', text: S.counter_will_weigh }),
      el('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: close }, [S.close]),
    ]);
    sheet.appendChild(box);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) close(); });
    sheet.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.body.appendChild(sheet);
    $('button', box).focus();
  }

  // ---------- barcode scanner ----------
  var scanner = null;
  function openScanner() {
    if (scanner) return;
    var video = el('video', { playsinline: true, muted: true, autoplay: true, 'aria-hidden': 'true' });
    var status = el('p', { class: 'scan-status', role: 'status', 'aria-live': 'polite', text: '' });
    var result = el('div', { class: 'scan-result', 'aria-live': 'polite' });
    var manualInput = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', id: 'manual-code', placeholder: '8901234567890', pattern: '[0-9 ]*' });
    var manual = el('form', { class: 'manual-entry', onsubmit: function (e) { e.preventDefault(); if (manualInput.value.trim()) handleCode(manualInput.value.trim(), true); } }, [
      el('label', { for: 'manual-code', text: S.manual_entry }), el('div', { class: 'row' }, [manualInput, el('button', { class: 'btn btn-secondary', type: 'submit' }, [S.add])]),
    ]);
    var modal = el('div', { class: 'scanner', role: 'dialog', 'aria-modal': 'true', 'aria-label': S.scan_product }, [
      el('div', { class: 'scanner-top' }, [el('strong', { text: S.scan_product }), el('button', { type: 'button', class: 'icon-btn light', 'aria-label': S.close, onclick: closeScanner }, ['✕'])]),
      el('div', { class: 'viewfinder' }, [video, el('div', { class: 'aim', 'aria-hidden': 'true' })]),
      status, result, manual,
    ]);
    document.body.appendChild(modal);
    document.body.classList.add('no-scroll');
    scanner = { modal: modal, video: video, status: status, result: result, paused: false, stream: null, timer: null, reader: null, busy: false };
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeScanner(); });
    startCamera();
  }
  function closeScanner() {
    if (!scanner) return;
    clearInterval(scanner.timer);
    try { if (scanner.reader) scanner.reader.reset(); } catch (e) { /* ignore */ }
    if (scanner.stream) scanner.stream.getTracks().forEach(function (t) { t.stop(); });
    scanner.modal.remove();
    document.body.classList.remove('no-scroll');
    scanner = null;
  }
  function cameraUnavailable() {
    if (!scanner) return;
    scanner.modal.classList.add('no-camera');
    scanner.status.textContent = S.camera_denied;
    var input = $('#manual-code'); if (input) input.focus();
  }
  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return cameraUnavailable();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(function (stream) {
        if (!scanner) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        scanner.stream = stream;
        scanner.video.srcObject = stream;
        var p = scanner.video.play(); if (p && p.catch) p.catch(function () {});
        if ('BarcodeDetector' in window) {
          window.BarcodeDetector.getSupportedFormats().then(function (formats) {
            var want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'].filter(function (f) { return formats.indexOf(f) >= 0; });
            if (!want.length) return startZxing(stream);
            var det = new window.BarcodeDetector({ formats: want });
            scanner.timer = setInterval(function () {
              if (!scanner || scanner.paused || scanner.busy || scanner.video.readyState < 2) return;
              scanner.busy = true;
              det.detect(scanner.video).then(function (codes) {
                if (scanner) scanner.busy = false;
                if (codes && codes.length) onDetected(codes[0].rawValue);
              }).catch(function () { if (scanner) scanner.busy = false; });
            }, 180);
          }).catch(function () { startZxing(stream); });
        } else startZxing(stream);
      })
      .catch(cameraUnavailable);
  }
  function startZxing(stream) {
    function go() {
      if (!scanner || !window.ZXing) return cameraUnavailable();
      var reader = new window.ZXing.BrowserMultiFormatReader(null, 250);
      scanner.reader = reader;
      reader.decodeFromStream(stream, scanner.video, function (res) {
        if (res && scanner && !scanner.paused) onDetected(res.getText());
      }).catch(function () {});
    }
    if (window.ZXing) return go();
    var s = document.createElement('script');
    s.src = '/vendor/zxing.min.js'; s.onload = go; s.onerror = cameraUnavailable;
    document.head.appendChild(s);
  }
  function onDetected(code) {
    if (!scanner || scanner.paused) return;
    scanner.paused = true; // one detection = one add; customer taps "Scan another" to continue
    handleCode(code, false);
  }
  function resume() {
    if (!scanner) return;
    scanner.result.innerHTML = '';
    scanner.status.textContent = '';
    scanner.paused = false;
  }
  function scanAnotherBtn() {
    return el('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: resume }, [S.scan_another]);
  }
  function handleCode(code, manual) {
    if (!scanner) return;
    scanner.paused = true;
    scanner.status.textContent = '…';
    var branch = basketBranch(getBasket()) || '';
    fetch('/api/items/lookup?code=' + encodeURIComponent(code) + '&branch=' + encodeURIComponent(branch), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (res) { showLookup(res, manual); })
      .catch(function () {
        scanner.status.textContent = S.you_are_offline;
        scanner.result.innerHTML = '';
        scanner.result.appendChild(scanAnotherBtn());
      });
  }
  function showLookup(res, manual) {
    if (!scanner) return;
    var box = scanner.result;
    box.innerHTML = '';
    scanner.status.textContent = '';
    if (res.kind === 'exact' || res.kind === 'scale') {
      var item = res.items[0];
      if (!item.available) {
        box.appendChild(el('p', { class: 'scan-msg warn', text: nameOf(item) + ' — ' + S.out_of_stock }));
        box.appendChild(scanAnotherBtn());
        return;
      }
      if (item.sold_by === 'weight') {
        var g = res.scale && res.scale.weightGrams;
        if (g) {
          addItem(item, { grams: g, barcode: res.code }); buzz();
          box.appendChild(el('p', { class: 'scan-msg ok', text: S.added + ' · ' + nameOf(item) + ' ' + grams(g) }));
          box.appendChild(scanAnotherBtn());
        } else {
          closeScanner();
          openWeightSheet(item, { barcode: res.code });
        }
        return;
      }
      var l = addItem(item, { barcode: res.code });
      buzz();
      box.appendChild(el('p', { class: 'scan-msg ok' }, [el('strong', { text: '✓ ' + S.added + ' · ' }), nameOf(item) + (item.pack ? ' ' + item.pack : ''), el('br'), money(item.price)]));
      var qtyRow = el('div', { class: 'row center' }, [
        el('button', { type: 'button', class: 'step-btn', 'aria-label': '−', onclick: function () { var b = getBasket(); var x = b.lines[String(item.id)]; setQty(item.id, (x ? x.qty : 1) - 1); upd(); } }, ['−']),
        el('span', { class: 'step-qty', 'data-scan-qty': '', text: String(l.qty) }),
        el('button', { type: 'button', class: 'step-btn', 'aria-label': '+', onclick: function () { addItem(item); upd(); } }, ['+']),
      ]);
      function upd() { var x = getBasket().lines[String(item.id)]; $('[data-scan-qty]', qtyRow).textContent = x ? x.qty : 0; }
      box.appendChild(qtyRow);
      box.appendChild(el('div', { class: 'row' }, [scanAnotherBtn(), el('a', { class: 'btn btn-secondary', href: '/basket' }, [S.view_basket])]));
      return;
    }
    if (res.kind === 'ambiguous') {
      box.appendChild(el('p', { class: 'scan-msg', text: LANG === 'ta' ? 'இந்த பார்கோடு பல பொருட்களுக்குப் பொருந்துகிறது. சரியானதைத் தேர்ந்தெடுக்கவும்:' : 'This barcode matches more than one product. Choose the one in your hand:' }));
      res.items.forEach(function (it) {
        box.appendChild(el('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: function () { showLookup({ kind: 'exact', code: res.code, items: [it], scale: res.scale }); } },
          [nameOf(it) + (it.pack ? ' · ' + it.pack : '') + ' · ' + money(it.price)]));
      });
      box.appendChild(scanAnotherBtn());
      return;
    }
    box.appendChild(el('p', { class: 'scan-msg warn', text: S.not_found + ': ' + res.code }));
    box.appendChild(el('p', { class: 'muted small', text: LANG === 'ta' ? 'இந்தப் பொருளைத் தேடுங்கள், அல்லது கவுண்டரில் காசாளரிடம் கொடுங்கள் — அவர் சேர்ப்பார்.' : 'Search for it by name, or just bring it to the counter — the cashier will add it.' }));
    var branch = basketBranch(getBasket());
    box.appendChild(el('div', { class: 'row' }, [
      el('a', { class: 'btn btn-secondary', href: (branch ? '/b/' + branch : '') + '/search' }, [S.search_products]),
      scanAnotherBtn(),
    ]));
    if (manual) { var i = $('#manual-code'); if (i) i.select(); }
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-open-scanner]');
    if (t) { e.preventDefault(); openScanner(); }
    var f = e.target.closest && e.target.closest('[data-focus-search]');
    if (f) { var q = $('#q-mob'); if (q && q.offsetParent) { e.preventDefault(); q.focus(); } }
  });

  // ---------- connectivity ----------
  function onlineState() {
    var off = !navigator.onLine;
    $all('[data-offline]').forEach(function (e) { e.hidden = !off; });
    var submit = $('[data-submit]');
    if (submit) {
      var note = $('[data-offline-note]');
      if (note) note.hidden = !off;
      submit.disabled = off || submit.getAttribute('data-busy') === '1';
    }
  }
  window.addEventListener('online', function () { onlineState(); if (getBasket().pending) submitBasket(); });
  window.addEventListener('offline', onlineState);

  // ---------- basket page ----------
  var root = $('[data-basket-root]');
  function renderBasketPage() {
    if (!root) return;
    var b = getBasket();
    var list = $('[data-lines]', root);
    list.innerHTML = '';
    var s = summary(b);
    $('[data-basket-empty]', root).hidden = s.count > 0;
    $('[data-summary]', root).hidden = s.count === 0;
    b.order.forEach(function (id) {
      var l = b.lines[id]; if (!l) return;
      var item = { id: l.id, name: l.name, name_ta: l.name_ta, pack: l.pack, sold_by: l.sold_by, price: l.price, max: l.max, slug: l.slug };
      var right;
      if (l.sold_by === 'weight') {
        right = el('div', { class: 'line-right' }, [
          el('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: function () { openWeightSheet(item); } }, [l.est_grams ? S.approx + ' ' + grams(l.est_grams) : S.weigh_at_counter]),
          el('span', { class: 'line-amt', text: l.est_grams ? '~' + money(lineTotal(l)) : '—' }),
        ]);
      } else {
        right = el('div', { class: 'line-right' }, [stepper(item, l), el('span', { class: 'line-amt', text: money(lineTotal(l)) })]);
      }
      list.appendChild(el('li', { class: 'bline' }, [
        el('img', { src: '/img/item/' + l.id + '.svg', alt: '', width: '56', height: '56', loading: 'lazy' }),
        el('div', { class: 'line-main' }, [
          el('a', { href: '/p/' + l.slug, class: 'line-name', text: nameOf(item) }),
          el('span', { class: 'muted small', text: (l.pack ? l.pack + ' · ' : '') + money(l.price) + (l.sold_by === 'weight' ? ' / kg' : '') }),
          el('button', { type: 'button', class: 'link-btn small', onclick: function () { setQty(l.id, 0); renderBasketPage(); } }, [S.remove]),
        ]),
        right,
      ]));
    });
    $('[data-total]', root).textContent = (s.estimated ? '~' : '') + money(s.total);
    $('[data-total-label]', root).textContent = s.estimated ? S.estimated_total : S.total;
    $('[data-est-note]', root).hidden = !s.estimated;
    var notIn = $('[data-not-in-store]', root);
    if (notIn) notIn.hidden = root.getAttribute('data-in-store') === '1';
    onlineState();
  }

  function showChanges(changes) {
    var box = $('[data-changes]', root);
    if (!changes || !changes.length) { box.hidden = true; return; }
    box.innerHTML = '';
    box.appendChild(el('p', {}, [el('strong', { text: S.price_changed })]));
    var ul = el('ul');
    changes.forEach(function (c) {
      var t = c.name + ': ';
      if (c.kind === 'price_changed') t += money(c.old_price_paise) + ' → ' + money(c.new_price_paise);
      else if (c.kind === 'qty_limited') t += (LANG === 'ta' ? 'அதிகபட்சம் ' : 'max ') + c.max_qty;
      else t += S.out_of_stock;
      ul.appendChild(el('li', { text: t }));
    });
    box.appendChild(ul);
    box.appendChild(el('button', { type: 'button', class: 'btn btn-primary', onclick: function () { applyChanges(changes); } }, [S.accept_changes]));
    box.hidden = false;
    box.scrollIntoView({ block: 'center' });
  }
  function applyChanges(changes) {
    var b = getBasket();
    changes.forEach(function (c) {
      var l = b.lines[String(c.item_id)]; if (!l) return;
      if (c.kind === 'price_changed') l.price = c.new_price_paise;
      else if (c.kind === 'qty_limited') { l.max = c.max_qty; l.qty = Math.min(l.qty, c.max_qty); }
      else { delete b.lines[String(c.item_id)]; b.order = b.order.filter(function (x) { return x !== String(c.item_id); }); }
    });
    b.checkoutKey = null; b.pending = false;
    setBasket(b);
    showChanges([]);
    renderBasketPage();
  }
  function payloadLines(b) {
    return b.order.filter(function (id) { return b.lines[id]; }).map(function (id) {
      var l = b.lines[id];
      return { item_id: l.id, qty: l.sold_by === 'weight' ? 1 : l.qty, est_grams: l.sold_by === 'weight' ? l.est_grams : null, seen_price_paise: l.price, barcode: l.barcode };
    });
  }
  function quoteBasket() {
    var b = getBasket();
    if (!b.order.length || !navigator.onLine) return;
    fetch('/api/basket/quote', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ lines: payloadLines(b) }) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res.changes && res.changes.length) showChanges(res.changes); })
      .catch(function () {});
    var br = basketBranch(b);
    if (br) fetch('/api/b/' + encodeURIComponent(br) + '/status', { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (st) {
      var p = $('[data-paused]', root);
      if (p) { p.hidden = st.accepting; p.textContent = st.message || S.accepting_paused; }
      var btn = $('[data-submit]', root); if (btn && !st.accepting) btn.disabled = true;
    }).catch(function () {});
  }
  function submitBasket() {
    var b = getBasket();
    var btn = $('[data-submit]', root);
    if (!b.order.length || !btn) return;
    var notIn = $('[data-not-in-store]', root);
    if (notIn && !notIn.hidden && !$('[data-confirm-in-store]', root).checked) {
      notIn.classList.add('attention'); $('[data-confirm-in-store]', root).focus(); return;
    }
    if (!navigator.onLine) { onlineState(); return; }
    // One idempotency key per checkout attempt, reused for every retry of that attempt.
    if (!b.checkoutKey) b.checkoutKey = randKey();
    b.pending = true;
    save(BASKET_KEY, b);
    btn.setAttribute('data-busy', '1'); btn.disabled = true; btn.textContent = S.sending_to_counter;
    var branch = basketBranch(b);
    fetch('/api/b/' + encodeURIComponent(branch) + '/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': b.checkoutKey },
      body: JSON.stringify({ lines: payloadLines(b) }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.status === 200 || res.status === 201) {
          var tickets = load(TICKETS_KEY, []);
          if (!tickets.some(function (t) { return t.token === res.body.token; }))
            tickets.push({ token: res.body.token, code: res.body.code, counter: res.body.counter && res.body.counter.number, at: Date.now() });
          save(TICKETS_KEY, tickets.slice(-5));
          save(BASKET_KEY, { branch: branch, lines: {}, order: [], checkoutKey: null, pending: false });
          location.replace(res.body.ticket_url);
          return;
        }
        var cur = getBasket(); cur.pending = false;
        if (res.status === 409 && res.body.details && res.body.details.changes) { cur.checkoutKey = null; save(BASKET_KEY, cur); showChanges(res.body.details.changes); }
        else {
          save(BASKET_KEY, cur);
          var p = $('[data-paused]', root); p.textContent = res.body.error || 'Error'; p.hidden = false;
        }
        resetBtn();
      })
      .catch(function () {
        // Network failure: the order may or may not exist. Keep the same key so a retry returns the same order.
        resetBtn();
        var p = $('[data-paused]', root); p.textContent = S.reconnect_to_send; p.hidden = false;
      });
    function resetBtn() { btn.removeAttribute('data-busy'); btn.textContent = S.pay_at_counter; onlineState(); }
  }
  if (root) {
    renderBasketPage();
    quoteBasket();
    $('[data-submit]', root).addEventListener('click', submitBasket);
    // A submission was in flight when the page closed or the connection dropped: resend with the same key.
    if (getBasket().pending && navigator.onLine) submitBasket();
  }

  // ---------- ticket page ----------
  var ticket = $('[data-ticket]');
  if (ticket) {
    var token = ticket.getAttribute('data-ticket');
    var card = $('[data-ticket-card]', ticket);
    var lastStatus = null;
    var poll = function () {
      if (document.hidden || !navigator.onLine) return;
      fetch('/api/tickets/' + encodeURIComponent(token), { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v) return;
          card.innerHTML = v.html;
          var tickets = load(TICKETS_KEY, []);
          tickets.forEach(function (t) { if (t.token === token) { t.counter = v.counter && v.counter.number; t.closed = ['paid', 'cancelled', 'expired'].indexOf(v.status) >= 0; } });
          save(TICKETS_KEY, tickets);
          if (lastStatus && lastStatus !== v.status) buzz();
          lastStatus = v.status;
        }).catch(function () {});
    };
    setInterval(poll, 5000);
    document.addEventListener('visibilitychange', poll);
    var nb = $('[data-new-basket]');
    if (nb) nb.addEventListener('click', function () {
      save(BASKET_KEY, { branch: DATA.branch && DATA.branch.slug, lines: {}, order: [], checkoutKey: null, pending: false });
      location.href = DATA.branch ? '/b/' + DATA.branch.slug : '/';
    });
  }

  // remember the branch from the QR so later pages keep it
  if (DATA.branch && DATA.inStore) { var bb = getBasket(); if (!bb.order.length || !bb.branch) { bb.branch = DATA.branch.slug; save(BASKET_KEY, bb); } }

  renderBasketChrome();
  syncCards();
  onlineState();
  window.addEventListener('storage', function (e) { if (e.key === BASKET_KEY) { renderBasketChrome(); syncCards(); renderBasketPage(); } });
})();
