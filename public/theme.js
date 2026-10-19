// Runs before first paint so a saved theme never flashes the wrong colors.
try {
  const t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow the system setting */ }
