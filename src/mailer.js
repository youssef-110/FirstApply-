// Email through Resend (https://resend.com). Without a verified domain, Resend only
// delivers from onboarding@resend.dev to the address that owns the Resend account.

const from = () => process.env.MAIL_FROM || 'Firstapply <onboarding@resend.dev>';

export const mailProvider = () => (process.env.RESEND_API_KEY ? 'resend' : null);

export const sendMail = async ({ to, subject, html, text, headers }) => {
  if (!process.env.RESEND_API_KEY) throw new Error('Email is not set up: RESEND_API_KEY is missing.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from(), to: [to], subject, html, text, ...(headers ? { headers } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${body.message ?? 'unknown error'}`);
  return body;
};
