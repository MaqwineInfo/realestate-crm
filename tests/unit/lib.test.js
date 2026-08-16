const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../../src/lib/money');
const phone = require('../../src/lib/phone');
const tz = require('../../src/lib/tz');
const { can, scopeOf } = require('../../src/lib/access');

test('money never uses binary floating point (§73)', async (t) => {
  await t.test('parses rupee input into integer paise', () => {
    assert.equal(money.toMinor('12,50,000.50'), 125000050);
    assert.equal(money.toMinor(1250000.5), 125000050);
    assert.equal(money.toMinor('₹ 45,00,000'), 450000000);
    assert.equal(money.toMinor(''), 0);
  });

  await t.test('0.1 + 0.2 problem cannot occur', () => {
    assert.equal(money.sum([money.toMinor('0.1'), money.toMinor('0.2')]), money.toMinor('0.3'));
  });

  await t.test('percentage and per-area rates round to whole paise', () => {
    assert.equal(money.percentOf(100000, 7.5), 7500);
    assert.equal(money.rateTimes(money.toMinor('5500'), 1250), money.toMinor('6875000'));
  });

  await t.test('rejects junk instead of silently producing NaN', () => {
    assert.throws(() => money.toMinor('abc'));
  });

  await t.test('short format uses Indian units', () => {
    assert.match(money.formatShort(money.toMinor('12500000')), /1\.25 Cr/);
    assert.match(money.formatShort(money.toMinor('4500000')), /45\.00 L/);
  });
});

test('mobile normalization is the duplicate key (§9.2)', async (t) => {
  await t.test('every real-world spelling of one number collapses to one value', () => {
    const forms = ['9876543210', '09876543210', '+91 98765 43210', '91-9876543210', '+919876543210'];
    const normalized = new Set(forms.map((f) => phone.normalizeMobile(f)));
    assert.equal(normalized.size, 1);
    assert.equal([...normalized][0], '+919876543210');
  });

  await t.test('unusable input returns null rather than a bad key', () => {
    assert.equal(phone.normalizeMobile('12345'), null);
    assert.equal(phone.normalizeMobile(''), null);
    assert.equal(phone.normalizeMobile(null), null);
  });

  await t.test('honours a non-Indian tenant calling code', () => {
    assert.equal(phone.normalizeMobile('501234567', '971'), '+971501234567');
  });

  await t.test('email validation', () => {
    assert.ok(phone.isValidEmail('a@b.co'));
    assert.ok(!phone.isValidEmail('a@b'));
    assert.equal(phone.normalizeEmail('  A@B.CO '), 'a@b.co');
  });
});

