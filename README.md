# Firstapply

Working student jobs, internships and theses across Germany. Search and filter by city, field, tech area, work mode and German/English requirements, track what you applied to, and get an email with the apply link as soon as a job matching your alerts is posted.

**Live site:** https://firstapply-kappa.vercel.app

Anyone can browse jobs. Creating a free account (email sign-in link, no password) unlocks saved jobs, the application tracker and email alerts. Each account's data is private to it, and users can download or delete their data at any time. Imprint, privacy policy and terms of use are in `public/legal/`.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:4380. Without `DATABASE_URL`, data lives in an embedded Postgres (PGlite) under `data/pglite`. The first start imports all current jobs (about a minute).

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string (production) |
| `RESEND_API_KEY` | Sends alert emails through Resend |
| `MAIL_FROM` | Sender, e.g. `Firstapply <alerts@yourdomain.com>`. Resend needs a verified domain to email anyone but the Resend account owner, so sign-up only works for other people once a domain is verified |
| `ADMIN_EMAIL` | Your account: sees job-source status and can trigger a manual check; owns data migrated from the single-user version |
| `SESSION_SECRET` | Signs session cookies (32+ characters). Changing it signs everyone out |
| `CRON_SECRET` | Scheduler calls send `Authorization: Bearer <CRON_SECRET>` (32+ characters) |
| `APP_URL` | Public URL, used for links in emails |
| `DIGEST_HOUR` | Hour (Berlin time) for daily-digest alerts, default 8 |

## How checking works

`/api/cron/tick` runs every 5 minutes (triggered by Upstash QStash; Vercel Cron runs a full pass once a day as a backup). Each tick first fetches the newest postings from the source and compares them with the previous tick. The database is only woken when something changed, which keeps Neon's free compute allowance intact. Every 2 hours the Bundesagentur list is synced, and twice a day a full pass marks closed jobs.

The first import never sends emails. Only jobs found after that count as new.

## Deploy (Vercel)

1. Attach Neon to the Vercel project (sets `DATABASE_URL`) and set the variables above.
2. After deploying, `POST /api/cron/setup` with `Authorization: Bearer <CRON_SECRET>` creates or migrates the schema and runs the first import (add `?import=0` to only migrate).
3. `vercel deploy --prod`.

## Tests

`npm test` runs the account and privacy checks (data isolation between users, single-use sign-in links, unsubscribe, export, deletion) against a throwaway local database.

## Sources

| Source | What it gives | Notes |
| --- | --- | --- |
| [workingstudentjobs.de API](https://www.workingstudentjobs.de/api/v1/jobs) | ~20k jobs with field, tech area, work mode, German/English requirement, salary, skills | Public API, allowed in their robots.txt. Apply links redirect to the employer posting. |
| [Bundesagentur für Arbeit](https://www.arbeitsagentur.de/jobsuche/) | ~3.5k extra Werkstudent jobs | No language data, so these show "Language not stated". Field is inferred from the title. |

The same job listed on both sources is shown once (matched on company, title and city).
