// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';

/** What one joins a call with, remembered on this device. */
export interface JoinPrefs {
  audio: boolean;
  camera: boolean;
  /** Chosen devices ('' for the system's default). */
  mic: string;
  cam: string;
  speaker: string;
  /** Show the check before joining (else join at once with these). */
  preview: boolean;
}

const KEY = 'cenacle.call.join';
const DEFAULTS: JoinPrefs = {
  audio: true,
  camera: false,
  mic: '',
  cam: '',
  speaker: '',
  preview: true,
};

export function loadJoinPrefs(): JoinPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<JoinPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveJoinPrefs(prefs: JoinPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows: the choice holds for this call only.
  }
}

/**
 * The check before joining: which call (by its channel's name) and what
 * joining does once the person is ready.
 */
export const usePreJoin = create<{
  open: { title: string; starting: boolean; go: (prefs: JoinPrefs) => Promise<void> } | null;
}>()(() => ({ open: null }));

/**
 * Joins after the check, or at once when the person turned the check off.
 * `go` gets the media to join with.
 */
export function beforeJoining(
  title: string,
  starting: boolean,
  go: (prefs: JoinPrefs) => Promise<void>,
): Promise<void> {
  const prefs = loadJoinPrefs();
  if (!prefs.preview) return go(prefs);
  usePreJoin.setState({ open: { title, starting, go } });
  return Promise.resolve();
}
