const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { scopeFilter } = require('../lib/access');
const { forbidden } = require('../lib/errors');
const { Tag, User } = require('../db/models');
const contactsService = require('../services/contacts');

const router = express.Router();
router.use('/app/contacts', requireAuth);
router.use('/api/contacts', requireAuth);

const f = require('../lib/fields');

const contactSchema = z.object({
  firstName: f.requiredText(80, 'Enter a first name.'),
  lastName: f.optionalText(80),
  primaryMobile: z.string().trim().min(6, 'Enter a valid mobile number.'),
  altMobile: f.optionalText(20),
  email: f.email,
  city: f.optionalText(80),
  state: f.optionalText(80),
  pincode: f.optionalText(12),
  address: f.optionalText(500),
  tagIds: f.stringList,
});

router.get('/app/contacts', requirePermission('contact.view'), async (req, res, next) => {
  try {
    const scope = await scopeFilter(req.user, 'contact.view', 'ownerUserId');
    if (!scope) throw forbidden('You do not have permission to view contacts.');

    const [result, tags, owners] = await Promise.all([
      contactsService.list({ tenantId: req.tenantId, scope, query: req.query, page: req.query.page || 1 }),
      Tag.find({ tenantId: req.tenantId, active: true }).sort({ name: 1 }).lean(),
      User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/contacts/list', { title: 'Contacts', ...result, tags, owners });
  } catch (err) { next(err); }
});

router.get('/app/contacts/new', requirePermission('contact.create'), async (req, res, next) => {
  try {
    const tags = await Tag.find({ tenantId: req.tenantId, active: true }).sort({ name: 1 }).lean();
    res.render('pages/contacts/new', { title: 'New contact', tags });
  } catch (err) { next(err); }
});

router.post('/api/contacts', requirePermission('contact.create'), validate(contactSchema), async (req, res, next) => {
  try {
    const contact = await contactsService.create({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, payload: req.data,
    });
    req.session.flash = { type: 'success', message: 'Contact created.' };
    res.redirect(`/app/contacts/${contact._id}`);
  } catch (err) { next(err); }
});

router.get('/app/contacts/:id', requirePermission('contact.view'), async (req, res, next) => {
  try {
    const { contact, leads } = await contactsService.getWithHistory({ tenantId: req.tenantId, contactId: req.params.id });
    const [tags, duplicates] = await Promise.all([
      Tag.find({ tenantId: req.tenantId, active: true }).sort({ name: 1 }).lean(),
      contactsService.possibleDuplicatesByEmail({ tenantId: req.tenantId, email: contact.email, excludeId: contact._id }),
    ]);
    res.render('pages/contacts/detail', { title: contact.displayName, contact, leads, tags, duplicates });
  } catch (err) { next(err); }
});

router.post('/api/contacts/:id', requirePermission('contact.edit'), validate(contactSchema), async (req, res, next) => {
  try {
    await contactsService.update({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, contactId: req.params.id, payload: req.data,
    });
    req.session.flash = { type: 'success', message: 'Contact updated.' };
    res.redirect(`/app/contacts/${req.params.id}`);
  } catch (err) { next(err); }
});

const consentSchema = z.object({
  whatsappOptOut: f.checkbox,
  smsOptOut: f.checkbox,
  emailOptOut: f.checkbox,
  dnd: f.checkbox,
  reason: f.optionalText(200),
});

/** §67: campaign sending must respect these flags. */
router.post('/api/contacts/:id/consent', requirePermission('contact.edit'), validate(consentSchema), async (req, res, next) => {
  try {
    await contactsService.update({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      contactId: req.params.id,
      payload: {
        consent: {
          whatsappOptOut: !!req.data.whatsappOptOut,
          smsOptOut: !!req.data.smsOptOut,
          emailOptOut: !!req.data.emailOptOut,
          dnd: !!req.data.dnd,
          reason: req.data.reason,
          source: 'CRM',
        },
      },
    });
    req.session.flash = { type: 'success', message: 'Communication preferences updated.' };
    res.redirect(`/app/contacts/${req.params.id}`);
  } catch (err) { next(err); }
});

module.exports = router;
