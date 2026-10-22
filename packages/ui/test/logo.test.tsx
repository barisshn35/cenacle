// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppIcon, Logo } from '../src/brand';

describe('Logo', () => {
  it('is an image named Cenacle by default', () => {
    render(<Logo />);
    const logo = screen.getByRole('img', { name: 'Cenacle' });
    expect(logo).toHaveAttribute('data-variant', 'lockup');
    expect(logo.querySelectorAll('path')).toHaveLength(3);
  });

  it('is hidden from assistive technology next to visible text', () => {
    const { container } = render(
      <span>
        <Logo variant="icon" decorative /> Cenacle
      </span>,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes its colours from theme variables', () => {
    render(<Logo variant="icon" />);
    const [arch, bubble] = screen.getByRole('img').querySelectorAll('path');
    expect(arch).toHaveAttribute('stroke', 'var(--logo-ink)');
    expect(bubble).toHaveAttribute('fill', 'var(--logo-accent)');
  });

  it('keeps the lockup proportions and sizes the icon square', () => {
    const { rerender } = render(<Logo size={20} />);
    const lockup = screen.getByRole('img');
    expect(Number(lockup.getAttribute('width'))).toBeCloseTo(20 * (399.04 / 75.57), 1);
    expect(Number(lockup.getAttribute('width'))).toBeGreaterThanOrEqual(96); // minimum lockup width
    rerender(<Logo variant="icon" size={32} />);
    expect(screen.getByRole('img')).toHaveAttribute('width', '32');
    expect(screen.getByRole('img')).toHaveAttribute('height', '32');
  });

  it('uses the heavier favicon stroke at 16 px', () => {
    render(<Logo variant="icon" size={16} />);
    expect(screen.getByRole('img').querySelector('path')).toHaveAttribute('stroke-width', '7.5');
  });

  it('renders single-colour artwork in currentColor', () => {
    render(<Logo tone="mono" />);
    const fills = [...screen.getByRole('img').querySelectorAll('path')].map((p) =>
      p.getAttribute('fill') === 'none' ? p.getAttribute('stroke') : p.getAttribute('fill'),
    );
    expect(new Set(fills)).toEqual(new Set(['currentColor']));
  });
});

describe('AppIcon', () => {
  it('names its appearance', () => {
    render(<AppIcon appearance="dark" />);
    expect(screen.getByRole('img', { name: 'Cenacle app icon (dark)' })).toBeInTheDocument();
  });
});
