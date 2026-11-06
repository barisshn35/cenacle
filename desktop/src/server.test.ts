// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.30.0' }, net: {} }));
const { normalize, olderThan, privacyUrlOf } = await import('./server.js');

describe('normalize', () => {
  it('takes addresses as people type them, https unless said otherwise', () => {
    expect(normalize('chat.example.com')).toEqual({ origin: 'https://chat.example.com' });
    expect(normalize(' https://chat.example.com/c/general?x=1 ')).toEqual({
      origin: 'https://chat.example.com',
    });
    expect(normalize('chat:8443')).toEqual({ origin: 'https://chat:8443' });
    expect(normalize('http://localhost:15173')).toEqual({ origin: 'http://localhost:15173' });
  });
  it('refuses plain http beyond this computer and odd addresses', () => {
    expect(normalize('http://chat.example.com')).toEqual({ error: 'insecure' });
    expect(normalize('ftp://chat.example.com')).toEqual({ error: 'invalid' });
    expect(normalize('https://user:pass@chat.example.com')).toEqual({ error: 'invalid' });
    expect(normalize('chat example')).toEqual({ error: 'invalid' });
    expect(normalize('')).toEqual({ error: 'invalid' });
  });
});

describe('olderThan', () => {
  it('compares release versions', () => {
    expect(olderThan('0.30.0', '0.30.1')).toBe(true);
    expect(olderThan('0.30.1', '0.30.0')).toBe(false);
    expect(olderThan('0.30.0', '0.30.0')).toBe(false);
    expect(olderThan('0.9.9', '0.10.0')).toBe(true);
    expect(olderThan('1.0.0-rc.1', '0.99.0')).toBe(false);
  });
});

describe('privacyUrlOf', () => {
  const meta = { web_app: true, desktop_min_version: '' };
  it('takes the http(s) address the server names', () => {
    expect(privacyUrlOf({ ...meta, privacy_url: 'https://example.com/privacy' })).toBe(
      'https://example.com/privacy',
    );
  });
  it('ignores none, odd values and other schemes', () => {
    expect(privacyUrlOf(meta)).toBeNull();
    expect(privacyUrlOf({ ...meta, privacy_url: '' })).toBeNull();
    expect(privacyUrlOf({ ...meta, privacy_url: 'javascript:alert(1)' })).toBeNull();
    expect(privacyUrlOf({ ...meta, privacy_url: 'file:///etc/passwd' })).toBeNull();
    expect(privacyUrlOf({ ...meta, privacy_url: 42 as unknown as string })).toBeNull();
  });
});
