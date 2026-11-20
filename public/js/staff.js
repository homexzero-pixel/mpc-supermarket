/* MPC staff screens: live order queue, alerts with sound, small form helpers. */
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="csrf-token"]');
  var CSRF = meta ? meta.getAttribute('content') : '';

  document.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('[data-autosubmit]')) e.target.form.submit();
  });
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
    // prevent accidental double submits of payment / adjust forms
    if (!e.defaultPrevented && e.target.method && e.target.method.toLowerCase() === 'post') {
      if (e.target.getAttribute('data-sent') === '1') { e.preventDefault(); return; }
      e.target.setAttribute('data-sent', '1');
      setTimeout(function () { e.target.removeAttribute('data-sent'); }, 4000);
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target.matches && e.target.matches('[data-print]')) window.print();
  });

  // ---- sound (enabled after first interaction, as browsers require) ----
  var audioCtx = null;
  document.addEventListener('click', function () {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }, { once: true });
  function beep(freq, times) {
    if (!audioCtx) return;
    for (var i = 0; i < (times || 1); i++) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
      var t = audioCtx.currentTime + i * 0.25;
      g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.start(t); o.stop(t + 0.21);
    }
  }

  // ---- live queue ----
  var feed = document.querySelector('[data-feed]');
  if (feed) {
    var branch = feed.getAttribute('data-feed');
    var newest = null, alertIds = null;
    var tick = function () {
      fetch('/api/staff/feed?branch=' + encodeURIComponent(branch), { headers: { accept: 'application/json', 'x-requested-with': 'fetch' }, credentials: 'same-origin' })
        .then(function (r) { if (r.status === 401) location.reload(); return r.json(); })
        .then(function (d) {
          if (document.activeElement && feed.contains(document.activeElement)) return; // don't disturb typing
          feed.querySelector('[data-queue]').innerHTML = d.queue;
          feed.querySelector('[data-alerts]').innerHTML = d.alerts;
          feed.querySelector('[data-printers]').innerHTML = d.printers;
          if (newest !== null && d.newest && d.newest > newest) beep(880, 2);
          if (alertIds !== null && d.alert_ids.some(function (id) { return alertIds.indexOf(id) < 0; })) beep(330, 3);
          newest = d.newest || newest || '';
          alertIds = d.alert_ids;
          document.title = (d.queue.match(/row-awaiting_payment/g) || []).length + ' waiting · Orders · MPC Staff';
        }).catch(function () {});
    };
    tick();
    setInterval(tick, 3000);
  }

  // ---- CSV import: read the file in the browser and post it as JSON ----
  var csvForm = document.querySelector('[data-csv-form]');
  if (csvForm) {
    csvForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var file = csvForm.querySelector('[data-csv-file]').files[0];
      if (!file) return;
      var btn = csvForm.querySelector('button'); btn.disabled = true; btn.textContent = 'Importing…';
      file.text().then(function (text) {
        return fetch('/admin/catalogue/import', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': CSRF, 'x-requested-with': 'fetch' },
          body: JSON.stringify({ csv: text }),
        });
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.syncId) location.href = '/admin/catalogue?import=' + d.syncId;
        else { alert(d.error || 'Import failed'); btn.disabled = false; btn.textContent = 'Validate & import'; }
      }).catch(function () { alert('Import failed'); btn.disabled = false; });
    });
  }

})();
