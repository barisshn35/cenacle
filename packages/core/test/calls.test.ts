// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, afterEach } from 'vitest';
import { candidateAllowed, ownIceServers, publicSDP, signalingURL } from '../src/calls/session';
import { calls, type CallAdmission } from '../src/calls/api';

afterEach(() => vi.unstubAllGlobals());
describe('same-origin call signaling', () => {
  it('keeps credentials out of URLs and refuses caller-supplied signaling origins', () => {
    vi.stubGlobal('location', new URL('https://chat.example.test/channels/one'));
    expect(signalingURL('/media/ws')).toBe('wss://chat.example.test/media/ws');
    for (const path of [
      'https://other.test/media/ws',
      '//other.test/media/ws',
      '/media/ws?token=secret',
    ]) {
      expect(() => signalingURL(path)).toThrow();
    }
  });
  it('refuses insecure production signaling', () => {
    vi.stubGlobal('location', new URL('http://chat.example.test/'));
    expect(() => signalingURL('/media/ws')).toThrow('call_secure_context_required');
  });
  it('uses no STUN fallback and accepts only the configured TURN port profiles', () => {
    const admission: CallAdmission = {
      token: '',
      expires_in: 60,
      signaling_path: '/media/ws',
      participant_id: 'p',
    };
    expect(ownIceServers(admission)).toEqual([]);
    expect(() =>
      ownIceServers({ ...admission, ice_servers: [{ urls: 'stun:public.test:3478' }] }),
    ).toThrow();
    expect(() =>
      ownIceServers({ ...admission, ice_servers: [{ urls: 'turn:own.test:80?transport=udp' }] }),
    ).toThrow();
    expect(
      ownIceServers({ ...admission, ice_servers: [{ urls: 'turns:own.test:5349?transport=tcp' }] }),
    ).toHaveLength(1);
  });
});
describe('candidate disclosure and forbidden targets', () => {
  const candidate = (ip: string) => `candidate:1 1 udp 2122260223 ${ip} 50000 typ host`;
  it('omits hostnames and restricted IPs without invoking DNS', () => {
    for (const ip of [
      'host.local',
      '127.0.0.1',
      '169.254.1.2',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'ff02::1',
    ]) {
      expect(candidateAllowed(candidate(ip))).toBe(false);
    }
    expect(candidateAllowed(candidate('192.168.1.2'))).toBe(true);
    expect(candidateAllowed(candidate('2001:db8::1'))).toBe(true);
    const sdp = `v=0\r\na=${candidate('host.local')}\r\na=${candidate('192.168.1.2')}\r\n`;
    expect(publicSDP(sdp)).not.toContain('host.local');
    expect(publicSDP(sdp)).toContain('192.168.1.2');
  });
});
describe('call API', () => {
  it('uses a body credential endpoint without cache or cross-origin cookies', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 'one-use' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await calls.admit('call-id');
    expect(fetch).toHaveBeenCalledWith(
      '/api/calls/call-id/token',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    );
  });
});
