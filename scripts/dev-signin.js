// Dev helper: runs the app on a throwaway database and prints a sign-in link, so the
// email sign-in flow can be tested in a browser without sending an email.
// Usage: node --env-file=.env scripts/dev-signin.js you@example.com
process.env.PGLITE_DIR = 'data/pglite-dev-signin';
delete process.env.DATABASE_URL;
process.env.APP_URL = 'http://localhost:4390';

const { app } = await import('../src/app.js');
const { createLoginToken } = await import('../src/auth.js');
const express = (await import('express')).default;
app.use(express.static('public'));
app.listen(4390, async () => {
  const { token, code } = await createLoginToken(process.argv[2] || 'test@example.com');
  console.log(`open: http://localhost:4390/signin.html#t=${token}  (or code ${code})`);
});
