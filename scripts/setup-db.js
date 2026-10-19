// Creates the schema, seeds defaults and runs the first full import.
// Usage: DATABASE_URL=... node scripts/setup-db.js
import { migrate, q } from '../src/db.js';
import { seed } from '../src/seed.js';
import { syncSource } from '../src/sync.js';

await q('SELECT 1'); // connect
await migrate();
await seed();
console.log('schema ready, importing jobs (takes about a minute)…');
console.log(await syncSource('wsj', { full: true }));
console.log(await syncSource('ba'));
process.exit(0);
