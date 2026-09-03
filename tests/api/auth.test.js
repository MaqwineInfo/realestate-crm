const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { User } = require('../../src/db/models');

test('authentication and session handling (§5)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();

  t.after(async () => { await h.stopServer(); });

  await t.test('the login page renders and carries a CSRF token', async () => {
    const c = h.client();
    const res = await c.get('/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /name="_csrf"/);
    assert.match(res.text, /Sign in/);
  });

  await t.test('a correct password signs the user in', async () => {
    const c = h.client();
    const res = await c.login('admin@alpha.test');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/app/dashboard');

    const dash = await c.get('/app/dashboard');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Alpha Admin|Hello, Alpha/);
  });

  await t.test('a wrong password is rejected without saying which field was wrong', async () => {
    const c = h.client();
    const token = await c.csrf('/login');
    const res = await c.post('/login', { _csrf: token, email: 'admin@alpha.test', password: 'nope' });
    assert.equal(res.status, 302);
    const followed = await c.get('/login');
    assert.match(followed.text, /Incorrect email or password/);
    const dash = await c.get('/app/dashboard');
    assert.equal(dash.status, 302, 'must not have a session');
  });

  await t.test('a post without a CSRF token is refused (§74)', async () => {
    const c = h.client();
    await c.get('/login');
    const res = await c.post('/login', { email: 'admin@alpha.test', password: 'Password1' });
    assert.equal(res.status, 302);
    const page = await c.get('/login');
    assert.match(page.text, /session expired/i);
  });

  await t.test('an unauthenticated request is sent to login, keeping its destination', async () => {
    const c = h.client();
    const res = await c.get('/app/leads');
    assert.equal(res.status, 302);
    assert.match(res.location, /^\/login\?next=/);
  });

  await t.test('a deactivated user loses access immediately (§5.2)', async () => {
    const c = h.client();
    await c.login('admin@alpha.test');
    assert.equal((await c.get('/app/dashboard')).status, 200);

    await User.updateOne({ tenantId: orgA.tenant._id, _id: orgA.admin._id }, { $set: { status: 'INACTIVE' } });
    const after = await c.get('/app/dashboard');
    assert.equal(after.status, 302, 'the live session must stop working');

    await User.updateOne({ tenantId: orgA.tenant._id, _id: orgA.admin._id }, { $set: { status: 'ACTIVE' } });
    const login = await h.client().login('admin@alpha.test');
    assert.equal(login.location, '/app/dashboard');
  });

  await t.test('an inactive user cannot log in but keeps their record', async () => {
    await User.updateOne({ tenantId: orgA.tenant._id, _id: orgA.admin._id }, { $set: { status: 'SUSPENDED' } });
    const c = h.client();
    const res = await c.login('admin@alpha.test');
    assert.equal(res.status, 302);
    assert.match((await c.get('/login')).text, /not active/i);
    assert.ok(await User.findOne({ tenantId: orgA.tenant._id, _id: orgA.admin._id }), 'record survives');
    await User.updateOne({ tenantId: orgA.tenant._id, _id: orgA.admin._id }, { $set: { status: 'ACTIVE' } });
  });

  /* ---------------------------- OTP sign-in (§5.4) --------------------------- */

  await t.test('a mobile code signs the user in without a password', async () => {
    const authService = require('../../src/services/auth');
    const user = await User.findOne({ tenantId: orgA.tenant._id, email: 'admin@alpha.test' });
    user.mobile = '9820011111';
    user.normalizedMobile = '+919820011111';
    await user.save();

    const { codes } = await authService.requestLoginOtp('9820011111');
    assert.equal(codes.length, 1, 'a code was issued');

    const c = h.client();
    const token = await c.csrf('/login/otp');
    const res = await c.post('/login/otp/verify', {
      _csrf: token, mobile: '9820011111', code: codes[0].code,
    });
    assert.equal(res.status, 302);
    assert.equal(res.location, '/app/dashboard');

    const dash = await c.get('/app/dashboard');
    assert.equal(dash.status, 200);
  });

  /**
   * The login screen must not become a staff directory: an unregistered number
   * has to look exactly like a registered one to whoever is typing.
   */
  await t.test('an unknown number is answered the same way as a known one', async () => {
    const authService = require('../../src/services/auth');
    const unknown = await authService.requestLoginOtp('9800000000');
    assert.equal(unknown.sent, false);
    assert.equal(unknown.codes.length, 0);

    const c = h.client();
    const token = await c.csrf('/login/otp');
    const res = await c.post('/login/otp', { _csrf: token, mobile: '9800000000' });
    assert.equal(res.status, 200);
    assert.match(res.text, /If that number is registered/);
  });

  /**
   * §192: six digits is a short brute force without a ceiling, so the ceiling is
   * the security property — once it trips, even the right code is refused.
   */
  await t.test('the code locks out after five wrong attempts', async () => {
    const authService = require('../../src/services/auth');
    const user = await User.findOne({ tenantId: orgB.tenant._id, email: 'admin@beta.test' });
    user.mobile = '9820022222';
    user.normalizedMobile = '+919820022222';
    await user.save();

    const { codes } = await authService.requestLoginOtp('9820022222');
    const real = codes[0].code;
    const wrong = real === '111111' ? '222222' : '111111';

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => authService.verifyLoginOtp('9820022222', wrong));
    }
    await assert.rejects(
      () => authService.verifyLoginOtp('9820022222', real),
      /Too many incorrect codes/,
      'the correct code is refused once the ceiling trips',
    );
  });

  await t.test('a code is single use', async () => {
    const authService = require('../../src/services/auth');
    // Reusing the alpha admin, so the resend throttle has to be cleared first.
    const user = await User.findOne({ tenantId: orgA.tenant._id, email: 'admin@alpha.test' });
    user.mobile = '9820033333';
    user.normalizedMobile = '+919820033333';
    user.loginOtpSentAt = undefined;
    await user.save();

    const { codes } = await authService.requestLoginOtp('9820033333');
    const code = codes[0].code;
    const first = await authService.verifyLoginOtp('9820033333', code);
    assert.ok(first.user || first.needsOrgChoice, 'the first use works');
    await assert.rejects(() => authService.verifyLoginOtp('9820033333', code), /not right, or it has expired/);
  });

  await t.test('logout ends the session', async () => {
    const c = h.client();
    await c.login('admin@alpha.test');
    const res = await c.submit('/logout', {});
    assert.equal(res.status, 302);
    assert.equal((await c.get('/app/dashboard')).status, 302);
  });

  await t.test('password reset issues a single-use link', async () => {
    const c = h.client();
    const token = await c.csrf('/forgot-password');
    const res = await c.post('/forgot-password', { _csrf: token, email: 'admin@alpha.test' });
    assert.equal(res.status, 200);
    const link = res.text.match(/\/reset-password\?token=([A-Za-z0-9_-]+)/);
    assert.ok(link, 'a reset link is surfaced while no email provider is configured');

    const reset = await c.submit('/reset-password', {
      token: link[1], password: 'BrandNew123', confirm: 'BrandNew123',
    }, `/reset-password?token=${link[1]}`);
    assert.equal(reset.location, '/login');

    const fresh = h.client();
    assert.equal((await fresh.login('admin@alpha.test', 'BrandNew123')).location, '/app/dashboard');

    const replay = await c.submit('/reset-password', {
      token: link[1], password: 'Another123', confirm: 'Another123',
    }, '/login');
    const page = await c.get('/login');
    assert.equal(replay.status, 302);
    assert.match(page.text, /invalid or has expired/i, 'a reset token cannot be reused');
  });
});
