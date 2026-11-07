// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  FolderTreeIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserMinusIcon,
  UsersRoundIcon,
  XIcon,
} from 'lucide-react';
import { useDeferredValue, useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Dialog } from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { PersonLine } from '../chat/channel-members';
import { peopleQuery, type Person } from '../chat/data';
import { isWorkspaceAdmin, workspaceGroupsQuery, type Workspace } from '../chat/workspaces';
import { SideNavDialog } from '../shell/side-nav-dialog';
import {
  addGroupMembers,
  createGroup,
  groupQuery,
  groupsQuery,
  HANDLE,
  removeGroupMember,
  RESERVED,
  setGroupCreation,
  setGroupManager,
  suggestHandle,
  updateGroup,
  type GroupList,
  type MentionGroup,
} from './groups';

type Section = 'mine' | 'all' | 'archived' | 'settings';

/**
 * The workspace's groups, mentioned together as @handle: the person's own,
 * all of them and the archived ones; a group opens in place with its members.
 * Administrators choose who may create groups.
 */
export function GroupsDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const admin = isWorkspaceAdmin(workspace);
  const [section, setSection] = useState<Section>('mine');
  const [shown, setShown] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery(groupsQuery(workspace.id));
  const groups = list.data?.groups ?? [];
  const inSection = (s: Section) =>
    s === 'archived'
      ? groups.filter((g) => g.archived)
      : groups.filter((g) => !g.archived && (s === 'all' || g.is_member));
  const pick = (s: Section) => {
    setSection(s);
    setShown(null);
    setCreating(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SideNavDialog
        id="groups"
        title={t('userGroups.title')}
        subtitle={workspace.name}
        value={section}
        onChange={pick}
        description={t(`userGroups.sections.${section}`)}
        groups={[
          {
            items: [
              {
                key: 'mine',
                label: t('userGroups.sectionNames.mine'),
                icon: UsersRoundIcon,
                count: inSection('mine').length,
              },
              {
                key: 'all',
                label: t('userGroups.sectionNames.all'),
                icon: FolderTreeIcon,
                count: inSection('all').length,
              },
              {
                key: 'archived',
                label: t('userGroups.sectionNames.archived'),
                icon: ArchiveIcon,
                count: inSection('archived').length,
              },
            ],
          },
          ...(admin
            ? [
                {
                  label: t('userGroups.adminLabel'),
                  items: [
                    {
                      key: 'settings' as const,
                      label: t('userGroups.sectionNames.settings'),
                      icon: SettingsIcon,
                    },
                  ],
                },
              ]
            : []),
        ]}
        footer={t('userGroups.footer')}
      >
        {creating ? (
          <CreateGroup
            workspace={workspace}
            onDone={(id) => {
              setCreating(false);
              if (id) setShown(id);
            }}
          />
        ) : shown ? (
          <GroupDetail groupId={shown} workspaceId={workspace.id} onBack={() => setShown(null)} />
        ) : section === 'settings' ? (
          <GroupSettings workspaceId={workspace.id} list={list.data} />
        ) : (
          <GroupRows
            groups={inSection(section)}
            empty={t(`userGroups.empty.${section}`)}
            canCreate={section !== 'archived' && !!list.data?.can_create}
            onCreate={() => setCreating(true)}
            onOpen={setShown}
          />
        )}
      </SideNavDialog>
    </Dialog>
  );
}

