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

  /* V2 §161: the collection drawer. Same one-drawer-many-rows shape as above.
     Two things change what it shows: the chosen outcome (promise fields) and
     whether the booking still owes money (next action). */
  var collectForm = document.getElementById('collect-form');
  if (collectForm) {
    var outcomeSelect = document.getElementById('collect-outcome');
    var promiseBlock = document.getElementById('collect-promise-block');
    var collectNext = document.getElementById('collect-next-block');
    var paidHint = document.getElementById('collect-paid-hint');
    var outstanding = 1;

    var syncPromise = function () {
      var isPromise = outcomeSelect.value === 'PROMISE_TO_PAY';
      promiseBlock.hidden = !isPromise;
      promiseBlock.querySelectorAll('input').forEach(function (el) { el.disabled = !isPromise; });
      if (isPromise && !document.getElementById('collect-promisedDate').value) {
        document.getElementById('collect-promisedDate').value = isoDate(new Date(Date.now() + 3 * 86400000));
      }
    };
    var syncOutstanding = function () {
      var settled = outstanding <= 0;
      collectNext.hidden = settled;
      paidHint.hidden = !settled;
      collectNext.querySelectorAll('select, input').forEach(function (el) { el.disabled = settled; });
      document.getElementById('collect-submit').textContent = settled ? 'Save' : 'Save & next';
    };
    outcomeSelect.addEventListener('change', syncPromise);

    document.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-collect]');
      if (!trigger) return;
      e.preventDefault();
      collectForm.setAttribute('action', trigger.getAttribute('data-action'));
      document.getElementById('collect-summary').textContent = trigger.getAttribute('data-summary') || '';
      outstanding = Number(trigger.getAttribute('data-outstanding') || 1);
      var dateInput = document.getElementById('collect-nextDate');
      if (!dateInput.value) dateInput.value = isoDate(new Date(Date.now() + 86400000));
      syncPromise();
      syncOutstanding();
      openDrawer('drawer-collect');
    });

    collectForm.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-cpreset]');
      if (!chip) return;
      e.preventDefault();
      var preset = chip.getAttribute('data-cpreset');
      var days = preset === 'today' ? 0 : Number(preset);
      document.getElementById('collect-nextDate').value = isoDate(new Date(Date.now() + days * 86400000));
      var time = chip.getAttribute('data-cpreset-time');
      if (time) document.getElementById('collect-nextTime').value = time;
      collectForm.querySelectorAll('[data-cpreset]').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
    });
  }

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* V2 §119: company fields only matter for a company applicant. Hidden, not
     removed — with JS off every field stays visible and the form still works. */
  document.querySelectorAll('[data-company-fields]').forEach(function (block) {
    var form = block.closest('form');
    var typeSelect = form && form.querySelector('[name="primary[type]"]');
    if (!typeSelect) return;
    var sync = function () { block.hidden = typeSelect.value !== 'COMPANY'; };
    typeSelect.addEventListener('change', sync);
    sync();
  });

  /* The channel-partner wizard asks for the type and the legal name on the same
     step, because the server refuses a company without one. Required only while
     it is showing, so an individual applicant is never blocked by it. */
  document.querySelectorAll('[data-company-only]').forEach(function (block) {
    var typeSelect = document.getElementById('partnerTypeSelect');
    if (!typeSelect) return;
    var input = block.querySelector('input, select, textarea');
    var sync = function () {
      var isCompany = typeSelect.value === 'COMPANY';
      block.hidden = !isCompany;
      if (input) input.required = isCompany;
    };
    typeSelect.addEventListener('change', sync);
    sync();
  });

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

/* Back links return to the list the user actually came from — with its filters
   still applied — and fall back to the plain href when they arrived any other
   way (a bookmark, a new tab, a link from outside). */
(function () {
  document.querySelectorAll('[data-back]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var ref = document.referrer;
      if (!ref || history.length < 2) return;
      var sameOrigin = ref.indexOf(window.location.origin + '/app/') === 0;
      // Only step back when the previous page was the list this link points at.
      if (sameOrigin && ref.indexOf(link.getAttribute('href')) === (window.location.origin).length) {
        e.preventDefault();
        history.back();
      }
    });
  });
}());

/* Mobile numbers: warn about the wrong length for the country actually chosen,
   before the form is submitted. The server validates the same rule — this is
   only here so the correction happens while the number is still on screen. */
