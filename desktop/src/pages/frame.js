// SPDX-License-Identifier: AGPL-3.0-only
// The bar of a window for others' pages: back, reload and the page's address.
(async () => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  document.documentElement.lang = params.get('lang') ?? 'en';
  const api = window.cenacleLocal;
  const texts = await api.frameTexts();
  $('back').setAttribute('aria-label', texts.back);
  $('back').title = texts.back;
  $('reload').setAttribute('aria-label', texts.reload);
  $('reload').title = texts.reload;
  $('back').addEventListener('click', () => api.back());
  $('reload').addEventListener('click', () => api.reload());
  api.onFrame((page) => {
    $('host').textContent = page.host;
    document.title = page.host;
    $('lock').hidden = !page.secure;
    $('lock').setAttribute('aria-label', page.secure ? texts.secure : texts.insecure);
    $('back').hidden = !page.browse;
    $('back').disabled = !page.canGoBack;
    $('reload').hidden = !page.browse;
  });
})();
