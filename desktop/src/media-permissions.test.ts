// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import { hardenSession } from './security.js';

function fixture() {
  let request!: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  let check!: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  const session = {
    setPermissionRequestHandler: (value: typeof request) => {
      request = value;
    },
    setPermissionCheckHandler: (value: typeof check) => {
      check = value;
    },
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(),
  } as unknown as Session;
  const prompt = vi.fn().mockResolvedValue(true);
  hardenSession(session, {
    allowNotifications: false,
    media: {
      trusted: (_wc, url, top) => top && url.startsWith('https://chat.example.test/'),
      request: prompt,
      display: (_request, callback) => callback(null),
    },
  });
  const wc = {} as WebContents;
  return { request, check, prompt, wc };
}
describe('desktop media permission mediation', () => {
  it('prompts for voice recording, not only camera calls', async () => {
    const f = fixture();
    const callback = vi.fn();
    f.request(f.wc, 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'https://chat.example.test/c/one',
      mediaTypes: ['audio'],
    });
    await Promise.resolve();
    expect(f.prompt).toHaveBeenCalledWith(f.wc, ['audio']);
    expect(callback).toHaveBeenCalledWith(true);
  });
  it('leaves screen capture (a request with no device types) to the picker', () => {
    const f = fixture();
    const callback = vi.fn();
    f.request(f.wc, 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'https://chat.example.test/c/one',
      mediaTypes: [],
    });
    expect(callback).toHaveBeenCalledWith(true);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it('rejects subframes and identity-provider windows without prompting', () => {
    const f = fixture();
    for (const details of [
      {
        isMainFrame: false,
        requestingUrl: 'https://chat.example.test/c/one',
        mediaTypes: ['audio'],
      },
      { isMainFrame: true, requestingUrl: 'https://id.example.test/login', mediaTypes: ['audio'] },
      { isMainFrame: false, requestingUrl: 'https://chat.example.test/c/one', mediaTypes: [] },
      { isMainFrame: true, requestingUrl: 'https://id.example.test/login', mediaTypes: [] },
    ]) {
      const callback = vi.fn();
      f.request(f.wc, 'media', callback, details);
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it('never bypasses consent through the permission-check path or grants unrelated devices', () => {
    const f = fixture();
    expect(f.check(f.wc, 'media', 'https://chat.example.test', { isMainFrame: true })).toBe(false);
    for (const permission of ['geolocation', 'usb', 'hid', 'serial'] as const) {
      const callback = vi.fn();
      f.request(f.wc, permission, callback, {
        isMainFrame: true,
        requestingUrl: 'https://chat.example.test/c/one',
      });
      expect(callback).toHaveBeenCalledWith(false);
    }
  });
});
