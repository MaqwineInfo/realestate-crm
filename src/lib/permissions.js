/**
 * Spec §6.2/§6.3: the permission catalog. Granular but understandable.
 * Scoped permissions resolve to one of own | team | all; the rest are booleans.
 */
const SCOPES = ['none', 'own', 'team', 'all'];
const SCOPE_RANK = { none: 0, own: 1, team: 2, all: 3 };

/** group → [{ key, label, scoped }] */
const CATALOG = {
  Dashboard: [
    { key: 'dashboard.own', label: 'View own dashboard' },
    { key: 'dashboard.team', label: 'View team dashboard' },
    { key: 'dashboard.management', label: 'View management dashboard' },
  ],
  Leads: [
    { key: 'lead.view', label: 'View leads', scoped: true },
    { key: 'lead.create', label: 'Create lead' },
    { key: 'lead.edit', label: 'Edit lead' },
    { key: 'lead.transfer', label: 'Transfer lead' },
    { key: 'lead.bulk_transfer', label: 'Bulk transfer lead' },
    { key: 'lead.mark_lost', label: 'Mark lost' },
    { key: 'lead.reopen_lost', label: 'Reopen lost' },
    { key: 'lead.view_source', label: 'View lead source' },
    { key: 'lead.view_attribution', label: 'View campaign attribution' },
    { key: 'lead.view_contact_details', label: 'View contact details' },
    { key: 'lead.export', label: 'Export leads' },
  ],
  Activities: [
    { key: 'followup.create', label: 'Create follow-up' },
    { key: 'followup.edit_own', label: 'Edit own follow-up' },
    { key: 'followup.edit_team', label: 'Edit team follow-up' },
    { key: 'followup.complete', label: 'Complete follow-up' },
    { key: 'note.create', label: 'Create note' },
    { key: 'note.mention', label: 'Mention user' },
    { key: 'call.view_recording', label: 'View call recording' },
  ],
  'Site Visits': [
    { key: 'visit.create', label: 'Create visit' },
    { key: 'visit.edit', label: 'Edit visit' },
    { key: 'visit.complete', label: 'Complete visit' },
    { key: 'visit.cancel', label: 'Cancel visit' },
    { key: 'visit.view_team', label: 'View team visits' },
  ],
  Projects: [
    { key: 'project.view', label: 'View projects' },
    { key: 'project.create', label: 'Create project' },
    { key: 'project.edit', label: 'Edit project' },
    { key: 'project.publish', label: 'Publish project' },
    { key: 'project.manage_media', label: 'Manage project media' },
    { key: 'project.manage_minisite', label: 'Manage mini website' },
  ],
  Inventory: [
    { key: 'inventory.view', label: 'View inventory' },
    { key: 'inventory.view_prices', label: 'View prices' },
    { key: 'inventory.edit', label: 'Edit inventory' },
    { key: 'unit.shortlist', label: 'Shortlist unit' },
    { key: 'unit.block', label: 'Block unit' },
    { key: 'unit.release_block', label: 'Release block' },
    { key: 'unit.override_block_expiry', label: 'Override block expiry' },
    { key: 'unit.book', label: 'Book unit' },
  ],
  Pricing: [
    { key: 'costsheet.create', label: 'Create cost sheet' },
    { key: 'discount.apply', label: 'Apply discount' },
    { key: 'discount.request_approval', label: 'Request discount approval' },
    { key: 'discount.approve', label: 'Approve discount' },
    { key: 'pricing.override', label: 'Override pricing' },
  ],
  Contacts: [
    { key: 'contact.view', label: 'View contacts', scoped: true },
    { key: 'contact.create', label: 'Create contacts' },
    { key: 'contact.edit', label: 'Edit contacts' },
    { key: 'contact.export', label: 'Export contacts' },
    { key: 'contact.manage_tags', label: 'Manage tags' },
  ],
  Campaigns: [
    { key: 'campaign.view', label: 'View campaigns' },
    { key: 'campaign.create', label: 'Create communication campaign' },
    { key: 'campaign.send', label: 'Send campaign' },
    { key: 'campaign.view_performance', label: 'View performance' },
    { key: 'campaign.edit_spend', label: 'Edit spend' },
    { key: 'campaign.export', label: 'Export campaign analytics' },
  ],
  /**
   * V2 §180: bookings and collections. `booking.view` and `collection.view` are
   * scoped because §183 keeps collection ownership separate from sales credit —
   * a salesperson may own the sale and someone else the money.
   */
  Bookings: [
    { key: 'booking.view', label: 'View bookings', scoped: true },
    { key: 'booking.edit', label: 'Edit booking operational data' },
    { key: 'booking.report', label: 'View booking reports' },
    // §130: seeing that KYC is done is not the same as seeing the documents.
    { key: 'booking.customer_link.create', label: 'Create customer booking link' },
    { key: 'booking.kyc.view', label: 'View KYC status and documents' },
    { key: 'booking.kyc.edit', label: 'Upload KYC documents' },
    { key: 'booking.kyc.review', label: 'Review and verify KYC' },
  ],
  Collections: [
    { key: 'collection.dashboard', label: 'View collection dashboard' },
    { key: 'collection.view', label: 'View collections', scoped: true },
    { key: 'collection.assign', label: 'Assign / transfer collection owner' },
    { key: 'collection.followup', label: 'Log collection follow-up' },
    { key: 'collection.payment_link', label: 'Create and send payment links' },
    { key: 'collection.record_payment', label: 'Record a payment received' },
    { key: 'collection.reverse_receipt', label: 'Reverse a receipt' },
    { key: 'collection.adjust_due_date', label: 'Change an installment due date' },
    { key: 'collection.report', label: 'View collection reports' },
  ],
  /** V2 §178: channel partner. Bank and invoice access is separated on purpose. */
  'Channel partners': [
    { key: 'cp.dashboard', label: 'View channel partner dashboard' },
    { key: 'cp.registration.view', label: 'View partner registrations' },
    { key: 'cp.registration.review', label: 'Review partner registrations' },
    { key: 'cp.partner.view', label: 'View channel partners' },
    { key: 'cp.partner.create', label: 'Add channel partner' },
    { key: 'cp.partner.edit', label: 'Edit channel partner' },
    { key: 'cp.partner.view_bank', label: 'View partner bank details' },
    { key: 'cp.team.manage', label: 'Manage partner team and portal access' },
    { key: 'cp.project_empanelment.manage', label: 'Manage project empanelment' },
    { key: 'cp.claim.view', label: 'View partner lead claims' },
    { key: 'cp.claim.review', label: 'Review partner lead claims' },
    { key: 'cp.commission.view', label: 'View partner commission' },
    { key: 'cp.commission.manage_rules', label: 'Manage commission rules' },
    { key: 'cp.invoice.view', label: 'View partner invoices' },
    { key: 'cp.invoice.review', label: 'Review partner invoices' },
    { key: 'cp.invoice.mark_paid', label: 'Record partner payouts' },
    { key: 'cp.report.view', label: 'View channel partner reports' },
  ],
  Reports: [
    { key: 'report.view', label: 'View reports', scoped: true },
    { key: 'report.export', label: 'Export reports' },
  ],
  Setup: [
    { key: 'setup.users', label: 'Manage users' },
    { key: 'setup.roles', label: 'Manage roles' },
    { key: 'setup.stages', label: 'Manage stages' },
    { key: 'setup.substages', label: 'Manage sub-stages' },
    { key: 'setup.action_types', label: 'Manage action types' },
    { key: 'setup.visit_outcomes', label: 'Manage visit outcomes' },
    { key: 'setup.sla', label: 'Manage SLA rules' },
    { key: 'setup.templates', label: 'Manage templates' },
    { key: 'setup.integrations', label: 'Manage integrations' },
    { key: 'setup.attribution', label: 'Manage attribution settings' },
    { key: 'setup.approval_rules', label: 'Manage approval rules' },
    { key: 'setup.block_rules', label: 'Manage block rules' },
    { key: 'setup.distribution', label: 'Manage lead distribution' },
    { key: 'setup.sources', label: 'Manage lead sources' },
    { key: 'setup.tags', label: 'Manage contact tags' },
    { key: 'setup.nurture', label: 'Manage nurture sequences' },
    { key: 'setup.organization', label: 'Manage organization' },
    // V2 §148: the collection pool is configured separately from lead allocation.
    { key: 'setup.collection_allocation', label: 'Manage collection allocation' },
    { key: 'setup.post_booking', label: 'Manage post-booking settings and KYC types' },
  ],
};

