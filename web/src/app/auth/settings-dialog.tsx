// SPDX-License-Identifier: AGPL-3.0-only
import { AnnouncementsPanel } from '../community/admin-panels';
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellIcon,
  ExternalLinkIcon,
  LanguagesIcon,
  LaptopIcon,
  LogOutIcon,
  MegaphoneIcon,
  PaletteIcon,
  ShieldCheckIcon,
  TypeIcon,
  UserIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type Language } from '../../i18n';
import { getTimeFormat, setTimeFormat, type TimeFormat } from '../../i18n/time-format';
import { cn } from '@cenacle/ui/lib/utils';
import { AppearancePanel } from '../appearance/appearance-panel';
import { UITextsPanel } from '../appearance/ui-texts-panel';
import { NotificationsPanel } from '../notifications/notifications-panel';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Label } from '@cenacle/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { useSession } from './session';
import { WebAppPanel } from './web-app-panel';
import {
  describeDevice,
  devicesQuery,
  endAllDevices,
  endDevice,
  type DeviceSession,
} from './devices';
import { dateLocale } from '../../i18n/time-format';

function useWhen() {
  const { i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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
type Tab =
  'account' | 'appearance' | 'notifications' | 'texts' | 'announcements' | 'language' | 'signIn';

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
  const admin = session.permissions.create_workspaces;
  const groups: { label?: string; tabs: Tab[] }[] = [
    { tabs: ['account', 'appearance', 'notifications', 'language'] },
    ...(admin
      ? [{ label: t('settings.adminGroup'), tabs: ['texts', 'announcements', 'signIn'] as Tab[] }]
      : []),
  ];
  const tabs = groups.flatMap((g) => g.tabs);
  const [tab, setTab] = useState<Tab>('account');
  const ICONS: Record<Tab, typeof UserIcon> = {
    account: UserIcon,
    appearance: PaletteIcon,
    notifications: BellIcon,
    language: LanguagesIcon,
    texts: TypeIcon,
    announcements: MegaphoneIcon,
    signIn: ShieldCheckIcon,
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="grid h-[min(90svh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-5xl md:grid-cols-[236px_minmax(0,1fr)] md:grid-rows-1">
          <nav
            aria-label={t('settings.title')}
            className="flex min-h-0 flex-col gap-1 border-b bg-secondary px-3 pt-5 pb-3 md:border-r md:border-b-0"
          >
            <div className="px-2.5 pb-3 max-md:pr-10">
              <DialogTitle className="text-[17px] font-semibold">{t('settings.title')}</DialogTitle>
              <DialogDescription className="text-xs">{session.user.display_name}</DialogDescription>
            </div>
            <div
              role="tablist"
              aria-orientation="vertical"
              aria-label={t('settings.title')}
              className="flex gap-1 overflow-x-auto max-md:pb-1 md:flex-col md:overflow-visible"
            >
              {groups.map((g, gi) => (
                <div key={gi} className="contents md:flex md:flex-col md:gap-0.5">
                  {g.label && (
                    <p className="px-2.5 pt-4 pb-1 text-xs font-semibold text-muted-foreground max-md:hidden">
                      {g.label}
                    </p>
                  )}
                  {g.tabs.map((k) => {
                    const Icon = ICONS[k];
                    return (
                      <button
                        key={k}
                        type="button"
                        role="tab"
                        id={`settings-tab-${k}`}
                        aria-selected={tab === k}
                        aria-controls={`settings-panel-${k}`}
                        tabIndex={tab === k ? 0 : -1}
                        onClick={() => setTab(k)}
                        onKeyDown={(e) => {
                          const i = tabs.indexOf(k);
                          const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
                          const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
                          if (!forward && !back) return;
                          e.preventDefault();
                          const next = tabs[(i + (forward ? 1 : tabs.length - 1)) % tabs.length]!;
                          setTab(next);
                          document.getElementById(`settings-tab-${next}`)?.focus();
                        }}
                        className={cn(
                          'flex h-8 min-h-target shrink-0 items-center gap-2.5 rounded-[7px] px-2.5 text-left text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                          tab === k
                            ? 'bg-accent font-semibold text-foreground'
                            : 'text-foreground hover:bg-muted',
                        )}
                      >
                        <Icon
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                          strokeWidth={1.75}
                        />
                        {t(`settings.tabs.${k}`)}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <a
              href={session.account_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex h-8 min-h-target items-center gap-2.5 rounded-[7px] px-2.5 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 max-md:hidden"
            >
              <ShieldCheckIcon
                aria-hidden
                className="size-4 text-muted-foreground"
                strokeWidth={1.75}
              />
              {t('settings.cenacleId')}
              <ExternalLinkIcon
                aria-hidden
                className="ml-auto size-3.5 text-muted-foreground"
                strokeWidth={1.75}
              />
              <span className="sr-only">{t('settings.newTab')}</span>
            </a>
            <p className="mt-auto px-2.5 pt-4 font-mono text-xs text-muted-foreground max-md:hidden">
              {window.location.host}
            </p>
          </nav>
          <div
            role="tabpanel"
            id={`settings-panel-${tab}`}
            aria-labelledby={`settings-tab-${tab}`}
            className="flex min-h-0 flex-col"
          >
            <header className="border-b px-8 pt-5 pb-4 max-sm:px-4 max-md:hidden">
              <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">
                {t(`settings.tabs.${tab}`)}
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t(`settings.sections.${tab}`)}
              </p>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8 max-sm:px-4">
              {tab === 'appearance' && <AppearancePanel />}
              {tab === 'language' && <LanguagePanel />}
              {tab === 'notifications' && <NotificationsPanel />}
              {tab === 'announcements' && <AnnouncementsPanel />}
              {tab === 'signIn' && <WebAppPanel />}
              {tab === 'texts' && <UITextsPanel />}
              {tab === 'account' && (
                <div className="flex flex-col gap-6 pt-4">
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

                  <section aria-labelledby="settings-devices" className="flex flex-col gap-2">
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
                          devices.error instanceof ApiError
                            ? devices.error.problem
                            : { status: 500 }
                        }
                        actions={
                          <Button onClick={() => void devices.refetch()}>
                            {t('ui:errors.retry')}
                          </Button>
                        }
                      />
                    ) : (
                      <ul className="flex flex-col divide-y rounded-[10px] border border-rule-strong bg-background px-3">
                        {devices.data.map((d) => (
                          <DeviceRow key={d.id} device={d} />
                        ))}
                      </ul>
                    )}
                    <Button
                      variant="outline"
                      className="mt-1 self-start text-destructive"
                      onClick={() => setConfirm(true)}
                    >
                      <LogOutIcon aria-hidden strokeWidth={1.75} />
                      {t('settings.endAll')}
                    </Button>
                  </section>
                </div>
              )}
            </div>
          </div>
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

/** The language of the interface (English or Turkish), the clock and the time zone. */
function LanguagePanel() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [format, setFormat] = useState<TimeFormat>(getTimeFormat);
  const now = new Date();
  const sample = (f: TimeFormat) =>
    new Intl.DateTimeFormat(
      f === 'auto' ? i18n.language : `${i18n.language}-u-hc-${f === '12' ? 'h12' : 'h23'}`,
      { hour: '2-digit', minute: '2-digit' },
    ).format(now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="flex flex-col gap-6 pt-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{t('appearance.language')}</Label>
        <select
          id={id}
          className="h-9 min-h-target w-full max-w-xs rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={i18n.resolvedLanguage}
          onChange={(e) => setLanguage(e.target.value as Language)}
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l === 'en' ? 'English' : 'Türkçe'}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">{t('settings.timeFormat.title')}</legend>
        {(['auto', '24', '12'] as const).map((f) => (
          <label key={f} className="flex min-h-target items-center gap-2.5 text-sm">
            <input
              type="radio"
              name="time-format"
              className="size-target shrink-0 accent-primary"
              checked={format === f}
              onChange={() => {
                setFormat(f);
                setTimeFormat(f);
              }}
            />
            {t(`settings.timeFormat.${f}`)}
            <span className="font-mono text-xs text-muted-foreground">{sample(f)}</span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{t('settings.timeFormat.hint')}</p>
      </fieldset>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t('settings.timeZone')}</p>
        <p className="font-mono text-sm">{zone}</p>
        <p className="text-xs text-muted-foreground">{t('settings.timeZoneHint')}</p>
      </div>
    </div>
  );
}
