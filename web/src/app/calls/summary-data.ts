// SPDX-License-Identifier: AGPL-3.0-only
export interface Summary {
  call_id?: string;
  outcome: 'ended' | 'missed' | 'declined' | 'busy' | 'failed';
  duration_seconds: number;
  participants: number;
  /** Lines of call notes kept (servers before 1.0 leave it out). */
  notes?: number;
}
export function summaryOf(attachment: unknown): Summary | null {
  const value = (attachment as { call_summary?: Partial<Summary> })?.call_summary;
  if (
    !value ||
    !['ended', 'missed', 'declined', 'busy', 'failed'].includes(value.outcome ?? '') ||
    typeof value.duration_seconds !== 'number' ||
    !Number.isFinite(value.duration_seconds) ||
    value.duration_seconds < 0 ||
    typeof value.participants !== 'number' ||
    value.participants < 0 ||
    (value.call_id !== undefined && typeof value.call_id !== 'string')
  )
    return null;
  return value as Summary;
}
