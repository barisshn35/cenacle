// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { ForwardIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { ForwardDialog } from '../richer/forward';
import { MAX_PICKED, stopPicking, usePicking } from './message-select';

/**
 * Stands in for the composer while messages are being picked: how many, and
 * forwarding them together. Escape (outside a dialog) stops picking.
 */
export function PickBar() {
  const { t } = useTranslation();
  const picked = usePicking((s) => s.picked);
  const [forwarding, setForwarding] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]'))
        stopPicking();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <footer className="shrink-0 px-4 pb-4" data-testid="pick-bar">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-[10px] border bg-card px-3 py-2 shadow-sm">
        <p role="status" className="me-auto text-sm">
          <span className="font-medium">
            {t('richer.forward.picked', { count: picked.length })}
          </span>
          <span className="ms-2 text-muted-foreground max-sm:hidden">
            {t('richer.forward.pickHint', { max: MAX_PICKED })}
          </span>
        </p>
        <Button variant="ghost" onClick={stopPicking}>
          <XIcon strokeWidth={1.75} />
          {t('richer.forward.pickCancel')}
        </Button>
        <Button disabled={picked.length === 0} onClick={() => setForwarding(true)}>
          <ForwardIcon strokeWidth={1.75} />
          {t('richer.forward.action')}
        </Button>
      </div>
      {forwarding && (
        <ForwardDialog messages={picked} open onOpenChange={setForwarding} onSent={stopPicking} />
      )}
    </footer>
  );
}
