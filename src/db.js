// Postgres access. Production uses Neon's HTTP driver (DATABASE_URL); local development
// without DATABASE_URL uses PGlite, an in-process Postgres stored in data/pglite.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id            text PRIMARY KEY,           -- "<source>:<source_id>"
    source        text NOT NULL,
    source_id     text NOT NULL,
    title         text NOT NULL,
    company       text NOT NULL,
    company_logo  text,
    city          text,
    state         text,
    lat double precision, lng double precision,
    types         jsonb NOT NULL DEFAULT '[]', -- working_student | internship | thesis
    field         text,
    sub_field     text,
    working_mode  text,                        -- remote | hybrid | onsite | unknown
    german        text NOT NULL DEFAULT 'unknown', -- required | optional | not_required | unknown
    english       text NOT NULL DEFAULT 'unknown',
    salary_min double precision, salary_max double precision, salary_currency text, salary_period text,
    skills        jsonb NOT NULL DEFAULT '[]',
    url           text NOT NULL,
    apply_url     text NOT NULL,
    posted_at     timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    active        boolean NOT NULL DEFAULT true,
    dedupe_key    text NOT NULL,
    dup_of        text                         -- set when another source already lists the same job
  );
  CREATE INDEX IF NOT EXISTS jobs_feed ON jobs (posted_at DESC) WHERE active AND dup_of IS NULL;
  CREATE INDEX IF NOT EXISTS jobs_city ON jobs (city);
  CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key);
  CREATE INDEX IF NOT EXISTS jobs_source_seen ON jobs (source, last_seen_at);

  CREATE TABLE IF NOT EXISTS job_status (
    job_id     text PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    status     text NOT NULL,   -- saved | applied | interviewing | offer | rejected | hidden
    notes      text NOT NULL DEFAULT '',
    applied_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    filters    jsonb NOT NULL,
    frequency  text NOT NULL DEFAULT 'instant', -- instant | daily
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    alert_id   integer NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    dedupe_key text NOT NULL,
    job_id     text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz,
    skipped    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (alert_id, dedupe_key)
  );

  CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);

  -- Accounts (passwordless: sign-in links are sent by email)
  CREATE TABLE IF NOT EXISTS users (
    id                serial PRIMARY KEY,
    email             text NOT NULL UNIQUE,            -- stored lower-case
    created_at        timestamptz NOT NULL DEFAULT now(),
    terms_accepted_at timestamptz,
    last_login_at     timestamptz,
    session_version   integer NOT NULL DEFAULT 1,      -- bump to sign out every device
    emails_paused     boolean NOT NULL DEFAULT false,  -- set by the unsubscribe link
    last_email_at     timestamptz,
    last_email_error  text
  );

  CREATE TABLE IF NOT EXISTS login_tokens (
    token_hash text PRIMARY KEY,                       -- sha256 of the emailed token
    email      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
  );

  CREATE TABLE IF NOT EXISTS rate_events (key text NOT NULL, at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS rate_events_key ON rate_events (key, at);

  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS alerts_user ON alerts (user_id);

  CREATE TABLE IF NOT EXISTS user_job_status (
    user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id     text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status     text NOT NULL,   -- saved | applied | interviewing | offer | rejected | hidden
    notes      text NOT NULL DEFAULT '',
    applied_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, job_id)
  );
`;

let runner;
const connect = async () => {
  if (process.env.DATABASE_URL) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    return (text, params = []) => sql.query(text, params);
  }
  if (process.env.VERCEL) throw new Error('DATABASE_URL is not set');
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create(process.env.PGLITE_DIR || 'data/pglite');
  return async (text, params = []) => (await pg.query(text, params)).rows;
};

const runSchema = async () => {
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await runner(stmt);
};

let ready;
const init = async () => {
  runner = await connect();
  // On Vercel the schema is created once by `npm run db:setup`, not on every cold start.
  if (!process.env.VERCEL) await runSchema();
};

/** Runs one parameterized statement ($1, $2, …) and returns the rows. */
export const q = async (text, params) => {
  ready ??= init().catch((err) => { ready = null; throw err; });
  await ready;
  return runner(text, params);
};
/** Creates tables and indexes (idempotent). */
export const migrate = async () => { await q('SELECT 1'); await runSchema(); };
export const one = async (text, params) => (await q(text, params))[0] ?? null;

export const getSetting = async (key, fallback = null) =>
  (await one('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? fallback;

export const setSetting = (key, value) =>
  q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, String(value)]);

/**
 * Lease-style lock stored in settings, so two overlapping cron runs never sync the same
 * source at once. Works across serverless instances, unlike an in-memory flag.
 */
export const acquireLock = async (name, ttlSeconds) => {
  const row = await one(`
    INSERT INTO settings (key, value) VALUES ($1, clock_timestamp()::text)
    ON CONFLICT (key) DO UPDATE SET value = clock_timestamp()::text
      WHERE settings.value::timestamptz < now() - make_interval(secs => $2)
    RETURNING value`, [`lock:${name}`, ttlSeconds]);
  return row?.value ?? null; // the token proves ownership when releasing
};
/** Releases only our own lease, never one a later run took over after ours expired. */
export const releaseLock = (name, token) => q('DELETE FROM settings WHERE key = $1 AND value = $2', [`lock:${name}`, token]);
