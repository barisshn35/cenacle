// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import { bannerQuery } from './community';

const DISMISSED = 'cenacle.banner.dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}

/** The instance's announcement banner, above the app. */
export function InstanceBanner() {
  const { t } = useTranslation();
  const banner = useQuery(bannerQuery).data;
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!banner || (banner.dismissible && dismissed === banner.updated_at)) return null;
  const Icon = banner.level === 'info' ? InfoIcon : TriangleAlertIcon;
  return (
    <div
      role={banner.level === 'critical' ? 'alert' : 'status'}
      data-testid="instance-banner"
      data-level={banner.level}
      className={cn(
        'flex shrink-0 items-center gap-2 px-4 py-1.5 text-sm',
        banner.level === 'info' && 'bg-info text-info-foreground',
        banner.level === 'warning' && 'bg-warning text-warning-foreground',
        banner.level === 'critical' && 'bg-destructive text-destructive-foreground',
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
      <p className="min-w-0 flex-1">{banner.text}</p>
      {banner.dismissible && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('community.banner.dismiss')}
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED, banner.updated_at);
            } catch {
              // per-browser convenience only
            }
            setDismissed(banner.updated_at);
          }}
        >
          <XIcon strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}
