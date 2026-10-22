// SPDX-License-Identifier: Apache-2.0
// Cenacle's service worker: web push only (no caching; the app is online).
// The server sends {title, body, url, tag} encrypted for this browser.
/* global self */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Cenacle', {
      body: data.body || '',
      tag: data.tag || undefined,
      data: { url: data.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  // Only our own pages are opened.
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === url.origin && 'focus' in w) {
          w.navigate(url.href).catch(() => undefined);
          return w.focus();
        }
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
