// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { deepLinkTarget, issuerOrigin, returnPath } from './security.js';

const server = 'https://chat.example.com';

describe('deepLinkTarget', () => {
  it('opens pages of the paired server', () => {
    expect(deepLinkTarget('cenacle://open/c/general', server)).toBe(
      'https://chat.example.com/c/general',
    );
    expect(deepLinkTarget('cenacle://open/c/general?m=42', server)).toBe(
      'https://chat.example.com/c/general?m=42',
    );
  });

  it('reads other sites in the path as paths of the paired server', () => {
    for (const link of [
      'cenacle://open//evil.example/c',
      'cenacle://open/\\evil.example/c',
      'cenacle://open/%2F%2Fevil.example',
    ]) {
      expect(new URL(deepLinkTarget(link, server) ?? 'about:blank').origin, link).toBe(server);
    }
  });

  it('never leads to the API, the WebSocket or anywhere else', () => {
    for (const link of [
      'cenacle://open/api/me/export',
      'cenacle://open/API/auth/logout',
      'cenacle://open/%61pi/me',
      'cenacle://open/c/../api/me',
      'cenacle://open/c/%2e%2e/api/me',
      'cenacle://open/ws',
      'cenacle://open/%E0%A4%A',
      'cenacle://evil.example/c/general',
      'https://chat.example.com/c/general',
      'javascript:alert(1)',
      'not a link',
    ]) {
      expect(deepLinkTarget(link, server), link).toBeNull();
    }
    expect(deepLinkTarget('cenacle://open/c/general', '')).toBeNull();
  });

  // Random links built from the characters that confuse URL parsers: whatever
  // comes out is a page of the paired server, never its API.
  it('holds for random links', () => {
    const parts = [
      '/',
      '\\',
      '//',
      '@',
      ':',
      '.',
      '..',
      '%2e',
      '%2f',
      '%5c',
      '%61',
      '%',
      '?',
      '#',
      'api',
      'API',
      'ws',
      'evil.example',
      'chat.example.com',
      'c',
      'open',
      ' ',
      '\t',
      '\n',
      'ı',
      '%00',
    ];
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 20000; i++) {
      let tail = '';
      const n = 1 + Math.floor(random() * 8);
      for (let j = 0; j < n; j++) tail += parts[Math.floor(random() * parts.length)];
      const link = (random() < 0.9 ? 'cenacle://open' : 'cenacle://') + tail;
      const target = deepLinkTarget(link, server);
      if (target === null) continue;
      const url = new URL(target);
      expect(url.origin, link).toBe(server);
      expect(decodeURIComponent(url.pathname), link).not.toMatch(/^[/\\]*(api|ws)([/\\]|$)/i);
    }
  });
});

describe('returnPath', () => {
  it('keeps paths of the paired server', () => {
    expect(returnPath('/c/general?m=1#x', server)).toBe('/c/general?m=1#x');
  });
  it('never names another site', () => {
    for (const to of [
      '//evil.example/',
      '/\\evil.example/',
      '/\\/evil.example',
      'https://evil.example',
      'c/general',
      42,
      null,
    ]) {
      expect(returnPath(to, server), String(to)).toBe('/');
    }
  });
});

describe('issuerOrigin', () => {
  const login = `${server}/api/auth/login?desktop=x&return_to=%2F`;
  it('takes the redirect of the server sign-in to Cenacle ID', () => {
    expect(issuerOrigin(server, login, 'https://id.example.com/auth?client_id=chat')).toBe(
      'https://id.example.com',
    );
  });
  it('ignores every page the sign-in visits after that', () => {
    for (const [from, to] of [
      // Cenacle ID sending the person on to an organization's own provider
      ['https://id.example.com/interaction/abc', 'https://evil.example/login'],
      // a link on any page of the sign-in
      ['https://evil.example/login', 'https://evil.example/next'],
      // other pages of the server
      [`${server}/api/auth/callback?code=1`, 'https://evil.example/'],
      [`${server}/signin`, 'https://evil.example/'],
      // the server itself, and what is not a web page
      [login, `${server}/desktop/signed-in?code=1`],
      [login, 'javascript:alert(1)'],
      ['not a url', 'https://id.example.com/'],
    ] as const) {
      expect(issuerOrigin(server, from, to), `${from} -> ${to}`).toBeNull();
    }
  });
});
