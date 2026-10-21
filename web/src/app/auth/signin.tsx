// SPDX-License-Identifier: Apache-2.0
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { safeReturnPath, signInUrl } from '@cenacle/core/api';
import { buttonVariants } from '@cenacle/ui/components/button';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Logo } from '@cenacle/ui/brand';
import { cn } from '@cenacle/ui/lib/utils';
import { AppearanceControls } from '../shell/appearance-controls';
import { sessionQuery, type SigninError } from './session';

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

/**
 * Sign-in screen of the chat app. Signing in happens at Cenacle ID: the
 * button is a plain link to the server, which redirects there.
 */
export function SigninPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/signin' });
  const returnTo = safeReturnPath(search.return_to);
  const session = useQuery(sessionQuery);

  // Already signed in (e.g. the page was bookmarked): go straight on.
  if (session.data) return <Navigate to={returnTo} replace />;

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <Logo variant="lockup" size={28} />
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-3xl font-medium">{t('auth.title')}</h1>
            <p className="text-muted-foreground">{t('auth.subtitle')}</p>
          </div>
          {search.error && <SigninMessage error={search.error} />}
          <a
            href={signInUrl(returnTo)}
            className={cn(buttonVariants({ size: 'lg' }), 'h-11 w-full text-base')}
            data-testid="signin-continue"
          >
            {t('auth.continue')}
          </a>
          <p className="text-sm text-muted-foreground">{t('auth.help')}</p>
        </div>
      </main>
      <footer className="flex justify-center p-4">
        <AppearanceControls />
      </footer>
    </div>
  );
}
