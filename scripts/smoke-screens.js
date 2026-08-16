/* Crawls every GET screen as each role, as a browser would, and reports
   anything that is not a clean 200 with a complete page. */
const BASE = 'http://localhost:3000';
function client() {
  const jar = new Map();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return async function req(method, path, body) {
    const init = { method, redirect: 'manual', headers: { cookie: cookie(), accept: 'text/html', referer: BASE + path } };
    if (body) { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + path, init);
    for (const line of res.headers.getSetCookie()) { const [p] = line.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
}
const csrf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect('mongodb://127.0.0.1:27017/real_estate_crm');
  const db = mongoose.connection.db;
  const ids = {
    lead: String((await db.collection('leads').findOne({}))._id),
    contact: String((await db.collection('contacts').findOne({}))._id),
    project: String((await db.collection('projects').findOne({}))._id),
    booking: String((await db.collection('bookings').findOne({}))._id),
    costSheet: String((await db.collection('costsheets').findOne({}))._id),
    role: String((await db.collection('roles').findOne({}))._id),
  };

  const paths = [
    '/app/dashboard', '/app/dashboard?tile=new', '/app/dashboard?tile=today', '/app/dashboard?tile=visits',
    '/app/dashboard?tile=missed', '/app/dashboard?tile=reinquiry',
    '/app/dashboard?view=team', '/app/dashboard?view=team&tile=sla', '/app/dashboard?view=team&tile=unassigned',
    '/app/dashboard?view=team&tile=visits', '/app/dashboard/management',
    '/app/notifications', '/app/profile', '/app/search?q=Neha',
    '/app/leads', '/app/leads?status=ACTIVE', '/app/leads/new', `/app/leads/${ids.lead}`,
    `/app/leads/${ids.lead}/cost-sheets/new`, `/app/leads/${ids.lead}/blocks/new`, `/app/leads/${ids.lead}/bookings/new`,
    '/app/contacts', '/app/contacts/new', `/app/contacts/${ids.contact}`,
    '/app/projects', '/app/projects/new', `/app/projects/${ids.project}`,
    `/app/projects/${ids.project}?step=media`, `/app/projects/${ids.project}?step=inventory`,
    `/app/projects/${ids.project}?step=pricing`, `/app/projects/${ids.project}?step=review`, `/app/projects/${ids.project}/edit`,
    '/app/inventory', `/app/inventory/${ids.project}`, `/app/inventory/${ids.project}?view=grid`,
    `/app/cost-sheets/${ids.costSheet}`, `/app/bookings/${ids.booking}`, '/app/approvals',
    '/app/opportunities/resale', '/app/opportunities/rental',
    '/app/campaigns', '/app/campaigns/communication', '/app/campaigns/communication/new', '/app/campaigns/performance',
    '/app/reports/leads', '/app/reports/sales', '/app/reports/projects', '/app/reports/campaigns', '/app/reports/activities',
    '/app/setup/organization', '/app/setup/users', '/app/setup/roles', `/app/setup/roles/${ids.role}`,
    '/app/setup/stages', '/app/setup/lead-allocation', '/app/setup/sla', '/app/setup/templates', '/app/setup/nurture',
    '/app/setup/integrations', '/app/setup/health', '/app/setup/audit',
    '/app/setup/action-types', '/app/setup/visit-outcomes', '/app/setup/sources', '/app/setup/tags',
  ];

  let bad = 0;
  for (const [label, email] of [['ADMIN', 'admin@skyline.test'], ['MANAGER', 'manager@skyline.test'], ['SALES', 'priya@skyline.test']]) {
    const req = client();
    await req('POST', '/login', { _csrf: csrf((await req('GET', '/login')).text), email, password: 'Password1' });
    const problems = [];
    for (const path of paths) {
      const res = await req('GET', path);
      let final = res;
      // Follow one intentional redirect (e.g. /app/inventory → the only project).
      if (res.status === 302 && res.location && res.location.startsWith('/app/')) {
        final = await req('GET', res.location);
      }
      const ok200 = final.status === 200 && final.text.includes('</html>');
      const denied = final.status === 403 || final.status === 404;   // expected for role-gated screens
      const leaked = /<%|Cannot read propert|is not defined|ReferenceError/.test(final.text);
      if (leaked) problems.push(`${path} TEMPLATE ERROR`);
      else if (!ok200 && !denied) problems.push(`${path} → ${final.status}${final !== res ? ` (via ${res.location})` : ''}`);
    }
    console.log(`${label.padEnd(8)} ${paths.length - problems.length}/${paths.length} screens clean` + (problems.length ? `\n  ${problems.join('\n  ')}` : ''));
    bad += problems.length;
  }

  const anon = client();
  const project = await db.collection('projects').findOne({});
  const sheet = await db.collection('costsheets').findOne({ shareToken: { $ne: null } });
  const publics = [['/login', 200], ['/forgot-password', 200], [`/visit/${project.qrToken}`, 200],
    [`/p/${project.slug}`, project.miniSite?.published ? 200 : 404], ['/healthz', 200],
    ['/app/dashboard', 302], ['/visit/bogus-token', 404], ['/nope', 404]];
  const pubProblems = [];
  for (const [path, expect] of publics) {
    const res = await anon('GET', path);
    if (res.status !== expect) pubProblems.push(`${path} → ${res.status} (expected ${expect})`);
  }
  if (sheet) {
    const res = await anon('GET', `/share/cost-sheet/${sheet.shareToken}`);
    if (res.status !== 200) pubProblems.push(`shared cost sheet → ${res.status}`);
  }
  console.log(`PUBLIC   ${publics.length - pubProblems.length}/${publics.length} clean` + (pubProblems.length ? `\n  ${pubProblems.join('\n  ')}` : ''));
  bad += pubProblems.length;

  console.log(bad === 0 ? '\nALL SCREENS OK' : `\n${bad} PROBLEM(S)`);
  await mongoose.disconnect();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
