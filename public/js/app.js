/* Progressive enhancement only — every form here works without JavaScript.
   The drawer is the one piece of interactivity the sales flow depends on (§103.1). */
(function () {
  'use strict';

  function openDrawer(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    var first = el.querySelector('input:not([type=hidden]), select, textarea, button');
    if (first) first.focus();
  }

  function closeDrawer(el) {
    el.hidden = true;
    document.body.style.overflow = '';
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-drawer]');
    if (opener) {
      e.preventDefault();
      openDrawer(opener.getAttribute('data-drawer'));
      return;
    }
    var closer = e.target.closest('[data-drawer-close]');
    if (closer) {
      e.preventDefault();
      closeDrawer(closer.closest('.drawer-backdrop'));
      return;
    }
    // Clicking the dimmed area closes the drawer.
    if (e.target.classList && e.target.classList.contains('drawer-backdrop')) {
      closeDrawer(e.target);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.drawer-backdrop:not([hidden])').forEach(closeDrawer);
  });

  // §103.10: confirm only for destructive or high-impact actions.
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // The shared complete-action drawer (§113/§114). One drawer serves every row
  // on the page; the clicked row supplies the target and the summary text.
  var quickForm = document.getElementById('quick-form');
  if (quickForm) {
    var nextBlock = document.getElementById('quick-next-block');
    var terminalHint = document.getElementById('quick-terminal-hint');
    var stageSelect = document.getElementById('quick-stageId');
    var actionTypeField = document.getElementById('quick-actiontype-field');

    var syncTerminal = function () {
      var option = stageSelect.options[stageSelect.selectedIndex];
      var terminal = option && option.getAttribute('data-terminal') === '1';
      nextBlock.hidden = terminal;
      terminalHint.hidden = !terminal;
      nextBlock.querySelectorAll('select, input').forEach(function (el) { el.disabled = terminal; });
      document.getElementById('quick-submit').textContent = terminal ? 'Save & close lead' : 'Save & next';
    };
    stageSelect.addEventListener('change', syncTerminal);

    document.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-quick]');
      if (!trigger) return;
      e.preventDefault();

      var mode = trigger.getAttribute('data-quick');
      quickForm.setAttribute('action', trigger.getAttribute('data-action'));
      document.getElementById('quick-heading').textContent =
        mode === 'first-action' ? 'Log first action' : 'Complete follow-up';
      document.getElementById('quick-summary').textContent = trigger.getAttribute('data-summary') || '';
      actionTypeField.hidden = mode !== 'first-action';
      actionTypeField.querySelector('select').disabled = mode !== 'first-action';

      var stageId = trigger.getAttribute('data-stage-id');
      if (stageId) stageSelect.value = stageId;
      stageSelect.dispatchEvent(new Event('change'));
      syncTerminal();

      // Default the next action to tomorrow morning so the common case is one click.
      var dateInput = document.getElementById('quick-nextDate');
      if (!dateInput.value) dateInput.value = isoDate(new Date(Date.now() + 86400000));
      openDrawer('drawer-quick');
    });

    // §21.4: quick date presets. The server still validates the real timestamp.
    quickForm.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-preset]');
      if (!chip) return;
      e.preventDefault();
      var preset = chip.getAttribute('data-preset');
      var days = preset === 'today' ? 0 : Number(preset);
      document.getElementById('quick-nextDate').value = isoDate(new Date(Date.now() + days * 86400000));
      var time = chip.getAttribute('data-preset-time');
      if (time) document.getElementById('quick-nextTime').value = time;
      quickForm.querySelectorAll('[data-preset]').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
    });
  }

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Stage pickers filter their sub-stage list so an invalid pair cannot be sent.
  document.querySelectorAll('[data-substage-for]').forEach(function (select) {
    var stageSelect = document.getElementById(select.getAttribute('data-substage-for'));
    if (!stageSelect) return;
    var sync = function () {
      var stageId = stageSelect.value;
      var visible = 0;
      select.querySelectorAll('option[data-stage]').forEach(function (opt) {
        var match = opt.getAttribute('data-stage') === stageId;
        opt.hidden = !match;
        opt.disabled = !match;
        if (match) visible++;
        if (!match && opt.selected) select.value = '';
      });
      var wrap = select.closest('.field');
      if (wrap) wrap.hidden = visible === 0;
      // §77: a child filter with no parent chosen is not a filter, it is a trap.
      select.disabled = visible === 0;
    };
    stageSelect.addEventListener('change', sync);
    sync();
  });
}());

/* Comma-separated text inputs post as repeated fields, so the server sees the
   same array a multi-select would produce. Marked with data-list-input. */
document.querySelectorAll('input[data-list-input]').forEach(function (input) {
  var form = input.form;
  if (!form) return;
  form.addEventListener('submit', function () {
    var name = input.getAttribute('name');
    var values = input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    input.removeAttribute('name');
    values.forEach(function (value) {
      var hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = name;
      hidden.value = value;
      form.appendChild(hidden);
    });
  });
});

