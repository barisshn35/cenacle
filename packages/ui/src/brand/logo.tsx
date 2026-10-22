// SPDX-License-Identifier: AGPL-3.0-only
import type { SVGProps } from 'react';
import { cn } from '../lib/utils';
import {
  ARCH_PATH,
  ARCH_STROKE,
  ARCH_STROKE_SMALL,
  BUBBLE_PATH,
  ICON_VIEWBOX,
  LOCKUP_ASPECT,
  LOCKUP_ICON_TRANSFORM,
  LOCKUP_VIEWBOX,
  WORDMARK_PATH,
} from './paths';

export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, 'role' | 'children'> {
  /** "lockup" (icon + wordmark) or "icon" alone. */
  variant?: 'lockup' | 'icon';
  /** Height in CSS pixels. Minimums: icon 16 px; lockup 96 px wide (about 18 px high). */
  size?: number;
  /** "brand": Forest/Bone arch with the brass bubble; "mono": everything in currentColor. */
  tone?: 'brand' | 'mono';
  /**
   * True when visible text next to the logo already says "Cenacle"; the logo
   * is then hidden from assistive technology instead of announced twice.
   */
  decorative?: boolean;
  /** Accessible name when not decorative. */
  label?: string;
}

/**
 * Cenacle logo. Colors come from --logo-ink and --logo-accent, so it follows
 * the theme without separate light/dark artwork.
 */
export function Logo({
  variant = 'lockup',
  size = 24,
  tone = 'brand',
  decorative = false,
  label = 'Cenacle',
  className,
  ...props
}: LogoProps) {
  const ink = tone === 'mono' ? 'currentColor' : 'var(--logo-ink)';
  const accent = tone === 'mono' ? 'currentColor' : 'var(--logo-accent)';
  const a11y = decorative
    ? { 'aria-hidden': true as const, focusable: false as const }
    : { role: 'img' as const, 'aria-label': label };

  if (variant === 'icon') {
    return (
      <svg
        viewBox={ICON_VIEWBOX}
        width={size}
        height={size}
        data-slot="logo"
        data-variant="icon"
        className={cn('shrink-0', className)}
        {...a11y}
        {...props}
      >
        <path
          d={ARCH_PATH}
          fill="none"
          stroke={ink}
          strokeWidth={size <= 16 ? ARCH_STROKE_SMALL : ARCH_STROKE}
          strokeLinecap="round"
        />
        <path d={BUBBLE_PATH} fill={accent} />
      </svg>
    );
  }

  return (
    <svg
      viewBox={LOCKUP_VIEWBOX}
      width={Math.round(size * LOCKUP_ASPECT * 100) / 100}
      height={size}
      data-slot="logo"
      data-variant="lockup"
      className={cn('shrink-0', className)}
      {...a11y}
      {...props}
    >
      <g transform={LOCKUP_ICON_TRANSFORM}>
        <path
          d={ARCH_PATH}
          fill="none"
          stroke={ink}
          strokeWidth={ARCH_STROKE}
          strokeLinecap="round"
        />
        <path d={BUBBLE_PATH} fill={accent} />
      </g>
      <path d={WORDMARK_PATH} fill={ink} />
    </svg>
  );
}

export interface AppIconProps extends Omit<SVGProps<SVGSVGElement>, 'role' | 'children'> {
  /** Fixed artwork of the light (Paper) or dark (Night) app icon. */
  appearance: 'light' | 'dark';
  size?: number;
}

/**
 * App icon as shipped to home screens and app stores. For the component
 * gallery and documentation; the UI itself uses Logo.
 */
export function AppIcon({ appearance, size = 64, className, ...props }: AppIconProps) {
  const bg = appearance === 'light' ? 'var(--brand-paper)' : 'var(--brand-night)';
  const ink = appearance === 'light' ? 'var(--brand-forest)' : 'var(--brand-bone)';
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={`Cenacle app icon (${appearance})`}
      className={cn('shrink-0', className)}
      {...props}
    >
      <rect width="64" height="64" rx="14.5" fill={bg} />
      <g transform="translate(8 8)">
        <path
          d={ARCH_PATH}
          fill="none"
          stroke={ink}
          strokeWidth={ARCH_STROKE}
          strokeLinecap="round"
        />
        <path d={BUBBLE_PATH} fill="var(--brand-brass)" />
      </g>
    </svg>
  );
}