test('tenant timezone decides "today" (§72)', async (t) => {
  await t.test('a UTC evening is already tomorrow in Kolkata', () => {
    // 2026-03-01T19:00Z is 2026-03-02 00:30 IST.
    const at = new Date('2026-03-01T19:00:00Z');
    const { start } = tz.todayRange('Asia/Kolkata', at);
    assert.equal(start.toISOString(), '2026-03-01T18:30:00.000Z');
    assert.equal(tz.toDateInput(at, 'Asia/Kolkata'), '2026-03-02');
    assert.equal(tz.toDateInput(at, 'UTC'), '2026-03-01');
  });

  await t.test('today range is exactly 24h and contains now', () => {
    const now = new Date('2026-06-15T09:00:00Z');
    const { start, end } = tz.todayRange('Asia/Kolkata', now);
    assert.equal(end - start, 86400000);
    assert.ok(start <= now && now < end);
  });

  await t.test('form date+time input maps back to the right UTC instant', () => {
    const at = tz.fromLocalInput('2026-06-15', '11:30', 'Asia/Kolkata');
    assert.equal(at.toISOString(), '2026-06-15T06:00:00.000Z');
  });

  await t.test('survives a DST boundary in a DST timezone', () => {
    // US DST starts 2026-03-08; local midnight is still a real instant.
    const { start, end } = tz.todayRange('America/New_York', new Date('2026-03-08T12:00:00Z'));
    assert.equal(start.toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(end - start, 23 * 3600000);
  });
});

test('permission scopes (§6.3)', async (t) => {
  const salesUser = { role: { permissions: { 'lead.view': 'own', 'lead.create': true } } };
  const manager = { role: { permissions: { 'lead.view': 'team' } } };
  const admin = { role: { isAdmin: true, permissions: {} } };

  await t.test('scoped permissions report their scope', () => {
    assert.equal(scopeOf(salesUser, 'lead.view'), 'own');
    assert.equal(scopeOf(manager, 'lead.view'), 'team');
    assert.equal(scopeOf(admin, 'lead.view'), 'all');
    assert.equal(scopeOf(salesUser, 'lead.transfer'), 'none');
  });

  await t.test('admin implicitly holds everything', () => {
    assert.ok(can(admin, 'setup.roles'));
    assert.ok(!can(salesUser, 'setup.roles'));
    assert.ok(can(salesUser, 'lead.create'));
  });

  await t.test('a missing user is never authorized', () => {
    assert.ok(!can(null, 'lead.view'));
    assert.equal(scopeOf(undefined, 'lead.view'), 'none');
  });
});

test('business-hours SLA clock (§16.1, §72)', async (t) => {
  const businessHours = require('../../src/lib/businessHours');
  const hours = { start: '09:30', end: '19:00', days: [1, 2, 3, 4, 5, 6] };

  await t.test('24x7 is plain elapsed time', () => {
    const from = new Date('2026-06-15T04:00:00Z');
    const to = new Date('2026-06-15T05:00:00Z');
    assert.equal(businessHours.elapsedSeconds(from, to, 'Asia/Kolkata', null), 3600);
  });

  await t.test('overnight waiting does not burn the SLA', () => {
    // 21:00 IST Monday → 10:00 IST Tuesday: only 30 min of business time.
    const from = new Date('2026-06-15T15:30:00Z');
    const to = new Date('2026-06-16T04:30:00Z');
    const seconds = businessHours.elapsedSeconds(from, to, 'Asia/Kolkata', hours);
    assert.equal(seconds, 1800);
  });

  await t.test('a closed day contributes nothing', () => {
    // Sunday is not in the working days list.
    const from = new Date('2026-06-20T16:00:00Z'); // Sat 21:30 IST
    const to = new Date('2026-06-22T04:30:00Z');   // Mon 10:00 IST
    assert.equal(businessHours.elapsedSeconds(from, to, 'Asia/Kolkata', hours), 1800);
  });

  await t.test('knows whether an instant is inside working hours', () => {
    assert.equal(businessHours.isWithinBusinessHours(new Date('2026-06-15T05:00:00Z'), 'Asia/Kolkata', hours), true);
    assert.equal(businessHours.isWithinBusinessHours(new Date('2026-06-15T20:00:00Z'), 'Asia/Kolkata', hours), false);
    assert.equal(businessHours.isWithinBusinessHours(new Date('2026-06-21T05:00:00Z'), 'Asia/Kolkata', hours), false);
  });

  await t.test('a misconfigured window falls back to 24x7 rather than freezing the clock', () => {
    const broken = { start: '19:00', end: '09:00', days: [1, 2, 3, 4, 5] };
    const from = new Date('2026-06-15T04:00:00Z');
    const to = new Date('2026-06-15T06:00:00Z');
    assert.equal(businessHours.elapsedSeconds(from, to, 'Asia/Kolkata', broken), 7200);
  });
});

test('template rendering (§17.3)', async (t) => {
  const messaging = require('../../src/services/messaging');

  await t.test('fills known variables and blanks unknown ones', () => {
    const out = messaging.render('Hi {{contact.first_name}}, about {{project.name}} — {{nope.here}}', {
      contact: { first_name: 'Meera' }, project: { name: 'Skyline' },
    });
    assert.equal(out, 'Hi Meera, about Skyline — ');
  });

  await t.test('tolerates spacing inside the braces', () => {
    assert.equal(messaging.render('{{ contact.name }}', { contact: { name: 'A' } }), 'A');
  });

  await t.test('campaign sends respect opt-out, operational messages do not (§67)', () => {
    const optedOut = { consent: { whatsappOptOut: true } };
    assert.ok(messaging.consentBlock({ contact: optedOut, channel: 'WHATSAPP', purpose: 'CAMPAIGN' }));
    assert.equal(messaging.consentBlock({ contact: optedOut, channel: 'WHATSAPP', purpose: 'ACKNOWLEDGEMENT' }), null);

    const dnd = { consent: { dnd: true } };
    assert.ok(messaging.consentBlock({ contact: dnd, channel: 'SMS', purpose: 'ACKNOWLEDGEMENT' }), 'DND blocks everything');
  });
});

test('secret sealing (§49.1, §74)', async (t) => {
  const secretbox = require('../../src/lib/secretbox');

  await t.test('round-trips a secret', () => {
    const sealed = secretbox.seal('provider-token-123');
    assert.notEqual(sealed, 'provider-token-123');
    assert.equal(secretbox.open(sealed), 'provider-token-123');
  });

  await t.test('a tampered ciphertext does not decrypt', () => {
    const sealed = secretbox.seal('provider-token-123');
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    assert.equal(secretbox.open(tampered), null);
  });

  await t.test('empty input stays empty', () => {
    assert.equal(secretbox.seal(''), null);
    assert.equal(secretbox.open(null), null);
  });
});

test('template fallbacks keep generic inquiries readable (§17.3)', async (t) => {
  const messaging = require('../../src/services/messaging');

  await t.test('uses the fallback when the value is missing or empty', () => {
    assert.equal(
      messaging.render('interested in {{project.name|our projects}}', { project: {} }),
      'interested in our projects',
    );
    assert.equal(
      messaging.render('interested in {{project.name|our projects}}', { project: { name: 'Skyline' } }),
      'interested in Skyline',
    );
  });
});
