// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import { directoryQuery, reloadChannels } from '../chat/data';
import { MessageBody } from '../chat/markdown/message-body';
import { workspacesQuery } from '../chat/workspaces';
import { finishOnboarding, welcomeQuery } from './community';

/** A workspace's welcome, once, for members who have not seen it. */
export function OnboardingDialog() {
  const { workspace } = useActiveWorkspace();
  if (!workspace?.needs_onboarding) return null;
  return <Onboarding key={workspace.id} workspaceId={workspace.id} name={workspace.name} />;
}

function Onboarding({ workspaceId, name }: { workspaceId: string; name: string }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const welcome = useQuery(welcomeQuery(workspaceId));
  const directory = useQuery(directoryQuery(workspaceId));
  const suggested = (welcome.data?.channel_ids ?? [])
    .map((id) => directory.data?.find((c) => c.id === id))
    .filter((c) => c !== undefined);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const picked = chosen ?? new Set(suggested.filter((c) => !c.is_member).map((c) => c.id));
  const done = useMutation({
    mutationFn: () => finishOnboarding(workspaceId, [...picked]),
    onSuccess: async () => {
      await reloadChannels(queryClient);
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
    },
    onError: () => toast.error(t('community.welcome.failed')),
  });
  if (!welcome.data) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && done.mutate()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" data-testid="onboarding">
        <DialogHeader>
          <DialogTitle>{t('community.welcome.title', { workspace: name })}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('community.welcome.description')}
          </DialogDescription>
        </DialogHeader>
        {welcome.data.message && (
          <div className="text-sm">
            <MessageBody body={welcome.data.message} mentions={[]} selfId={user.id} />
          </div>
        )}
        {welcome.data.rules.length > 0 && (
          <section aria-labelledby="welcome-rules" className="flex flex-col gap-2">
            <h3 id="welcome-rules" className="text-xs font-medium text-muted-foreground uppercase">
              {t('community.welcome.rules')}
            </h3>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {welcome.data.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ol>
          </section>
        )}
        {suggested.length > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground uppercase">
              {t('community.welcome.channels')}
            </legend>
            {suggested.map((c) => (
              <label
                key={c.id}
                data-target
                className="flex min-h-target items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  data-target-exempt
                  className="size-4 accent-primary"
                  checked={c.is_member || picked.has(c.id)}
                  disabled={c.is_member}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setChosen(next);
                  }}
                />
                <span className="font-medium">#{c.name}</span>
                {c.topic && <span className="truncate text-muted-foreground">{c.topic}</span>}
              </label>
            ))}
          </fieldset>
        )}
        <DialogFooter>
          <Button disabled={done.isPending} onClick={() => done.mutate()}>
            {t('community.welcome.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
