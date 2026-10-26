// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';

/**
 * Keeps keyboard focus in a virtualized list. When the list drops the row that
 * holds focus (scrolled far away, or pushed out by new messages), browsers
 * move focus to the page itself, and the next Tab starts over at its top;
 * focus goes to the list instead (it needs tabIndex -1), where screen readers
 * say its name. Focus someone moved elsewhere on purpose is left alone.
 */
export function useKeepFocusIn(list: HTMLElement | null) {
  useEffect(() => {
    if (!list) return;
    let last: Element | null = null;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target as Element;
    };
    const onFocusOut = () => {
      // Still in the page: focus moved on (elsewhere, or to the page by a click).
      requestAnimationFrame(() => {
        if (last?.isConnected && !list.contains(document.activeElement)) last = null;
      });
    };
    const keep = () => {
      if (last && !last.isConnected && document.activeElement === document.body) {
        last = null;
        list.focus({ preventScroll: true });
      }
    };
    const observer = new MutationObserver(keep);
    observer.observe(list, { childList: true, subtree: true });
    list.addEventListener('focusin', onFocusIn);
    list.addEventListener('focusout', onFocusOut);
    return () => {
      observer.disconnect();
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('focusout', onFocusOut);
    };
  }, [list]);
}
