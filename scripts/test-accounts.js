// End-to-end check of accounts against a throwaway local database.
// Usage: node --env-file=.env scripts/test-accounts.js
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.PGLITE_DIR = 'data/pglite-test';
delete process.env.DATABASE_URL;
process.env.RESEND_API_KEY = ''; // never send real email from tests
rmSync('data/pglite-test', { recursive: true, force: true });

const { app } = await import('../src/app.js');
const { q } = await import('../src/db.js');
const { createLoginToken, unsubscribeToken } = await import('../src/auth.js');
const { queueNewJobs } = await import('../src/alerts.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (path, { method = 'GET', body, cookie } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: base },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const signIn = async (email) => {
  const token = await createLoginToken(email);
  const r = await call('/api/auth/verify', { method: 'POST', body: { token } });
  assert.equal(r.status, 200, 'verify works');
  const again = await call('/api/auth/verify', { method: 'POST', body: { token } });
  assert.equal(again.status, 400, 'token is single use');
  return r.cookie;
};

await q('SELECT 1');
await q(`INSERT INTO jobs (id, source, source_id, title, company, city, types, field, sub_field, url, apply_url, posted_at, dedupe_key)
         VALUES ('wsj:t1', 'wsj', 't1', 'Working Student Backend', 'Acme', 'Berlin', '["working_student"]', 'tech', 'software-engineering',
                 'https://example.com/1', 'https://example.com/apply/1', now(), 'acme|wsb|berlin')`);

const anna = await signIn('Anna@Example.com');
const ben = await signIn('ben@example.com');
assert.equal((await call('/api/me', { cookie: anna })).json.user.email, 'anna@example.com', 'email is normalised');

// Per-user data stays separate.
await call('/api/jobs/wsj:t1/status', { method: 'PUT', cookie: anna, body: { status: 'applied', notes: 'sent CV' } });
assert.equal((await call('/api/tracker', { cookie: anna })).json.length, 1);
assert.equal((await call('/api/tracker', { cookie: ben })).json.length, 0, "ben can't see anna's tracker");
assert.equal((await call('/api/jobs/wsj:t1', { cookie: ben })).json.notes, '', "ben can't see anna's notes");
assert.equal((await call('/api/jobs/wsj:t1')).json.status, null, 'anonymous sees no status');

const alert = (await call('/api/alerts', { method: 'POST', cookie: anna, body: { name: 'Berlin', filters: { cities: ['Berlin'] } } })).json;
assert.equal((await call('/api/alerts', { cookie: ben })).json.length, 0, "ben can't list anna's alerts");
assert.equal((await call(`/api/alerts/${alert.id}`, { method: 'PUT', cookie: ben, body: { enabled: false } })).status, 404, "ben can't edit it");
await call(`/api/alerts/${alert.id}`, { method: 'DELETE', cookie: ben });
assert.equal((await call('/api/alerts', { cookie: anna })).json.length, 1, "ben can't delete it");

// Matching jobs are queued only for anna's alert.
assert.equal(await queueNewJobs(['wsj:t1']), 1);

// Unsubscribe link pauses emails; a forged one does not.
const annaId = (await q("SELECT id FROM users WHERE email = 'anna@example.com'"))[0].id;
assert.equal((await call(`/api/unsubscribe?u=${annaId}&t=forged`)).status, 400);
assert.equal((await call(`/api/unsubscribe?u=${annaId}&t=${unsubscribeToken(annaId)}`, { method: 'POST' })).status, 200);
assert.equal((await call('/api/account', { cookie: anna })).json.emailsPaused, true);

// Export contains anna's data only.
const exp = (await call('/api/account/export', { cookie: anna })).json;
assert.equal(exp.account.email, 'anna@example.com');
assert.equal(exp.savedAndApplied[0].notes, 'sent CV');

// Admin-only manual sync.
assert.equal((await call('/api/sync', { method: 'POST', cookie: ben })).status, 403);

// Sign out everywhere revokes old cookies.
await call('/api/account/logout-everywhere', { method: 'POST', cookie: ben });
assert.equal((await call('/api/me', { cookie: ben })).json.user, null, 'old cookie revoked');

// Cross-site writes are blocked.
const cross = await fetch(`${base}/api/account`, { method: 'DELETE', headers: { Cookie: anna, Origin: 'https://evil.example' } });
assert.equal(cross.status, 403);

// Account deletion removes everything.
assert.equal((await call('/api/account', { method: 'DELETE', cookie: anna })).status, 200);
assert.equal((await q("SELECT count(*)::int AS n FROM users WHERE email = 'anna@example.com'"))[0].n, 0);
assert.equal((await q('SELECT count(*)::int AS n FROM alerts WHERE id = $1', [alert.id]))[0].n, 0);
assert.equal((await q('SELECT count(*)::int AS n FROM user_job_status WHERE user_id = $1', [annaId]))[0].n, 0);
assert.equal((await call('/api/me', { cookie: anna })).json.user, null, 'deleted user is signed out');

console.log('all account tests passed');
server.close();
process.exit(0);
