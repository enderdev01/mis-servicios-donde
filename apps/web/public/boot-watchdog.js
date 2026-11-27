/* global document, window */
// The app bundle failed to arrive: say so instead of promising a load that will not happen.
// The app script sets data-app-booted on <html> as soon as it runs, so a slow API never trips this.
const pending = document.querySelector('#answer');
const initialText = pending?.textContent;
window.setTimeout(() => {
  if (document.documentElement.dataset.appBooted) return;
  if (pending && pending.textContent === initialText) pending.textContent = 'No pudimos cargar la app. Revisa tu conexión y recarga.';
}, 15_000);