(function () {
  document.querySelectorAll('.phone-input').forEach(function (wrap) {
    var select = wrap.querySelector('[data-calling-code]');
    var input = wrap.querySelector('[data-phone-national]');
    var hint = wrap.parentNode.querySelector('[data-phone-hint]');
    if (!select || !input || !hint) return;

    var check = function () {
      var opt = select.options[select.selectedIndex];
      var lengths = (opt.getAttribute('data-lengths') || '').split(',').filter(Boolean).map(Number);
      var digits = input.value.replace(/\D/g, '');
      var ok = !digits.length || !lengths.length || lengths.indexOf(digits.length) > -1;
      input.classList.toggle('is-error', !ok);
      hint.classList.toggle('is-error', !ok);
      hint.textContent = digits.length && !ok
        ? 'A ' + opt.textContent.trim().split(' ').slice(1).join(' ') + ' number is '
          + lengths.join(' or ') + ' digits — this one has ' + digits.length + '.'
        : (lengths.length ? lengths.join(' or ') + ' digits' : '');
      input.setCustomValidity(ok ? '' : 'Check the number of digits for the country selected.');
    };

    select.addEventListener('change', check);
    input.addEventListener('input', check);
    check();
  });
}());

/* The tag filter. A contact can carry many tags, so the list needs to be
   searchable once a tenant has more than a handful. */
(function () {
  document.querySelectorAll('[data-tag-picker]').forEach(function (picker) {
    var filter = picker.querySelector('[data-tag-filter]');
    var empty = picker.querySelector('[data-tag-empty]');
    if (!filter) return;
    var options = Array.prototype.slice.call(picker.querySelectorAll('.tag-option'));

    filter.addEventListener('input', function () {
      var q = filter.value.trim().toLowerCase();
      var shown = 0;
      options.forEach(function (opt) {
        // A selected tag always stays visible, or filtering would hide a choice.
        var checked = opt.querySelector('input').checked;
        var match = !q || checked || opt.getAttribute('data-tag-name').indexOf(q) > -1;
        opt.hidden = !match;
        if (match) shown += 1;
      });
      if (empty) empty.hidden = shown > 0;
    });
  });
}());

/* Repeating form rows (site contacts, configurations). The last row is cloned
   and cleared, so the markup stays a plain table and the form still submits
   whatever rows exist with JavaScript off. */
(function () {
  document.querySelectorAll('[data-row-table]').forEach(function (table) {
    var kind = table.getAttribute('data-row-table');
    var body = table.querySelector('tbody');
    var addBtn = document.querySelector('[data-row-add="' + kind + '"]');
    if (!body || !addBtn) return;

    var blankRow = function () {
      var template = body.rows[0];
      if (!template) return null;
      var row = template.cloneNode(true);
      row.querySelectorAll('input, select').forEach(function (el) {
        if (el.type === 'radio') { el.checked = false; return; }
        if (el.tagName === 'SELECT') { el.selectedIndex = 0; return; }
        el.value = '';
      });
      return row;
    };

    // An empty table has nothing to clone, so keep one hidden template around.
    var template = body.rows[0] ? body.rows[0].cloneNode(true) : null;

    addBtn.addEventListener('click', function () {
      var row = blankRow() || (template && template.cloneNode(true));
      if (!row) return;
      row.querySelectorAll('input, select').forEach(function (el) {
        if (el.type === 'radio') { el.checked = false; el.value = String(body.rows.length); }
        else if (el.tagName !== 'SELECT') el.value = '';
      });
      body.appendChild(row);
      var first = row.querySelector('input, select');
      if (first) first.focus();
    });

    body.addEventListener('click', function (e) {
      if (!e.target.closest('[data-row-remove]')) return;
      var row = e.target.closest('tr');
      if (!row) return;
      // Never leave the table with nothing to clone from — blank it instead.
      if (body.rows.length === 1) {
        row.querySelectorAll('input').forEach(function (el) {
          if (el.type === 'radio') el.checked = false; else el.value = '';
        });
        return;
      }
      row.remove();
      // Radio values index the rows, so they have to be renumbered after a removal.
      Array.prototype.forEach.call(body.rows, function (r, i) {
        var radio = r.querySelector('input[type=radio]');
        if (radio) radio.value = String(i);
      });
    });
  });
}());

/* A renamed project type still has to tell the rest of the app how it behaves,
   so the semantic travels in a hidden field alongside the chosen id. */
