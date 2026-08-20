const partnerPortal = require('../services/partnerPortal');
const { unauthorized, forbidden } = require('../lib/errors');

/**
 * V2 §24: the channel partner's session, deliberately its own identity.
 *
 * This sets `req.partnerUser` / `req.partner` and NEVER `req.user`. Internal
 * authorization (`middleware/auth`, `lib/access`) reads `req.user`, so a partner
 * session cannot satisfy an internal route even if one were mounted by mistake —
 * which is asserted in the tests rather than assumed.
 */
async function currentPartner(req, res, next) {
  res.locals.partnerUser = null;
  res.locals.partner = null;
  if (!req.session?.partnerUserId) return next();

  const session = await partnerPortal.loadSession({ portalUserId: req.session.partnerUserId });
  if (!session) {
    // Suspended, deactivated or deleted mid-session: drop it.
    delete req.session.partnerUserId;
    return next();
  }
  req.partnerSession = session;
  req.partnerUser = session.portalUser;
  req.partner = session.partner;
  req.tenantId = session.portalUser.tenantId;
  req.tenant = session.tenant;
  res.locals.partnerUser = session.portalUser;
  res.locals.partner = session.partner;
  res.locals.partnerMember = session.member;
  res.locals.partnerReadOnly = session.readOnly;
  res.locals.isCompanyAdmin = session.isCompanyAdmin;
  res.locals.tenant = session.tenant;
  next();
}

function requirePartner(req, res, next) {
  if (req.partnerUser) return next();
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.redirect(`/cp/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next(unauthorized());
}

/** §218: a suspended partner keeps read access and loses the ability to act. */
function requirePartnerWrite(req, res, next) {
  if (!req.partnerUser) return next(unauthorized());
  if (req.partnerSession.readOnly) {
    return next(forbidden('Your account is read-only at the moment. Contact the sales team.'));
  }
  next();
}

/**
 * §23/§30: portal capabilities come from the member record, not an internal role.
 *
 * A login with no member record IS the partner — an individual partner, or the
 * company's own account — and is not constrained by a member row that does not
 * exist. Capability limits apply to company staff, who have one.
 */
function requirePartnerCapability(capability) {
  return (req, res, next) => {
    if (!req.partnerUser) return next(unauthorized());
    const { member, isCompanyAdmin } = req.partnerSession;
    if (isCompanyAdmin) return next();
    if (!member) return next();
    if (member[capability]) return next();
    next(forbidden('Your portal account does not have access to that.'));
  };
}

module.exports = { currentPartner, requirePartner, requirePartnerWrite, requirePartnerCapability };
