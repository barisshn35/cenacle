// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { signinSearchFor, validateSigninSearch } from './session';
import { initials } from './sign-out';

describe('sign-in search', () => {
  it('accepts known outcomes only', () => {
    expect(validateSigninSearch({ error: 'expired', return_to: '/x' })).toEqual({
      error: 'expired',
      return_to: '/x',
    });
    expect(validateSigninSearch({ error: '<script>', return_to: 42 })).toEqual({
      error: undefined,
      return_to: undefined,
    });
  });

  it('omits return_to for the home page', () => {
    expect(signinSearchFor('/')).toEqual({ error: undefined, return_to: undefined });
    expect(signinSearchFor('/?c=1', 'session_expired')).toEqual({
      error: 'session_expired',
      return_to: '/?c=1',
    });
  });
});

describe('initials', () => {
  it.each([
    ['Deniz Kaya', 'DK'],
    ['ışıl özgür', 'IÖ'],
    ['deniz@example.com', 'DE'],
    ['Ada', 'A'],
  ])('%s → %s', (name, want) => {
    expect(initials(name)).toBe(want);
  });
});