/* Booking form: show only the fields the chosen buyer purpose needs (§117.9). */
(function () {
  var select = document.querySelector('[data-purpose-select]');
  if (!select) return;
  var panels = document.querySelectorAll('[data-purpose-panel]');
  var sync = function () {
    panels.forEach(function (panel) {
      var match = panel.getAttribute('data-purpose-panel') === select.value;
      panel.hidden = !match;
      panel.querySelectorAll('input, select').forEach(function (el) { el.disabled = !match; });
    });
  };
  select.addEventListener('change', sync);
  sync();
}());

/* QR walk-in form: channel-partner fields only when they are relevant (§25.1). */
(function () {
  var select = document.querySelector('[data-cp-select]');
  var panel = document.querySelector('[data-cp-panel]');
  if (!select || !panel) return;
  var sync = function () { panel.hidden = select.value !== 'CHANNEL_PARTNER'; };
  select.addEventListener('change', sync);
  sync();
}());

/* Generic "show these fields only for these values" toggle (V1.1 §10.1, §14.6).
   One handler instead of a function per form. */
(function () {
  var RULES = [
    { select: '[data-temp-mode]', panel: '[data-temp-manual]', show: ['MANUAL'] },
    { select: '[data-funding-select]', panel: '[data-loan-field]', show: ['HOME_LOAN', 'MIXED'] },
    { select: '[data-assign-mode]', panel: '[data-assign-manual]', show: ['MANUAL'] },
    { select: '[data-source-select]', panel: '[data-referral-panel]', show: ['REFERRAL'] },
    { select: '[data-source-select]', panel: '[data-portal-panel]', show: ['PROPERTY_PORTAL'] }
  ];
  RULES.forEach(function (rule) {
    var select = document.querySelector(rule.select);
    var panel = document.querySelector(rule.panel);
    if (!select || !panel) return;
    var sync = function () {
      var value = select.selectedOptions && select.selectedOptions[0]
        ? (select.selectedOptions[0].getAttribute('data-category') || select.value)
        : select.value;
      var on = rule.show.indexOf(value) !== -1;
      panel.hidden = !on;
      panel.querySelectorAll('input, select, textarea').forEach(function (el) { el.disabled = !on; });
    };
    select.addEventListener('change', sync);
    sync();
  });
}());

/* V1.1 §60: copy-to-clipboard for the API console. A developer integrating a
   webhook should never have to hand-select a cURL out of a page. */
document.addEventListener('click', function (e) {
  var block = e.target.closest('[data-copy]');
  if (!block || !navigator.clipboard) return;
  navigator.clipboard.writeText(block.textContent.trim()).then(function () {
    var previous = block.getAttribute('data-copied-label') || 'Copied';
    block.classList.add('copied');
    block.setAttribute('data-label', previous);
    setTimeout(function () { block.classList.remove('copied'); }, 1400);
  });
});

/* V1.1 §35: payment plan milestones. The running total is shown live because
   "must add up to 100%" is a rule people would rather see than be told after
   they press save. The server still enforces it. */
document.querySelectorAll('[data-plan-rows]').forEach(function (wrap) {
  var form = wrap.closest('form');
  var totalEl = form.querySelector('[data-plan-total]');

  var retotal = function () {
    var sum = 0;
    wrap.querySelectorAll('[data-plan-pct]').forEach(function (input) {
      var value = parseFloat(input.value);
      if (!isNaN(value)) sum += value;
    });
    if (!totalEl) return;
    totalEl.textContent = Math.round(sum * 100) / 100;
    totalEl.style.color = Math.abs(sum - 100) < 0.005 ? 'var(--success)' : 'var(--warn)';
  };

  form.addEventListener('input', retotal);
  form.addEventListener('click', function (e) {
    if (e.target.closest('[data-plan-add]')) {
      e.preventDefault();
      var last = wrap.querySelector('.plan-row');
      var row = last.cloneNode(true);
      row.querySelectorAll('input').forEach(function (i) { if (i.type !== 'hidden') i.value = ''; });
      wrap.appendChild(row);
      retotal();
    }
    if (e.target.closest('[data-plan-remove]')) {
      e.preventDefault();
      if (wrap.querySelectorAll('.plan-row').length > 1) e.target.closest('.plan-row').remove();
      retotal();
    }
  });
  retotal();
});

/* V1.1 §8.2: live duplicate lookup on the capture form. Telling the user the
   customer already exists *before* they fill the rest of the form is the whole
   point — the server still refuses a duplicate either way. */
