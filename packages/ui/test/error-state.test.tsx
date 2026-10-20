// SPDX-License-Identifier: Apache-2.0
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorState, InlineError } from '../src/components/error-state';
import { errorKindFor } from '../src/lib/errors';

afterEach(async () => {
  await i18next.changeLanguage('en');
});

describe('errorKindFor', () => {
  it('maps codes and statuses', () => {
    expect(errorKindFor({ code: 'rate_limited' })).toBe('rate_limited');
    expect(errorKindFor({ status: 401 })).toBe('session_expired');
    expect(errorKindFor({ status: 403, code: 'scope_missing' })).toBe('forbidden');
    expect(errorKindFor({ status: 502 })).toBe('server_error');
    expect(errorKindFor({})).toBe('network_error');
  });
});

describe('ErrorState', () => {
  it('renders all four parts from a problem', () => {
    render(
      <ErrorState problem={{ status: 500, code: 'internal_error', request_id: 'REQ-8F3A' }} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(alert).toHaveTextContent('The server could not complete the request.');
    expect(alert).toHaveTextContent(/Try again/);
    expect(alert).toHaveTextContent('internal_error');
    expect(alert).toHaveTextContent('REQ-8F3A');
  });

  it('uses Turkish texts when the language is Turkish', async () => {
    await i18next.addResourceBundle(
      'tr',
      'ui',
      (await import('../src/i18n/tr.json')).default,
      true,
      true,
    );
    await i18next.changeLanguage('tr');
    render(<ErrorState problem={{ status: 429 }} values={{ seconds: 30 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('30 saniye sonra tekrar dene.');
  });

  it('can be a polite status', () => {
    render(<ErrorState politeness="status" title="Nothing here yet." />);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here yet.');
  });
});

describe('InlineError', () => {
  it('can be referenced by aria-describedby', () => {
    render(
      <>
        <input aria-describedby="e1" aria-label="Name" />
        <InlineError id="e1" title="Name is required." />
      </>,
    );
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Name is required.');
  });
});
