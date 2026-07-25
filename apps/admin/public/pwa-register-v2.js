(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw-v2.js', { scope: '/' })
      .then((registration) => registration.update())
      .catch((error) => console.warn('PWA update check failed', error));
  });
})();
