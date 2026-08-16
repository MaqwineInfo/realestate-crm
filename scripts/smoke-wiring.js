/* Every interactive hook in the rendered HTML must actually resolve:
   - data-drawer="x"  → an element with id="x" on the same page
   - data-quick       → a data-action URL that matches a real route
   - every <form action> → a real route
   - data-substage-for → an existing select id
   A mismatch is a button that silently does nothing — invisible to HTTP tests. */
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
const attrs = (html, attr) => [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);

// Route table, with :params turned into a matcher.
const routes = require('node:child_process').execSync(`node ${__dirname}/list-routes.js 2>/dev/null`, { encoding: 'utf8' })
  .split('\n').filter((l) => /^(GET|POST)/.test(l))
  .map((l) => { const [methods, path] = l.split(' '); return { methods: methods.split(','), re: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`) }; });
const routeExists = (method, url) => {
  const path = url.split('?')[0];
  return routes.some((r) => r.methods.includes(method) && r.re.test(path));
};

(async () => {
  const mongoose = require('mongoose');
  await mongoose.connect('mongodb://127.0.0.1:27017/real_estate_crm');
  const db = mongoose.connection.db;
  const lead = await db.collection('leads').findOne({ status: 'ACTIVE' });
  const project = await db.collection('projects').findOne({});
  const contact = await db.collection('contacts').findOne({});
  const role = await db.collection('roles').findOne({});

  const pages = [
    '/app/dashboard', '/app/dashboard?tile=visits', '/app/dashboard?view=team',
    `/app/leads/${lead._id}`, '/app/leads', '/app/leads/new',
    `/app/leads/${lead._id}/cost-sheets/new`, `/app/leads/${lead._id}/blocks/new`,
    `/app/projects/${project._id}`, `/app/projects/${project._id}?step=media`,
    `/app/projects/${project._id}?step=pricing`, `/app/projects/${project._id}?step=review`, '/app/projects/new', `/app/inventory/${project._id}`,
    `/app/contacts/${contact._id}`, '/app/contacts/new',
    '/app/campaigns/communication/new', '/app/campaigns/performance',
    '/app/setup/stages', '/app/setup/users', `/app/setup/roles/${role._id}`,
    '/app/setup/templates', '/app/setup/sla', '/app/setup/lead-allocation', '/app/setup/integrations', '/app/setup/nurture',
    '/app/setup/action-types', '/app/reports/leads',
  ];

  const req = client();
  await req('POST', '/login', { _csrf: csrf((await req('GET', '/login')).text), email: 'admin@skyline.test', password: 'Password1' });

  const problems = [];
  let checked = 0;
  for (const path of pages) {
    const res = await req('GET', path);
    if (res.status !== 200) { problems.push(`${path} → ${res.status}`); continue; }
    const html = res.text;

    for (const target of attrs(html, 'data-drawer')) {
      checked += 1;
      if (!html.includes(`id="${target}"`)) problems.push(`${path}: button opens "${target}" but no such drawer on the page`);
    }
    for (const action of attrs(html, 'data-action')) {
      checked += 1;
      if (!routeExists('POST', action)) problems.push(`${path}: quick action posts to ${action} — no such route`);
    }
    for (const action of attrs(html, 'action')) {
      if (!action.startsWith('/')) continue;
      checked += 1;
      const isGet = html.includes(`action="${action}"`) && new RegExp(`method="get"[^>]*action="${action}"|action="${action}"[^>]*method="get"`, 'i').test(html);
      if (!routeExists(isGet ? 'GET' : 'POST', action) && !routeExists('GET', action)) {
        problems.push(`${path}: form posts to ${action} — no such route`);
      }
    }
    for (const target of attrs(html, 'data-substage-for')) {
      checked += 1;
      if (!html.includes(`id="${target}"`)) problems.push(`${path}: sub-stage filter points at missing select "${target}"`);
    }
    // Every POST form must carry a CSRF token or it will 403 on submit.
    const forms = [...html.matchAll(/<form[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/gi)];
    for (const [full, body] of forms) {
      checked += 1;
      if (!body.includes('name="_csrf"')) problems.push(`${path}: a POST form has no CSRF token — ${full.slice(0, 80)}`);
    }
  }

  console.log(`${checked} interactive hooks checked across ${pages.length} pages`);
  console.log(problems.length ? problems.map((p) => `  ✖ ${p}`).join('\n') : '  ✔ every button, drawer and form resolves');
  await mongoose.disconnect();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
