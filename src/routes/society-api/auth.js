const express = require('express');
const { z } = require('zod');
const f = require('../../lib/fields');
const validate = require('../../middleware/validate');
const jwtLib = require('../../lib/society/jwt');
const auth = require('../../services/society/auth');
const { wrap, send } = require('./_helpers');

/**
 * `/api/v1/auth/*` — society admin sign-in (4 endpoints).
 *
 * Public: mounted ahead of the CSRF gate like `routes/public.js`, because a
 * bearer-token API has no session cookie for CSRF to protect. Rate limited with
 * the app's existing auth limiter — an OTP endpoint is the most brute-forcible
 * surface in the product.
 */
const router = express.Router();

const phoneBody = {
  societyCode: f.requiredText(20, 'Society code is required.'),
  countryCode: f.requiredText(6, 'Country code is required.'),
  phoneNumber: f.requiredText(20, 'Phone number is required.'),
};

const sendSchema = z.object(phoneBody);
const verifySchema = z.object({ ...phoneBody, otp: f.requiredText(10, 'Enter the OTP.') });

const limited = (req, res, next) => req.app.locals.limiters.auth(req, res, next);

router.post('/api/v1/auth/send-otp', limited, validate(sendSchema), wrap(async (req, res) => {
  const { message } = await auth.sendPhoneOtp(req.data);
  return send(res, message);
}));

router.post('/api/v1/auth/resend-otp', limited, validate(sendSchema), wrap(async (req, res) => {
  const { message } = await auth.resendOtp(req.data);
  return send(res, message);
}));

router.post('/api/v1/auth/verify-otp', limited, validate(verifySchema), wrap(async (req, res) => {
  const { message, admin } = await auth.verifyPhoneOtp(req.data);
  return send(res, message, admin);
}));

/** Unauthenticated on purpose: the token being revoked is the credential. */
router.post('/api/v1/auth/logout', wrap(async (req, res) => {
  const { message } = await auth.logout({ token: jwtLib.readHeaderToken(req) });
  return send(res, message);
}));

module.exports = router;
