// SPDX-License-Identifier: AGPL-3.0-only
import { WorkspaceAIForm } from '../ai/ai-ui';
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  BellIcon,
  BellOffIcon,
  BotIcon,
  ChevronDownIcon,
  CopyIcon,
  GlobeIcon,
  HandIcon,
  KeyRoundIcon,
  LogOutIcon,
  ScaleIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldIcon,
  SparklesIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  UsersRoundIcon,
} from 'lucide-react';
import { GroupsDialog } from '../groups/groups-dialog';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { useSession } from '../auth/session';
import {
  FOREVER,
  isActive,
  notificationsQuery,
  setWorkspaceMute,
} from '../notifications/notifications';
import { WorkspaceGroupsSection } from './directory-groups';
import {
  EditHistorySetting,
  PersistentSetting,
  ReadReceiptsSetting,
  WorkspaceAppearanceForm,
  WorkspaceDetailsForm,
} from './workspace-details';
import { IntegrationsDialog } from './integrations';
import { useLastWorkspace } from './active-workspace';
import {
  createInvite,
  createWorkspace,
  invitesQuery,
  inviteLink,
  inviteToken,
  isSpillageReviewer,
  isWorkspaceAdmin,
  may,
  reloadWorkspaces,
  removeWorkspaceMember,
  revokeInvite,
  setWorkspaceRole,
  workspaceMembersQuery,
  type Workspace,
} from './workspaces';
import { ModerationDialog, TimeoutSelect } from '../community/moderation';
import { WelcomeForm } from '../community/admin-panels';
import { PermissionsSetting } from './permissions-setting';
import { SpillageDialog } from '../compliance/spillage';
import { EmojiAndStickers } from '../richer/manage';
import { dateLocale } from '../../i18n/time-format';
import { cn } from '@cenacle/ui/lib/utils';
import { UserAvatar } from '../profile/avatar';
import { SideNavDialog } from '../shell/side-nav-dialog';
import { sideNavLink } from '../shell/board-styles';

const selectClass =
  'min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60';

