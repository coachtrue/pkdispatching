/* ==========================================================================
   PK Dispatching — landing page behavior
   Handles: nav, multi-step express onboarding, carrier packet uploads,
            validation, form submission, modals, toasts.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     CONFIG — edit this block to wire the forms to your backend.
     Leave endpoints empty ('') and the site still works: submissions
     fall back to opening a pre-filled email to FALLBACK_EMAIL.
     ------------------------------------------------------------------ */
  var CONFIG = {
    // JSON endpoint for the short lead forms (hero + contact).
    leadEndpoint: '/api/leads',
    // Multipart endpoint for express onboarding (fields + document uploads).
    onboardEndpoint: '/api/onboarding',
    // Used when an endpoint is unavailable or not configured.
    fallbackEmail: 'dispatch@pkdispatching.com',
    packetEmail: 'packets@pkdispatching.com',
    phone: '(555) 555-0123',
    maxFileBytes: 15 * 1024 * 1024, // 15 MB per file
    allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx', 'webp']
  };

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

  /* ==================================================================
     Small utilities
     ================================================================== */

  function toast(message, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('toast--error', !!isError);
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('is-visible'); });
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.classList.remove('is-visible');
      setTimeout(function () { el.hidden = true; }, 250);
    }, isError ? 6000 : 4000);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function extensionOf(name) {
    var parts = String(name).split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value).trim());
  }

  function isValidPhone(value) {
    var digits = String(value).replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  }

  function referenceNumber() {
    var now = new Date();
    var stamp = String(now.getFullYear()).slice(2) +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    var rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return 'PK-' + stamp + '-' + rand;
  }

  /* ==================================================================
     Validation
     ================================================================== */

  function setFieldError(input, message) {
    var slot = input.id ? $('[data-err-for="' + input.id + '"]') : null;
    if (message) {
      input.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      if (slot) slot.textContent = message;
    } else {
      input.classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
      if (slot) slot.textContent = '';
    }
  }

  function validateInput(input) {
    var value = (input.value || '').trim();
    var label = (input.previousElementSibling && input.previousElementSibling.textContent || 'This field')
      .replace(/\*/g, '').replace(/\(optional\)/i, '').trim();

    if (input.required && !value) {
      setFieldError(input, label + ' is required.');
      return false;
    }
    if (value && input.type === 'email' && !isValidEmail(value)) {
      setFieldError(input, 'Enter a valid email address.');
      return false;
    }
    if (value && input.type === 'tel' && !isValidPhone(value)) {
      setFieldError(input, 'Enter a valid phone number (10+ digits).');
      return false;
    }
    if (value && input.type === 'number') {
      var num = Number(value);
      var min = input.min !== '' ? Number(input.min) : null;
      var max = input.max !== '' ? Number(input.max) : null;
      if (isNaN(num) || (min !== null && num < min) || (max !== null && num > max)) {
        setFieldError(input, 'Enter a number between ' + (min || 1) + ' and ' + (max || 500) + '.');
        return false;
      }
    }
    setFieldError(input, '');
    return true;
  }

  function validateScope(scope) {
    var inputs = $$('input:not([type="checkbox"]):not([type="hidden"]), select, textarea', scope)
      .filter(function (el) { return !el.classList.contains('hp-field') && el.offsetParent !== null; });
    var ok = true;
    var firstBad = null;
    // Validate every field so each one gets its own message, not just the first.
    inputs.forEach(function (input) {
      if (!validateInput(input)) {
        ok = false;
        if (!firstBad) firstBad = input;
      }
    });
    if (firstBad) {
      firstBad.focus({ preventScroll: true });
      firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return ok;
  }

  /* ==================================================================
     Header / navigation
     ================================================================== */

  function initHeader() {
    var header = $('#siteHeader');
    var nav = $('#nav');
    var toggle = $('#navToggle');

    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        var open = nav.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', String(open));
      });
      nav.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') {
          nav.classList.remove('is-open');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    }

    if (header) {
      var onScroll = function () {
        header.classList.toggle('is-stuck', window.scrollY > 8);
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    // Scroll spy
    var sections = $$('main section[id]');
    var links = $$('.nav a[href^="#"]');
    if ('IntersectionObserver' in window && sections.length) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (link) {
            link.classList.toggle('is-current', link.getAttribute('href') === '#' + entry.target.id);
          });
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      sections.forEach(function (s) { observer.observe(s); });
    }
  }

  /* ==================================================================
     State dropdown
     ================================================================== */

  function initStates() {
    var select = $('#o_state');
    if (!select) return;
    US_STATES.forEach(function (code) {
      var opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code;
      select.appendChild(opt);
    });
  }

  /* ==================================================================
     Carrier packet uploads
     ================================================================== */

  var fileStore = {}; // { docKey: [File, ...] }

  function syncInput(input, files) {
    // Keep the real <input type="file"> in sync so a native multipart POST
    // carries exactly the files shown in the UI.
    try {
      var dt = new DataTransfer();
      files.forEach(function (f) { dt.items.add(f); });
      input.files = dt.files;
    } catch (e) {
      /* DataTransfer unsupported — FormData is built from fileStore instead. */
    }
  }

  function totalFileCount() {
    return Object.keys(fileStore).reduce(function (sum, key) { return sum + fileStore[key].length; }, 0);
  }

  function totalFileBytes() {
    return Object.keys(fileStore).reduce(function (sum, key) {
      return sum + fileStore[key].reduce(function (s, f) { return s + f.size; }, 0);
    }, 0);
  }

  function updateUploadSummary() {
    var el = $('#uploadSummary');
    if (!el) return;
    var count = totalFileCount();
    if (!count) {
      el.textContent = 'No files added yet. You can still submit — we\'ll follow up for anything missing.';
      return;
    }
    var required = ['authority', 'insurance', 'w9'];
    var missing = required.filter(function (key) { return !(fileStore[key] && fileStore[key].length); });
    var base = count + (count === 1 ? ' file' : ' files') + ' ready (' + formatBytes(totalFileBytes()) + ').';
    el.textContent = missing.length
      ? base + ' Still missing: ' + missing.map(labelForDoc).join(', ') + '.'
      : base + ' All required documents attached — you\'re set for express approval.';
  }

  function labelForDoc(key) {
    return ({
      authority: 'MC Authority Letter',
      insurance: 'Certificate of Insurance',
      w9: 'W-9',
      noa: 'Notice of Assignment',
      cdl: 'CDL & Medical Card',
      other: 'Other documents'
    })[key] || key;
  }

  function renderFileList(docKey) {
    var list = $('[data-files="' + docKey + '"]');
    if (!list) return;
    list.innerHTML = '';
    (fileStore[docKey] || []).forEach(function (file, index) {
      var li = document.createElement('li');
      li.className = 'fileitem';

      var icon = document.createElement('span');
      icon.className = 'fileitem__icon';
      icon.textContent = (extensionOf(file.name) || 'FILE').slice(0, 4).toUpperCase();

      var name = document.createElement('span');
      name.className = 'fileitem__name';
      name.textContent = file.name;
      name.title = file.name;

      var size = document.createElement('span');
      size.className = 'fileitem__size';
      size.textContent = formatBytes(file.size);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'fileitem__remove';
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      remove.innerHTML = '&times;';
      remove.addEventListener('click', function () {
        fileStore[docKey].splice(index, 1);
        var input = $('.upload[data-doc="' + docKey + '"] input[type="file"]');
        if (input) syncInput(input, fileStore[docKey]);
        renderFileList(docKey);
        updateUploadSummary();
      });

      li.appendChild(icon);
      li.appendChild(name);
      li.appendChild(size);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  function addFiles(docKey, input, fileList) {
    fileStore[docKey] = fileStore[docKey] || [];
    var rejected = [];

    Array.prototype.forEach.call(fileList, function (file) {
      var ext = extensionOf(file.name);
      if (CONFIG.allowedExtensions.indexOf(ext) === -1) {
        rejected.push(file.name + ' — unsupported file type');
        return;
      }
      if (file.size > CONFIG.maxFileBytes) {
        rejected.push(file.name + ' — over ' + formatBytes(CONFIG.maxFileBytes));
        return;
      }
      var duplicate = fileStore[docKey].some(function (f) {
        return f.name === file.name && f.size === file.size;
      });
      if (duplicate) return;
      fileStore[docKey].push(file);
    });

    syncInput(input, fileStore[docKey]);
    renderFileList(docKey);
    updateUploadSummary();

    if (rejected.length) {
      toast('Could not add: ' + rejected.join('; '), true);
    } else if (fileStore[docKey].length) {
      toast(labelForDoc(docKey) + ' attached.');
    }
  }

  function initUploads() {
    $$('.upload').forEach(function (upload) {
      var docKey = upload.getAttribute('data-doc');
      var input = $('input[type="file"]', upload);
      var zone = $('.dropzone', upload);
      if (!input || !zone) return;

      fileStore[docKey] = [];

      input.addEventListener('change', function () {
        if (input.files && input.files.length) {
          // Snapshot before syncInput() rewrites input.files.
          var picked = Array.prototype.slice.call(input.files);
          addFiles(docKey, input, picked);
        }
      });

      ['dragenter', 'dragover'].forEach(function (type) {
        zone.addEventListener(type, function (e) {
          e.preventDefault(); e.stopPropagation();
          zone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (type) {
        zone.addEventListener(type, function (e) {
          e.preventDefault(); e.stopPropagation();
          zone.classList.remove('is-dragover');
        });
      });
      zone.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          addFiles(docKey, input, e.dataTransfer.files);
        }
      });
      zone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
      });
    });

    // Stop the page from opening a dropped file in a new tab.
    ['dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (e) {
        if (e.target.closest && e.target.closest('.dropzone')) return;
        e.preventDefault();
      });
    });

    updateUploadSummary();
  }

  /* ==================================================================
     Multi-step onboarding
     ================================================================== */

  var currentStep = 1;
  var TOTAL_STEPS = 4;

  function showStep(step) {
    currentStep = step;
    $$('.fs[data-panel]').forEach(function (panel) {
      panel.hidden = Number(panel.getAttribute('data-panel')) !== step;
    });
    $$('.progress__step').forEach(function (node) {
      var n = Number(node.getAttribute('data-step'));
      node.classList.toggle('is-active', n === step);
      node.classList.toggle('is-done', n < step);
    });
    var onboard = $('.onboard');
    if (onboard) {
      var top = onboard.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: top, behavior: 'smooth' });
    }
  }

  function validateStep(step) {
    var panel = $('.fs[data-panel="' + step + '"]');
    if (!panel) return true;

    var ok = validateScope(panel);

    if (step === 2) {
      var equipChecked = $$('input[name="equipment"]:checked', panel).length > 0;
      var slot = $('[data-err-for="equipment"]');
      if (slot) slot.textContent = equipChecked ? '' : 'Select at least one equipment type.';
      if (!equipChecked) ok = false;
    }

    if (step === 4) {
      var consents = $$('.consents input[type="checkbox"]');
      var allAgreed = consents.every(function (c) { return c.checked; });
      var cSlot = $('[data-err-for="consents"]');
      if (cSlot) cSlot.textContent = allAgreed ? '' : 'Please accept all three items to continue.';
      if (!allAgreed) ok = false;
    }

    return ok;
  }

  function collectOnboarding() {
    var form = $('#onboardForm');
    var data = {};
    $$('input, select, textarea', form).forEach(function (el) {
      if (el.type === 'file' || el.classList.contains('hp-field')) return;
      if (el.type === 'checkbox') {
        if (!el.checked) return;
        if (el.name === 'equipment' || el.name === 'endorsements') {
          data[el.name] = data[el.name] || [];
          data[el.name].push(el.value);
        } else {
          data[el.name] = true;
        }
      } else if (el.name) {
        data[el.name] = el.value.trim();
      }
    });
    return data;
  }

  function buildReview() {
    var review = $('#review');
    if (!review) return;
    var d = collectOnboarding();

    var docsAttached = Object.keys(fileStore)
      .filter(function (k) { return fileStore[k].length; })
      .map(function (k) { return labelForDoc(k) + ' (' + fileStore[k].length + ')'; })
      .join(', ');

    var rows = [
      ['Company', d.companyName + (d.dba ? ' (dba ' + d.dba + ')' : '')],
      ['Contact', d.contactName + (d.role ? ' — ' + d.role : '')],
      ['Phone', d.phone],
      ['Email', d.email],
      ['MC / DOT', [d.mcNumber, d.dotNumber].filter(Boolean).join(' / ')],
      ['Authority age', d.authorityAge],
      ['Home base', [d.homeCity, d.homeState].filter(Boolean).join(', ')],
      ['Trucks', d.truckCount],
      ['Equipment', (d.equipment || []).join(', ')],
      ['Endorsements', (d.endorsements || []).join(', ')],
      ['Operating radius', d.radius],
      ['Minimum rate/mile', d.minRpm],
      ['Preferred lanes', d.preferredLanes],
      ['Avoids', d.avoidAreas],
      ['Factoring', d.factoringCompany],
      ['Available', d.startDate],
      ['Documents attached', docsAttached]
    ];

    review.innerHTML = '';
    rows.forEach(function (pair) {
      var wide = ['Preferred lanes', 'Avoids', 'Equipment', 'Endorsements', 'Documents attached'].indexOf(pair[0]) !== -1;
      var div = document.createElement('div');
      div.className = 'review__row' + (wide ? ' review__row--full' : '');
      var label = document.createElement('span');
      label.className = 'review__label';
      label.textContent = pair[0];
      var value = document.createElement('span');
      var hasValue = pair[1] !== undefined && pair[1] !== null && String(pair[1]).trim() !== '';
      value.className = 'review__value' + (hasValue ? '' : ' review__value--muted');
      value.textContent = hasValue ? pair[1] : 'Not provided';
      div.appendChild(label);
      div.appendChild(value);
      review.appendChild(div);
    });
  }

  function initOnboarding() {
    var form = $('#onboardForm');
    if (!form) return;

    $$('[data-next]', form).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = Number(btn.getAttribute('data-next'));
        if (!validateStep(currentStep)) {
          toast('Please fix the highlighted fields.', true);
          return;
        }
        if (next === 4) buildReview();
        showStep(Math.min(next, TOTAL_STEPS));
      });
    });

    $$('[data-prev]', form).forEach(function (btn) {
      btn.addEventListener('click', function () {
        showStep(Math.max(Number(btn.getAttribute('data-prev')), 1));
      });
    });

    // Let clicking a completed progress step jump back.
    $$('.progress__step').forEach(function (node) {
      node.addEventListener('click', function () {
        var target = Number(node.getAttribute('data-step'));
        if (target < currentStep) showStep(target);
      });
    });

    // Live-clear errors as the user types.
    $$('input, select, textarea', form).forEach(function (el) {
      el.addEventListener('input', function () {
        if (el.classList.contains('is-invalid')) validateInput(el);
      });
      el.addEventListener('blur', function () {
        if (el.value.trim() || el.required) validateInput(el);
      });
    });

    $$('.consents input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var slot = $('[data-err-for="consents"]');
        if (slot && $$('.consents input[type="checkbox"]').every(function (c) { return c.checked; })) {
          slot.textContent = '';
        }
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.querySelector('.hp-field').value) return; // bot
      if (!validateStep(4)) { toast('Please complete the required items.', true); return; }

      // Re-validate every earlier step so nothing slips through.
      for (var s = 1; s <= 3; s++) {
        if (!validateStep(s)) {
          showStep(s);
          toast('Something on step ' + s + ' still needs attention.', true);
          return;
        }
      }

      submitOnboarding(form);
    });

    var again = $('#submitAnother');
    if (again) {
      again.addEventListener('click', function () {
        form.reset();
        Object.keys(fileStore).forEach(function (key) {
          fileStore[key] = [];
          renderFileList(key);
        });
        updateUploadSummary();
        $('#onboardSuccess').hidden = true;
        form.hidden = false;
        $('#progress').hidden = false;
        showStep(1);
      });
    }
  }

  function submitOnboarding(form) {
    var button = form.querySelector('button[type="submit"]');
    button.classList.add('is-loading');
    button.querySelector('.btn__label').textContent = 'Submitting…';

    var data = collectOnboarding();
    var ref = referenceNumber();

    var payload = new FormData();
    payload.append('reference', ref);
    payload.append('submittedAt', new Date().toISOString());
    payload.append('formType', 'express-onboarding');
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      payload.append(key, Array.isArray(value) ? value.join(', ') : value);
    });
    Object.keys(fileStore).forEach(function (docKey) {
      fileStore[docKey].forEach(function (file) {
        payload.append('doc_' + docKey, file, file.name);
      });
    });
    payload.append('documentCount', String(totalFileCount()));

    post(CONFIG.onboardEndpoint, payload)
      .then(function (result) {
        $('#refNumber').textContent = (result && result.reference) || ref;
        form.hidden = true;
        $('#progress').hidden = true;
        var success = $('#onboardSuccess');
        success.hidden = false;
        success.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
      .catch(function () {
        // No backend reachable — hand the carrier a working manual path.
        emailFallback('Express Onboarding — ' + (data.companyName || 'New Carrier') + ' (' + ref + ')', data, ref, true);
        toast('We couldn\'t reach the server. We opened an email with your details — attach your documents and send it, or call ' + CONFIG.phone + '.', true);
      })
      .finally(function () {
        button.classList.remove('is-loading');
        button.querySelector('.btn__label').textContent = 'Submit & Get Dispatched';
      });
  }

  /* ==================================================================
     Short lead forms (hero + contact)
     ================================================================== */

  function initLeadForm(formId, successId, formType) {
    var form = $('#' + formId);
    if (!form) return;

    $$('input, select, textarea', form).forEach(function (el) {
      el.addEventListener('input', function () {
        if (el.classList.contains('is-invalid')) validateInput(el);
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.querySelector('.hp-field').value) return; // bot
      if (!validateScope(form)) { toast('Please fix the highlighted fields.', true); return; }

      var button = form.querySelector('button[type="submit"]');
      var label = button.querySelector('.btn__label');
      var original = label.textContent;
      button.classList.add('is-loading');
      label.textContent = 'Sending…';

      var data = { formType: formType, submittedAt: new Date().toISOString() };
      $$('input, select, textarea', form).forEach(function (el) {
        if (el.name && !el.classList.contains('hp-field')) data[el.name] = el.value.trim();
      });

      post(CONFIG.leadEndpoint, JSON.stringify(data), true)
        .then(function () {
          form.hidden = true;
          var success = $('#' + successId);
          success.hidden = false;
          success.scrollIntoView({ behavior: 'smooth', block: 'center' });
        })
        .catch(function () {
          emailFallback(
            formType === 'contact' ? 'Website inquiry' : 'Call back request',
            data, null, false
          );
          toast('We couldn\'t reach the server, so we opened an email instead. You can also call ' + CONFIG.phone + '.', true);
        })
        .finally(function () {
          button.classList.remove('is-loading');
          label.textContent = original;
        });
    });
  }

  /* ==================================================================
     Transport + fallback
     ================================================================== */

  function post(endpoint, body, isJson) {
    if (!endpoint) return Promise.reject(new Error('No endpoint configured'));

    var options = { method: 'POST', body: body };
    if (isJson) options.headers = { 'Content-Type': 'application/json' };

    return fetch(endpoint, options).then(function (response) {
      if (!response.ok) throw new Error('Request failed: ' + response.status);
      return response.json().catch(function () { return {}; });
    });
  }

  function emailFallback(subject, data, ref, isPacket) {
    var lines = [];
    if (ref) lines.push('Reference: ' + ref, '');
    Object.keys(data).forEach(function (key) {
      if (key === 'formType' || key === 'submittedAt') return;
      var value = Array.isArray(data[key]) ? data[key].join(', ') : data[key];
      if (value === true) value = 'Yes';
      if (!value) return;
      lines.push(prettyKey(key) + ': ' + value);
    });
    if (isPacket) {
      var attached = Object.keys(fileStore).filter(function (k) { return fileStore[k].length; });
      lines.push('', 'IMPORTANT: please attach your documents to this email before sending —');
      lines.push(attached.length
        ? attached.map(function (k) { return '  • ' + labelForDoc(k); }).join('\n')
        : '  • MC Authority Letter\n  • Certificate of Insurance\n  • W-9');
    }
    var to = isPacket ? CONFIG.packetEmail : CONFIG.fallbackEmail;
    var href = 'mailto:' + to +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(lines.join('\n'));
    window.location.href = href;
  }

  function prettyKey(key) {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, function (c) { return c.toUpperCase(); })
      .replace(/\bMc\b/, 'MC')
      .replace(/\bDot\b/, 'DOT')
      .replace(/\bRpm\b/, 'RPM');
  }

  /* ==================================================================
     Modal (terms / privacy)
     ================================================================== */

  var MODAL_CONTENT = {
    terms: {
      title: 'Terms of Service',
      html: [
        '<p><strong>Last updated:</strong> ' + new Date().getFullYear() + '. This summary describes how PK Dispatching works with carriers. Your signed dispatch agreement is the controlling document.</p>',
        '<h3>1. What we are</h3>',
        '<p>PK Dispatching is a dispatch service acting as an agent of the carrier under the carrier\'s own operating authority. We are not a motor carrier, freight broker, or freight forwarder, and we do not take possession of freight or assume carrier liability.</p>',
        '<h3>2. Carrier responsibilities</h3>',
        '<ul><li>Maintain active FMCSA operating authority and required insurance.</li><li>Provide accurate, current documents and notify us of any lapse or change.</li><li>Comply with all DOT, FMCSA, and state safety and hours-of-service regulations.</li><li>Communicate load status, delays, and delivery paperwork promptly.</li></ul>',
        '<h3>3. Our responsibilities</h3>',
        '<ul><li>Source and negotiate freight, subject to carrier approval of every load.</li><li>Submit carrier packets to brokers and shippers on the carrier\'s behalf.</li><li>Assemble and submit invoice packets to the carrier\'s factor or the broker.</li><li>Pursue accessorial charges including detention, layover, TONU, and lumpers.</li></ul>',
        '<h3>4. Fees</h3>',
        '<p>Fees are set out in the signed dispatch agreement. There is no setup fee. No fee is owed on loads the carrier sources independently, or on loads cancelled prior to pickup.</p>',
        '<h3>5. Term and cancellation</h3>',
        '<p>Service is month to month. Either party may cancel with 30 days\' written notice. Loads already booked will be dispatched and invoiced through completion.</p>',
        '<h3>6. Payment risk</h3>',
        '<p>We screen broker credit before booking, but a dispatch service does not guarantee broker payment. Collection risk remains with the carrier.</p>',
        '<h3>7. Limitation of liability</h3>',
        '<p>Our aggregate liability is limited to the dispatch fees paid in the three months preceding a claim. We are not liable for cargo loss, damage, or consequential damages.</p>',
        '<p class="fineprint">This page is a plain-language summary and is not legal advice. Have your dispatch agreement reviewed by your own counsel before signing.</p>'
      ].join('')
    },
    privacy: {
      title: 'Privacy Policy',
      html: [
        '<p><strong>Last updated:</strong> ' + new Date().getFullYear() + '.</p>',
        '<h3>What we collect</h3>',
        '<p>Contact details, company and authority information (MC/USDOT), equipment and lane preferences, and the carrier packet documents you upload — authority letters, certificates of insurance, W-9s, notices of assignment, and driver credentials.</p>',
        '<h3>Why we collect it</h3>',
        '<ul><li>To verify your authority and insurance status.</li><li>To set you up with brokers and shippers so loads can be booked.</li><li>To submit invoices and supporting paperwork for payment.</li><li>To contact you about loads and your account.</li></ul>',
        '<h3>Who we share it with</h3>',
        '<p>Brokers, shippers, and your factoring company, strictly for the purpose of booking and settling your freight. We do not sell your information or share it with advertisers.</p>',
        '<h3>How it\'s protected</h3>',
        '<p>Documents are transmitted over an encrypted connection and stored with access limited to dispatch staff working your account.</p>',
        '<h3>Your choices</h3>',
        '<p>You may request a copy of your data, ask us to correct it, or ask us to delete it after your account is closed and outstanding invoices are settled. Reply STOP to any text message to opt out of SMS.</p>',
        '<h3>Contact</h3>',
        '<p>Questions about privacy: <a href="mailto:' + CONFIG.fallbackEmail + '">' + CONFIG.fallbackEmail + '</a>.</p>'
      ].join('')
    }
  };

  function initModal() {
    var modal = $('#modal');
    if (!modal) return;
    var titleEl = $('#modalTitle');
    var bodyEl = $('#modalBody');
    var lastFocused = null;

    function open(key) {
      var content = MODAL_CONTENT[key];
      if (!content) return;
      lastFocused = document.activeElement;
      titleEl.textContent = content.title;
      bodyEl.innerHTML = content.html;
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      $('.modal__close', modal).focus();
    }

    function close() {
      modal.hidden = true;
      document.body.style.overflow = '';
      if (lastFocused) lastFocused.focus();
    }

    document.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-modal]');
      if (trigger) {
        e.preventDefault();
        open(trigger.getAttribute('data-modal'));
        return;
      }
      if (e.target.closest('[data-close]')) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  /* ==================================================================
     Boot
     ================================================================== */

  function init() {
    var year = $('#year');
    if (year) year.textContent = new Date().getFullYear();

    var signDate = $('#signDate');
    if (signDate) {
      signDate.textContent = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
    }

    initHeader();
    initStates();
    initUploads();
    initOnboarding();
    initModal();
    initLeadForm('quickForm', 'quickSuccess', 'quick-callback');
    initLeadForm('contactForm', 'contactSuccess', 'contact');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
