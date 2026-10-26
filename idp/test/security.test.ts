// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { isSameOriginPost, pageSecurityHeaders } from '../src/oidc/security.ts';

const ISSUER = 'https://id.example.com';
const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

describe('isSameOriginPost', () => {
  it.each([
    [{ 'sec-fetch-site': 'same-origin', origin: ISSUER }, true],
    [{ 'sec-fetch-site': 'same-origin', origin: 'null' }, true],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ origin: ISSUER }, true],
    [{ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, false],
    [{ 'sec-fetch-site': 'same-site', origin: 'https://chat.example.com' }, false],
    [{ 'sec-fetch-site': 'none' }, false],
    [{ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' }, false],
    [{ origin: 'https://evil.example' }, false],
    [{ origin: 'null' }, false],
    [{}, false],
  ])('%o -> %s', (headers, expected) => {
    expect(isSameOriginPost(req(headers), ISSUER)).toBe(expected);
  });
});

describe('pageSecurityHeaders', () => {
  it('keeps the pages to our own site', () => {
    const h = pageSecurityHeaders(['https://chat.example.com']);
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toContain("form-action 'self' https://chat.example.com");
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['x-content-type-options']).toBe('nosniff');
  });
});
