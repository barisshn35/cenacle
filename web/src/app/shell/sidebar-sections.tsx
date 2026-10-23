// SPDX-License-Identifier: AGPL-3.0-only
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellOffIcon,
  ChevronDownIcon,
  CompassIcon,
  FolderInputIcon,
  FolderPlusIcon,
  FoldersIcon,
  MailCheckIcon,
  MailIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  UndoIcon,
  UsersIcon,
} from 'lucide-react';
import { useId, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@cenacle/ui/components/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { cn } from '@cenacle/ui/lib/utils';
import { useActiveChannel } from '../chat/active-channel';
import { useActiveWorkspace } from '../chat/active-workspace';
import { CategoriesDialog } from '../chat/categories-dialog';
import { ChannelDirectory } from '../chat/channel-directory';
import { ChannelIcon } from '../chat/channel-icon';
import { CreateChannelDialog } from '../chat/create-channel-dialog';
import {
  categoriesQuery,
  channelsQuery,
  isConversation,
  markRead,
  markUnread,
  clearCountsLocally,
  type Channel,
} from '../chat/data';
import { NewConversationDialog } from '../chat/new-conversation-dialog';
import { usePresence, useWorkspacePresence } from '../chat/presence-state';
import { useMutedChannels } from '../notifications/muted';
import { PresenceIndicator } from './presence';
import {
  addSection,
  arrange,
  CHANNELS,
  DIRECT,
  FAVORITES,
  fullOrder,
  homeOf,
  isUnread,
  moveSection,
  place,
  removeSection,
  renameSection,
  toggleCollapsed,
  useSidebarLayout,
  type Section,
  type SidebarLayout,
} from './sidebar-layout';

/** What is being dragged in the sidebar (a channel or a section), for drop targets. */
type Dragged =
  { type: 'channel'; channel: Channel; home: string } | { type: 'section'; key: string };

const CHANNEL_DATA = 'text/x-cenacle-channel';
const SECTION_DATA = 'text/x-cenacle-section';

/** The icon of a conversation: the other person's presence, or a group icon. */
function ConversationIcon({ channel }: { channel: Channel }) {
  const other = channel.kind === 'direct' ? channel.participants[0]?.id : undefined;
  const presence = usePresence(other);
  return channel.kind === 'direct' ? (
    <PresenceIndicator presence={presence} className="bg-transparent" />
  ) : (
    <UsersIcon aria-hidden strokeWidth={1.75} />
  );
}

/**
 * The sidebar's sections in the person's arrangement: Favorites, their own
 * sections, channels by category and conversations. Channels move between
 * sections by dragging or from their menu; sections reorder the same ways.
 */
export function SidebarSections() {
  const { t } = useTranslation();
  const { id: workspaceId, admin } = useActiveWorkspace();
  const channels = useQuery(channelsQuery);
  const categories = useQuery(categoriesQuery(workspaceId));
  const muted = useMutedChannels();
  const { layout, update } = useSidebarLayout(workspaceId);
  const [dialog, setDialog] = useState<'create' | 'browse' | 'categories' | 'conversation' | null>(
    null,
  );
  // Naming a new section (optionally moving a channel into it) or renaming one.
  const [naming, setNaming] = useState<{ id?: string; name: string; channelId?: string } | null>(
    null,
  );
  const [dragged, setDragged] = useState<Dragged | null>(null);
  useWorkspacePresence(workspaceId);
  if (!workspaceId) return null;

  const list = (channels.data ?? []).filter((c) => c.workspace_id === workspaceId);
  const cats = categories.data ?? [];
  const categoryIds = new Set(cats.map((c) => c.id));
  const sections = arrange(layout, list, cats, muted);
  const order = fullOrder(sections);
  const ownSections = layout.sections;

  const titleOf = (s: Section) =>
    s.kind === 'unreads'
      ? t('sidebar.unreads')
      : s.kind === 'favorites'
        ? t('sidebar.favorites')
        : s.kind === 'channels'
          ? t('shell.channels')
          : s.kind === 'direct'
            ? t('dm.title')
            : s.name!;

  const moveTo = (channel: Channel, key: string | null) => {
    const home = homeOf(channel, categoryIds);
    update((l) => place(l, channel.id, key === home ? null : key));
  };
  const accepts = (s: Section) => {
    if (!dragged) return false;
    if (dragged.type === 'section') return s.kind !== 'unreads' && s.key !== dragged.key;
    return s.kind === 'favorites' || s.kind === 'own' || s.key === dragged.home;
  };
  const drop = (s: Section) => {
    if (!dragged || !accepts(s)) return;
    if (dragged.type === 'section') {
      const key = dragged.key;
      update((l) => ({ ...l, order: moveSection(order, key, order.indexOf(s.key)) }));
    } else {
      moveTo(dragged.channel, s.key);
    }
    setDragged(null);
  };
  const remove = (id: string) => {
    let before: SidebarLayout | undefined;
    update((l) => {
      before = l;
      return removeSection(l, id);
    });
    showUndoToast({
      message: t('sidebar.sectionRemoved'),
      onUndo: () => {
        if (before) update(() => before!);
      },
    });
  };

  const shown = [...sections];
  // While a channel is dragged, Favorites takes it even before it has any.
  if (dragged?.type === 'channel' && !shown.some((s) => s.kind === 'favorites')) {
    shown.splice(shown[0]?.kind === 'unreads' ? 1 : 0, 0, {
      key: FAVORITES,
      kind: 'favorites',
      channels: [],
    });
  }

  return (
    <>
      {shown.map((s) => {
        const at = order.indexOf(s.key);
        const collapsed = layout.collapsed.includes(s.key);
        return (
          <SidebarGroup
            key={s.key}
            data-section={s.key}
            data-drop-target={(dragged && accepts(s)) || undefined}
            className="group/sidebar-group rounded-lg data-[drop-target]:ring-1 data-[drop-target]:ring-sidebar-ring/40"
            onDragOver={(e) => {
              if (!accepts(s)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(s);
            }}
          >
            <SectionLabel
              label={titleOf(s)}
              open={!collapsed}
              onToggle={() => update((l) => toggleCollapsed(l, s.key))}
              draggable={s.kind !== 'unreads'}
              onDragStart={(e) => {
                e.dataTransfer.setData(SECTION_DATA, s.key);
                e.dataTransfer.effectAllowed = 'move';
                setDragged({ type: 'section', key: s.key });
              }}
              onDragEnd={() => setDragged(null)}
            />
            <SectionMenu
              title={titleOf(s)}
              withAdd={(s.kind === 'channels' && admin) || s.kind === 'direct'}
              canMove={s.kind !== 'unreads'}
              first={at <= 0}
              last={at === order.length - 1}
              own={s.kind === 'own'}
              groupUnreads={layout.group_unreads}
              onMove={(by) => update((l) => ({ ...l, order: moveSection(order, s.key, at + by) }))}
              onNew={() => setNaming({ name: '' })}
              onRename={() => setNaming({ id: s.key, name: s.name ?? '' })}
              onRemove={() => remove(s.key)}
              onGroupUnreads={(on) => update((l) => ({ ...l, group_unreads: on }))}
            />
            {s.kind === 'channels' && admin && (
              <AddAction label={t('channels.createTitle')} onClick={() => setDialog('create')} />
            )}
            {s.kind === 'direct' && (
              <AddAction label={t('dm.newTitle')} onClick={() => setDialog('conversation')} />
            )}
            <SidebarGroupContent hidden={collapsed}>
              {s.kind === 'channels' && channels.isPending ? (
                <ChannelListSkeleton />
              ) : s.channels.length > 0 ? (
                <ChannelList
                  channels={s.channels}
                  muted={muted}
                  section={s}
                  ownSections={ownSections}
                  homeOf={(c) => homeOf(c, categoryIds)}
                  homeName={(c) => {
                    const home = homeOf(c, categoryIds);
                    return home === DIRECT
                      ? t('dm.title')
                      : home === CHANNELS
                        ? t('shell.channels')
                        : (cats.find((x) => x.id === home)?.name ?? '');
                  }}
                  onMove={moveTo}
                  onNewSection={(c) => setNaming({ name: '', channelId: c.id })}
                  onDragStart={(c) =>
                    setDragged({ type: 'channel', channel: c, home: homeOf(c, categoryIds) })
                  }
                  onDragEnd={() => setDragged(null)}
                />
              ) : (
                <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
                  {s.kind === 'direct'
                    ? t('dm.none')
                    : s.kind === 'favorites'
                      ? t('sidebar.dropFavorites')
                      : s.kind === 'own'
                        ? t('sidebar.emptySection')
                        : null}
                </p>
              )}
              {s.kind === 'channels' && (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => setDialog('browse')}>
                      <CompassIcon aria-hidden strokeWidth={1.75} />
                      <span>{t('channels.browse')}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {admin && (
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={() => setDialog('categories')}>
                        <FoldersIcon aria-hidden strokeWidth={1.75} />
                        <span>{t('categories.manage')}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
      <CreateChannelDialog open={dialog === 'create'} onOpenChange={(o) => !o && setDialog(null)} />
      <ChannelDirectory open={dialog === 'browse'} onOpenChange={(o) => !o && setDialog(null)} />
      {dialog === 'categories' && (
        <CategoriesDialog open onOpenChange={(o) => !o && setDialog(null)} />
      )}
      {dialog === 'conversation' && (
        <NewConversationDialog
          workspaceId={workspaceId}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      {naming && (
        <SectionNameDialog
          initial={naming.name}
          renaming={!!naming.id}
          taken={ownSections.filter((s) => s.id !== naming.id).map((s) => s.name.toLowerCase())}
          onOpenChange={(o) => !o && setNaming(null)}
          onSave={(name) => {
            if (naming.id) {
              const id = naming.id;
              update((l) => renameSection(l, id, name));
            } else {
              const id = crypto.randomUUID();
              const channelId = naming.channelId;
              update((l) => {
                const added = addSection(l, sections, name, id);
                return channelId ? place(added, channelId, id) : added;
              });
            }
            setNaming(null);
          }}
        />
      )}
    </>
  );
}

function AddAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<SidebarGroupAction aria-label={label} onClick={onClick} />}>
        <PlusIcon strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A section's own menu: moving it, the person's sections, and gathering unread ones. */
function SectionMenu({
  title,
  withAdd,
  canMove,
  first,
  last,
  own,
  groupUnreads,
  onMove,
  onNew,
  onRename,
  onRemove,
  onGroupUnreads,
}: {
  title: string;
  withAdd: boolean;
  canMove: boolean;
  first: boolean;
  last: boolean;
  own: boolean;
  groupUnreads: boolean;
  onMove: (by: -1 | 1) => void;
  onNew: () => void;
  onRename: () => void;
  onRemove: () => void;
  onGroupUnreads: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarGroupAction
            aria-label={t('sidebar.sectionMenu', { section: title })}
            className={cn(
              withAdd && 'right-10',
              'opacity-0 group-hover/sidebar-group:opacity-100 group-focus-within/sidebar-group:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100',
            )}
          />
        }
      >
        <MoreHorizontalIcon strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {canMove && (
          <>
            <DropdownMenuItem disabled={first} onClick={() => onMove(-1)}>
              <ArrowUpIcon strokeWidth={1.75} />
              {t('sidebar.moveUp')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={last} onClick={() => onMove(1)}>
              <ArrowDownIcon strokeWidth={1.75} />
              {t('sidebar.moveDown')}
            </DropdownMenuItem>
          </>
        )}
        {own && (
          <>
            <DropdownMenuItem onClick={onRename}>
              <PencilIcon strokeWidth={1.75} />
              {t('sidebar.renameSection')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2Icon strokeWidth={1.75} />
              {t('sidebar.removeSection')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onNew}>
          <FolderPlusIcon strokeWidth={1.75} />
          {t('sidebar.newSection')}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={groupUnreads} onCheckedChange={onGroupUnreads}>
          {t('sidebar.groupUnreads')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChannelList({
  channels,
  muted,
  section,
  ownSections,
  homeOf,
  homeName,
  onMove,
  onNewSection,
  onDragStart,
  onDragEnd,
}: {
  channels: Channel[];
  muted: Set<string>;
  section: Section;
  ownSections: SidebarLayout['sections'];
  homeOf: (c: Channel) => string;
  homeName: (c: Channel) => string;
  onMove: (c: Channel, key: string | null) => void;
  onNewSection: (c: Channel) => void;
  onDragStart: (c: Channel) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const { id: activeId } = useActiveChannel();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {channels.map((ch) => {
        const isActive = ch.id === activeId;
        const isMuted = muted.has(ch.id);
        // Muted: new messages stay quiet; mentions still show.
        const unread = isUnread(ch, muted);
        // Conversations are addressed to you: their count stands out like a
        // mention; channels are only marked as having something new.
        const counted = unread && ((isConversation(ch) && !isMuted) || ch.mention_count > 0);
        const count = isConversation(ch) && !isMuted ? ch.unread_count : ch.mention_count;
        return (
          <SidebarMenuItem
            key={ch.id}
            data-unread={unread || undefined}
            draggable={section.kind !== 'unreads'}
            onDragStart={(e: DragEvent) => {
              e.dataTransfer.setData(CHANNEL_DATA, ch.id);
              e.dataTransfer.effectAllowed = 'move';
              onDragStart(ch);
            }}
            onDragEnd={onDragEnd}
          >
            <SidebarMenuButton
              isActive={isActive}
              className={cn(
                unread && 'font-semibold text-sidebar-foreground',
                isMuted && !unread && 'opacity-70',
                'pr-8',
                (unread || counted) && 'pointer-coarse:pr-14',
              )}
              render={
                <Link
                  to="/c/$channelId"
                  params={{ channelId: ch.id }}
                  aria-current={isActive ? 'page' : undefined}
                  draggable={false}
                  // Picking a channel closes the drawer on phones.
                  onClick={() => isMobile && setOpenMobile(false)}
                />
              }
            >
              {isConversation(ch) ? (
                <ConversationIcon channel={ch} />
              ) : (
                <ChannelIcon channel={ch} labelled />
              )}
              <span>{ch.name}</span>
              {isMuted && (
                <>
                  <BellOffIcon
                    aria-hidden
                    className="ml-auto size-3.5 shrink-0 opacity-70"
                    strokeWidth={1.75}
                  />
                  <span className="sr-only">{t('notifications.mutedLabel')}</span>
                </>
              )}
              {unread && (
                <span className="sr-only">
                  {t('dm.unread', { count: ch.unread_count })}
                  {ch.mention_count > 0 && `, ${t('mentions.unread', { count: ch.mention_count })}`}
                </span>
              )}
            </SidebarMenuButton>
            {counted ? (
              <SidebarMenuBadge
                aria-hidden
                className="rounded-full bg-mention text-mention-foreground group-focus-within/menu-item:pointer-fine:opacity-0 group-hover/menu-item:pointer-fine:opacity-0 group-has-[[aria-expanded=true]]/menu-item:opacity-0 peer-data-active/menu-button:text-mention-foreground peer-hover/menu-button:text-mention-foreground pointer-coarse:right-8"
              >
                {count > 99 ? '99+' : count}
              </SidebarMenuBadge>
            ) : unread ? (
              <SidebarMenuBadge
                aria-hidden
                className="group-focus-within/menu-item:pointer-fine:opacity-0 group-hover/menu-item:pointer-fine:opacity-0 group-has-[[aria-expanded=true]]/menu-item:opacity-0 pointer-coarse:right-8"
              >
                <span className="size-2 rounded-full bg-sidebar-foreground" />
              </SidebarMenuBadge>
            ) : null}
            <ChannelMenu
              channel={ch}
              unread={ch.unread_count > 0}
              section={section}
              ownSections={ownSections}
              home={homeOf(ch)}
              homeName={homeName(ch)}
              onMove={(key) => onMove(ch, key)}
              onNewSection={() => onNewSection(ch)}
            />
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** A channel's menu in the sidebar: read state, Favorites and moving it. */
function ChannelMenu({
  channel,
  unread,
  section,
  ownSections,
  home,
  homeName,
  onMove,
  onNewSection,
}: {
  channel: Channel;
  unread: boolean;
  section: Section;
  ownSections: SidebarLayout['sections'];
  home: string;
  homeName: string;
  onMove: (key: string | null) => void;
  onNewSection: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const read = useMutation({
    mutationFn: () => (unread ? markRead(channel.id) : markUnread(channel.id)),
    onMutate: () => {
      if (unread) clearCountsLocally(queryClient, channel.id);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['channels'] }),
    onError: () => toast.error(unread ? t('sidebar.markReadFailed') : t('chat.markUnreadFailed')),
  });
  const favorite = section.kind === 'favorites';
  // Where it is now (gathered unread ones are still in their own section).
  const placedIn = section.kind === 'unreads' ? undefined : section.key;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuAction
            showOnHover
            aria-label={t('sidebar.channelMenu', { channel: channel.name })}
          />
        }
      >
        <MoreHorizontalIcon strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right">
        <DropdownMenuItem onClick={() => read.mutate()}>
          {unread ? <MailCheckIcon strokeWidth={1.75} /> : <MailIcon strokeWidth={1.75} />}
          {unread ? t('home.markRead') : t('chat.markUnread')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMove(favorite ? null : FAVORITES)}>
          {favorite ? <StarOffIcon strokeWidth={1.75} /> : <StarIcon strokeWidth={1.75} />}
          {favorite ? t('sidebar.unfavorite') : t('sidebar.favorite')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderInputIcon strokeWidth={1.75} />
            {t('sidebar.moveTo')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {ownSections.map((s) => (
              <DropdownMenuItem
                key={s.id}
                disabled={placedIn === s.id}
                onClick={() => onMove(s.id)}
              >
                {s.name}
              </DropdownMenuItem>
            ))}
            {placedIn !== home && placedIn !== undefined && (
              <DropdownMenuItem onClick={() => onMove(null)}>
                <UndoIcon strokeWidth={1.75} />
                {t('sidebar.backTo', { section: homeName })}
              </DropdownMenuItem>
            )}
            {ownSections.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={onNewSection}>
              <FolderPlusIcon strokeWidth={1.75} />
              {t('sidebar.newSection')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChannelListSkeleton() {
  return (
    <SidebarMenu>
      {[0, 1, 2].map((i) => (
        <SidebarMenuItem key={i}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/** Section headers fold their list away; the state is part of the button. */
function SectionLabel({
  label,
  open,
  onToggle,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <SidebarGroupLabel
      render={
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      }
      className="hit-target w-fit max-w-[calc(100%-4.5rem)] gap-1.5 pr-3 hover:text-sidebar-foreground"
    >
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className={cn(
          'size-3.5! transition-transform duration-(--duration-base) ease-(--ease-out)',
          !open && '-rotate-90',
        )}
      />
      <span className="truncate">{label}</span>
    </SidebarGroupLabel>
  );
}

/** Names a new section of one's own, or renames one. */
function SectionNameDialog({
  initial,
  renaming,
  taken,
  onOpenChange,
  onSave,
}: {
  initial: string;
  renaming: boolean;
  taken: string[];
  onOpenChange: (open: boolean) => void;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(initial);
  const clean = name.trim().replace(/\s+/g, ' ');
  const duplicate = taken.includes(clean.toLowerCase());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (clean !== '' && !duplicate) onSave(clean);
  };
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {renaming ? t('sidebar.renameSection') : t('sidebar.newSection')}
          </DialogTitle>
          <DialogDescription>{t('sidebar.sectionHint')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor={id}>{t('sidebar.sectionName')}</Label>
            <Input
              id={id}
              value={name}
              maxLength={40}
              // The dialog's only field: typing the name is why it opened.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              aria-invalid={duplicate || undefined}
              aria-describedby={duplicate ? `${id}-taken` : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {duplicate && (
              <p id={`${id}-taken`} className="text-xs text-destructive">
                {t('sidebar.sectionTaken')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('glossary.cancel')}
            </Button>
            <Button type="submit" disabled={clean === '' || duplicate}>
              {renaming ? t('chat.save') : t('sidebar.create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
