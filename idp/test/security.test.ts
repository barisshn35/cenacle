// SPDX-License-Identifier: AGPL-3.0-only
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { isSameOriginPost } from '../src/oidc/security.ts';

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
