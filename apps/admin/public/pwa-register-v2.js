(() => {
  if (!('serviceWorker' in navigator)) return;
  let registration;
  let activationPending = false;

  const isUpdateRefreshClick = (event) => {
    if (!(event.target instanceof Element)) return false;
    const button = event.target.closest('button');
    const alert = button?.closest('[role="alert"]');
    const heading = alert?.querySelector('h1')?.textContent?.trim();
    const label = button?.textContent?.trim();
    return (heading === '检测到新版本' || heading === 'Update ready')
      && (label === '刷新页面' || label === 'Refresh');
  };

  const activateUpdateWorker = (current) => {
    const worker = current?.waiting || current?.installing;
    if (!worker) return false;
    if (activationPending) return true;
    activationPending = true;
    let reloaded = false;
    const reloadOnce = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') reloadOnce();
    });
    try {
      worker.postMessage({ type: 'SKIP_WAITING' });
      window.setTimeout(reloadOnce, 4_000);
    } catch (error) {
      activationPending = false;
      throw error;
    }
    return true;
  };

  document.addEventListener('click', (event) => {
    if (!isUpdateRefreshClick(event)) return;
    try {
      if (!activateUpdateWorker(registration)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    } catch (error) {
      console.warn('PWA update activation failed', error);
    }
  }, true);

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw-v2.js', { scope: '/' })
      .then((current) => {
        registration = current;
        return current.update();
      })
      .catch((error) => console.warn('PWA update check failed', error));
  });
})();
