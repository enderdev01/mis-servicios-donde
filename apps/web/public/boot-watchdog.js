/* global document, window */
// The app bundle failed to arrive: say so instead of promising a load that will not happen.
const pending = document.querySelector('#answer');
const initialText = pending?.textContent;
window.setTimeout(() => {
  if (pending && pending.textContent === initialText) pending.textContent = 'No pudimos cargar la app. Revisa tu conexión y recarga.';
}, 15_000);
