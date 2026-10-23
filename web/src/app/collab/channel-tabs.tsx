// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  KanbanSquareIcon,
  LinkIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
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
import type { Channel } from '../chat/data';
import { createTab, deleteTab, tabsQuery, updateTab, type Tab, type TabInput } from './collab';

type NewTab = 'canvas' | 'list' | 'tasks' | 'link';

const TAB_ICONS = { canvas: FileTextIcon, list: TableIcon, link: LinkIcon } as const;

/** The tabs of a channel: its messages, then canvases, lists and links. */
export function ChannelTabs({ channel, active }: { channel: Channel; active?: string }) {
  const { t } = useTranslation();
  const tabs = useQuery(tabsQuery(channel.id)).data ?? [];
  const [adding, setAdding] = useState<NewTab | null>(null);
  const [editing, setEditing] = useState<Tab | null>(null);
  const [deleting, setDeleting] = useState<Tab | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  if (tabs.length === 0 && !channel.can_post) return null;

  const move = (tab: Tab, by: number) => {
    void updateTab(tab.id, { position: tab.position + by }).then(() =>
      queryClient.invalidateQueries({ queryKey: ['tabs', channel.id] }),
    );
  };
  // The selected tab is underlined in Brass, the others are quiet text.
  const item =
    'inline-flex h-10 min-h-target shrink-0 items-center gap-1.5 border-b-2 border-transparent px-1.5 text-[13.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:border-accent-brand aria-[current=page]:font-medium aria-[current=page]:text-foreground';

  return (
    <nav
      aria-label={t('collab.tabs.label')}
      className="flex shrink-0 items-end gap-3 overflow-x-auto border-b px-4"
    >
      <Link
        to="/c/$channelId"
        params={{ channelId: channel.id }}
        search={{ tab: undefined }}
        // Active only without a tab (not for any search, as by default).
        activeOptions={{ explicitUndefined: true }}
        aria-current={!active ? 'page' : undefined}
        className={item}
      >
        <MessagesSquareIcon aria-hidden className="size-4" strokeWidth={1.75} />
        {t('collab.tabs.messages')}
      </Link>
      {tabs.map((tab) => {
        const Icon = TAB_ICONS[tab.kind];
        const current = tab.id === active;
        return (
          <span key={tab.id} className="flex shrink-0 items-center">
            {tab.kind === 'link' ? (
              <a href={tab.url} target="_blank" rel="noopener noreferrer" className={item}>
                <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                {tab.title}
                <ExternalLinkIcon aria-hidden className="size-3" strokeWidth={1.75} />
                <span className="sr-only">{t('collab.tabs.opensElsewhere')}</span>
              </a>
            ) : (
              <Link
                to="/c/$channelId"
                params={{ channelId: channel.id }}
                search={{ tab: tab.id }}
                aria-current={current ? 'page' : undefined}
                className={item}
              >
                <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                {tab.title}
              </Link>
            )}
            {channel.can_post && (current || tab.kind === 'link') && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('collab.tabs.options', { title: tab.title })}
                    />
                  }
                >
                  <MoreHorizontalIcon strokeWidth={1.75} />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => setEditing(tab)}>
                    <PencilIcon strokeWidth={1.75} />
                    {t('collab.tabs.rename')}
                  </DropdownMenuItem>
                  {tab.position > 0 && (
                    <DropdownMenuItem onClick={() => move(tab, -1)}>
                      <ArrowLeftIcon strokeWidth={1.75} />
                      {t('collab.tabs.moveLeft')}
                    </DropdownMenuItem>
                  )}
                  {tab.position < tabs.length - 1 && (
                    <DropdownMenuItem onClick={() => move(tab, 1)}>
                      <ArrowRightIcon strokeWidth={1.75} />
                      {t('collab.tabs.moveRight')}
                    </DropdownMenuItem>
                  )}
                  {tab.can_delete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleting(tab)}>
                        <Trash2Icon strokeWidth={1.75} />
                        {t('collab.tabs.delete')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        );
      })}
      {channel.can_post && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={t('collab.tabs.add')} />}
          >
            <PlusIcon strokeWidth={1.75} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setAdding('canvas')}>
              <FileTextIcon strokeWidth={1.75} />
              {t('collab.tabs.newCanvas')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAdding('list')}>
              <TableIcon strokeWidth={1.75} />
              {t('collab.tabs.newList')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAdding('tasks')}>
              <ListChecksIcon strokeWidth={1.75} />
              {t('collab.tabs.newTasks')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAdding('link')}>
              <LinkIcon strokeWidth={1.75} />
              {t('collab.tabs.newLink')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {adding && (
        <TabDialog
          kind={adding}
          onClose={() => setAdding(null)}
          onSave={async (title, url) => {
            const tab = await createTab(channel.id, newTabInput(adding, title, url, t));
            await queryClient.invalidateQueries({ queryKey: ['tabs', channel.id] });
            if (tab.kind !== 'link') {
              void navigate({
                to: '/c/$channelId',
                params: { channelId: channel.id },
                search: { tab: tab.id },
              });
            }
          }}
        />
      )}
      {editing && (
        <TabDialog
          kind={editing.kind}
          tab={editing}
          onClose={() => setEditing(null)}
          onSave={async (title, url) => {
            await updateTab(editing.id, editing.kind === 'link' ? { title, url } : { title });
            await queryClient.invalidateQueries({ queryKey: ['tabs', channel.id] });
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        severity="s2"
        title={t('collab.tabs.deleteTitle', { title: deleting?.title ?? '' })}
        description={t(`collab.tabs.deleteHint.${deleting?.kind ?? 'link'}`)}
        confirmLabel={t('collab.tabs.delete')}
        onConfirm={async () => {
          if (!deleting) return;
          await deleteTab(deleting.id);
          if (deleting.id === active) {
            void navigate({ to: '/c/$channelId', params: { channelId: channel.id }, search: {} });
          }
          await queryClient.invalidateQueries({ queryKey: ['tabs', channel.id] });
          setDeleting(null);
        }}
      />
    </nav>
  );
}

/** What to create for a new tab; a task list comes with its columns. */
function newTabInput(
  kind: NewTab,
  title: string,
  url: string,
  t: (key: string) => string,
): TabInput {
  switch (kind) {
    case 'link':
      return { kind, title, url };
    case 'tasks':
      return {
        kind: 'list',
        title,
        columns: [
          { id: 'status', name: t('collab.list.template.status'), kind: 'status' },
          { id: 'owner', name: t('collab.list.template.owner'), kind: 'person' },
          { id: 'due', name: t('collab.list.template.due'), kind: 'date' },
        ],
        board_column: 'status',
      };
    default:
      return { kind, title };
  }
}

function TabDialog({
  kind,
  tab,
  onClose,
  onSave,
}: {
  kind: NewTab | Tab['kind'];
  tab?: Tab;
  onClose: () => void;
  onSave: (title: string, url: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [title, setTitle] = useState(tab?.title ?? '');
  const [url, setUrl] = useState(tab?.url ?? 'https://');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const Icon = kind === 'tasks' ? KanbanSquareIcon : TAB_ICONS[kind];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            onSave(title.trim(), url.trim())
              .then(onClose)
              .catch((err: unknown) => setError(err))
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon aria-hidden className="size-4" strokeWidth={1.75} />
              {tab ? t('collab.tabs.renameTitle') : t(`collab.tabs.newTitle.${kind}`)}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-title`}>{t('collab.tabs.title')}</Label>
            <Input
              id={`${id}-title`}
              value={title}
              required
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {kind === 'link' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-url`}>{t('collab.tabs.url')}</Label>
              <Input
                id={`${id}-url`}
                type="url"
                value={url}
                required
                maxLength={2000}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}
          {error !== null && (
            <InlineError
              title={t('collab.tabs.saveFailed')}
              problem={error instanceof ApiError ? error.problem : { status: 500 }}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('collab.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !title.trim()} aria-busy={busy}>
              {tab ? t('collab.tabs.save') : t('collab.tabs.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
