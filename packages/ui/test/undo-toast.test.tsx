// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Toaster } from '../src/components/sonner';
import { showUndoToast } from '../src/components/undo-toast';
import { ThemeProvider } from '../src/theme';

function setup() {
  render(
    <ThemeProvider>
      <button>Composer</button>
      <Toaster />
    </ThemeProvider>,
  );
}

describe('UndoToast', () => {
  it('announces politely, keeps focus and undoes', async () => {
    setup();
    const composer = screen.getByRole('button', { name: 'Composer' });
    composer.focus();
    const onUndo = vi.fn();
    act(() => {
      showUndoToast({ message: 'Message deleted.', onUndo });
    });
    const status = await screen.findByText('Message deleted.');
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(composer).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Message deleted.')).not.toBeInTheDocument());
  });

  it('shows at most two toasts at once', async () => {
    setup();
    act(() => {
      for (const n of [1, 2, 3]) showUndoToast({ message: `Toast ${n}`, onUndo: () => {} });
    });
    await screen.findByText('Toast 3');
    const visible = document.querySelectorAll('[data-sonner-toast][data-visible="true"]');
    expect(visible.length).toBeLessThanOrEqual(2);
  });
});
