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
      'report.view': 'all', 'report.export': true,
    },
  },
];

module.exports = { SCOPES, SCOPE_RANK, CATALOG, ALL, KEYS, SCOPED_KEYS, isScoped, DEFAULT_ROLES };