(function () {
  var select = document.getElementById('projectTypeId');
  var semantic = document.querySelector('[data-type-semantic]');
  if (!select || !semantic) return;
  var sync = function () {
    var opt = select.options[select.selectedIndex];
    var value = opt && opt.getAttribute('data-semantic');
    if (value) semantic.value = value;
  };
  select.addEventListener('change', sync);
  sync();
}());

/* Referrer lookup (§9.1). The chosen type decides which book is searched, so a
   referral ends up pointing at a real record rather than a typed-in name. With
   JavaScript off the free-text name and mobile fields still capture it. */
(function () {
  var panel = document.querySelector('[data-referral-panel]');
  if (!panel || !window.fetch) return;

  var typeSelect = panel.querySelector('[data-referral-type]');
  var wrap = panel.querySelector('[data-referrer-lookup]');
  var input = panel.querySelector('[data-referrer-search]');
  var box = panel.querySelector('[data-referrer-results]');
  var contactId = panel.querySelector('[data-referrer-contact]');
  var partnerId = panel.querySelector('[data-referrer-partner]');
  var chosen = panel.querySelector('[data-referrer-chosen]');
  var chosenLabel = panel.querySelector('[data-referrer-label]');
  var clearBtn = panel.querySelector('[data-referrer-clear]');
  var nameField = document.getElementById('referrerName');
  var mobileField = document.getElementById('referrerMobile');
  if (!typeSelect || !wrap || !input || !box) return;

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var clear = function () {
    contactId.value = '';
    partnerId.value = '';
    chosen.hidden = true;
    input.hidden = false;
    input.value = '';
    box.hidden = true;
  };

  typeSelect.addEventListener('change', function () {
    wrap.hidden = !typeSelect.value;
    clear();
  });
  wrap.hidden = !typeSelect.value;

  clearBtn.addEventListener('click', clear);

  var timer = null;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var q = input.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      fetch('/api/referrers?type=' + encodeURIComponent(typeSelect.value)
            + '&q=' + encodeURIComponent(q), { headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) { box.hidden = true; return; }
          if (!data.results.length) {
            box.innerHTML = '<div class="lookup-empty">Nobody found — type the name below instead.</div>';
            box.hidden = false;
            return;
          }
          box.innerHTML = data.results.map(function (r) {
            return '<button type="button" class="lookup-row" data-id="' + esc(r.id) + '"'
              + ' data-label="' + esc(r.label) + '" data-mobile="' + esc(r.mobile) + '">'
              + '<strong>' + esc(r.label) + '</strong>'
              + (r.sub ? '<span class="t-sub">' + esc(r.sub) + '</span>' : '')
              + '</button>';
          }).join('');
          box.hidden = false;
        })
        .catch(function () { box.hidden = true; });
    }, 250);
  });

  box.addEventListener('click', function (e) {
    var row = e.target.closest('.lookup-row');
    if (!row) return;
    var isPartner = typeSelect.value === 'CHANNEL_PARTNER';
    (isPartner ? partnerId : contactId).value = row.getAttribute('data-id');
    (isPartner ? contactId : partnerId).value = '';
    chosenLabel.textContent = row.getAttribute('data-label');
    chosen.hidden = false;
    input.hidden = true;
    box.hidden = true;
    // Keep the readable name on the lead too, so a list never has to join.
    if (nameField) nameField.value = row.getAttribute('data-label');
    if (mobileField && row.getAttribute('data-mobile')) mobileField.value = row.getAttribute('data-mobile');
  });

  document.addEventListener('click', function (e) {
    if (!wrap.contains(e.target)) box.hidden = true;
  });
}());

/* Voice notes (§18.7). MediaRecorder is built into the browser, so there is no
   library and nothing to install — and where it is unavailable the block stays
   hidden and the note still takes text and files. */
