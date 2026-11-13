// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { Logo } from '@cenacle/ui/brand';
import { cn } from '@cenacle/ui/lib/utils';
import { desktop } from './desktop';

/** The color of an element as rgb(), for the window's buttons. */
const rgb = (value: string) => {
  const canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) return value;
  canvas.fillStyle = value;
  return canvas.fillStyle;
};

/**
 * The bar of the desktop app's window (it has no system title bar): drags
 * the window, names the server, and leaves room at its right for the
 * window's buttons, which take its colors. Nothing in a browser.
 */
export function DesktopTitleBar({ tone = 'sidebar' }: { tone?: 'sidebar' | 'page' }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!desktop || !el) return;
    // Follows the theme: the buttons repaint whenever the colors change.
    const paint = () => {
      const style = getComputedStyle(el);
      void desktop?.setTitleBar({
        color: rgb(style.backgroundColor),
        symbolColor: rgb(style.color),
      });
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-preset', 'style'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', paint);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', paint);
    };
  }, [tone]);
  if (!desktop) return null;
  return (
    <div
      ref={bar}
      data-testid="desktop-title-bar"
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 pl-3.5 text-[13px] font-semibold select-none [-webkit-app-region:drag] [app-region:drag]',
        // Room for the window's buttons (Window Controls Overlay).
        'pe-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+12px)]',
        tone === 'sidebar'
          ? 'bg-sidebar text-sidebar-foreground'
          : 'border-b bg-panel text-foreground',
      )}
    >
      <Logo variant="icon" size={18} decorative />
      <span>Cenacle</span>
      <span className="truncate text-xs font-normal opacity-70 forced-colors:opacity-100">
        {window.location.host}
      </span>
    </div>
  );
}
