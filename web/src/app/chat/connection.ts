// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import type { ConnectionStatus } from '@cenacle/core/realtime';

/** State of the live connection, for the UI. */
export const useConnection = create<{ status: ConnectionStatus }>()(() => ({
  status: 'connecting',
}));
