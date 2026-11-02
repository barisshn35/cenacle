// SPDX-License-Identifier: AGPL-3.0-only
import { DraftStore } from '@cenacle/core/drafts';
import { forgetKeys, loadKeys } from '../compliance/e2e';
import { dropStaleDevice, forgetLocally } from '../e2e/mls';

/** Whose encryption keys, decrypted texts and drafts this browser keeps. */
const OWNER = 'cenacle-owner';

function owner(): string | null {
  try {
    return localStorage.getItem(OWNER);
  } catch {
    return null;
  }
}

/**
 * The session ended (it timed out, was ended elsewhere or by the session
 * policy, or the browser comes back without one): the encryption keys and
 * decrypted texts kept for it go, as on signing out. Drafts stay for the same
 * person (claimBrowser drops them for anyone else).
 */
export async function sessionEnded(): Promise<void> {
  await Promise.allSettled([forgetKeys(), forgetLocally(owner())]);
}

/**
 * Before the app shows anything for a person: what another person left in
 * this browser goes (keys, texts, drafts), then this person's keys load. A
 * browser that kept no owner yet (before this check) is taken as it is.
 */
export async function claimBrowser(userId: string): Promise<void> {
  const was = owner();
  if (was !== userId) {
    if (was !== null) {
      await Promise.allSettled([forgetKeys(), forgetLocally(was), new DraftStore().clear()]);
    }
    try {
      localStorage.setItem(OWNER, userId);
    } catch {
      // Private windows: nothing outlives the page anyway.
    }
  }
  await Promise.allSettled([loadKeys(), dropStaleDevice(userId)]);
}