(function () {
  var input = document.querySelector('[data-dup-mobile]');
  var notice = document.querySelector('[data-dup-notice]');
  if (!input || !notice || !window.fetch) return;
  var project = document.getElementById('projectId');
  var timer = null;

  var check = function () {
    var mobile = input.value.trim();
    if (mobile.replace(/\D/g, '').length < 6) { notice.hidden = true; return; }
    var url = '/api/contacts/lookup?mobile=' + encodeURIComponent(mobile)
      + (project && project.value ? '&projectId=' + encodeURIComponent(project.value) : '');
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.found) { notice.hidden = true; return; }
        var head = '<strong>Existing contact found</strong> — ' + data.displayName
          + ' · ' + data.leadCount + ' previous inquir' + (data.leadCount === 1 ? 'y' : 'ies');
        var tail = '';
        if (data.kind === 'ACTIVE_SAME_PROJECT') {
          tail = '<div>An active lead already exists for this customer and project. '
            + '<a href="/app/leads/' + data.lead.id + '">Open it</a>, or save to record a re-inquiry.</div>';
        } else if (data.kind === 'LOST_SAME_PROJECT') {
          tail = '<div>This customer was marked lost on this project. Saving will offer to reopen it.</div>';
        } else if (data.bookedHere) {
          tail = '<div>This customer has already booked here — this will be recorded as a new purchase inquiry.</div>';
        } else {
          tail = '<div>Their details will be reused. No duplicate contact is created.</div>';
        }
        notice.innerHTML = head + tail;
        notice.hidden = false;
      })
      .catch(function () { notice.hidden = true; });
  };

  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(check, 350); });
  input.addEventListener('blur', check);
  if (project) project.addEventListener('change', check);
  if (input.value) check();
}());

/* V1.1 §70: rotation order. Move buttons rather than drag-and-drop — they work
   with a keyboard, on a touch screen, and in a screen reader, and the hidden
   inputs post in list order either way. */
document.querySelectorAll('[data-reorder]').forEach(function (form) {
  form.addEventListener('click', function (e) {
    var button = e.target.closest('[data-move]');
    if (!button) return;
    e.preventDefault();
    var item = button.closest('li');
    var sibling = button.getAttribute('data-move') === 'up'
      ? item.previousElementSibling
      : item.nextElementSibling;
    if (!sibling) return;
    if (button.getAttribute('data-move') === 'up') item.parentNode.insertBefore(item, sibling);
    else item.parentNode.insertBefore(sibling, item);
    button.focus();
  });
});

/* V1.1 §5: dashboard lookup. Exact mobile answers "do we already know them and
   who owns them" while the customer is still on the phone. Without JS the form
   simply submits to the full search page. */
(function () {
  var form = document.querySelector('[data-quick-search]');
  if (!form || !window.fetch) return;
  var input = form.querySelector('input[name=q]');
  var box = form.querySelector('[data-qs-results]');
  var timer = null;
  var lastQuery = '';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var render = function (data) {
    if (!data.results.length) {
      box.innerHTML = data.createLeadHref
        ? '<div class="qs-empty">No customer found with that mobile number.'
          + '<a class="btn btn-sm btn-primary" href="' + esc(data.createLeadHref) + '">Create new lead</a></div>'
        : '<div class="qs-empty">Nothing found.</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = data.results.map(function (r) {
      // §5.6: an out-of-scope lead shows ownership and nothing else.
      if (r.access === 'OWNERSHIP_ONLY') {
        return '<div class="qs-row is-locked">'
          + '<div class="qs-main"><strong>' + esc(r.contactName) + '</strong>'
          + (r.projectName ? ' · ' + esc(r.projectName) : '')
          + '<div class="t-sub">Owner: ' + esc(r.owner ? r.owner.name : 'Unassigned')
          + (r.stage ? ' · ' + esc(r.stage) : '') + '</div>'
          + '<div class="t-sub">This lead belongs to another sales user.</div></div></div>';
      }
      var badges = (r.isNew ? '<span class="badge b-blue pulse-new"><span class="dot"></span> New</span>' : '')
        + (r.temperature ? '<span class="badge ' + ({ HOT: 'b-red', WARM: 'b-amber', COLD: 'b-slate' }[r.temperature] || 'b-slate') + '">' + esc(r.temperature) + '</span>' : '')
        + (r.reinquiry ? '<span class="badge b-amber">Re-inquiry</span>' : '');
      return '<a class="qs-row" href="/app/leads/' + esc(r.leadId) + '">'
        + '<div class="qs-main"><strong>' + esc(r.contactName) + '</strong> ' + badges
        + '<div class="t-sub">' + esc(r.mobile)
        + (r.projectName ? ' · ' + esc(r.projectName) : '')
        + (r.stage ? ' · ' + esc(r.stage) + (r.subStage ? ' / ' + esc(r.subStage) : '') : '') + '</div>'
        + '<div class="t-sub">Owner: ' + esc(r.owner ? r.owner.name : 'Unassigned') + '</div></div>'
        + '<span class="btn btn-sm">Open lead</span></a>';
    }).join('');
    box.hidden = false;
  };

  var run = function () {
    var q = input.value.trim();
    var digits = q.replace(/\D/g, '');
    // §5.3: mobile after 4 digits, text after 2 characters.
    if (digits.length >= 4 ? false : q.length < 2) { box.hidden = true; return; }
    if (q === lastQuery) return;
    lastQuery = q;
    fetch('/api/search?q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data) render(data); })
      .catch(function () { box.hidden = true; });
  };

  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 300); // §5.3 debounce
  });
  document.addEventListener('click', function (e) {
    if (!form.contains(e.target)) box.hidden = true;
  });
}());