function GroupRows({
  groups,
  empty,
  canCreate,
  onCreate,
  onOpen,
}: {
  groups: MentionGroup[];
  empty: string;
  canCreate: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 pt-4">
      {canCreate && (
        <div className="flex justify-end">
          <Button size="sm" onClick={onCreate}>
            <PlusIcon aria-hidden strokeWidth={1.75} />
            {t('userGroups.create')}
          </Button>
        </div>
      )}
      {groups.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-[10px] border">
          {groups.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => onOpen(g.id)}
                className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"
                >
                  <UsersRoundIcon className="size-4" strokeWidth={1.75} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-sm font-semibold">@{g.handle}</span>
                  <span className="truncate text-xs text-muted-foreground">{g.name}</span>
                </span>
                {g.directory_group && (
                  <span className="text-xs text-muted-foreground max-sm:hidden">
                    {t('userGroups.directoryTag')}
                  </span>
                )}
                {g.is_member && (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                    {g.can_manage && !g.directory_group
                      ? t('userGroups.manager')
                      : t('userGroups.member')}
                  </span>
                )}
                <span className="w-20 text-end text-xs tabular-nums text-muted-foreground">
                  {t('userGroups.people', { count: g.member_count })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Finds people of the workspace to add (not the ones listed in `except`). */
function PeopleFinder({
  workspaceId,
  except,
  onPick,
}: {
  workspaceId: string;
  except: Set<string>;
  onPick: (person: Person) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const people = useQuery(peopleQuery(workspaceId, query));
  const results = (people.data ?? []).filter((p) => !except.has(p.id) && !p.is_bot);
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t('channels.findPeople')}</Label>
      <Input
        id={id}
        type="search"
        value={q}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
      />
      {query !== '' && (
        <ul aria-live="polite" className="-mx-1 grid max-h-56 gap-1 overflow-y-auto">
          {results.map((person) => (
            <li key={person.id} className="flex items-center gap-2 px-1">
              <PersonLine person={person} />
              <Button
                size="sm"
                variant="outline"
                aria-label={t('dm.pick', { person: person.display_name || person.email })}
                onClick={() => {
                  onPick(person);
                  setQ('');
                }}
              >
                {t('channels.add')}
              </Button>
            </li>
          ))}
          {people.data && results.length === 0 && (
            <li className="px-1 text-sm text-muted-foreground">{t('channels.noPeople')}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Why a handle cannot be used, or null. */
function handleProblem(handle: string, t: (key: string) => string): string | null {
  if (handle === '') return null;
  if (RESERVED.has(handle)) return t('userGroups.handleReserved');
  return HANDLE.test(handle) ? null : t('userGroups.handleRules');
}

function CreateGroup({
  workspace,
  onDone,
}: {
  workspace: Workspace;
  onDone: (id?: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const admin = isWorkspaceAdmin(workspace);
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<Person[]>([]);
  const [directory, setDirectory] = useState<string | null>(null);
  const directoryGroups = useQuery({
    ...workspaceGroupsQuery(workspace.id),
    enabled: admin && directory !== null,
  });
  const theHandle = (handle ?? suggestHandle(name)).toLowerCase();
  const problem = handleProblem(theHandle, t);
  const create = useMutation({
    mutationFn: () =>
      createGroup(workspace.id, {
        handle: theHandle,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(directory !== null
          ? { directory_group: directory.trim() }
          : { member_ids: members.map((m) => m.id) }),
      }),
    onSuccess: async (g) => {
      await queryClient.invalidateQueries({ queryKey: ['mention-groups', workspace.id] });
      toast.success(t('userGroups.created', { handle: g.handle }));
      onDone(g.id);
    },
  });
  const taken = create.error instanceof ApiError && create.error.problem.code === 'handle_taken';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && theHandle && !problem) create.mutate();
  };

  return (
    <form className="flex max-w-xl flex-col gap-5 pt-4" onSubmit={submit}>
      <BackButton label={t('userGroups.back')} onClick={() => onDone()} />
      <h3 className="text-base font-semibold">{t('userGroups.createTitle')}</h3>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>{t('userGroups.name')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={64}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-handle`}>{t('userGroups.handle')}</Label>
        <div className="flex items-center gap-1">
          <span aria-hidden className="text-sm text-muted-foreground">
            @
          </span>
          <Input
            id={`${id}-handle`}
            value={theHandle}
            maxLength={30}
            aria-invalid={!!problem || taken || undefined}
            aria-describedby={`${id}-handle-help`}
            onChange={(e) => setHandle(e.target.value.replace(/^@/, '').toLowerCase())}
          />
        </div>
        <p
          id={`${id}-handle-help`}
          className={cn('text-xs', problem || taken ? 'text-destructive' : 'text-muted-foreground')}
        >
          {taken ? t('userGroups.handleTaken') : (problem ?? t('userGroups.handleHint'))}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-description`}>{t('userGroups.description')}</Label>
        <Input
          id={`${id}-description`}
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {admin && (
        <label className="flex min-h-target items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={directory !== null}
            onChange={(e) => setDirectory(e.target.checked ? '' : null)}
          />
          {t('userGroups.followDirectory')}
        </label>
      )}
      {directory !== null ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-directory`}>{t('userGroups.directoryGroup')}</Label>
          <Input
            id={`${id}-directory`}
            value={directory}
            list={`${id}-directory-list`}
            maxLength={200}
            required
            onChange={(e) => setDirectory(e.target.value)}
          />
          <datalist id={`${id}-directory-list`}>
            {directoryGroups.data?.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">{t('userGroups.directoryHint')}</p>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('userGroups.members')}</p>
          <p className="text-xs text-muted-foreground">{t('userGroups.youManage')}</p>
          {members.length > 0 && (
            <ul aria-label={t('userGroups.picked')} className="flex flex-wrap gap-1.5">
              {members.map((p) => (
                <li key={p.id}>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-label={t('dm.unpick', { person: p.display_name || p.email })}
                    onClick={() => setMembers(members.filter((x) => x.id !== p.id))}
                  >
                    {p.display_name || p.email}
                    <XIcon aria-hidden strokeWidth={1.75} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <PeopleFinder
            workspaceId={workspace.id}
            except={new Set([self, ...members.map((m) => m.id)])}
            onPick={(p) => setMembers([...members, p])}
          />
        </div>
      )}
      {create.isError && !taken && (
        <InlineError
          problem={create.error instanceof ApiError ? create.error.problem : { status: 500 }}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {t('glossary.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={!name.trim() || !theHandle || !!problem || create.isPending}
          aria-busy={create.isPending || undefined}
        >
          {t('userGroups.create')}
        </Button>
      </div>
    </form>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="-ms-2 w-fit" onClick={onClick}>
      <ArrowLeftIcon aria-hidden strokeWidth={1.75} />
      {label}
    </Button>
  );
}

function GroupDetail({
  groupId,
  workspaceId,
  onBack,
}: {
  groupId: string;
  workspaceId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const detail = useQuery(groupQuery(groupId));
  const [editing, setEditing] = useState(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['mention-group', groupId] });
    await queryClient.invalidateQueries({ queryKey: ['mention-groups', workspaceId] });
  };
  const failed = (err: unknown) =>
    toast.error(
      err instanceof ApiError && err.problem.code === 'last_manager'
        ? t('userGroups.lastManager')
        : t('userGroups.changeFailed'),
    );
  const change = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: failed,
  });
  const archive = (archived: boolean) =>
    change.mutate(() => updateGroup(groupId, { archived }), {
      onSuccess: () => {
        if (archived) {
          showUndoToast({
            message: t('userGroups.archived'),
            onUndo: async () => {
              await updateGroup(groupId, { archived: false });
              await refresh();
            },
          });
        }
      },
    });

  if (!detail.data) {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <BackButton label={t('userGroups.back')} onClick={onBack} />
        {detail.isError ? (
          <InlineError
            problem={detail.error instanceof ApiError ? detail.error.problem : { status: 500 }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('userGroups.loading')}</p>
        )}
      </div>
    );
  }
  const { group, members } = detail.data;
  const own = !group.directory_group;
  const manage = group.can_manage;
  const memberIds = new Set(members.map((m) => m.person.id));

  return (
    <div className="flex max-w-2xl flex-col gap-5 pt-4">
      <BackButton label={t('userGroups.back')} onClick={onBack} />
      {editing ? (
        <EditGroup
          group={group}
          onDone={async (saved) => {
            setEditing(false);
            if (saved) await refresh();
          }}
        />
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold">@{group.handle}</h3>
            <p className="text-sm">{group.name}</p>
            {group.description && (
              <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
            )}
            {group.directory_group && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('userGroups.follows', { group: group.directory_group })}
              </p>
            )}
            {group.archived && (
              <p className="mt-2 text-xs text-muted-foreground">{t('userGroups.archivedNote')}</p>
            )}
          </div>
          {manage && !group.archived && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <PencilIcon aria-hidden strokeWidth={1.75} />
              {t('userGroups.edit')}
            </Button>
          )}
        </div>
      )}

      <section aria-labelledby={`members-${group.id}`} className="flex flex-col gap-2">
        <h4 id={`members-${group.id}`} className="text-sm font-semibold">
          {t('userGroups.people', { count: members.length })}
        </h4>
        <ul className="divide-y rounded-[10px] border">
          {members.map((m) => (
            <li key={m.person.id} className="flex items-center gap-2 px-3 py-2">
              <PersonLine
                person={m.person}
                card
                badge={m.manager ? t('userGroups.manager') : undefined}
              />
              {own && manage && !group.archived && m.person.id !== self && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={
                      m.manager
                        ? t('userGroups.unmakeManager', { person: m.person.display_name })
                        : t('userGroups.makeManager', { person: m.person.display_name })
                    }
                    onClick={() =>
                      change.mutate(() => setGroupManager(group.id, m.person.id, !m.manager))
                    }
                  >
                    <ShieldCheckIcon aria-hidden strokeWidth={1.75} />
                    <span className="max-sm:hidden">
                      {m.manager ? t('userGroups.fromManager') : t('userGroups.toManager')}
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('userGroups.remove', { person: m.person.display_name })}
                    onClick={() => change.mutate(() => removeGroupMember(group.id, m.person.id))}
                  >
                    <UserMinusIcon aria-hidden strokeWidth={1.75} />
                  </Button>
                </>
              )}
            </li>
          ))}
          {members.length === 0 && (
            <li className="px-3 py-3 text-sm text-muted-foreground">{t('userGroups.noMembers')}</li>
          )}
        </ul>
      </section>

      {own && manage && !group.archived && (
        <PeopleFinder
          workspaceId={workspaceId}
          except={memberIds}
          onPick={(p) => change.mutate(() => addGroupMembers(group.id, [p.id]))}
        />
      )}

      <div className="flex flex-wrap gap-2 border-t pt-4">
        {own && memberIds.has(self) && (
          <Button
            variant="outline"
            onClick={() =>
              change.mutate(() => removeGroupMember(group.id, self), { onSuccess: onBack })
            }
          >
            <LogOutIcon aria-hidden strokeWidth={1.75} />
            {t('userGroups.leave')}
          </Button>
        )}
        {manage &&
          (group.archived ? (
            <Button variant="outline" onClick={() => archive(false)}>
              <ArchiveRestoreIcon aria-hidden strokeWidth={1.75} />
              {t('userGroups.restore')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => archive(true)}>
              <ArchiveIcon aria-hidden strokeWidth={1.75} />
              {t('userGroups.archive')}
            </Button>
          ))}
      </div>
    </div>
  );
}

function EditGroup({ group, onDone }: { group: MentionGroup; onDone: (saved: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(group.name);
  const [handle, setHandle] = useState(group.handle);
  const [description, setDescription] = useState(group.description);
  const problem = handleProblem(handle, t);
  const save = useMutation({
    mutationFn: () => updateGroup(group.id, { name: name.trim(), handle, description }),
    onSuccess: () => onDone(true),
  });
  const taken = save.error instanceof ApiError && save.error.problem.code === 'handle_taken';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && handle && !problem) save.mutate();
  };
  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>{t('userGroups.name')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-handle`}>{t('userGroups.handle')}</Label>
        <Input
          id={`${id}-handle`}
          value={handle}
          maxLength={30}
          aria-invalid={!!problem || taken || undefined}
          aria-describedby={`${id}-handle-help`}
          onChange={(e) => setHandle(e.target.value.replace(/^@/, '').toLowerCase())}
        />
        <p
          id={`${id}-handle-help`}
          className={cn('text-xs', problem || taken ? 'text-destructive' : 'text-muted-foreground')}
        >
          {taken ? t('userGroups.handleTaken') : (problem ?? t('userGroups.renameHint'))}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-description`}>{t('userGroups.description')}</Label>
        <Input
          id={`${id}-description`}
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onDone(false)}>
          {t('glossary.cancel')}
        </Button>
        <Button type="submit" disabled={!name.trim() || !handle || !!problem || save.isPending}>
          {t('chat.save')}
        </Button>
      </div>
    </form>
  );
}

function GroupSettings({ workspaceId, list }: { workspaceId: string; list?: GroupList }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (creation: GroupList['creation']) => setGroupCreation(workspaceId, creation),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mention-groups', workspaceId] }),
    onError: () => toast.error(t('userGroups.changeFailed')),
  });
  const value = set.isPending ? set.variables : list?.creation;
  return (
    <fieldset className="flex flex-col gap-2 pt-5">
      <legend className="mb-2 text-sm font-semibold">{t('userGroups.whoCreates')}</legend>
      {(['members', 'admins'] as const).map((c) => (
        <div key={c} className="flex min-h-target items-start gap-2.5 text-sm">
          <input
            id={`group-creation-${c}`}
            type="radio"
            name="group-creation"
            className="mt-1 size-4"
            checked={value === c}
            aria-describedby={`group-creation-${c}-hint`}
            onChange={() => set.mutate(c)}
          />
          <div>
            <label htmlFor={`group-creation-${c}`} className="font-medium">
              {t(`userGroups.creation.${c}`)}
            </label>
            <p id={`group-creation-${c}-hint`} className="text-xs text-muted-foreground">
              {t(`userGroups.creationHint.${c}`)}
            </p>
          </div>
        </div>
      ))}
    </fieldset>
  );
}
