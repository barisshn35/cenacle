// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { buttonVariants } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useSession } from './session';
import { serverAddress, setWebApp, webAppQuery } from './web-app';

/** Cenacle ID's page for the sign-in policy, next to the account page. */
function policyUrl(accountUrl: string): string | null {
  try {
    return new URL('/account/admin/sign-in', accountUrl).toString();
  } catch {
    return null;
  }
}

/**
 * In Settings (server administrators): whether Cenacle may be used in web
 * browsers. Turning it off signs this browser out too, so it asks first.
 */
export function WebAppPanel() {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const id = useId();
  const setting = useQuery(webAppQuery);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const policy = policyUrl(session.account_url);

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      queryClient.setQueryData(webAppQuery.queryKey, await setWebApp(enabled));
      toast.success(enabled ? t('webApp.on') : t('webApp.off'));
      // Off: this browser is turned away from now on.
      if (!enabled) await queryClient.invalidateQueries({ queryKey: ['session'] });
    } catch {
      toast.error(t('webApp.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t('webApp.title')}
        </h3>
        <p id={`${id}-hint`} className="max-w-[60ch] text-sm text-muted-foreground">
          {t('webApp.hint', { address: serverAddress() })}
        </p>
        {setting.isPending ? (
          <Skeleton className="h-8 w-56" />
        ) : setting.data ? (
          <>
            <label className="flex items-center gap-2 self-start text-sm font-medium">
              <input
                type="checkbox"
                role="switch"
                className="size-target shrink-0 accent-primary"
                aria-describedby={`${id}-hint`}
                checked={setting.data.enabled}
                disabled={busy || setting.data.forced}
                onChange={(e) => (e.target.checked ? void save(true) : setConfirm(true))}
              />
              {t('webApp.label')}
            </label>
            {setting.data.forced && (
              <p className="text-[13px] text-muted-foreground">{t('webApp.forced')}</p>
            )}
          </>
        ) : null}
      </section>

      {policy && (
        <section className="flex flex-col gap-2 border-t pt-4">
          <p className="max-w-[60ch] text-sm text-muted-foreground">{t('webApp.policy')}</p>
          <a
            href={policy}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'outline', className: 'self-start' })}
          >
            <ShieldCheckIcon aria-hidden strokeWidth={1.75} />
            {t('webApp.openPolicy')}
            <ExternalLinkIcon aria-hidden strokeWidth={1.75} />
            <span className="sr-only">{t('settings.newTab')}</span>
          </a>
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        severity="s2"
        title={t('webApp.confirmTitle')}
        description={t('webApp.confirmDescription')}
        impact={t('webApp.confirmImpact')}
        confirmLabel={t('webApp.confirm')}
        onConfirm={() => save(false)}
      />
    </div>
  );
}
