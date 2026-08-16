const express = require('express');
const { z } = require('zod');
const authService = require('../services/auth');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { badRequest } = require('../lib/errors');
const { User } = require('../db/models');
const config = require('../config');

const router = express.Router();

const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  next: z.string().optional(),
});

const safeNext = (value) => (typeof value === 'string' && value.startsWith('/app/') ? value : '/app/dashboard');

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/app/dashboard');
  res.render('pages/auth/login', { title: 'Sign in', next: req.query.next || '', email: '' });
});

router.post('/login', (req, res, next) => req.app.locals.limiters.auth(req, res, next),
  validate(loginSchema), async (req, res, next) => {
    try {
      const result = await authService.login(req.data.email, req.data.password);

      if (result.needsOrgChoice) {
        req.session.pendingLogin = {
          userIds: result.options.map((o) => String(o.userId)),
          next: req.data.next,
        };
        return res.render('pages/auth/choose-org', {
          title: 'Choose organization',
          options: result.options,
        });
      }

      await establishSession(req, result.user);
      res.redirect(safeNext(req.data.next));
    } catch (err) { next(err); }
  });

router.post('/login/organization', async (req, res, next) => {
  try {
    const pending = req.session.pendingLogin;
    if (!pending) throw badRequest('Please sign in again.');
    const { user } = await authService.completeOrgChoice(pending.userIds, req.body.userId);
    delete req.session.pendingLogin;
    await establishSession(req, user);
    res.redirect(safeNext(pending.next));
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/forgot-password', (req, res) => {
  res.render('pages/auth/forgot', { title: 'Reset password', devLinks: [] });
});

router.post('/forgot-password', (req, res, next) => req.app.locals.limiters.auth(req, res, next),
  async (req, res, next) => {
    try {
      const links = await authService.requestPasswordReset(req.body.email);
      // §17.4-style behaviour: without a configured email provider the link is
      // surfaced in the UI rather than silently going nowhere.
      const devLinks = config.env === 'production' ? [] : links.map((l) => `${config.appUrl}/reset-password?token=${l.token}`);
      req.session.flash = { type: 'success', message: 'If that email is registered, a reset link is on its way.' };
      res.render('pages/auth/forgot', { title: 'Reset password', devLinks, flash: req.session.flash });
      delete req.session.flash;
    } catch (err) { next(err); }
  });

router.get('/reset-password', (req, res) => {
  res.render('pages/auth/set-password', {
    title: 'Set a new password',
    heading: 'Set a new password',
    subtitle: 'Choose a password you have not used before.',
    action: '/reset-password',
    cta: 'Save password',
    token: req.query.token || '',
  });
});

router.post('/reset-password', async (req, res, next) => {
  try {
    if (req.body.password !== req.body.confirm) throw badRequest('Both passwords must match.');
    await authService.resetPassword(req.body.token, req.body.password);
    req.session.flash = { type: 'success', message: 'Password updated. Sign in with your new password.' };
    res.redirect('/login');
  } catch (err) { next(err); }
});

router.get('/accept-invite', (req, res) => {
  res.render('pages/auth/set-password', {
    title: 'Activate your account',
    heading: 'Activate your account',
    subtitle: 'Set a password to start working your leads.',
    action: '/accept-invite',
    cta: 'Activate account',
    token: req.query.token || '',
  });
});

router.post('/accept-invite', async (req, res, next) => {
  try {
    if (req.body.password !== req.body.confirm) throw badRequest('Both passwords must match.');
    const user = await authService.acceptInvite(req.body.token, req.body.password);
    await establishSession(req, user);
    res.redirect('/app/dashboard');
  } catch (err) { next(err); }
});

router.post('/app/profile/password', requireAuth, async (req, res, next) => {
  try {
    if (req.body.password !== req.body.confirm) throw badRequest('Both passwords must match.');
    await authService.changePassword(req.user, req.body.currentPassword, req.body.password);
    req.session.flash = { type: 'success', message: 'Password updated.' };
    res.redirect('/app/profile');
  } catch (err) { next(err); }
});

/** Fresh session id on login, so a fixated pre-login id cannot be reused (§74). */
function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(async (err) => {
      if (err) return reject(err);
      req.session.userId = String(user._id);
      await User.updateOne({ tenantId: user.tenantId?._id || user.tenantId, _id: user._id }, { $set: { lastLoginAt: new Date() } });
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

module.exports = router;
