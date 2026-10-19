import { acquireLock, getSetting, one, q, releaseLock, setSetting } from './db.js';
import { buildWhere, describeFilters, parseFilters } from './filters.js';
import { mailProvider, sendMail } from './mailer.js';
import { unsubscribeToken } from './auth.js';

export const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 8); // Europe/Berlin
const MAX_AGE_HOURS = 48; // never email a stale backlog (e.g. after email was off for days)
export const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 4380}`).replace(/\/$/, '');

export const berlinHour = (date = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hourCycle: 'h23' }).format(date));
const berlinDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(date);

/** Records which alerts each freshly discovered job matches. */
export const queueNewJobs = async (jobIds) => {
  if (!jobIds.length) return 0;
  const alerts = await q(`SELECT a.id, a.filters FROM alerts a JOIN users u ON u.id = a.user_id
                          WHERE a.enabled AND NOT u.emails_paused`);
  let queued = 0;
  for (const alert of alerts) {
    const params = [alert.id, jobIds];
    const { where } = buildWhere(parseFilters(alert.filters), params);
    const rows = await q(`
      INSERT INTO deliveries (alert_id, dedupe_key, job_id)
      SELECT $1, j.dedupe_key, j.id FROM jobs j WHERE j.id = ANY($2::text[]) AND ${where}
      ON CONFLICT DO NOTHING RETURNING job_id`, params);
    queued += rows.length;
  }
  if (queued) console.log(`[alerts] queued ${queued} matches`);
  return queued;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : appUrl());

const LANG = { required: 'required', optional: 'a plus', not_required: 'not needed', unknown: 'not stated' };
const MODE = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', unknown: '' };
const euro = (v) => `€${Math.round(v).toLocaleString('de-DE')}`;

const unsubscribeUrl = (userId) => `${appUrl()}/api/unsubscribe?u=${userId}&t=${unsubscribeToken(userId)}`;

const layout = (inner, footer) => `<!doctype html><html><body style="margin:0;background:#F5F6F8;padding:24px 12px">
  <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:8px 24px 24px">
    <tr><td style="padding-top:20px;font:800 20px Arial,sans-serif;color:#14161B">Firstapply</td></tr>
    ${inner}
    <tr><td style="padding-top:24px;font:12px/1.6 Arial,sans-serif;color:#8A90A0">${footer}
      <br><a href="${esc(appUrl())}/legal/imprint.html" style="color:#8A90A0">Imprint</a> &nbsp;·&nbsp;
      <a href="${esc(appUrl())}/legal/privacy.html" style="color:#8A90A0">Privacy policy</a></td></tr>
  </table></body></html>`;

const jobBlock = (j) => {
  const meta = [j.company, j.city, MODE[j.working_mode]].filter(Boolean).map(esc).join(', ');
  const range = j.salary_max && j.salary_max !== j.salary_min ? `–${euro(j.salary_max)}` : j.salary_max ? '' : '+';
  const salary = j.salary_min ? `${euro(j.salary_min)}${range} / ${j.salary_period ?? 'month'}` : '';
  const apply = esc(safeUrl(j.apply_url));
  return `
  <tr><td style="padding:16px 0;border-bottom:1px solid #E3E6EC">
    <div style="font:600 16px/1.35 Arial,sans-serif;color:#14161B">${esc(j.title)}</div>
    <div style="font:14px/1.5 Arial,sans-serif;color:#4A5060;margin-top:2px">${meta}</div>
    <div style="font:13px/1.5 Arial,sans-serif;color:#4A5060;margin-top:4px">German ${LANG[j.german] ?? 'not stated'} &nbsp;|&nbsp; English ${LANG[j.english] ?? 'not stated'}${salary ? ` &nbsp;|&nbsp; ${esc(salary)}` : ''}</div>
    <div style="margin-top:12px">
      <a href="${apply}" style="display:inline-block;background:#2347D9;color:#fff;text-decoration:none;font:600 14px Arial,sans-serif;padding:9px 16px;border-radius:8px">Apply</a>
      <a href="${esc(appUrl())}/#/jobs/${encodeURIComponent(j.id)}" style="display:inline-block;color:#2347D9;text-decoration:none;font:600 14px Arial,sans-serif;padding:9px 12px">Track in Firstapply</a>
    </div>
    <div style="font:12px/1.4 Arial,sans-serif;color:#8A90A0;margin-top:8px;word-break:break-all">Apply link: ${apply}</div>
  </td></tr>`;
};

const composeAlertEmail = (groups, userId) => {
  const all = groups.flatMap((g) => g.jobs);
  const first = all[0];
  const subject = all.length === 1
    ? `New job: ${first.title} at ${first.company}`
    : `${all.length} new jobs: ${first.title} at ${first.company} and more`;
  const sections = groups.map((g) => `
    <tr><td style="padding:24px 0 4px;font:600 13px Arial,sans-serif;color:#0F8A5A">${esc(g.name)} (${g.jobs.length})</td></tr>
    ${g.jobs.map(jobBlock).join('')}`).join('');
  const unsub = unsubscribeUrl(userId);
  const html = layout(sections, `You get this email because you set up job alerts on Firstapply.
    <a href="${esc(appUrl())}/#/alerts" style="color:#2347D9">Manage alerts</a> or
    <a href="${esc(unsub)}" style="color:#2347D9">unsubscribe from all alert emails</a>.`);
  const text = groups.map((g) => `${g.name}\n` + g.jobs.map((j) =>
    `- ${j.title} at ${j.company} (${j.city ?? 'Germany'})\n  Apply: ${safeUrl(j.apply_url)}`).join('\n')).join('\n\n')
    + `\n\nUnsubscribe from all alert emails: ${unsub}`;
  // RFC 8058 one-click unsubscribe, shown as "Unsubscribe" by Gmail and others.
  const headers = { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return { subject, html, text, headers };
};

export const sendSignInEmail = async (email, link, code) => {
  const html = layout(`
    <tr><td style="padding-top:16px;font:15px/1.6 Arial,sans-serif;color:#14161B">Your sign-in code for Firstapply:</td></tr>
    <tr><td style="padding-top:10px;font:700 32px/1.2 Arial,sans-serif;letter-spacing:6px;color:#14161B">${esc(code)}</td></tr>
    <tr><td style="padding-top:10px;font:14px/1.6 Arial,sans-serif;color:#4A5060">Type it into the Firstapply window where you asked to sign in. Or use the button, if you're in the same browser. Both work once and expire in 15 minutes.</td></tr>
    <tr><td style="padding-top:18px"><a href="${esc(link)}" style="display:inline-block;background:#2347D9;color:#fff;text-decoration:none;font:600 15px Arial,sans-serif;padding:11px 20px;border-radius:8px">Sign in to Firstapply</a></td></tr>`,
  'If you didn\'t ask to sign in, ignore this email. No account is created unless the code or link is used.');
  await sendMail({
    to: email,
    subject: `${code} is your Firstapply sign-in code`,
    html,
    text: `Your Firstapply sign-in code: ${code}\n\nType it into the Firstapply window where you asked to sign in, or open this link in the same browser:\n${link}\n\nBoth work once and expire in 15 minutes. If you didn't ask to sign in, ignore this email.`,
  });
};

