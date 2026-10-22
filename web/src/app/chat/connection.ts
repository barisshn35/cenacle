// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';
import type { ConnectionStatus } from '@cenacle/core/realtime';

/** State of the live connection, for the UI. */
export const useConnection = create<{ status: ConnectionStatus }>()(() => ({
  status: 'connecting',
}));
