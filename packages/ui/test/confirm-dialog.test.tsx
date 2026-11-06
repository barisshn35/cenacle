// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, type ConfirmDialogProps } from '../src/components/confirm-dialog';

function Harness(props: Partial<ConfirmDialogProps> & { onClosed?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) props.onClosed?.();
      }}
      severity="s2"
      title="Archive #ops-alerts?"
      description="Messages are kept and searchable. You can unarchive it at any time."
      confirmLabel="Archive channel"
      onConfirm={async () => {}}
      {...props}
    />
  );
}

describe('ConfirmDialog', () => {
  it('keeps red for what cannot be undone: a reversible action is asked calmly', async () => {
    const { unmount } = render(<Harness />);
    const archive = await screen.findByRole('button', { name: 'Archive channel' });
    expect(screen.getByRole('alertdialog')).not.toHaveAttribute('data-destructive');
    expect(archive.className).not.toContain('bg-destructive');
    unmount();
    render(<Harness irreversible confirmLabel="Delete channel" />);
    const remove = await screen.findByRole('button', { name: 'Delete channel' });
    expect(screen.getByRole('alertdialog')).toHaveAttribute('data-destructive', 'true');
    expect(remove.className).toContain('bg-destructive');
  });

  it('opens as an alert dialog with focus on Cancel', async () => {
    render(<Harness />);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Archive #ops-alerts?');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('Enter on the default focus cancels instead of confirming', async () => {
    const onConfirm = vi.fn();
    const onClosed = vi.fn();
    render(<Harness onConfirm={onConfirm} onClosed={onClosed} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalled();
  });

  it('Escape cancels', async () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    expect(onClosed).toHaveBeenCalled();
  });

  it('runs the action once even on double click and closes when done', async () => {
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const onClosed = vi.fn();
    render(<Harness onConfirm={onConfirm} onClosed={onClosed} />);
    const action = await screen.findByRole('button', { name: /Archive channel/ });
    await userEvent.dblClick(action);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(action).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });

  it('stays open and explains a failure', async () => {
    const onClosed = vi.fn();
    render(<Harness onConfirm={() => Promise.reject(new Error('boom'))} onClosed={onClosed} />);
    await userEvent.click(await screen.findByRole('button', { name: /Archive channel/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be completed/);
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Archive channel/ })).toBeEnabled();
  });

  it('S3 requires typing the exact name and allows paste', async () => {
    const onConfirm = vi.fn();
    render(
      <Harness
        severity="s3"
        title="Delete #ops-alerts permanently?"
        confirmLabel="Delete channel"
        confirmationText="ops-alerts"
        irreversible
        onConfirm={onConfirm}
      />,
    );
    const action = await screen.findByRole('button', { name: /Delete channel/ });
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(action).toBeDisabled();

    const input = screen.getByLabelText(/To confirm, type/);
    await userEvent.type(input, 'ops-alert');
    expect(action).toBeDisabled();
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await userEvent.clear(input);
    input.focus();
    await userEvent.paste('ops-alerts');
    expect(action).toBeEnabled();

    await userEvent.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(action);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('only claims irreversibility when told so', async () => {
    render(<Harness severity="s3" />);
    await screen.findByRole('alertdialog');
    expect(screen.queryByText('This cannot be undone.')).not.toBeInTheDocument();
  });

  it('shows the impact summary slot', async () => {
    render(<Harness impact={<span>3 bots and 2 webhooks will stop posting.</span>} />);
    expect(await screen.findByText('3 bots and 2 webhooks will stop posting.')).toBeVisible();
  });
});