(function () {
  var block = document.querySelector('[data-recorder]');
  if (!block) return;
  var form = block.closest('form');
  if (!form || !window.MediaRecorder || !navigator.mediaDevices) return;
  block.hidden = false;

  var startBtn = block.querySelector('[data-rec-start]');
  var stopBtn = block.querySelector('[data-rec-stop]');
  var discardBtn = block.querySelector('[data-rec-discard]');
  var timeEl = block.querySelector('[data-rec-time]');
  var playback = block.querySelector('[data-rec-playback]');
  var hint = block.querySelector('[data-rec-hint]');

  var recorder = null;
  var chunks = [];
  var stream = null;
  var ticker = null;
  var seconds = 0;
  var blob = null;

  var clock = function () {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    timeEl.innerHTML = '<span class="dot" aria-hidden="true"></span> ' + m + ':' + (s < 10 ? '0' : '') + s;
  };

  // The stream keeps the microphone indicator lit, so release it the moment
  // recording stops rather than when the page unloads.
  var release = function () {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  };

  var reset = function () {
    blob = null;
    chunks = [];
    seconds = 0;
    clearInterval(ticker);
    timeEl.hidden = true;
    discardBtn.hidden = true;
    playback.hidden = true;
    playback.removeAttribute('src');
    startBtn.hidden = false;
    stopBtn.hidden = true;
  };

  startBtn.addEventListener('click', function () {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s;
      chunks = [];
      recorder = new MediaRecorder(s);
      recorder.addEventListener('dataavailable', function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      });
      recorder.addEventListener('stop', function () {
        release();
        blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        playback.src = URL.createObjectURL(blob);
        playback.hidden = false;
        discardBtn.hidden = false;
      });
      recorder.start();
      seconds = 0;
      clock();
      timeEl.hidden = false;
      startBtn.hidden = true;
      stopBtn.hidden = false;
      ticker = setInterval(function () { seconds += 1; clock(); }, 1000);
    }).catch(function () {
      hint.textContent = 'Microphone unavailable — check the browser permission for this site.';
      hint.classList.add('is-error');
    });
  });

  stopBtn.addEventListener('click', function () {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    clearInterval(ticker);
    startBtn.hidden = false;
    stopBtn.hidden = true;
  });

  discardBtn.addEventListener('click', reset);

  // The recording only exists in memory, so it is attached at submit time.
  form.addEventListener('submit', function () {
    if (!blob) return;
    var dt = new DataTransfer();
    var ext = (blob.type.indexOf('ogg') > -1) ? 'ogg' : (blob.type.indexOf('mp4') > -1 ? 'm4a' : 'webm');
    dt.items.add(new File([blob], 'voice-note.' + ext, { type: blob.type }));
    var input = form.querySelector('input[name=voiceNote]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.name = 'voiceNote';
      input.hidden = true;
      form.appendChild(input);
    }
    input.files = dt.files;
    var secs = form.querySelector('input[name=voiceSeconds]');
    if (!secs) {
      secs = document.createElement('input');
      secs.type = 'hidden';
      secs.name = 'voiceSeconds';
      form.appendChild(secs);
    }
    secs.value = String(seconds);
  });
}());

/* The capture form's stage picker. A stage that closes the lead needs no
   follow-up, so the block disappears — same rule as the complete-action drawer,
   and the server enforces it either way. */
(function () {
  var stage = document.querySelector('[data-capture-stage]');
  var block = document.querySelector('[data-capture-next]');
  var hint = document.querySelector('[data-capture-terminal-hint]');
  if (!stage || !block || !hint) return;

  var sync = function () {
    var opt = stage.options[stage.selectedIndex];
    var terminal = opt && opt.getAttribute('data-terminal') === '1';
    block.hidden = terminal;
    hint.hidden = !terminal;
    block.querySelectorAll('select, input').forEach(function (el) { el.disabled = terminal; });
  };
  stage.addEventListener('change', sync);
  sync();

  // Quick date chips, same shorthand the complete-action drawer uses.
  block.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-preset]');
    if (!chip) return;
    e.preventDefault();
    var preset = chip.getAttribute('data-preset');
    var days = preset === 'today' ? 0 : Number(preset);
    var d = new Date(Date.now() + days * 86400000);
    document.getElementById('nextDate').value =
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var time = chip.getAttribute('data-preset-time');
    if (time) document.getElementById('nextTime').value = time;
    block.querySelectorAll('[data-preset]').forEach(function (c) { c.classList.remove('on'); });
    chip.classList.add('on');
  });

  // Default to tomorrow so the common case is one click, not four.
  var dateInput = document.getElementById('nextDate');
  if (dateInput && !dateInput.value) {
    var t = new Date(Date.now() + 86400000);
    dateInput.value = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
}());

/* Print the visiting card. The print stylesheet hides everything else, so this
   is just the trigger. */
(function () {
  var btn = document.querySelector('[data-print-card]');
  if (btn) btn.addEventListener('click', function () { window.print(); });
}());
