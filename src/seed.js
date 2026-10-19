import { getSetting, one, q, setSetting } from './db.js';
import { parseFilters } from './filters.js';

/** First-run defaults: alert email and a Berlin tech alert. Safe to run repeatedly. */
export const seed = async () => {
  if (!(await getSetting('email'))) await setSetting('email', process.env.ALERT_EMAIL || 'youssef990yy7@gmail.com');
  if ((await getSetting('seeded')) || (await one('SELECT 1 FROM alerts LIMIT 1'))) return;
  const filters = parseFilters({
    cities: ['Berlin'],
    fields: ['tech'],
    subFields: ['software-engineering', 'ai-ml', 'it-support', 'cloud-devops', 'data-engineering',
      'embedded-systems', 'cybersecurity', 'qa-testing', 'data-analytics'],
  });
  await q('INSERT INTO alerts (name, filters, frequency) VALUES ($1, $2, $3)', ['Berlin tech student jobs', JSON.stringify(filters), 'instant']);
  await setSetting('seeded', '1');
};
