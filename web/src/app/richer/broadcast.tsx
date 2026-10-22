// SPDX-License-Identifier: AGPL-3.0-only
import { BellRingIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';

/**
 * Before @channel / @here notifies many people: how many, and a way back.
 * Not a destructive action, so no warning colors.
 */
export function BroadcastConfirm({
  count,
  onSend,
  onCancel,
}: {
  /** People it would notify; null: closed. */
  count: number | null;
  onSend: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={count !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="broadcast-confirm">
        <DialogHeader>
          <DialogTitle>{t('richer.broadcast.title')}</DialogTitle>
          <DialogDescription>
            {t('richer.broadcast.confirm', { count: count ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>{t('glossary.cancel')}</DialogClose>
          <Button onClick={onSend}>
            <BellRingIcon strokeWidth={1.75} />
            {t('richer.broadcast.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
