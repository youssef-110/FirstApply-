// Completes an email sign-in link. The token is in the URL fragment (#t=…), which browsers
// never send to servers, and it's posted once by script so link scanners can't use it up.
(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  history.replaceState(null, '', '/signin.html'); // drop the token from the address bar and history
  const show = (title, text) => {
    document.getElementById('title').textContent = title;
    document.getElementById('text').textContent = text;
    document.getElementById('action').hidden = false;
  };
  if (!token) return show('Link incomplete', 'This sign-in link is missing its code. Copy the whole link from the email, or request a new one.');
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return show('Sign-in link not valid', data.error || 'Request a new sign-in link and try again.');
    location.replace('/#/jobs');
  } catch {
    show('Connection problem', 'Check your connection and open the link from the email again.');
  }
})();
