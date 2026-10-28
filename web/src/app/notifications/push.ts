// SPDX-License-Identifier: AGPL-3.0-only
import { apiFetch } from '@cenacle/core/api';

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Web push works in this browser (a service worker and the Push API). */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    window.isSecureContext
  );
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/**
 * Subscribes this browser to web push (asks for permission first) and tells
 * the server. Returns false when the person declined.
 */
export async function enablePush(publicKey: string): Promise<boolean> {
  if (!pushSupported()) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  const body = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await apiFetch<void>(
    '/api/me/push-subscriptions',
    json({ endpoint: body.endpoint, keys: body.keys }, 'POST'),
  );
  return true;
}

/**
 * Tells the server again about this browser's existing subscription (no
 * prompt). Subscriptions belong to a session, so a new sign-in renews them.
 */
export async function renewPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const body = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await apiFetch<void>(
    '/api/me/push-subscriptions',
    json({ endpoint: body.endpoint, keys: body.keys }, 'POST'),
  ).catch(() => undefined);
}

/** Stops web push in this browser. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await apiFetch<void>(
    '/api/me/push-subscriptions',
    json({ endpoint: sub.endpoint }, 'DELETE'),
  ).catch(() => undefined);
  await sub.unsubscribe();
}
