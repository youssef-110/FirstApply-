// Sends email through Gmail (GMAIL_USER + GMAIL_APP_PASSWORD) when configured, otherwise
// through Resend (RESEND_API_KEY).
//
// Gmail needs no domain and can email anyone (about 500 emails a day). Resend without a
// verified domain only delivers to the address that owns the Resend account.
import nodemailer from 'nodemailer';

let gmail;
const gmailTransport = () => {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  gmail ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return gmail;
};

export const mailProvider = () => (gmailTransport() ? 'gmail' : process.env.RESEND_API_KEY ? 'resend' : null);

export const sendMail = async ({ to, subject, html, text, headers }) => {
  const transport = gmailTransport();
  if (transport) {
    // Gmail only sends as the signed-in account, so the From address is always GMAIL_USER.
    await transport.sendMail({ from: { name: 'Firstapply', address: process.env.GMAIL_USER }, to, subject, html, text, headers });
    return;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('Email is not set up on this server.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Firstapply <onboarding@resend.dev>',
      to: [to], subject, html, text, ...(headers ? { headers } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The email provider refused the email (${res.status}): ${body.message ?? 'unknown error'}`);
};
