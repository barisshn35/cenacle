// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearch } from '@tanstack/react-router';
import { LockIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { safeReturnPath, signInUrl } from '@cenacle/core/api';
import { buttonVariants } from '@cenacle/ui/components/button';
import { InlineError } from '@cenacle/ui/components/error-state';
import { cn } from '@cenacle/ui/lib/utils';
import { useTheme } from '@cenacle/ui/theme';
import { sessionQuery, type SigninError } from './session';
import { SigninLayout, SigninRecord } from './signin-layout';
import { metaQuery, serverAddress } from './web-app';
import { WebOffPage } from './web-off';
import { desktop } from '../desktop/desktop';

/** The theme chosen in the app for Cenacle ID's pages; none when it follows the system. */
function useChosenTheme(): 'light' | 'dark' | undefined {
  const { theme } = useTheme();
  return theme === 'system' ? undefined : theme;
}

/** Informational outcomes are announced politely; failures as alerts. */
const POLITE: ReadonlySet<SigninError> = new Set(['cancelled', 'session_expired']);

function SigninMessage({ error }: { error: SigninError }) {
  const { t } = useTranslation();
  if (error === 'session_expired') {
    return <InlineError politeness="status" problem={{ code: 'session_expired' }} />;
  }
  return (
    <InlineError
      politeness={POLITE.has(error) ? 'status' : 'alert'}
      title={t(`auth.errors.${error}.title`)}
      reason={t(`auth.errors.${error}.reason`)}
      action={t(`auth.errors.${error}.action`)}
      code={error === 'cancelled' ? undefined : `signin_${error}`}
    />
  );
}

const STEPS = ['server', 'password', 'code'] as const;

/** The three steps of signing in; the first, the server, is this page. */
function Steps() {
  const { t } = useTranslation();
  return (
    <SigninRecord
      title={t('auth.steps.title')}
      icon={<ShieldCheckIcon aria-hidden className="size-4" strokeWidth={1.75} />}
      note={
        <>
          <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
          <span>{t('auth.steps.passwordNote')}</span>
        </>
      }
    >
      <ol className="grid gap-2.5 px-4 pt-3 pb-3.5">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === 0 ? 'step' : undefined}
            className={cn(
              'grid grid-cols-[24px_1fr] items-center gap-2.5 text-sm',
              i === 0 ? 'font-semibold' : 'text-muted-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'grid size-6 place-items-center rounded-full border text-xs tabular-nums',
                i === 0 ? 'border-foreground text-foreground' : 'border-rule-strong',
              )}
            >
              {i + 1}
            </span>
            {t(`auth.steps.${s}`)}
          </li>
        ))}
      </ol>
    </SigninRecord>
  );
}

/** In the desktop app: opens its sign-in window once, with a way to open it again. */
function DesktopSignin({ returnTo }: { returnTo: string }) {
  const { t } = useTranslation();
  const theme = useChosenTheme();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void desktop?.signIn(returnTo, theme);
  }, [returnTo, theme]);
  return (
    <SigninLayout aside={<Steps />}>
      <h1 className="text-[34px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
        {t('auth.title')}
      </h1>
      <p className="mt-2 text-[15.5px] leading-[1.55] text-muted-foreground">
        {t('auth.desktop.lede')}
      </p>
      <button
        type="button"
        onClick={() => void desktop?.signIn(returnTo, theme)}
        className={cn(buttonVariants({ size: 'lg' }), 'mt-6 h-12 w-full text-[15.5px]')}
      >
        {t('auth.desktop.open')}
      </button>
      <button
        type="button"
        onClick={() => void desktop?.changeServer()}
        className={cn(buttonVariants({ variant: 'outline' }), 'mt-3 w-full')}
      >
        {t('auth.desktop.changeServer')}
      </button>
    </SigninLayout>
  );
}

/**
 * Sign-in screen of the chat app. The server is the page's own address;
 * signing in happens at Cenacle ID: the button is a plain link to the
 * server, which redirects there.
 */
export function SigninPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/signin' });
  const returnTo = safeReturnPath(search.return_to);
  const theme = useChosenTheme();
  const session = useQuery(sessionQuery);
  const meta = useQuery(metaQuery);

  // Already signed in (e.g. the page was bookmarked): go straight on. A
  // session that just ended keeps its old data next to the error: that is
  // not signed in, and redirecting would bounce back here forever.
  if (session.data && !session.isError) return <Navigate to={returnTo} replace />;
  // The desktop app signs in in a window of its own, also while browsers are turned away.
  if (desktop) return <DesktopSignin returnTo={returnTo} />;
  if (meta.data?.web_app === false || search.error === 'web_app_off') return <WebOffPage />;

  return (
    <SigninLayout aside={<Steps />}>
      <h1 className="text-[34px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
        {t('auth.title')}
      </h1>
      <p className="mt-2 text-[15.5px] leading-[1.55] text-muted-foreground">
        {t('auth.subtitle')}
      </p>
      {search.error && (
        <div className="mt-5">
          <SigninMessage error={search.error} />
        </div>
      )}
      <div className="mt-6 grid gap-1.5">
        <span id="signin-server" className="text-[13.5px] font-semibold">
          {t('auth.server')}
        </span>
        <p
          aria-labelledby="signin-server"
          className="flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] border border-rule-strong bg-well px-3.5 py-2"
        >
          <span className="text-[15px] break-all" data-testid="signin-server">
            {serverAddress()}
          </span>
          <span className="ms-auto flex items-center gap-1 text-[12.5px] text-muted-foreground">
            <LockIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
            {t('auth.thisAddress')}
          </span>
        </p>
      </div>
      <a
        href={signInUrl(returnTo, theme)}
        className={cn(buttonVariants({ size: 'lg' }), 'mt-5 h-12 w-full text-[15.5px]')}
        data-testid="signin-continue"
      >
        {t('auth.continue')}
      </a>
      <p className="mt-3 text-[13.5px] leading-5 text-muted-foreground">{t('auth.next')}</p>
      <p className="mt-4 flex items-center gap-2 text-[12.5px] text-muted-foreground lg:hidden">
        <ShieldCheckIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
        {t('auth.stepOf', { step: 1, count: STEPS.length })}
      </p>
    </SigninLayout>
  );
}
