// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { Logo } from '@cenacle/ui/brand';
import { useSession } from '../auth/session';
import { useSignOut } from '../auth/sign-out';
import { MessageBody } from '../chat/markdown/message-body';
import { acceptTerms, termsQuery } from './community';

/**
 * Shows the terms of service in force until the person accepts them; the app
 * (and its live connection) starts only then. Without terms, or when they
 * cannot be read, the app shows as usual (the server enforces them anyway).
 */
export function TermsGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const terms = useQuery(termsQuery);
  const signOut = useSignOut();
  const accept = useMutation({
    mutationFn: (id: string) => acceptTerms(id),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: () => {
      toast.error(t('community.terms.failed'));
      void queryClient.invalidateQueries({ queryKey: termsQuery.queryKey });
    },
  });
  if (terms.isPending) return null;
  const pending = terms.data?.terms && !terms.data.accepted ? terms.data.terms : null;
  if (!pending) return <>{children}</>;
  return (
    <main
      aria-labelledby="terms-title"
      className="flex min-h-svh items-start justify-center overflow-y-auto bg-background p-4 sm:p-8"
    >
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <Logo variant="icon" size={32} decorative />
        <h1 id="terms-title" className="font-display text-2xl font-medium">
          {t('community.terms.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('community.terms.intro')}</p>
        <div
          data-testid="terms-text"
          className="max-h-[55svh] overflow-y-auto rounded-xl border bg-card p-4 text-sm"
        >
          <MessageBody body={pending.text} mentions={[]} selfId={user.id} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={accept.isPending} onClick={() => accept.mutate(pending.id)}>
            {t('community.terms.accept')}
          </Button>
          <Button variant="ghost" onClick={() => signOut.mutate()}>
            {t('community.terms.signOut')}
          </Button>
        </div>
      </div>
    </main>
  );
}
