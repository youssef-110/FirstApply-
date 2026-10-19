// Local development server. On Vercel, api/index.js exports the same app instead.
import express from 'express';
import { resolve } from 'node:path';
import { app } from './app.js';
import { tick } from './sync.js';
import { seed } from './seed.js';

const PORT = Number(process.env.PORT || 4380);
app.use(express.static(resolve('public'), { extensions: ['html'] }));

await seed();
app.listen(PORT, '127.0.0.1', () => console.log(`Firstapply running at http://localhost:${PORT}`));

// Same schedule as production: a tick every 5 minutes. The first tick runs a full import.
const run = (opts) => tick(opts).catch((err) => console.error('[tick]', err.message));
run({ force: true });
setInterval(run, 5 * 60_000);
