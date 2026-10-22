// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError, isUnauthenticated } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Logo } from '@cenacle/ui/brand';
import { SessionContext, sessionQuery, signinSearchFor } from './session';
import { AppearanceSync } from '../appearance/appearance-sync';
import { NotificationsSync } from '../notifications/notifications-sync';
import { RealtimeProvider } from '../chat/realtime';
import { InstanceBanner } from '../community/banner';
import { TermsGate } from '../community/terms-gate';

/**
 * Renders the app for signed-in users. When the session ends while the app
 * is open (idle timeout, sign-out in another tab), it goes to /signin with
 * the current location, so signing in again returns to the same place
 * (drafts stay in IndexedDB).
 */
export function RequireSession() {
  const { t } = useTranslation();
  const session = useQuery(sessionQuery);
  const href = useRouterState({ select: (s) => s.location.href });
  const navigate = useNavigate();
  const ended = session.isError && isUnauthenticated(session.error);

  // Navigate once: the location changes while navigating, and following it
  // would start a new navigation each time (an endless loop).
  const redirected = useRef(false);
  useEffect(() => {
    if (ended && !redirected.current) {
      redirected.current = true;
      void navigate({
        to: '/signin',
        search: signinSearchFor(href, 'session_expired'),
        replace: true,
      });
    }
  }, [ended, href, navigate]);

  if (session.data && !ended) {
    return (
      <SessionContext.Provider value={session.data}>
        <TermsGate>
          <RealtimeProvider>
            <AppearanceSync />
            <NotificationsSync />
            <div className="flex h-svh flex-col">
              <InstanceBanner />
              <div className="min-h-0 flex-1">
                <Outlet />
              </div>
            </div>
          </RealtimeProvider>
        </TermsGate>
      </SessionContext.Provider>
    );
  }
  if (session.isError && !ended) {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <ErrorState
          problem={session.error instanceof ApiError ? session.error.problem : { status: 500 }}
          className="max-w-md"
          actions={
            <Button onClick={() => void session.refetch()} disabled={session.isFetching}>
              {t('ui:errors.retry')}
            </Button>
          }
        />
      </main>
    );
  }
  return (
    <main aria-busy className="flex min-h-svh items-center justify-center">
      <Logo
        variant="icon"
        size={40}
        decorative
        className="animate-pulse motion-reduce:animate-none"
      />
      <span className="sr-only">{t('auth.loading')}</span>
    </main>
  );
}
