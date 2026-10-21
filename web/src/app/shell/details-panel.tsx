// SPDX-License-Identifier: Apache-2.0
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { useLayout } from '../../stores/layout';
import { useActiveChannel } from '../chat/active-channel';

export function DetailsPanel() {
  const { t } = useTranslation();
  const { channel } = useActiveChannel();
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);

  return (
    <aside aria-labelledby="details-title" className="flex h-full flex-col border-l bg-background">
      <header className="flex min-h-12 items-center justify-between border-b px-3">
        <h2 id="details-title" className="text-sm font-semibold">
          {t('shell.details')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('shell.closeDetails')}
          onClick={() => setDetailsOpen(false)}
        >
          <XIcon strokeWidth={1.75} />
        </Button>
      </header>
      {channel && (
        <dl className="flex flex-col gap-4 p-4 text-sm">
          <div className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground uppercase">
              {t('shell.about')}
            </dt>
            <dd>{channel.topic || t('shell.noTopic')}</dd>
          </div>
        </dl>
      )}
    </aside>
  );
}
