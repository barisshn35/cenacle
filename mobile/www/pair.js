// SPDX-License-Identifier: AGPL-3.0-only
// The pairing page of the mobile app: the address of the organization's
// Cenacle server. Once it answers as Cenacle, the app opens its web app (the
// server's own pages, sessions and updates), as the desktop app does.
(() => {
  const TEXTS = {
    en: {
      title: 'Connect to your server',
      lede: 'Enter the address of your organization’s Cenacle server.',
      address: 'Server address',
      example: 'For example chat.example.com',
      connect: 'Continue',
      connecting: 'Connecting…',
      next: 'You sign in on the next page.',
      recent: 'Recent servers',
      remove: 'Forget {{origin}}',
      errors: {
        invalid: 'That is not a server address.',
        insecure: 'The server must use https.',
        unreachable: 'The server cannot be reached. Check the address and your connection.',
        notCenacle: 'This server does not answer as Cenacle.',
      },
    },
    tr: {
      title: 'Sunucunuza bağlanın',
      lede: 'Kurumunuzun Cenacle sunucusunun adresini girin.',
      address: 'Sunucu adresi',
      example: 'Örneğin chat.example.com',
      connect: 'Devam',
      connecting: 'Bağlanılıyor…',
      next: 'Giriş bir sonraki sayfada yapılır.',
      recent: 'Son sunucular',
      remove: '{{origin}} sunucusunu unut',
      errors: {
        invalid: 'Bu bir sunucu adresi değil.',
        insecure: 'Sunucu https kullanmalıdır.',
        unreachable: 'Sunucuya ulaşılamıyor. Adresi ve bağlantınızı kontrol edin.',
        notCenacle: 'Bu sunucu Cenacle olarak yanıt vermiyor.',
      },
    },
  };
  const KEY = 'cenacle.servers';
  const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
  const lang = navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en';
  const texts = TEXTS[lang];
  const $ = (id) => document.getElementById(id);
  const fill = (s, v) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
  document.documentElement.lang = lang;

  /** The origin of an address as people type it; https unless it says otherwise. */
  function normalize(input) {
    const raw = input.trim();
    if (!raw || /\s/.test(raw)) return { error: 'invalid' };
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return { error: 'invalid' };
    }
    if (url.username || url.password || !url.hostname) return { error: 'invalid' };
    if (url.protocol === 'http:' && !LOCAL.has(url.hostname)) return { error: 'insecure' };
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' };
    return { origin: url.origin };
  }

  /** The server answers /api/meta as Cenacle does (fetched natively: no CORS). */
  async function check(origin) {
    let res;
    try {
      res = await fetch(`${origin}/api/meta`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return { error: 'unreachable' };
    }
    if (!res.ok) return { error: 'notCenacle' };
    try {
      const meta = await res.json();
      if (typeof meta?.web_app !== 'boolean') return { error: 'notCenacle' };
    } catch {
      return { error: 'notCenacle' };
    }
    return {};
  }

  const recent = () => {
    try {
      const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
      return Array.isArray(list) ? list.filter((o) => typeof o === 'string') : [];
    } catch {
      return [];
    }
  };
  const remember = (origin) => {
    const list = [origin, ...recent().filter((o) => o !== origin)].slice(0, 5);
    localStorage.setItem(KEY, JSON.stringify(list));
  };
  const forget = (origin) => {
    localStorage.setItem(KEY, JSON.stringify(recent().filter((o) => o !== origin)));
    showRecent();
  };

  $('title').textContent = texts.title;
  document.title = texts.title;
  $('lede').textContent = texts.lede;
  $('address-label').textContent = texts.address;
  $('example').textContent = texts.example;
  $('connect').textContent = texts.connect;
  $('next').textContent = texts.next;
  $('recent-title').textContent = texts.recent;

  function error(code) {
    const box = $('error');
    if (!code) {
      box.hidden = true;
      $('address').removeAttribute('aria-invalid');
      return;
    }
    box.textContent = texts.errors[code] ?? texts.errors.unreachable;
    box.hidden = false;
    $('address').setAttribute('aria-invalid', 'true');
  }

  async function connect(address) {
    const button = $('connect');
    error(null);
    const n = normalize(address);
    if (n.error) {
      error(n.error);
      $('address').focus();
      return;
    }
    button.disabled = true;
    button.textContent = texts.connecting;
    const result = await check(n.origin);
    button.disabled = false;
    button.textContent = texts.connect;
    if (result.error) {
      error(result.error);
      $('address').focus();
      return;
    }
    remember(n.origin);
    location.replace(`${n.origin}/`);
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    void connect($('address').value);
  });

  function showRecent() {
    const list = recent();
    const ul = $('recent-list');
    ul.replaceChildren();
    $('recent').hidden = list.length === 0;
    for (const origin of list) {
      const host = new URL(origin).host;
      const li = document.createElement('li');
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'use';
      use.textContent = host;
      use.addEventListener('click', () => {
        $('address').value = origin;
        void connect(origin);
      });
      const gone = document.createElement('button');
      gone.type = 'button';
      gone.className = 'forget';
      gone.textContent = '×';
      gone.setAttribute('aria-label', fill(texts.remove, { origin: host }));
      gone.addEventListener('click', () => forget(origin));
      li.append(use, gone);
      ul.append(li);
    }
  }
  showRecent();
})();