const ALL = Object.values(CATALOG).flat();
const KEYS = ALL.map((p) => p.key);
const SCOPED_KEYS = ALL.filter((p) => p.scoped).map((p) => p.key);
const isScoped = (key) => SCOPED_KEYS.includes(key);

/** Spec §6.1: default roles a new tenant receives. Tenant admins may edit them all. */
const DEFAULT_ROLES = [
  {
    name: 'Organization Admin',
    description: 'Full access to every module and all setup.',
    isAdmin: true,
    permissions: Object.fromEntries(KEYS.map((k) => [k, isScoped(k) ? 'all' : true])),
  },
  {
    name: 'Sales Manager',
    description: 'Runs a sales team: sees team work, exceptions and performance.',
    permissions: {
      'dashboard.own': true, 'dashboard.team': true,
      'lead.view': 'team', 'lead.create': true, 'lead.edit': true, 'lead.transfer': true,
      'lead.bulk_transfer': true, 'lead.mark_lost': true, 'lead.reopen_lost': true,
      'lead.view_source': true, 'lead.view_attribution': true, 'lead.view_contact_details': true,
      'lead.export': true,
      'followup.create': true, 'followup.edit_own': true, 'followup.edit_team': true,
      'followup.complete': true, 'note.create': true, 'note.mention': true, 'call.view_recording': true,
      'visit.create': true, 'visit.edit': true, 'visit.complete': true, 'visit.cancel': true, 'visit.view_team': true,
      'project.view': true,
      'inventory.view': true, 'inventory.view_prices': true, 'unit.shortlist': true,
      'unit.block': true, 'unit.release_block': true, 'unit.book': true,
      'costsheet.create': true, 'discount.apply': true, 'discount.request_approval': true, 'discount.approve': true,
      'contact.view': 'team', 'contact.create': true, 'contact.edit': true, 'contact.manage_tags': true,
      'campaign.view': true, 'campaign.view_performance': true,
      'booking.view': 'team', 'booking.edit': true, 'booking.report': true,
      'booking.customer_link.create': true, 'booking.kyc.view': true, 'booking.kyc.edit': true,
      'booking.kyc.review': true,
      // A sales manager works with partners but does not approve their money.
      'cp.dashboard': true, 'cp.registration.view': true, 'cp.partner.view': true,
      'cp.claim.view': true, 'cp.claim.review': true, 'cp.commission.view': true,
      'cp.report.view': true,
      'collection.dashboard': true, 'collection.view': 'team', 'collection.assign': true,
      'collection.followup': true, 'collection.payment_link': true, 'collection.record_payment': true,
      'collection.reverse_receipt': true, 'collection.adjust_due_date': true, 'collection.report': true,
      'report.view': 'team', 'report.export': true,
    },
  },
  {
    name: 'Sales User',
    description: 'Works their own leads: the daily sales work engine.',
    permissions: {
      'dashboard.own': true,
      'lead.view': 'own', 'lead.create': true, 'lead.edit': true,
      'lead.mark_lost': true, 'lead.view_source': true, 'lead.view_contact_details': true,
      'followup.create': true, 'followup.edit_own': true, 'followup.complete': true,
      'note.create': true, 'note.mention': true,
      'visit.create': true, 'visit.edit': true, 'visit.complete': true, 'visit.cancel': true,
      'project.view': true,
      'inventory.view': true, 'inventory.view_prices': true, 'unit.shortlist': true, 'unit.block': true,
      // A salesperson closes their own booking; releasing someone else's block
      // and approving discounts stay with the manager.
      'unit.book': true,
      'costsheet.create': true, 'discount.apply': true, 'discount.request_approval': true,
      'contact.view': 'own', 'contact.create': true, 'contact.edit': true,
      // §221: the salesperson chases their own booking's money by default.
      'booking.view': 'own', 'booking.customer_link.create': true,
      // §130: they can see whether KYC is done without opening the documents.
      'collection.dashboard': true, 'collection.view': 'own', 'collection.followup': true,
      'collection.payment_link': true,
      'report.view': 'own',
    },
  },
  {
    name: 'Marketing User',
    description: 'Runs campaigns and watches spend-to-booking performance.',
    permissions: {
      'dashboard.own': true,
      'lead.view': 'all', 'lead.view_source': true, 'lead.view_attribution': true, 'lead.export': true,
      'project.view': true, 'inventory.view': true,
      'contact.view': 'all', 'contact.create': true, 'contact.edit': true,
      'contact.export': true, 'contact.manage_tags': true,
      'campaign.view': true, 'campaign.create': true, 'campaign.send': true,
      'campaign.view_performance': true, 'campaign.edit_spend': true, 'campaign.export': true,
      'report.view': 'all', 'report.export': true,
      'setup.tags': true, 'setup.templates': true, 'setup.attribution': true,
    },
  },
  {
    name: 'Management Viewer',
    description: 'Read-only business outcome view across the organization.',
    permissions: {
      'dashboard.own': true, 'dashboard.team': true, 'dashboard.management': true,
      'lead.view': 'all', 'lead.view_source': true, 'lead.view_attribution': true,
      'visit.view_team': true, 'project.view': true,
      'inventory.view': true, 'inventory.view_prices': true,
      'contact.view': 'all', 'campaign.view': true, 'campaign.view_performance': true,
      'booking.view': 'all', 'booking.report': true,
      'collection.view': 'all', 'collection.report': true,
      'cp.dashboard': true, 'cp.partner.view': true, 'cp.commission.view': true,
      'cp.invoice.view': true, 'cp.report.view': true,
      'report.view': 'all', 'report.export': true,
    },
  },
  /**
   * V2 §181: collections as a job of its own, for organizations that separate
   * it from sales. Tenants that do not can simply grant the collection
   * permissions to their existing sales roles instead (§221).
   */
  /** §181: channel partner operations as a job of its own. */
  {
    name: 'Channel Partner Manager',
    description: 'Runs channel partners: registration, compliance, claims, commission and payouts.',
    permissions: {
      'dashboard.own': true, 'dashboard.team': true,
      'lead.view': 'all', 'lead.view_source': true, 'lead.view_contact_details': true,
      'project.view': true, 'inventory.view': true, 'inventory.view_prices': true,
      'contact.view': 'all',
      'booking.view': 'all', 'booking.report': true,
      'cp.dashboard': true,
      'cp.registration.view': true, 'cp.registration.review': true,
      'cp.partner.view': true, 'cp.partner.create': true, 'cp.partner.edit': true,
      'cp.partner.view_bank': true, 'cp.team.manage': true,
      'cp.project_empanelment.manage': true,
      'cp.claim.view': true, 'cp.claim.review': true,
      'cp.commission.view': true, 'cp.commission.manage_rules': true,
      'cp.invoice.view': true, 'cp.invoice.review': true, 'cp.invoice.mark_paid': true,
      'cp.report.view': true,
      'report.view': 'all', 'report.export': true,
    },
  },
  {
    name: 'Collection Manager',
    description: 'Runs collections across projects: assignment, exceptions and recovery.',
    permissions: {
      'dashboard.own': true, 'dashboard.team': true,
      'lead.view': 'team', 'lead.view_contact_details': true,
      'project.view': true, 'inventory.view': true, 'inventory.view_prices': true,
      'contact.view': 'team',
      'booking.view': 'all', 'booking.edit': true, 'booking.report': true,
      'booking.customer_link.create': true, 'booking.kyc.view': true, 'booking.kyc.review': true,
      'collection.dashboard': true, 'collection.view': 'all', 'collection.assign': true,
      'collection.followup': true, 'collection.payment_link': true, 'collection.record_payment': true,
      'collection.reverse_receipt': true, 'collection.adjust_due_date': true, 'collection.report': true,
      'report.view': 'team', 'report.export': true,
      'setup.collection_allocation': true, 'setup.post_booking': true,
    },
  },
  {
    name: 'Collection Executive',
    description: 'Works their own collection queue: follow-ups, promises and recovery.',
    permissions: {
      'dashboard.own': true,
      'lead.view_contact_details': true,
      'project.view': true, 'inventory.view': true,
      'contact.view': 'own',
      'booking.view': 'own', 'booking.customer_link.create': true, 'booking.kyc.view': true,
      'collection.dashboard': true, 'collection.view': 'own', 'collection.followup': true,
      'collection.payment_link': true, 'collection.record_payment': true,
      'report.view': 'own',
    },
  },
];

module.exports = { SCOPES, SCOPE_RANK, CATALOG, ALL, KEYS, SCOPED_KEYS, isScoped, DEFAULT_ROLES };
