const money = require('../lib/money');
const tz = require('../lib/tz');
const phone = require('../lib/phone');

/**
 * View helpers bound to the tenant's timezone, currency and locale (§72, §73),
 * so no template ever has to know those settings.
 */
function locals(req, res, next) {
  const flash = req.session?.flash;
  if (flash) delete req.session.flash;
  res.locals.flash = flash || null;

  const t = req.tenant || {};
  const zone = req.user?.timezone || t.timezone || 'Asia/Kolkata';
  const currency = t.currency || 'INR';
  const locale = t.locale || 'en-IN';

  res.locals.h = {
    money: (minor) => money.format(minor, { currency, locale }),
    moneyShort: (minor) => money.formatShort(minor, { currency, locale }),
    date: (d) => tz.formatDate(d, zone, locale),
    time: (d) => tz.formatTime(d, zone, locale),
    dateTime: (d) => tz.formatDateTime(d, zone, locale),
    rel: (d) => tz.relative(d),
    dateInput: (d) => tz.toDateInput(d, zone),
    timeInput: (d) => tz.toTimeInput(d, zone),
    mobile: (m) => phone.formatMobile(m, t.callingCode),
    initials: (name) => String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase(),
    isOverdue: (d) => !!d && new Date(d) < new Date(),
  };
  res.locals.zone = zone;
  res.locals.query = req.query;
  res.locals.path = req.path;
  next();
}

module.exports = locals;
