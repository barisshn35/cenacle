// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';

/** The browser tab names where one is (WCAG 2.4.2): "General · Acme · Cenacle". */
export function usePageTitle(...parts: (string | undefined)[]) {
  const title = [...parts.filter(Boolean), 'Cenacle'].join(' · ');
  useEffect(() => {
    document.title = title;
  }, [title]);
}
