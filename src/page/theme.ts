/**
 * The theme setting: light (the default) or dark. It stays in this browser only.
 * The page loads this file in its head, so the theme is set before the first paint.
 */
(() => {
  const read = () => {
    try {
      return localStorage.getItem('tuloy-theme');
    } catch {
      return null; // a browser with no storage: the page stays light
    }
  };
  const dark = read() === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme');
    if (!button) return;
    // The button says what a click does.
    button.textContent = dark ? 'Light theme' : 'Dark theme';
    button.addEventListener('click', () => {
      try {
        localStorage.setItem('tuloy-theme', dark ? 'light' : 'dark');
      } catch {
        return;
      }
      // ponytail: a reload applies the theme. The 3D street reads its colours at its start, and the run that shows is in the address.
      location.reload();
    });
  });
})();
