// SPDX-License-Identifier: AGPL-3.0-only
import { AnnouncementsPanel } from '../community/admin-panels';
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellIcon,
  ExternalLinkIcon,
  KeyboardIcon,
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
import { AppearancePanel } from '../appearance/appearance-panel';
import { UITextsPanel } from '../appearance/ui-texts-panel';
import { NotificationsPanel } from '../notifications/notifications-panel';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Label } from '@cenacle/ui/components/label';
import { Dialog } from '@cenacle/ui/components/dialog';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { ApiError } from '@cenacle/core/api';
import { useSession } from './session';
import { desktop } from '../desktop/desktop';
import { WebAppPanel } from './web-app-panel';
import { SideNavDialog } from '../shell/side-nav-dialog';
import { sideNavLink } from '../shell/board-styles';
import { useShortcutsDialog } from '../shell/shortcuts-state';
import { Kbd } from '@cenacle/ui/components/kbd';
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
        <SideNavDialog
          id="settings"
          title={t('settings.title')}
          subtitle={session.user.display_name}
          groups={groups.map((g) => ({
            label: g.label,
            items: g.tabs.map((k) => ({ key: k, label: t(`settings.tabs.${k}`), icon: ICONS[k] })),
          }))}
          value={tab}
          onChange={setTab}
          description={t(`settings.sections.${tab}`)}
          aside={
            <>
              <a
                href={session.account_url}
                target="_blank"
                rel="noopener noreferrer"
                className={sideNavLink}
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
              <button
                type="button"
                className={sideNavLink}
                onClick={() => {
                  onOpenChange(false);
                  useShortcutsDialog.getState().setOpen(true);
                }}
              >
                <KeyboardIcon
                  aria-hidden
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.75}
                />
                {t('shortcuts.open')}
                <Kbd className="ml-auto font-sans">Ctrl /</Kbd>
              </button>
            </>
          }
          footer={<span className="font-mono">{window.location.host}</span>}
        >
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

              {desktop && (
                <section aria-labelledby="settings-app" className="flex flex-col gap-2">
                  <h3 id="settings-app" className="text-sm font-semibold">
                    {t('settings.thisApp')}
                  </h3>
                  <dl className="grid gap-0.5 rounded-[10px] border border-rule-strong bg-background px-3 py-2.5">
                    <dt className="text-xs text-muted-foreground">{t('settings.pairedServer')}</dt>
                    <dd className="font-mono text-sm">{window.location.host}</dd>
                    <dt className="mt-1.5 text-xs text-muted-foreground">
                      {t('settings.appVersion')}
                    </dt>
                    <dd className="font-mono text-sm">{desktop.version}</dd>
                  </dl>
                  <p className="text-sm text-muted-foreground">{t('settings.pairedHint')}</p>
                  <DesktopPrefs />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => void desktop?.checkUpdates()}>
                      {t('settings.checkUpdates')}
                    </Button>
                    <Button variant="outline" onClick={() => void desktop?.changeServer()}>
                      {t('settings.changeServer')}
                    </Button>
                  </div>
                </section>
              )}

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
                      devices.error instanceof ApiError ? devices.error.problem : { status: 500 }
                    }
                    actions={
                      <Button onClick={() => void devices.refetch()}>{t('ui:errors.retry')}</Button>
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
        </SideNavDialog>
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

/** The desktop app's own choices: keep running in the tray when closed. */
function DesktopPrefs() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<{
    closeToTray: boolean;
    sessionKept: boolean;
    tray: boolean;
  } | null>(null);
  useEffect(() => {
    void desktop?.prefs().then(setPrefs);
  }, []);
  if (!prefs) return null;
  return (
    <>
      {prefs.tray && (
        <label className="flex min-h-target items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            className="size-target shrink-0 accent-primary"
            checked={prefs.closeToTray}
            onChange={(e) => {
              const on = e.target.checked;
              setPrefs({ ...prefs, closeToTray: on });
              void desktop?.setCloseToTray(on);
            }}
          />
          {t('settings.closeToTray')}
        </label>
      )}
      {!prefs.sessionKept && (
        <p className="text-sm text-muted-foreground">{t('settings.sessionNotKept')}</p>
      )}
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
