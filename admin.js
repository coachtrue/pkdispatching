/* ==========================================================================
   LP3 Dispatching — Dispatch Desk

   IMPORTANT: every value that originates from a carrier (company names,
   notes, emails) is written with textContent, never innerHTML. Carriers
   control that text, so innerHTML here would be a stored-XSS hole straight
   into the admin session.
   ========================================================================== */
(function () {
  'use strict';

  var API = '/api/crm';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { view: 'all', search: '', status: '', contacts: [], current: null, kind: 'note' };

  var CARRIER_STATUSES = ['new', 'verifying', 'approved', 'active', 'paused', 'rejected'];
  var LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

  var STATUS_TONE = {
    new: 'new', verifying: 'progress', contacted: 'progress', qualified: 'progress',
    approved: 'good', active: 'good', converted: 'good', delivered: 'good', paid: 'good',
    rejected: 'bad', lost: 'bad', failed: 'bad', cancelled: 'bad',
    paused: 'idle',
    booked: 'new', in_transit: 'progress', pending: 'progress'
  };

  var LOAD_STATUSES = ['booked', 'in_transit', 'delivered', 'paid', 'cancelled'];
  var PAYMENT_STATUSES = ['pending', 'paid', 'failed'];

  /* ================================================================
     DOM helpers — el() only ever sets text, never markup.
     ================================================================ */

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

  /* ================================================================
     Formatting
     ================================================================ */

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtDateTime(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function daysAgo(value) {
    if (!value) return null;
    var d = new Date(value);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function relative(value) {
    var days = daysAgo(value);
    if (days === null) return 'Never';
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return days + ' days ago';
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  /* ================================================================
     Transport
     ================================================================ */

  function api(action, options) {
    options = options || {};
    var url = API + '?action=' + encodeURIComponent(action) + (options.query || '');
    var init = { method: options.method || 'GET', credentials: 'same-origin' };
    if (options.body) {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // A 401 on login means the password was wrong — surface the server's
        // message. Anywhere else it means the session lapsed.
        if (res.status === 401 && action !== 'login') {
          showGate();
          throw new Error('Session expired — sign in again.');
        }
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  /* ================================================================
     Auth
     ================================================================ */

  function showGate() { $('#gate').hidden = false; $('#app').hidden = true; }
  function showApp() { $('#gate').hidden = true; $('#app').hidden = false; }

  function initLogin() {
    $('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var label = $('#loginLabel');
      var err = $('#loginError');
      err.textContent = '';
      label.textContent = 'Checking…';

      api('login', { body: { password: $('#password').value } })
        .then(function () {
          $('#password').value = '';
          showApp();
          // Honour ?ref= here too — arriving from a GoHighLevel link usually
          // means signing in first, and the deep link must survive that.
          return refreshAll().then(openDeepLink);
        })
        .catch(function (e2) { err.textContent = e2.message; })
        .finally(function () { label.textContent = 'Sign in'; });
    });

    $('#logoutBtn').addEventListener('click', function () {
      api('logout', { method: 'POST' }).finally(showGate);
    });
  }

  /* ================================================================
     Stats
     ================================================================ */

  function renderStats(s) {
    var host = $('#stats');
    clear(host);

    var tiles = [
      { label: 'New carriers', value: s.carriers.new, tone: s.carriers.new > 0 ? 'attention' : '' },
      { label: 'Verifying', value: s.carriers.verifying, tone: '' },
      { label: 'Active carriers', value: s.carriers.active, tone: 'good' },
      { label: 'New leads', value: s.leads.new, tone: s.leads.new > 0 ? 'attention' : '' },
      { label: 'Arrived today', value: s.carriers.today + s.leads.today, tone: '' },
      { label: 'Follow-ups due', value: s.followUpsDue, tone: s.followUpsDue > 0 ? 'attention' : '' }
    ];

    tiles.forEach(function (t) {
      var card = el('div', 'stat' + (t.tone ? ' stat--' + t.tone : ''));
      card.appendChild(el('span', 'stat__num', t.value));
      card.appendChild(el('span', 'stat__label', t.label));
      host.appendChild(card);
    });
  }

  /* ================================================================
     Contact table
     ================================================================ */

  function visibleContacts() {
    if (state.view !== 'followup') return state.contacts;
    var today = todayISO();
    return state.contacts.filter(function (c) { return c.next_follow_up && c.next_follow_up <= today; });
  }

  function statusPill(status) {
    var tone = STATUS_TONE[status] || 'idle';
    return el('span', 'pill pill--' + tone, status || 'new');
  }

  function renderRows() {
    var body = $('#rows');
    clear(body);
    var rows = visibleContacts();

    $('#empty').hidden = rows.length > 0;

    rows.forEach(function (c) {
      var tr = el('tr');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');

      // Contact
      var who = el('div', 'who');
      who.appendChild(el('span', 'who__name', c.name || c.contact_name || '(no name)'));
      var sub = [c.contact_name && c.contact_name !== c.name ? c.contact_name : '', c.mc_number || '']
        .filter(Boolean).join(' · ');
      who.appendChild(el('span', 'who__sub', sub || c.email || ''));
      var td1 = el('td'); td1.appendChild(who); tr.appendChild(td1);

      // Type
      var td2 = el('td');
      td2.appendChild(el('span', 'tag', c.contact_type === 'lead' ? 'Lead' : 'Carrier'));
      tr.appendChild(td2);

      // Status
      var td3 = el('td'); td3.appendChild(statusPill(c.status)); tr.appendChild(td3);

      // Equipment
      var td4 = el('td');
      var equipment = Array.isArray(c.equipment) ? c.equipment : [];
      if (!equipment.length) td4.appendChild(el('span', 'muted', '—'));
      equipment.slice(0, 2).forEach(function (item) { td4.appendChild(el('span', 'tag', item)); });
      if (equipment.length > 2) td4.appendChild(el('span', 'muted', '+' + (equipment.length - 2)));
      tr.appendChild(td4);

      // Docs
      var td5 = el('td', 'num', c.contact_type === 'carrier' ? String(c.document_count || 0) : '—');
      tr.appendChild(td5);

      // Last contact
      tr.appendChild(el('td', 'nowrap muted', relative(c.last_contacted_at)));

      // Follow-up
      var overdue = c.next_follow_up && c.next_follow_up <= todayISO();
      tr.appendChild(el('td', 'nowrap' + (overdue ? ' due' : ' muted'),
        c.next_follow_up ? fmtDate(c.next_follow_up) : '—'));

      // Received
      tr.appendChild(el('td', 'nowrap muted', fmtDate(c.created_at)));

      function open() { openContact(c); }
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      body.appendChild(tr);
    });
  }

  /* ================================================================
     Detail drawer
     ================================================================ */

  function fact(key, value, isLink) {
    var box = el('div', 'fact');
    box.appendChild(el('span', 'fact__k', key));
    var v = el('span', 'fact__v');
    if (isLink && value) {
      var a = el('a', null, value);
      a.href = isLink + value;
      v.appendChild(a);
    } else {
      v.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    }
    box.appendChild(v);
    return box;
  }

  function fmtMoney(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!isFinite(n)) return '—';
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* --- Carrier portal: account status + create/reset/enable/disable --- */
  function renderPortalSection(container, data, summary) {
    var section = el('div', 'dsection');
    section.appendChild(el('h3', null, 'Carrier Portal'));

    var account = data.portalAccount;
    var statusRow = el('div', 'portal-status');
    if (account) {
      statusRow.appendChild(el('span', null, account.email));
      statusRow.appendChild(el('span', 'portal-badge portal-badge--' + (account.is_active ? 'active' : 'inactive'),
        account.is_active ? 'Active' : 'Disabled'));
      statusRow.appendChild(el('span', 'muted', 'Last sign-in: ' + relative(account.last_login_at)));
    } else {
      statusRow.appendChild(el('span', 'muted', 'No portal account yet.'));
    }
    section.appendChild(statusRow);

    var emailInput = null;
    if (!account) {
      var emailWrap = el('div');
      emailWrap.style.marginTop = '.5rem';
      emailWrap.appendChild(el('label', null, 'Portal email'));
      emailInput = el('input');
      emailInput.type = 'email';
      emailInput.value = data.record.email || '';
      emailInput.style.cssText = 'width:100%;padding:.5rem .6rem;border:1.5px solid var(--line);border-radius:var(--radius-sm);font:inherit;';
      emailWrap.appendChild(emailInput);
      section.appendChild(emailWrap);
    }

    var btnRow = el('div', 'logform__row');
    btnRow.style.marginTop = '.6rem';

    var createBtn = el('button', 'btn btn--sm btn--primary', account ? 'Reset password' : 'Create portal account');
    createBtn.addEventListener('click', function () {
      if (emailInput && !emailInput.value.trim()) { toast('Enter an email first.', true); return; }
      createBtn.disabled = true;
      api('portalAccount', {
        body: { reference: summary.reference, email: emailInput ? emailInput.value : undefined }
      }).then(function (res) {
        toast(res.created ? 'Portal account created.' : 'Password reset.');
        var old = $('#portalReveal', container);
        if (old) old.parentNode.removeChild(old);

        var revealWrap = el('div', null);
        revealWrap.id = 'portalReveal';
        revealWrap.appendChild(el('p', 'muted', 'Shown once — copy it now and send it to the carrier yourself. It cannot be shown again.'));
        var reveal = el('div', 'portal-reveal');
        var input = el('input');
        input.type = 'text';
        input.readOnly = true;
        input.value = res.email + '   ' + res.password;
        reveal.appendChild(input);
        var copyBtn = el('button', 'btn btn--sm btn--ghost', 'Copy');
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', function () {
          input.select();
          if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(function () {});
          toast('Copied.');
        });
        reveal.appendChild(copyBtn);
        revealWrap.appendChild(reveal);
        section.appendChild(revealWrap);

        return refreshAll();
      }).catch(function (e) { toast(e.message, true); })
        .finally(function () { createBtn.disabled = false; });
    });
    btnRow.appendChild(createBtn);

    if (account) {
      var toggleBtn = el('button', 'btn btn--sm btn--ghost', account.is_active ? 'Disable' : 'Enable');
      toggleBtn.addEventListener('click', function () {
        toggleBtn.disabled = true;
        api('portalToggle', { body: { reference: summary.reference, active: !account.is_active } })
          .then(function () {
            toast(account.is_active ? 'Portal account disabled.' : 'Portal account enabled.');
            return refreshAll();
          })
          .then(function () { openContact(summary); })
          .catch(function (e) { toast(e.message, true); })
          .finally(function () { toggleBtn.disabled = false; });
      });
      btnRow.appendChild(toggleBtn);
    }

    section.appendChild(btnRow);
    container.appendChild(section);
  }

  /* --- Loads: table + add/edit form --- */
  function renderLoadsSection(container, data, summary) {
    var section = el('div', 'dsection');
    section.appendChild(el('h3', null, 'Loads (' + data.loads.length + ')'));

    if (data.loads.length) {
      var table = el('table', 'mini-table');
      var thead = el('thead');
      var htr = el('tr');
      ['Load #', 'Route', 'Rate', 'Status'].forEach(function (h) { htr.appendChild(el('th', null, h)); });
      thead.appendChild(htr);
      table.appendChild(thead);

      var tbody = el('tbody');
      data.loads.forEach(function (ld) {
        var tr = el('tr');
        tr.appendChild(el('td', null, ld.load_number || '—'));
        var route = [ld.pickup_city, ld.pickup_state].filter(Boolean).join(', ') +
          ' → ' + [ld.delivery_city, ld.delivery_state].filter(Boolean).join(', ');
        tr.appendChild(el('td', null, route === ' → ' ? '—' : route));
        tr.appendChild(el('td', 'num', fmtMoney(ld.rate)));
        var statusTd = el('td');
        statusTd.appendChild(statusPill(ld.status));
        tr.appendChild(statusTd);
        tr.addEventListener('click', function () { showLoadForm(ld); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      section.appendChild(table);
    } else {
      section.appendChild(el('p', 'muted', 'No loads logged yet.'));
    }

    var addBtn = el('button', 'btn btn--sm btn--ghost', '+ Add load');
    addBtn.style.marginTop = '.6rem';
    var formHolder = el('div');
    addBtn.addEventListener('click', function () { showLoadForm(null); });
    section.appendChild(addBtn);
    section.appendChild(formHolder);
    container.appendChild(section);

    function showLoadForm(existing) {
      clear(formHolder);
      var form = el('div', 'mini-form');

      function field(label, name, type) {
        var wrap = el('div');
        wrap.appendChild(el('label', null, label));
        var input = el(type === 'textarea' ? 'textarea' : 'input');
        if (type && type !== 'textarea') input.type = type;
        input.name = name;
        if (existing && existing[name] !== undefined && existing[name] !== null) input.value = existing[name];
        wrap.appendChild(input);
        form.appendChild(wrap);
        return input;
      }

      var loadNumber = field('Load #', 'load_number', 'text');
      var broker = field('Broker', 'broker', 'text');
      var pickupCity = field('Pickup city', 'pickup_city', 'text');
      var pickupState = field('Pickup state', 'pickup_state', 'text');
      var pickupDate = field('Pickup date', 'pickup_date', 'date');
      var deliveryCity = field('Delivery city', 'delivery_city', 'text');
      var deliveryState = field('Delivery state', 'delivery_state', 'text');
      var deliveryDate = field('Delivery date', 'delivery_date', 'date');
      var rate = field('Rate ($)', 'rate', 'number');
      rate.step = '0.01'; rate.min = '0';

      var statusWrap = el('div');
      statusWrap.appendChild(el('label', null, 'Status'));
      var statusSel = el('select');
      LOAD_STATUSES.forEach(function (s) {
        var opt = el('option', null, s);
        opt.value = s;
        if ((existing ? existing.status : 'booked') === s) opt.selected = true;
        statusSel.appendChild(opt);
      });
      statusWrap.appendChild(statusSel);
      form.appendChild(statusWrap);

      var notesWrap = el('div', 'span2');
      notesWrap.appendChild(el('label', null, 'Notes'));
      var notes = el('textarea');
      if (existing && existing.notes) notes.value = existing.notes;
      notesWrap.appendChild(notes);
      form.appendChild(notesWrap);

      var actions = el('div', 'mini-form__actions');
      var saveBtn = el('button', 'btn btn--sm btn--primary', existing ? 'Save changes' : 'Add load');
      saveBtn.addEventListener('click', function () {
        saveBtn.disabled = true;
        api('loadSave', {
          body: {
            id: existing ? existing.id : undefined,
            reference: summary.reference,
            loadNumber: loadNumber.value,
            broker: broker.value,
            pickupCity: pickupCity.value,
            pickupState: pickupState.value,
            pickupDate: pickupDate.value,
            deliveryCity: deliveryCity.value,
            deliveryState: deliveryState.value,
            deliveryDate: deliveryDate.value,
            rate: rate.value,
            status: statusSel.value,
            notes: notes.value
          }
        }).then(function () {
          toast(existing ? 'Load updated.' : 'Load added.');
          openContact(summary);
        }).catch(function (e) { toast(e.message, true); })
          .finally(function () { saveBtn.disabled = false; });
      });
      actions.appendChild(saveBtn);

      var cancelBtn = el('button', 'btn btn--sm btn--ghost', 'Cancel');
      cancelBtn.addEventListener('click', function () { clear(formHolder); });
      actions.appendChild(cancelBtn);
      form.appendChild(actions);

      formHolder.appendChild(form);
    }
  }

  /* --- Payments: table + add/edit form --- */
  function renderPaymentsSection(container, data, summary) {
    var section = el('div', 'dsection');
    section.appendChild(el('h3', null, 'Payments (' + data.payments.length + ')'));

    if (data.payments.length) {
      var table = el('table', 'mini-table');
      var thead = el('thead');
      var htr = el('tr');
      ['Amount', 'Status', 'Method', 'Paid'].forEach(function (h) { htr.appendChild(el('th', null, h)); });
      thead.appendChild(htr);
      table.appendChild(thead);

      var tbody = el('tbody');
      data.payments.forEach(function (p) {
        var tr = el('tr');
        tr.appendChild(el('td', 'num', fmtMoney(p.amount)));
        var statusTd = el('td');
        statusTd.appendChild(statusPill(p.status));
        tr.appendChild(statusTd);
        tr.appendChild(el('td', null, p.method || '—'));
        tr.appendChild(el('td', null, p.paid_at ? fmtDate(p.paid_at) : '—'));
        tr.addEventListener('click', function () { showPaymentForm(p); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      section.appendChild(table);
    } else {
      section.appendChild(el('p', 'muted', 'No payments logged yet.'));
    }

    var addBtn = el('button', 'btn btn--sm btn--ghost', '+ Add payment');
    addBtn.style.marginTop = '.6rem';
    var formHolder = el('div');
    addBtn.addEventListener('click', function () { showPaymentForm(null); });
    section.appendChild(addBtn);
    section.appendChild(formHolder);
    container.appendChild(section);

    function showPaymentForm(existing) {
      clear(formHolder);
      var form = el('div', 'mini-form');

      var amountWrap = el('div');
      amountWrap.appendChild(el('label', null, 'Amount ($)'));
      var amount = el('input');
      amount.type = 'number'; amount.step = '0.01'; amount.min = '0';
      if (existing) amount.value = existing.amount;
      amountWrap.appendChild(amount);
      form.appendChild(amountWrap);

      var statusWrap = el('div');
      statusWrap.appendChild(el('label', null, 'Status'));
      var statusSel = el('select');
      PAYMENT_STATUSES.forEach(function (s) {
        var opt = el('option', null, s);
        opt.value = s;
        if ((existing ? existing.status : 'pending') === s) opt.selected = true;
        statusSel.appendChild(opt);
      });
      statusWrap.appendChild(statusSel);
      form.appendChild(statusWrap);

      var methodWrap = el('div');
      methodWrap.appendChild(el('label', null, 'Method'));
      var method = el('input');
      method.type = 'text';
      method.placeholder = 'ACH, factoring, check…';
      if (existing && existing.method) method.value = existing.method;
      methodWrap.appendChild(method);
      form.appendChild(methodWrap);

      var paidWrap = el('div');
      paidWrap.appendChild(el('label', null, 'Paid date'));
      var paidAt = el('input');
      paidAt.type = 'date';
      if (existing && existing.paid_at) paidAt.value = String(existing.paid_at).slice(0, 10);
      paidWrap.appendChild(paidAt);
      form.appendChild(paidWrap);

      var notesWrap = el('div', 'span2');
      notesWrap.appendChild(el('label', null, 'Notes'));
      var notes = el('textarea');
      if (existing && existing.notes) notes.value = existing.notes;
      notesWrap.appendChild(notes);
      form.appendChild(notesWrap);

      var actions = el('div', 'mini-form__actions');
      var saveBtn = el('button', 'btn btn--sm btn--primary', existing ? 'Save changes' : 'Add payment');
      saveBtn.addEventListener('click', function () {
        if (!amount.value || Number(amount.value) <= 0) { toast('Enter an amount.', true); return; }
        saveBtn.disabled = true;
        api('paymentSave', {
          body: {
            id: existing ? existing.id : undefined,
            reference: summary.reference,
            amount: amount.value,
            status: statusSel.value,
            method: method.value,
            paidAt: paidAt.value,
            notes: notes.value
          }
        }).then(function () {
          toast(existing ? 'Payment updated.' : 'Payment added.');
          openContact(summary);
        }).catch(function (e) { toast(e.message, true); })
          .finally(function () { saveBtn.disabled = false; });
      });
      actions.appendChild(saveBtn);

      var cancelBtn = el('button', 'btn btn--sm btn--ghost', 'Cancel');
      cancelBtn.addEventListener('click', function () { clear(formHolder); });
      actions.appendChild(cancelBtn);
      form.appendChild(actions);

      formHolder.appendChild(form);
    }
  }

  function openContact(summary) {
    var drawer = $('#drawer');
    drawer.hidden = false;
    $('#drawerName').textContent = summary.name || summary.contact_name || summary.reference;
    $('#drawerMeta').textContent = 'Loading…';
    clear($('#drawerBody'));

    api('contact', { query: '&reference=' + encodeURIComponent(summary.reference) + '&type=' + encodeURIComponent(summary.contact_type) })
      .then(function (data) {
        state.current = { summary: summary, data: data };
        renderDrawer(data, summary);
      })
      .catch(function (e) { toast(e.message, true); });
  }

  function renderDrawer(data, summary) {
    var r = data.record;
    var isCarrier = data.contactType === 'carrier';

    $('#drawerMeta').textContent =
      (isCarrier ? 'Carrier' : 'Lead') + ' · ' + summary.reference + ' · received ' + fmtDate(r.created_at);

    var body = $('#drawerBody');
    clear(body);

    /* --- Quick actions --- */
    var actions = el('div', 'dsection');
    var row = el('div', 'logform__row');
    if (r.phone) {
      var call = el('a', 'btn btn--sm btn--accent', 'Call');
      call.href = 'tel:' + r.phone; row.appendChild(call);
      var sms = el('a', 'btn btn--sm btn--ghost', 'Text');
      sms.href = 'sms:' + r.phone; row.appendChild(sms);
    }
    if (r.email) {
      var mail = el('a', 'btn btn--sm btn--ghost', 'Email');
      mail.href = 'mailto:' + r.email + '?subject=' + encodeURIComponent('LP3 Dispatching — ' + (r.company_name || r.name || ''));
      row.appendChild(mail);
    }
    actions.appendChild(row);
    body.appendChild(actions);

    /* --- Status / owner / follow-up --- */
    var manage = el('div', 'dsection');
    manage.appendChild(el('h3', null, 'Manage'));
    var controls = el('div', 'controls');

    var statusWrap = el('div');
    statusWrap.appendChild(el('label', null, 'Status'));
    var statusSel = el('select');
    (isCarrier ? CARRIER_STATUSES : LEAD_STATUSES).forEach(function (s) {
      var opt = el('option', null, s);
      opt.value = s;
      if ((r.status || 'new') === s) opt.selected = true;
      statusSel.appendChild(opt);
    });
    statusWrap.appendChild(statusSel);
    controls.appendChild(statusWrap);

    var followWrap = el('div');
    followWrap.appendChild(el('label', null, 'Next follow-up'));
    var followInput = el('input');
    followInput.type = 'date';
    followInput.value = r.next_follow_up || '';
    followWrap.appendChild(followInput);
    controls.appendChild(followWrap);

    manage.appendChild(controls);

    var saveRow = el('div', 'logform__row');
    saveRow.style.marginTop = '.6rem';
    var save = el('button', 'btn btn--sm btn--primary', 'Save changes');
    save.addEventListener('click', function () {
      save.disabled = true;
      api('update', {
        body: {
          reference: summary.reference,
          contactType: data.contactType,
          status: statusSel.value,
          nextFollowUp: followInput.value || ''
        }
      }).then(function () {
        toast('Saved.');
        return refreshAll();
      }).then(function () {
        openContact(summary);
      }).catch(function (e) { toast(e.message, true); })
        .finally(function () { save.disabled = false; });
    });
    saveRow.appendChild(save);
    manage.appendChild(saveRow);
    body.appendChild(manage);

    /* --- Details --- */
    var details = el('div', 'dsection');
    details.appendChild(el('h3', null, 'Details'));
    var facts = el('div', 'facts');

    facts.appendChild(fact('Contact', r.contact_name || r.name));
    facts.appendChild(fact('Phone', r.phone, 'tel:'));
    facts.appendChild(fact('Email', r.email, 'mailto:'));

    if (isCarrier) {
      facts.appendChild(fact('MC / DOT', [r.mc_number, r.dot_number].filter(Boolean).join(' / ')));
      facts.appendChild(fact('Authority age', r.authority_age));
      facts.appendChild(fact('Home base', [r.home_city, r.home_state].filter(Boolean).join(', ')));
      facts.appendChild(fact('Trucks', r.truck_count));
      facts.appendChild(fact('Equipment', (r.equipment || []).join(', ')));
      facts.appendChild(fact('Endorsements', (r.endorsements || []).join(', ')));
      facts.appendChild(fact('Radius', r.operating_radius));
      facts.appendChild(fact('Min rate/mile', r.min_rate_per_mile));
      facts.appendChild(fact('Factoring', r.factoring_company));
      facts.appendChild(fact('Available', r.availability));

      var lanes = fact('Preferred lanes', r.preferred_lanes);
      lanes.className = 'fact fact--wide'; facts.appendChild(lanes);
      var avoid = fact('Avoids', r.avoid_areas);
      avoid.className = 'fact fact--wide'; facts.appendChild(avoid);
      var signed = fact('Signed', r.signature ? r.signature + ' on ' + fmtDate(r.signed_at) : '—');
      signed.className = 'fact fact--wide'; facts.appendChild(signed);
    } else {
      facts.appendChild(fact('Company', r.company_name));
      facts.appendChild(fact('Equipment', r.equipment));
      facts.appendChild(fact('Topic', r.topic));
      facts.appendChild(fact('Source', r.form_type));
    }

    if (r.notes || r.message) {
      var notes = fact('Their notes', r.notes || r.message);
      notes.className = 'fact fact--wide'; facts.appendChild(notes);
    }

    details.appendChild(facts);
    body.appendChild(details);

    /* --- Documents --- */
    if (isCarrier) {
      var docs = el('div', 'dsection');
      docs.appendChild(el('h3', null, 'Carrier packet (' + data.documents.length + ')'));
      if (!data.documents.length) {
        docs.appendChild(el('p', 'muted', 'No documents uploaded yet.'));
      } else {
        var list = el('div', 'docs');
        data.documents.forEach(function (d) {
          var item = el('div', 'doc');
          item.appendChild(el('span', 'doc__cat', d.category));
          item.appendChild(el('span', 'doc__name', d.fileName));
          if (d.link) {
            var a = el('a', null, 'Open');
            a.href = d.link; a.target = '_blank'; a.rel = 'noopener';
            item.appendChild(a);
          } else {
            item.appendChild(el('span', 'muted', 'unavailable'));
          }
          list.appendChild(item);
        });
        docs.appendChild(list);
        docs.appendChild(el('p', 'muted', 'Links expire after one hour.'));
      }
      body.appendChild(docs);

      renderPortalSection(body, data, summary);
      renderLoadsSection(body, data, summary);
      renderPaymentsSection(body, data, summary);
    }

    /* --- Log a communication --- */
    var logSection = el('div', 'dsection');
    logSection.appendChild(el('h3', null, 'Log a communication'));
    var form = el('div', 'logform');

    var kinds = el('div', 'logform__row');
    ['call', 'sms', 'email', 'note'].forEach(function (k) {
      var b = el('button', 'kindbtn' + (state.kind === k ? ' is-on' : ''),
        k === 'sms' ? 'Text' : k.charAt(0).toUpperCase() + k.slice(1));
      b.addEventListener('click', function () {
        state.kind = k;
        Array.prototype.forEach.call(kinds.children, function (c) { c.classList.remove('is-on'); });
        b.classList.add('is-on');
      });
      kinds.appendChild(b);
    });
    form.appendChild(kinds);

    var textarea = el('textarea');
    textarea.placeholder = 'What was said? Anything to remember for next time?';
    form.appendChild(textarea);

    var logRow = el('div', 'logform__row');
    var saveLog = el('button', 'btn btn--sm btn--primary', 'Save to timeline');
    saveLog.addEventListener('click', function () {
      if (!textarea.value.trim()) { toast('Write something first.', true); return; }
      saveLog.disabled = true;
      api('log', {
        body: {
          reference: summary.reference,
          contactType: data.contactType,
          kind: state.kind,
          direction: state.kind === 'note' ? null : 'outbound',
          body: textarea.value
        }
      }).then(function () {
        textarea.value = '';
        toast('Logged.');
        return refreshAll();
      }).then(function () { openContact(summary); })
        .catch(function (e) { toast(e.message, true); })
        .finally(function () { saveLog.disabled = false; });
    });
    logRow.appendChild(saveLog);
    form.appendChild(logRow);
    logSection.appendChild(form);
    body.appendChild(logSection);

    /* --- Timeline --- */
    var timelineSection = el('div', 'dsection');
    timelineSection.appendChild(el('h3', null, 'History (' + data.activities.length + ')'));
    if (!data.activities.length) {
      timelineSection.appendChild(el('p', 'muted', 'Nothing logged yet.'));
    } else {
      var timeline = el('div', 'timeline');
      data.activities.forEach(function (a) {
        var event = el('div', 'event');
        var glyph = { call: '☎', sms: '✉', email: '@', note: '✎', status: '⇄', system: '•' }[a.kind] || '•';
        event.appendChild(el('span', 'event__dot event__dot--' + a.kind, glyph));

        var content = el('div', 'event__body');
        var label = (a.kind === 'sms' ? 'Text' : a.kind.charAt(0).toUpperCase() + a.kind.slice(1));
        content.appendChild(el('span', 'event__meta',
          label + ' · ' + fmtDateTime(a.created_at) + (a.created_by ? ' · ' + a.created_by : '')));
        content.appendChild(el('p', 'event__text', a.body || ''));
        event.appendChild(content);
        timeline.appendChild(event);
      });
      timelineSection.appendChild(timeline);
    }
    body.appendChild(timelineSection);
  }

  function closeDrawer() { $('#drawer').hidden = true; state.current = null; }

  /* ================================================================
     Loading
     ================================================================ */

  function loadContacts() {
    var query = '';
    if (state.view === 'carrier' || state.view === 'lead') query += '&type=' + state.view;
    if (state.search) query += '&q=' + encodeURIComponent(state.search);
    if (state.status) query += '&status=' + encodeURIComponent(state.status);

    return api('contacts', { query: query }).then(function (data) {
      state.contacts = data.contacts || [];
      renderRows();
    });
  }

  function refreshAll() {
    return Promise.all([
      api('stats').then(renderStats).catch(function () {}),
      loadContacts()
    ]).catch(function (e) { toast(e.message, true); });
  }

  /* ================================================================
     Wiring
     ================================================================ */

  function initStatusFilter() {
    var sel = $('#statusFilter');
    var seen = {};
    CARRIER_STATUSES.concat(LEAD_STATUSES).forEach(function (s) {
      if (seen[s]) return;
      seen[s] = true;
      var opt = el('option', null, s);
      opt.value = s;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      state.status = sel.value;
      loadContacts().catch(function (e) { toast(e.message, true); });
    });
  }

  function initControls() {
    var timer;
    $('#search').addEventListener('input', function (e) {
      clearTimeout(timer);
      var value = e.target.value;
      timer = setTimeout(function () {
        state.search = value.trim();
        loadContacts().catch(function (err) { toast(err.message, true); });
      }, 260);
    });

    $('#viewNav').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-view]');
      if (!btn) return;
      state.view = btn.getAttribute('data-view');
      Array.prototype.forEach.call($('#viewNav').children, function (c) { c.classList.remove('is-active'); });
      btn.classList.add('is-active');
      loadContacts().catch(function (err) { toast(err.message, true); });
    });

    $('#refreshBtn').addEventListener('click', function () { refreshAll(); });

    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-close-drawer]')) closeDrawer();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
    });
  }

  function init() {
    initLogin();
    initStatusFilter();
    initControls();

    api('session')
      .then(function (s) {
        if (!s.configured) {
          showGate();
          $('#loginError').textContent = 'ADMIN_PASSWORD is not set on the server yet.';
          return;
        }
        if (s.signedIn) { showApp(); return refreshAll().then(openDeepLink); }
        showGate();
      })
      .catch(function () { showGate(); });
  }

  /**
   * /admin?ref=LP3-… opens straight to that carrier. This is the link stored on
   * the GoHighLevel contact, so "view their packet" is one click from the CRM.
   */
  function openDeepLink() {
    var match = /[?&]ref=([^&]+)/.exec(window.location.search);
    if (!match) return;
    var reference = decodeURIComponent(match[1]);
    var found = state.contacts.filter(function (c) { return c.reference === reference; })[0];
    if (found) { openContact(found); return; }
    // Not in the current view — fetch it directly rather than give up.
    api('contacts', { query: '&q=' + encodeURIComponent(reference) })
      .then(function (data) {
        var hit = (data.contacts || []).filter(function (c) { return c.reference === reference; })[0];
        if (hit) openContact(hit);
        else toast('Could not find ' + reference + '.', true);
      })
      .catch(function (e) { toast(e.message, true); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
