import { getSetting, one, q, setSetting } from './db.js';
import { parseFilters } from './filters.js';

/**
 * Idempotent setup data. Creates the admin account (ADMIN_EMAIL) and moves anything left
 * over from the single-owner version (alerts without a user, the old job_status table)
 * onto it, so nothing the owner saved is lost.
 */
export const seed = async () => {
  // Settings from the single-user version, which stored an alert address; no longer read.
  await q("DELETE FROM settings WHERE key IN ('email', 'lastEmail', 'lastEmailError')");
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const admin = await one(`INSERT INTO users (email, terms_accepted_at) VALUES ($1, now())
    ON CONFLICT (email) DO UPDATE SET email = excluded.email RETURNING id`, [email]);

  await q('UPDATE alerts SET user_id = $1 WHERE user_id IS NULL', [admin.id]);
  if (await one("SELECT 1 FROM information_schema.tables WHERE table_name = 'job_status'")) {
    await q(`INSERT INTO user_job_status (user_id, job_id, status, notes, applied_at, updated_at)
             SELECT $1, job_id, status, notes, applied_at, updated_at FROM job_status
             ON CONFLICT DO NOTHING`, [admin.id]);
  }

  if ((await getSetting('seeded')) || (await one('SELECT 1 FROM alerts LIMIT 1'))) return;
  const filters = parseFilters({
    cities: ['Berlin'],
    fields: ['tech'],
    subFields: ['software-engineering', 'ai-ml', 'it-support', 'cloud-devops', 'data-engineering',
      'embedded-systems', 'cybersecurity', 'qa-testing', 'data-analytics'],
  });
  await q('INSERT INTO alerts (user_id, name, filters, frequency) VALUES ($1, $2, $3, $4)',
    [admin.id, 'Berlin tech student jobs', JSON.stringify(filters), 'instant']);
  await setSetting('seeded', '1');
};
