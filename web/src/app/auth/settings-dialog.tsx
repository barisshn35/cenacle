// SPDX-License-Identifier: Apache-2.0
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, LaptopIcon, LogOutIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { useSession } from './session';
import {
  describeDevice,
  devicesQuery,
  endAllDevices,
  endDevice,
  type DeviceSession,
} from './devices';

function useWhen() {
  const { i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return (iso: string) => fmt.format(new Date(iso));
}

function DeviceRow({ device }: { device: DeviceSession }) {
  const { t } = useTranslation();
  const when = useWhen();
  const queryClient = useQueryClient();
  const { browser, os } = describeDevice(device.user_agent);
  const name =
    browser && os
      ? t('settings.deviceName', { browser, os })
      : (browser ?? os ?? t('settings.unknownDevice'));
  const end = useMutation({
    mutationFn: () => endDevice(device.id),
    onSuccess: () => {
      toast(t('settings.deviceEnded', { device: name }));
      return queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: () => toast.error(t('settings.endFailed')),
  });
  return (
    <li data-testid="device" className="flex items-center gap-3 py-2.5">
      <LaptopIcon
        aria-hidden
        strokeWidth={1.75}
        className="size-5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-medium">
          {name}
          {device.current && (
            <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal">
              {t('settings.thisDevice')}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {t('settings.lastActive', { when: when(device.last_seen_at) })}
          {device.ip_address && ` · ${device.ip_address}`}
        </p>
      </div>
      {!device.current && (
        <Button
          size="sm"
          variant="outline"
          disabled={end.isPending}
          aria-label={t('settings.endDeviceNamed', { device: name })}
          onClick={() => end.mutate()}
        >
          {t('settings.endDevice')}
        </Button>
      )}
    </li>
  );
}

/**
 * Settings of the signed-in user: signed-in devices with "sign out
 * everywhere" (S3) and the way to two-step verification in Cenacle ID.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const devices = useQuery({ ...devicesQuery, enabled: open });
  const [confirm, setConfirm] = useState(false);
  const [keepCurrent, setKeepCurrent] = useState(true);
  const keepId = useId();
  const others = (devices.data ?? []).filter((d) => !d.current).length;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('settings.title')}</DialogTitle>
            <DialogDescription>{t('settings.description')}</DialogDescription>
          </DialogHeader>

          <section aria-labelledby="settings-security" className="flex flex-col gap-2">
            <h3 id="settings-security" className="text-sm font-semibold">
              {t('settings.security')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('settings.securityHint')}</p>
            <a
              href={session.account_url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'outline', className: 'self-start' })}
            >
              <ShieldCheckIcon aria-hidden strokeWidth={1.75} />
              {t('settings.openAccount')}
              <ExternalLinkIcon aria-hidden strokeWidth={1.75} />
              <span className="sr-only">{t('settings.newTab')}</span>
            </a>
          </section>

          <section aria-labelledby="settings-devices" className="flex flex-col gap-1">
            <h3 id="settings-devices" className="text-sm font-semibold">
              {t('settings.devices')}
            </h3>
            {devices.isPending ? (
              <div aria-hidden className="flex flex-col gap-2 py-2">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : devices.isError ? (
              <ErrorState
                problem={
                  devices.error instanceof ApiError ? devices.error.problem : { status: 500 }
                }
                actions={
                  <Button onClick={() => void devices.refetch()}>{t('ui:errors.retry')}</Button>
                }
              />
            ) : (
              <ul className="flex max-h-[40svh] flex-col divide-y overflow-y-auto">
                {devices.data.map((d) => (
                  <DeviceRow key={d.id} device={d} />
                ))}
              </ul>
            )}
            <Button
              variant="outline"
              className="mt-2 self-start text-destructive"
              onClick={() => setConfirm(true)}
            >
              <LogOutIcon aria-hidden strokeWidth={1.75} />
              {t('settings.endAll')}
            </Button>
          </section>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        severity="s3"
        title={t('settings.endAllTitle')}
        description={<p>{t('settings.endAllDescription')}</p>}
        impact={
          <div className="flex flex-col gap-2">
            <p>{t('settings.endAllImpact', { count: others })}</p>
            <label
              htmlFor={keepId}
              data-target
              className="flex min-h-target cursor-pointer items-center gap-2 text-sm"
            >
              <input
                id={keepId}
                type="checkbox"
                checked={keepCurrent}
                onChange={(e) => setKeepCurrent(e.target.checked)}
                className="size-4 accent-primary"
                // The whole label is the target (at least 24 px).
                data-target-exempt
              />
              {t('settings.keepThisDevice')}
            </label>
          </div>
        }
        confirmLabel={t('settings.endAll')}
        onConfirm={async () => {
          const { ended } = await endAllDevices(keepCurrent);
          if (keepCurrent) {
            toast(t('settings.endedOthers', { count: ended }));
            await queryClient.invalidateQueries({ queryKey: ['devices'] });
          } else {
            // This device is signed out too: the app goes to the sign-in page.
            await queryClient.invalidateQueries({ queryKey: ['session'] });
          }
        }}
      />
    </>
  );
}
