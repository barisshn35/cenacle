// SPDX-License-Identifier: AGPL-3.0-only
// Source: border-beam by Jakub Antalik (MIT),
// https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/border-beam
import { BorderBeam } from 'border-beam';
import { useMediaQuery } from '../hooks/use-media-query';
import { useTheme } from '../theme/theme-provider';

/**
 * Something is being written for the reader (the AI's answer): the edge of
 * the placeholder card breathes in a warm glow while it waits. Still for
 * people who prefer reduced motion; decorative for assistive technology.
 */
function WorkingBeam({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const { resolvedTheme } = useTheme();
  return (
    <BorderBeam
      size="pulse-inner"
      colorVariant="sunset"
      theme={resolvedTheme}
      staticColors
      strength={0.6}
      active={!reduced}
      className={className}
    >
      {children}
    </BorderBeam>
  );
}

export { WorkingBeam };
