// SPDX-License-Identifier: AGPL-3.0-only
// Shown while the server cannot be reached; the app keeps trying on its own.
(async () => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  document.documentElement.lang = params.get('lang') ?? 'en';
  document.documentElement.dir = params.get('lang') === 'ar' ? 'rtl' : 'ltr';
  const host = params.get('host') ?? '';

  const texts = (await window.cenacleLocal.texts()).offline;
  const title = texts.title.replace('{{host}}', host);
  $('title').textContent = title;
  document.title = title;
  $('lede').textContent = texts.lede;
  $('retry').textContent = texts.retry;
  $('change').textContent = texts.changeServer;
  $('retry').addEventListener('click', () => window.cenacleLocal.retry());
  $('change').addEventListener('click', () => window.cenacleLocal.changeServer());
})();
