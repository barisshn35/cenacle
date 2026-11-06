// SPDX-License-Identifier: AGPL-3.0-only
//
// On a narrow screen toasts span the width at the bottom, where the composer
// and its buttons are. Each mounted composer registers here; the highest one
// on screen sets --toast-mobile-bottom on <html>, which the Toaster uses as
// its bottom offset on narrow screens, so toasts sit above the composer and
// never cover its buttons.
import { useEffect, type RefObject } from 'react';

const GAP = 8;
const elements = new Set<HTMLElement>();
let observer: ResizeObserver | undefined;

function update() {
  let clearance = 0;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0) continue;
    clearance = Math.max(clearance, window.innerHeight - rect.top + GAP);
  }
  const root = document.documentElement;
  if (clearance > 0) root.style.setProperty('--toast-mobile-bottom', `${Math.round(clearance)}px`);
  else root.style.removeProperty('--toast-mobile-bottom');
}

export function useToastClearance(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    if (elements.size === 0) {
      observer = new ResizeObserver(update);
      window.addEventListener('resize', update);
    }
    elements.add(element);
    observer?.observe(element);
    update();
    return () => {
      elements.delete(element);
      observer?.unobserve(element);
      if (elements.size === 0) {
        observer?.disconnect();
        observer = undefined;
        window.removeEventListener('resize', update);
      }
      update();
    };
  }, [ref]);
}
