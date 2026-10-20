// SPDX-License-Identifier: Apache-2.0
// Source: shadcn/ui https://ui.shadcn.com (MIT, shadcn and contributors).
// Adapted for Cenacle: built on useMediaQuery (no setState in effects).
import { useMediaQuery } from './use-media-query';

const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}
