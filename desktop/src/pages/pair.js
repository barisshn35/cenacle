// SPDX-License-Identifier: AGPL-3.0-only
// The pairing page: the address of the organization's Cenacle server.
(async () => {
  const $ = (id) => document.getElementById(id);
  const fill = (s, v) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
  const params = new URLSearchParams(location.search);
  document.documentElement.lang = params.get('lang') ?? 'en';

  const api = window.cenacleLocal;
  const texts = await api.texts();
  $('title').textContent = texts.title;
  document.title = texts.title;
  $('lede').textContent = texts.lede;
  $('address-label').textContent = texts.address;
  $('example').textContent = texts.example;
  $('connect').textContent = texts.connect;
  $('next').textContent = texts.next;
  $('recent-title').textContent = texts.recent;

  const error = (code, version) => {
    const box = $('error');
    if (!code) {
      box.hidden = true;
      $('address').removeAttribute('aria-invalid');
      return;
    }
    box.textContent = fill(texts.errors[code] ?? texts.errors.unreachable, {
      version: version ?? '',
    });
    box.hidden = false;
    $('address').setAttribute('aria-invalid', 'true');
  };

  // A new server with a privacy policy: shown before going on.
  function showConfirm(host) {
    $('title').textContent = fill(texts.confirmTitle, { host });
    $('lede').hidden = true;
    $('form').hidden = true;
    $('recent').hidden = true;
    $('confirm').hidden = false;
    $('continue').focus();
  }

  function showForm() {
    $('title').textContent = texts.title;
    $('lede').hidden = false;
    $('form').hidden = false;
    $('confirm').hidden = true;
    void api.recent().then(showRecent);
    $('address').focus();
  }

  $('confirm-lede').textContent = texts.confirmLede;
  $('privacy').textContent = `${texts.privacy} `;
  const note = document.createElement('span');
  note.className = 'hint';
  note.textContent = texts.privacyNote;
  $('privacy').append(note);
  $('continue').textContent = texts.continue;
  $('other').textContent = texts.otherAddress;
  $('privacy').addEventListener('click', () => void api.privacy());
  $('continue').addEventListener('click', () => void api.continue());
  $('other').addEventListener('click', () => {
    void api.cancel();
    showForm();
  });

  async function connect(address) {
    const button = $('connect');
    button.disabled = true;
    button.textContent = texts.connecting;
    error(null);
    const result = await api.connect(address);
    button.disabled = false;
    button.textContent = texts.connect;
    if (result && 'error' in result) {
      error(result.error, result.version);
      $('address').focus();
    } else if (result && 'confirm' in result) {
      showConfirm(result.confirm);
    }
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    void connect($('address').value);
  });

  function showRecent(list) {
    const ul = $('recent-list');
    ul.replaceChildren();
    $('recent').hidden = list.length === 0;
    for (const r of list) {
      const host = new URL(r.origin).host;
      const li = document.createElement('li');
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'use';
      use.textContent = host;
      use.addEventListener('click', () => {
        $('address').value = r.origin;
        void connect(r.origin);
      });
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'forget';
      forget.textContent = '×';
      forget.setAttribute('aria-label', fill(texts.remove, { origin: host }));
      forget.addEventListener('click', async () => showRecent(await api.forget(r.origin)));
      li.append(use, forget);
      ul.append(li);
    }
  }
  showRecent(await api.recent());
})();
