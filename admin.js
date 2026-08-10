/* ==========================================================================
   PK Dispatching — Dispatch Desk

   IMPORTANT: every value that originates from a carrier (company names,
   notes, emails) is written with textContent, never innerHTML. Carriers
   control that text, so innerHTML here would be a stored-XSS hole straight
   into the admin session.
   ========================================================================== */
(function () {
  'use strict';

  var API = '/api/admin';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { view: 'all', search: '', status: '', contacts: [], current: null, kind: 'note' };

  var CARRIER_STATUSES = ['new', 'verifying', 'approved', 'active', 'paused', 'rejected'];
  var LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

  var STATUS_TONE = {
    new: 'new', verifying: 'progress', contacted: 'progress', qualified: 'progress',
    approved: 'good', active: 'good', converted: 'good',
    rejected: 'bad', lost: 'bad', paused: 'idle'
  };

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
          return refreshAll();
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
      mail.href = 'mailto:' + r.email + '?subject=' + encodeURIComponent('PK Dispatching — ' + (r.company_name || r.name || ''));
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
        if (s.signedIn) { showApp(); return refreshAll(); }
        showGate();
      })
      .catch(function () { showGate(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