/** Sends each user one email holding all their due matches, grouped by alert. */
export const sendPending = async ({ force = false } = {}) => {
  if (!mailProvider()) return { sent: 0, reason: 'email-not-configured' };
  // Two overlapping ticks must not both email the same matches.
  const lock = await acquireLock('email', 280);
  if (!lock) return { sent: 0, reason: 'already sending' };
  let sent = 0;
  const failures = [];
  try {
    await q(`UPDATE deliveries SET skipped = true WHERE sent_at IS NULL AND NOT skipped
             AND created_at < now() - make_interval(hours => $1)`, [MAX_AGE_HOURS]);

    const today = berlinDate();
    const digestDue = force || (berlinHour() >= DIGEST_HOUR && (await getSetting('lastDigest')) !== today);
    const rows = (await q(`
      SELECT d.alert_id, d.dedupe_key, a.name AS alert_name, a.frequency, u.id AS user_id, u.email AS user_email, j.*
      FROM deliveries d
        JOIN alerts a ON a.id = d.alert_id
        JOIN users u ON u.id = a.user_id
        JOIN jobs j ON j.id = d.job_id
      WHERE d.sent_at IS NULL AND NOT d.skipped AND a.enabled AND NOT u.emails_paused
      ORDER BY u.id, d.alert_id, j.posted_at DESC NULLS LAST
      LIMIT 5000`))
      .filter((r) => r.frequency === 'instant' || digestDue);

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { email: r.user_email, rows: [] });
      byUser.get(r.user_id).rows.push(r);
    }

    for (const [userId, { email, rows: userRows }] of byUser) {
      const groups = new Map();
      const seen = new Set();
      for (const r of userRows) {
        if (!groups.has(r.alert_id)) groups.set(r.alert_id, { name: r.alert_name, jobs: [] });
        if (seen.has(r.dedupe_key)) continue; // same job matched two alerts: show it once
        seen.add(r.dedupe_key);
        groups.get(r.alert_id).jobs.push(r);
      }
      try {
        await sendMail({ to: email, ...composeAlertEmail([...groups.values()].filter((g) => g.jobs.length), userId) });
        await q(`UPDATE deliveries d SET sent_at = now() FROM unnest($1::int[], $2::text[]) AS u(alert_id, dedupe_key)
                 WHERE d.alert_id = u.alert_id AND d.dedupe_key = u.dedupe_key`,
          [userRows.map((r) => r.alert_id), userRows.map((r) => r.dedupe_key)]);
        await q('UPDATE users SET last_email_at = now(), last_email_error = NULL WHERE id = $1', [userId]);
        sent += seen.size;
      } catch (err) {
        // One bad address must not stop everyone else's alerts.
        failures.push(userId);
        await q('UPDATE users SET last_email_error = $2 WHERE id = $1', [userId, err.message.slice(0, 300)]);
        console.error(`[alerts] email to user ${userId} failed:`, err.message);
      }
    }
    if (rows.some((r) => r.frequency === 'daily')) await setSetting('lastDigest', today);
    if (sent) console.log(`[alerts] emailed ${sent} jobs to ${byUser.size - failures.length} users`);
    return { sent, users: byUser.size, failed: failures.length };
  } finally {
    await releaseLock('email', lock).catch(() => {});
  }
};

const sampleEmail = async (userId) => {
  const jobs = await q(`SELECT * FROM jobs WHERE active AND dup_of IS NULL AND source = 'wsj' ORDER BY posted_at DESC LIMIT 2`);
  return composeAlertEmail([{ name: 'Test email: this is how alerts look', jobs }], userId);
};
export const previewEmailHtml = async (userId) => (await sampleEmail(userId)).html;

export const sendTestEmail = async (user) => {
  const { html, text, headers } = await sampleEmail(user.id);
  await sendMail({ to: user.email, subject: 'Firstapply test email', html, text, headers });
  return { to: user.email };
};

export const describeAlert = (filters) => describeFilters(parseFilters(filters));

export const alertCounts = async (alert) => {
  const params = [];
  const { where } = buildWhere(parseFilters(alert.filters), params);
  const week = await one(`SELECT count(*)::int AS n FROM jobs j WHERE ${where} AND j.posted_at >= now() - interval '7 days'`, params);
  const sent = await one('SELECT count(*)::int AS n FROM deliveries WHERE alert_id = $1 AND sent_at IS NOT NULL', [alert.id]);
  return { matchesLastWeek: week.n, sent: sent.n };
};
