// SPDX-License-Identifier: Apache-2.0
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState, InlineError } from '@cenacle/ui/components/error-state';
import { Logo } from '@cenacle/ui/brand';
import { useLastWorkspace } from './active-workspace';
import { acceptInvite, invitePreviewQuery, reloadWorkspaces } from './workspaces';

/** /invite/<token>: join the workspace of an invitation (signed in). */
export function InvitePage() {
  const { t } = useTranslation();
  const { token } = useParams({ from: '/app/invite/$token' });
  const preview = useQuery(invitePreviewQuery(token));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remember = useLastWorkspace((s) => s.set);
  const accept = useMutation({
    mutationFn: () => acceptInvite(token),
    onSuccess: async (ws) => {
      await reloadWorkspaces(queryClient);
      remember(ws.id);
      void navigate({ to: '/w/$workspaceId', params: { workspaceId: ws.id }, replace: true });
    },
  });

  if (preview.data?.is_member) {
    return (
      <Navigate to="/w/$workspaceId" params={{ workspaceId: preview.data.workspace_id }} replace />
    );
  }
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo variant="lockup" size={28} />
        {preview.isPending ? null : preview.isError ? (
          <ErrorState
            title={t('invites.notFoundTitle')}
            reason={t('invites.notFoundReason')}
            action={t('invites.askAgain')}
            problem={preview.error instanceof ApiError ? preview.error.problem : { status: 404 }}
          />
        ) : !preview.data.valid ? (
          <ErrorState
            title={t('invites.invalidTitle')}
            reason={t('invites.invalidReason')}
            action={t('invites.askAgain')}
            code="invite_invalid"
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="font-display text-3xl font-medium">
                {t('invites.title', { workspace: preview.data.workspace_name })}
              </h1>
              <p className="text-muted-foreground">{t('invites.subtitle')}</p>
            </div>
            {accept.isError && (
              <InlineError
                problem={accept.error instanceof ApiError ? accept.error.problem : { status: 0 }}
                title={
                  accept.error instanceof ApiError && accept.error.status === 410
                    ? t('invites.invalidTitle')
                    : undefined
                }
              />
            )}
            <Button
              size="lg"
              className="h-11 w-full text-base"
              disabled={accept.isPending}
              onClick={() => accept.mutate()}
            >
              {t('invites.join', { workspace: preview.data.workspace_name })}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