/** The workspace name in the sidebar header opens this menu. */
export function WorkspaceMenu({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<
    'settings' | 'invite' | 'integrations' | 'leave' | 'moderation' | 'groups' | 'spillage' | null
  >(null);
  const admin = isWorkspaceAdmin(workspace);
  const queryClient = useQueryClient();
  const notifications = useQuery(notificationsQuery);
  const wsMuted = isActive(
    notifications.data?.workspaces.find((w) => w.workspace_id === workspace.id)?.muted_until,
  );
  const toggleMute = () => {
    const until = wsMuted ? null : FOREVER;
    void setWorkspaceMute(workspace.id, until)
      .then(() => queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey }))
      .catch(() => toast.error(t('notifications.saveFailed')));
  };
  const { user } = useSession();
  const navigate = useNavigate();
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="w-full justify-between px-2 text-[0.9375rem] font-semibold"
              aria-label={t('workspaces.menu', { workspace: workspace.name })}
            />
          }
        >
          <span className="truncate">{workspace.name}</span>
          <ChevronDownIcon aria-hidden strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          {may(workspace, 'invite_people') && (
            <DropdownMenuItem onClick={() => setDialog('invite')}>
              <UserPlusIcon strokeWidth={1.75} />
              {t('workspaces.invitePeople')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setDialog('settings')}>
            <SettingsIcon strokeWidth={1.75} />
            {admin ? t('workspaces.settings') : t('workspaces.members')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog('groups')}>
            <UsersRoundIcon strokeWidth={1.75} />
            {t('userGroups.title')}
          </DropdownMenuItem>
          {admin && (
            <DropdownMenuItem onClick={() => setDialog('moderation')}>
              <ShieldIcon strokeWidth={1.75} />
              {t('community.moderation.open')}
            </DropdownMenuItem>
          )}
          {isSpillageReviewer(workspace, user.id) && (
            <DropdownMenuItem onClick={() => setDialog('spillage')}>
              <ShieldAlertIcon strokeWidth={1.75} />
              {t('spillage.title')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => toggleMute()}>
            {wsMuted ? <BellIcon strokeWidth={1.75} /> : <BellOffIcon strokeWidth={1.75} />}
            {wsMuted ? t('notifications.unmuteWorkspace') : t('notifications.muteWorkspace')}
          </DropdownMenuItem>
          {admin && (
            <DropdownMenuItem onClick={() => setDialog('integrations')}>
              <BotIcon strokeWidth={1.75} />
              {t('bots.title')}
            </DropdownMenuItem>
          )}
          {!workspace.is_default && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDialog('leave')}>
                <LogOutIcon strokeWidth={1.75} />
                {t('workspaces.leave')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'settings' && (
        <WorkspaceSettingsDialog
          workspace={workspace}
          open
          onOpenChange={close}
          onOpen={setDialog}
        />
      )}
      {dialog === 'invite' && <InviteDialog workspace={workspace} open onOpenChange={close} />}
      {dialog === 'groups' && <GroupsDialog workspace={workspace} open onOpenChange={close} />}
      {dialog === 'moderation' && (
        <ModerationDialog workspace={workspace} open onOpenChange={close} />
      )}
      {dialog === 'spillage' && <SpillageDialog workspace={workspace} open onOpenChange={close} />}
      {dialog === 'integrations' && (
        <IntegrationsDialog workspace={workspace} open onOpenChange={close} />
      )}
      <ConfirmDialog
        open={dialog === 'leave'}
        onOpenChange={close}
        severity="s2"
        title={t('workspaces.leaveTitle', { workspace: workspace.name })}
        description={<p>{t('workspaces.leaveDescription')}</p>}
        impact={t('workspaces.leaveImpact')}
        confirmLabel={t('workspaces.leaveConfirm')}
        onConfirm={async () => {
          try {
            await removeWorkspaceMember(workspace.id, user.id);
            await reloadWorkspaces(queryClient);
            void navigate({ to: '/' });
          } catch (err) {
            toast.error(
              err instanceof ApiError && err.problem.code === 'last_owner'
                ? t('workspaces.lastOwner')
                : t('channels.changeFailed'),
            );
          }
        }}
      />
    </>
  );
}

/** Name (owners and admins), members with their roles. */
function WorkspaceSettingsDialog({
  workspace,
  open,
  onOpenChange,
  onOpen,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens another dialog of the workspace instead of this one. */
  onOpen: (dialog: 'integrations' | 'moderation') => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const nameId = useId();
  const { user } = useSession();
  const admin = isWorkspaceAdmin(workspace);
  const owner = workspace.role === 'owner';
  const members = useQuery(workspaceMembersQuery(workspace.id));
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['workspace-members', workspace.id] });
  const failed = (err: unknown) =>
    toast.error(
      err instanceof ApiError && err.problem.code === 'last_owner'
        ? t('workspaces.lastOwner')
        : t('channels.changeFailed'),
    );

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Workspace['role'] }) =>
      setWorkspaceRole(workspace.id, userId, role),
    onSuccess: refresh,
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeWorkspaceMember(workspace.id, userId),
    onSuccess: refresh,
    onError: failed,
  });

  type Section = 'general' | 'members' | 'permissions' | 'welcome' | 'ai';
  // Members open the member list; administrators start at the general settings.
  const [section, setSection] = useState<Section>(admin ? 'general' : 'members');
  const go = (to: '/compliance' | '/federation') => {
    onOpenChange(false);
    void navigate({ to });
  };

  const membersList = (
    <ul
      className="divide-y rounded-[10px] border border-rule-strong bg-background"
      data-testid="workspace-members"
    >
      {members.data?.map((m) => {
        const self = m.user.id === user.id;
        // Admins manage members and admins; only owners touch owners.
        // Guests come from the directory: their role is not changed here.
        const editable = admin && !self && m.role !== 'guest' && (owner || m.role !== 'owner');
        const name = m.user.display_name || m.user.email;
        return (
          <li key={m.user.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <UserAvatar userId={m.user.id} name={name} size="sm" />
            <div className="min-w-0 flex-1 basis-40 leading-tight">
              <p className="truncate text-sm font-semibold">
                {name}
                {self && (
                  <span className="ms-1 font-normal text-muted-foreground">
                    {t('workspaces.you')}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
            </div>
            {editable ? (
              <>
                <label htmlFor={`role-${m.user.id}`} className="sr-only">
                  {t('workspaces.roleOf', { person: name })}
                </label>
                <select
                  id={`role-${m.user.id}`}
                  className={cn(selectClass, 'w-32')}
                  value={m.role}
                  disabled={setRole.isPending}
                  onChange={(e) =>
                    setRole.mutate({
                      userId: m.user.id,
                      role: e.target.value as Workspace['role'],
                    })
                  }
                >
                  {owner && <option value="owner">{t('workspaces.roles.owner')}</option>}
                  <option value="admin">{t('workspaces.roles.admin')}</option>
                  <option value="member">{t('workspaces.roles.member')}</option>
                </select>
                {m.role !== 'owner' && m.role !== 'admin' && (
                  <TimeoutSelect workspace={workspace} userId={m.user.id} name={name} />
                )}
                {!workspace.is_default && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('workspaces.removeNamed', { person: name })}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(m.user.id)}
                  >
                    <UserMinusIcon strokeWidth={1.75} />
                  </Button>
                )}
              </>
            ) : (
              <span className="text-[13px] text-muted-foreground">
                {t(`workspaces.roles.${m.role}`)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SideNavDialog
        id="workspace-settings"
        title={admin ? t('workspaces.settings') : t('workspaces.members')}
        subtitle={workspace.name}
        value={section}
        onChange={setSection}
        description={t(`workspaces.sections.${section}`)}
        groups={[
          {
            label: t('workspaces.groups.workspace'),
            items: [
              { key: 'general', label: t('workspaces.sectionNames.general'), icon: SettingsIcon },
              {
                key: 'members',
                label: t('workspaces.sectionNames.members'),
                icon: UsersIcon,
                count: members.data?.length,
              },
              ...(admin
                ? [
                    {
                      key: 'permissions' as const,
                      label: t('workspaces.sectionNames.permissions'),
                      icon: KeyRoundIcon,
                    },
                    {
                      key: 'welcome' as const,
                      label: t('workspaces.sectionNames.welcome'),
                      icon: HandIcon,
                    },
                    {
                      key: 'ai' as const,
                      label: t('workspaces.sectionNames.ai'),
                      icon: SparklesIcon,
                    },
                  ]
                : []),
            ],
          },
        ]}
        aside={
          admin && (
            <>
              <p className="px-2.5 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                {t('workspaces.groups.more')}
              </p>
              <button type="button" className={sideNavLink} onClick={() => onOpen('integrations')}>
                <BotIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
                {t('bots.title')}
              </button>
              <button type="button" className={sideNavLink} onClick={() => onOpen('moderation')}>
                <ShieldIcon
                  aria-hidden
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.75}
                />
                {t('community.moderation.open')}
              </button>
              <button type="button" className={sideNavLink} onClick={() => go('/compliance')}>
                <ScaleIcon
                  aria-hidden
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.75}
                />
                {t('home.compliance')}
              </button>
              <button type="button" className={sideNavLink} onClick={() => go('/federation')}>
                <GlobeIcon
                  aria-hidden
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.75}
                />
                {t('home.federation')}
              </button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-6 pt-4">
          {section === 'general' &&
            (admin ? (
              <>
                <WorkspaceDetailsForm workspace={workspace} />
                <EditHistorySetting workspace={workspace} />
                <PersistentSetting workspace={workspace} />
                <ReadReceiptsSetting workspace={workspace} />
                <WorkspaceAppearanceForm workspace={workspace} />
                <EmojiAndStickers workspace={workspace} />
              </>
            ) : (
              <>
                {workspace.description && (
                  <p className="text-sm whitespace-pre-line" data-testid="workspace-description">
                    {workspace.description}
                  </p>
                )}
                <EmojiAndStickers workspace={workspace} />
              </>
            ))}
          {section === 'members' && (
            <>
              <section aria-labelledby={`${nameId}-members`} className="grid gap-2">
                <h3 id={`${nameId}-members`} className="text-sm font-semibold">
                  {members.data
                    ? t('channels.membersCount', { count: members.data.length })
                    : t('channels.members')}
                </h3>
                {membersList}
              </section>
              {admin && <WorkspaceGroupsSection workspace={workspace} />}
            </>
          )}
          {section === 'permissions' && <PermissionsSetting workspace={workspace} />}
          {section === 'welcome' && <WelcomeForm workspace={workspace} />}
          {section === 'ai' && <WorkspaceAIForm workspace={workspace} />}
        </div>
      </SideNavDialog>
    </Dialog>
  );
}

const EXPIRY_HOURS = [24, 168, 720] as const;
const MAX_USES = [0, 1, 10, 100] as const;

/** Invitation links: create, copy, revoke (owners and admins). */
function InviteDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const ids = { expiry: useId(), uses: useId(), link: useId() };
  const [expiry, setExpiry] = useState<number>(168);
  const [uses, setUses] = useState<number>(0);
  const [link, setLink] = useState<string | null>(null);
  const invites = useQuery(invitesQuery(workspace.id));
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['invites', workspace.id] });
  const create = useMutation({
    mutationFn: () =>
      createInvite(workspace.id, { expires_in_hours: expiry, max_uses: uses || null }),
    onSuccess: async ({ token }) => {
      setLink(inviteLink(token));
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvite(workspace.id, id),
    onSuccess: refresh,
    onError: () => toast.error(t('channels.changeFailed')),
  });
  const fmt = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast(t('invites.copied'));
    } catch {
      toast.error(t('invites.copyFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('invites.dialogTitle', { workspace: workspace.name })}</DialogTitle>
          <DialogDescription>{t('invites.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor={ids.expiry}>{t('invites.expiresIn')}</Label>
            <select
              id={ids.expiry}
              className={selectClass}
              value={expiry}
              onChange={(e) => setExpiry(Number(e.target.value))}
            >
              {EXPIRY_HOURS.map((h) => (
                <option key={h} value={h}>
                  {t(`invites.expiry.${h}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.uses}>{t('invites.maxUses')}</Label>
            <select
              id={ids.uses}
              className={selectClass}
              value={uses}
              onChange={(e) => setUses(Number(e.target.value))}
            >
              {MAX_USES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t('invites.unlimited') : t('invites.uses', { count: n })}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {t('invites.create')}
        </Button>
        {create.isError && (
          <InlineError
            problem={create.error instanceof ApiError ? create.error.problem : { status: 0 }}
          />
        )}
        {link && (
          <div className="grid gap-2">
            <Label htmlFor={ids.link}>{t('invites.link')}</Label>
            <div className="flex gap-2">
              <Input id={ids.link} value={link} readOnly onFocus={(e) => e.target.select()} />
              <Button variant="outline" onClick={() => void copy()}>
                <CopyIcon aria-hidden strokeWidth={1.75} />
                {t('invites.copy')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('invites.linkHint')}</p>
          </div>
        )}
        {invites.data && invites.data.length > 0 && (
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('invites.active')}</h3>
            <ul className="grid gap-1" data-testid="invites">
              {invites.data.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1">
                    {t('invites.summary', {
                      date: fmt.format(new Date(i.expires_at)),
                      uses: i.max_uses ? `${i.uses}/${i.max_uses}` : String(i.uses),
                    })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(i.id)}
                  >
                    {t('invites.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "+" in the workspace rail: create a workspace (instance administrator) or join with a link. */
export function AddWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const ids = { name: useId(), link: useId() };
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remember = useLastWorkspace((s) => s.set);
  const create = useMutation({
    mutationFn: () => createWorkspace(name.trim()),
    onSuccess: async (ws) => {
      await reloadWorkspaces(queryClient);
      remember(ws.id);
      onOpenChange(false);
      void navigate({ to: '/w/$workspaceId', params: { workspaceId: ws.id } });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workspaces.addTitle')}</DialogTitle>
          <DialogDescription>{t('workspaces.addDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const token = inviteToken(link);
            if (token) {
              onOpenChange(false);
              void navigate({ to: '/invite/$token', params: { token } });
            }
          }}
        >
          <Label htmlFor={ids.link}>{t('workspaces.joinWithLink')}</Label>
          <div className="flex gap-2">
            <Input
              id={ids.link}
              value={link}
              autoComplete="off"
              placeholder={t('workspaces.linkPlaceholder')}
              onChange={(e) => setLink(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={link.trim() === ''}>
              {t('workspaces.open')}
            </Button>
          </div>
        </form>
        {permissions.create_workspaces && (
          <form
            className="grid gap-2 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <Label htmlFor={ids.name}>{t('workspaces.newName')}</Label>
            <div className="flex gap-2">
              <Input
                id={ids.name}
                value={name}
                maxLength={80}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" disabled={create.isPending || name.trim() === ''}>
                {t('workspaces.create')}
              </Button>
            </div>
            {create.isError && (
              <InlineError
                problem={create.error instanceof ApiError ? create.error.problem : { status: 0 }}
              />
            )}
          </form>
        )}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
