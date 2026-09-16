/**
 * The four named joins between the society module and the CRM around it.
 *
 * SOCIETY-PLAN.md D4: the module ships standalone, but the places where it will
 * one day meet the CRM are named now rather than discovered later. Each is a
 * single function, called from the one place it will matter, and each currently
 * returns `null` — the caller must treat that as "not joined", never as a
 * failure, which is why they never throw.
 *
 * Naming them now costs four stubs. Not naming them costs a refactor: the call
 * sites would be wherever somebody happened to need them, and there would be
 * three slightly different versions of "find the CRM contact for this
 * resident".
 *
 * Each stub records enough of its input to be implementable without going back
 * to the call site — that is the whole point of writing them before they work.
 */

/**
 * 1. CRM `Project` → `Society`.
 *
 * The reference admin's `AddConvertSociety.tsx`: a completed project becomes a
 * managed society, carrying its blocks, floors and units across rather than
 * having them keyed in twice. Called when a society is created with a
 * `projectId`.
 *
 * Will return the created society. Until then the operator generates the
 * structure from the society form, which is what Phase 1 does.
 */
// eslint-disable-next-line no-unused-vars
const societyFromProject = async ({ tenantId, projectId, actorId }) => null;

/**
 * 2. Society enquiry → CRM `Lead`.
 *
 * The source shipped its own half of this as `societyInquiryLeadService.js`: a
 * society enquiry is a sales lead, and the CRM already owns stages, SLAs,
 * follow-ups and round-robin for those. Called after `inquiries.submitFromApp`.
 *
 * Until it is joined, `services/society/inquiries.js` runs its own small
 * pipeline — which is why the assignment there is deliberately simple.
 */
// eslint-disable-next-line no-unused-vars
const leadFromInquiry = async ({ inquiryId, tenantId, actorId }) => null;

/**
 * 3. Resident → CRM `Contact`.
 *
 * The same person is a resident here and, when they sell their flat, a contact
 * on the sales side. `Contact` is unique on mobile per tenant (§9.2) and
 * `SocietyUser` is unique on mobile platform-wide, so the join key exists on
 * both sides already. Called from `occupancy.assign`.
 */
// eslint-disable-next-line no-unused-vars
const contactFromResident = async ({ societyUserId, mobileNumber, tenantId }) => null;

/**
 * 4. Channel-sales CP array → the CRM's `ChannelPartner` module (§3.6).
 *
 * The source's society records carry an inline array of channel partners.
 * This codebase has a real ChannelPartner module with a portal, commissions and
 * payouts, so the array is a denormalised copy of something that should point
 * at it. Called when a property listing is passed to sales.
 */
// eslint-disable-next-line no-unused-vars
const channelPartnerForListing = async ({ listingId, societyId, tenantId }) => null;

/**
 * Every seam, so a test can assert the set has not quietly grown a fifth
 * member that nobody wired up.
 */
const SEAMS = {
  societyFromProject,
  leadFromInquiry,
  contactFromResident,
  channelPartnerForListing,
};

module.exports = { ...SEAMS, SEAMS };
