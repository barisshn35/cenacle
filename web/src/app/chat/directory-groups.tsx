// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { reloadChannels, type Channel } from './data';
import {
  channelGroupsQuery,
  deleteWorkspaceGroup,
  reloadWorkspaces,
  setChannelGroups,
  setWorkspaceGroup,
  workspaceGroupsQuery,
  type GroupMapping,
  type Workspace,
} from './workspaces';

const selectClass =
  'min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60';

const ROLES: GroupMapping['role'][] = ['admin', 'member', 'guest'];

/**
 * A mapping whose group Cenacle ID renamed when several groups had its name
 * (ADR 0046): it matches none of them until an administrator picks one of
 * the new names or keeps it as it is (or removes it).
 */
function GroupReviewNotice({
  group,
  candidates,
  disabled,
  onPick,
  onKeep,
}: {
  group: string;
  candidates: string[];
  disabled: boolean;
  onPick: (candidate: string) => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-hint`}
      className="grid gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-sm"
      data-testid="group-review"
    >
      <p id={`${id}-title`} className="flex items-center gap-1.5 font-medium">
        <AlertCircleIcon aria-hidden className="size-3.5 text-warning" strokeWidth={1.75} />
        {t('groups.review')}: <span className="font-mono">{group}</span>
      </p>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('groups.reviewHint')}
      </p>
      <div className="flex flex-wrap gap-2">
        {candidates.map((c) => (
          <Button key={c} size="sm" variant="outline" disabled={disabled} onClick={() => onPick(c)}>
            {t('groups.useCandidate', { group: c })}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onKeep}>
          {t('groups.keep')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Directory groups of Cenacle ID that give membership of a workspace: their
 * people join with the mapped role at sign-in and when the directory changes.
 */
export function WorkspaceGroupsSection({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const id = useId();
  const groups = useQuery(workspaceGroupsQuery(workspace.id));
  const queryClient = useQueryClient();
  const [group, setGroup] = useState('');
  const [role, setRole] = useState<GroupMapping['role']>('member');
  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: ['workspace-groups', workspace.id] });
    await queryClient.invalidateQueries({ queryKey: ['workspace-members', workspace.id] });
    await reloadWorkspaces(queryClient);
  };
  const failed = () => toast.error(t('channels.changeFailed'));
  const save = useMutation({
    mutationFn: (m: GroupMapping) => setWorkspaceGroup(workspace.id, m),
    onSuccess: changed,
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (name: string) => deleteWorkspaceGroup(workspace.id, name),
    onSuccess: changed,
    onError: failed,
  });
  // Under review: the chosen new name takes the mapping's place.
  const pick = useMutation({
    mutationFn: async ({ from, to }: { from: GroupMapping; to: string }) => {
      await setWorkspaceGroup(workspace.id, { group: to, role: from.role });
      await deleteWorkspaceGroup(workspace.id, from.group);
    },
    onSuccess: changed,
    onError: failed,
  });
  const busy = save.isPending || remove.isPending || pick.isPending;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = group.trim();
    if (!name) return;
    save.mutate({ group: name, role }, { onSuccess: () => setGroup('') });
  };

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2" data-testid="workspace-groups">
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('groups.title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('groups.workspaceHint')}</p>
      {groups.data && groups.data.mappings.length > 0 && (
        <ul className="grid gap-1">
          {groups.data.mappings.map((m) => (
            <li key={m.group} className="grid gap-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{m.group}</span>
                <label htmlFor={`${id}-${m.group}`} className="sr-only">
                  {t('groups.roleOf', { group: m.group })}
                </label>
                <select
                  id={`${id}-${m.group}`}
                  className={selectClass}
                  value={m.role}
                  disabled={save.isPending}
                  onChange={(e) =>
                    save.mutate({ group: m.group, role: e.target.value as GroupMapping['role'] })
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`workspaces.roles.${r}`)}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('groups.remove', { group: m.group })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(m.group)}
                >
                  <XIcon strokeWidth={1.75} />
                </Button>
              </div>
              {m.candidates && m.candidates.length > 0 && (
                <GroupReviewNotice
                  group={m.group}
                  candidates={m.candidates}
                  disabled={busy}
                  onPick={(to) => pick.mutate({ from: m, to })}
                  // Saved by hand, a mapping is reviewed.
                  onKeep={() => save.mutate({ group: m.group, role: m.role })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-40 flex-1 gap-1">
          <Label htmlFor={`${id}-group`}>{t('groups.group')}</Label>
          <Input
            id={`${id}-group`}
            value={group}
            maxLength={200}
            autoComplete="off"
            list={`${id}-known`}
            onChange={(e) => setGroup(e.target.value)}
          />
          <datalist id={`${id}-known`}>
            {groups.data?.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-role`}>{t('groups.role')}</Label>
          <select
            id={`${id}-role`}
            className={selectClass}
            value={role}
            onChange={(e) => setRole(e.target.value as GroupMapping['role'])}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`workspaces.roles.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" disabled={save.isPending || !group.trim()}>
          {t('groups.add')}
        </Button>
      </form>
    </section>
  );
}

/** Directory groups of a private channel; managed: its members are exactly their people. */
export function ChannelGroupsSection({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const id = useId();
  const current = useQuery(channelGroupsQuery(channel.id));
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [managed, setManaged] = useState<boolean | null>(null);
  const shownText = text ?? current.data?.groups.join(', ') ?? '';
  const shownManaged = managed ?? current.data?.managed ?? false;
  const saved = async () => {
    setText(null);
    setManaged(null);
    await queryClient.invalidateQueries({ queryKey: ['channel-groups', channel.id] });
    await queryClient.invalidateQueries({ queryKey: ['members', channel.id] });
    await reloadChannels(queryClient);
    toast.success(t('groups.saved'));
  };
  const save = useMutation({
    mutationFn: () =>
      setChannelGroups(channel.id, {
        groups: shownText
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean),
        managed: shownManaged,
      }),
    onSuccess: saved,
    onError: () => toast.error(t('channels.changeFailed')),
  });
  // A group under review (from the saved groups, not the field being edited):
  // a new name takes its place, or it stays as it is.
  const review = useMutation({
    mutationFn: ({ group, to }: { group: string; to?: string }) => {
      const groups = current.data?.groups ?? [];
      return setChannelGroups(channel.id, {
        groups: to ? groups.map((g) => (g === group ? to : g)) : groups,
        managed: current.data?.managed ?? false,
        reviewed: to ? [] : [group],
      });
    },
    onSuccess: saved,
    onError: () => toast.error(t('channels.changeFailed')),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      aria-labelledby={`${id}-title`}
      className="grid gap-2 border-t pt-4"
      data-testid="channel-groups"
    >
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('groups.title')}
      </h3>
      {current.data?.reviews?.map((r) => (
        <GroupReviewNotice
          key={r.group}
          group={r.group}
          candidates={r.candidates}
          disabled={review.isPending || save.isPending}
          onPick={(to) => review.mutate({ group: r.group, to })}
          onKeep={() => review.mutate({ group: r.group })}
        />
      ))}
      <Label htmlFor={`${id}-groups`}>{t('groups.channelGroups')}</Label>
      <Input
        id={`${id}-groups`}
        value={shownText}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        onChange={(e) => setText(e.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('groups.channelHint')}
      </p>
      <label data-target className="flex min-h-target items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={shownManaged}
          onChange={(e) => setManaged(e.target.checked)}
          className="size-4 accent-primary"
          // The whole label is the target (at least 24 px).
          data-target-exempt
        />
        {t('groups.managed')}
      </label>
      <div>
        <Button type="submit" variant="outline" disabled={save.isPending || current.isPending}>
          {t('groups.saveChannel')}
        </Button>
      </div>
    </form>
  );
}
