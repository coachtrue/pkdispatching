/* ==========================================================================
   LP3 Dispatching — Carrier Portal

   IMPORTANT: every value here (broker names, notes, method) was typed by
   staff but could contain anything a carrier said in a message that got
   copy-pasted in. Written with textContent, never innerHTML, same rule as
   admin.js.
   ========================================================================== */
(function () {
  'use strict';

  var API = '/api/portal';
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var STATUS_TONE = {
    booked: 'new', in_transit: 'progress', delivered: 'good', paid: 'good', cancelled: 'bad',
    pending: 'progress', failed: 'bad'
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function toast(message, isError) {
    var t = $('#toast');
    t.textContent = message;
    t.classList.toggle('toast--error', !!isError);
    t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('is-visible'); });
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      t.classList.remove('is-visible');
      setTimeout(function () { t.hidden = true; }, 220);
    }, isError ? 5200 : 2800);
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtMoney(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!isFinite(n)) return '—';
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function statusPill(status) {
    var tone = STATUS_TONE[status] || 'idle';
    return el('span', 'pill pill--' + tone, (status || '').replace(/_/g, ' '));
  }

  function api(action, options) {
    options = options || {};
    var url = API + '?action=' + encodeURIComponent(action);
    var init = { method: options.method || 'GET', credentials: 'same-origin' };
    if (options.body) {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && action !== 'login') {
          showGate();
          throw new Error('Session expired — sign in again.');
        }
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  function showGate() { $('#gate').hidden = false; $('#app').hidden = true; }
  function showApp() { $('#gate').hidden = true; $('#app').hidden = false; }

  function initLogin() {
    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('#loginError');
      var label = $('#loginLabel');
      err.textContent = '';
      label.textContent = 'Signing in…';
      api('login', { body: { email: $('#email').value, password: $('#password').value } })
        .then(function () {
          $('#password').value = '';
          showApp();
          return loadTransactions();
        })
        .catch(function (e2) { err.textContent = e2.message; })
        .finally(function () { label.textContent = 'Sign in'; });
    });

    $('#logoutBtn').addEventListener('click', function () {
      api('logout').finally(function () {
        showGate();
        $('#email').value = '';
      });
    });
  }

  function renderLoads(loads) {
    var tbody = $('#loadsRows');
    clear(tbody);
    $('#loadsEmpty').hidden = Boolean(loads.length);

    loads.forEach(function (ld) {
      var tr = el('tr');
      tr.appendChild(el('td', null, ld.load_number || '—'));
      tr.appendChild(el('td', null, ld.broker || '—'));
      var route = [ld.pickup_city, ld.pickup_state].filter(Boolean).join(', ') +
        ' → ' + [ld.delivery_city, ld.delivery_state].filter(Boolean).join(', ');
      tr.appendChild(el('td', null, route === ' → ' ? '—' : route));
      tr.appendChild(el('td', null, fmtDate(ld.pickup_date)));
      tr.appendChild(el('td', null, fmtDate(ld.delivery_date)));
      tr.appendChild(el('td', 'num', fmtMoney(ld.rate)));
      var statusTd = el('td');
      statusTd.appendChild(statusPill(ld.status));
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    });
  }

  function renderPayments(payments) {
    var tbody = $('#paymentsRows');
    clear(tbody);
    $('#paymentsEmpty').hidden = Boolean(payments.length);

    payments.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num', fmtMoney(p.amount)));
      var statusTd = el('td');
      statusTd.appendChild(statusPill(p.status));
      tr.appendChild(statusTd);
      tr.appendChild(el('td', null, p.method || '—'));
      tr.appendChild(el('td', null, p.paid_at ? fmtDate(p.paid_at) : '—'));
      tr.appendChild(el('td', null, p.notes || '—'));
      tbody.appendChild(tr);
    });
  }

  function loadTransactions() {
    return api('transactions').then(function (data) {
      $('#carrierName').textContent = data.carrier ? data.carrier.company_name : '';
      renderLoads(data.loads || []);
      renderPayments(data.payments || []);
    }).catch(function (e) { toast(e.message, true); });
  }

  function init() {
    initLogin();
    api('session')
      .then(function (s) {
        if (s.signedIn) {
          $('#carrierName').textContent = s.email || '';
          showApp();
          return loadTransactions();
        }
        showGate();
      })
      .catch(function () { showGate(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
