// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArchiveIcon } from 'lucide-react';
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
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import {
  archiveChannel,
  categoriesQuery,
  reloadChannels,
  setChannelCategory,
  unarchiveChannel,
  updateChannel,
  type Channel,
} from './data';
import { ChannelGroupsSection } from './directory-groups';
import { isWorkspaceAdmin, workspacesQuery } from './workspaces';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60';

/** Slow mode choices, in seconds. */
const SLOW_MODES = [0, 10, 30, 60, 300, 900, 3600] as const;

/** Channel settings for its managers: name, topic, visibility, category; archiving. */
export function ChannelSettingsDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const workspaces = useQuery(workspacesQuery);
  const wsAdmin = isWorkspaceAdmin(workspaces.data?.find((w) => w.id === channel.workspace_id));
  const ids = {
    name: useId(),
    topic: useId(),
    visibility: useId(),
    category: useId(),
    slow: useId(),
    tags: useId(),
    error: useId(),
  };
  const [slow, setSlow] = useState(channel.slow_mode_seconds ?? 0);
  const [tags, setTags] = useState((channel.forum_tags ?? []).join(', '));
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [visibility, setVisibility] = useState(channel.visibility);
  const [category, setCategory] = useState(channel.category_id ?? '');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const categoriesOptions = categoriesQuery(channel.workspace_id);
  const categories = useQuery({ ...categoriesOptions, enabled: open && wsAdmin });
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const save = useMutation({
    mutationFn: async () => {
      await updateChannel(channel.id, {
        name: name.trim(),
        topic: topic.trim(),
        visibility,
        slow_mode_seconds: slow,
        ...(channel.kind === 'forum'
          ? {
              forum_tags: tags
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      });
      if (wsAdmin && (category || null) !== (channel.category_id ?? null)) {
        await setChannelCategory(channel.id, category || null);
      }
    },
    onSuccess: () => {
      void reloadChannels(queryClient);
      onOpenChange(false);
    },
  });
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  const errorTitle =
    problem?.code === 'channel_name_taken'
      ? t('channels.nameTaken')
      : problem?.code === 'channel_configured'
        ? t('channels.configuredName')
        : undefined;

  const archive = async () => {
    await archiveChannel(channel.id);
    await reloadChannels(queryClient);
    onOpenChange(false);
    void navigate({ to: '/' });
    showUndoToast({
      message: t('channels.archived', { channel: channel.name }),
      onUndo: async () => {
        await unarchiveChannel(channel.id);
        await reloadChannels(queryClient);
        void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
      },
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() !== '') save.mutate();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t('channels.settingsTitle', { channel: channel.name })}</DialogTitle>
              <DialogDescription>{t('channels.settingsDescription')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={ids.name}>{t('channels.name')}</Label>
              <Input
                id={ids.name}
                value={name}
                maxLength={80}
                required
                autoComplete="off"
                aria-describedby={save.isError ? ids.error : undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.topic}>{t('channels.topicOptional')}</Label>
              <Input
                id={ids.topic}
                value={topic}
                maxLength={250}
                autoComplete="off"
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.visibility}>{t('channels.visibility.label')}</Label>
              <select
                id={ids.visibility}
                className={selectClass}
                value={visibility}
                disabled={channel.is_default}
                onChange={(e) => setVisibility(e.target.value as Channel['visibility'])}
              >
                <option value="public">{t('channels.visibility.public')}</option>
                <option value="private">{t('channels.visibility.private')}</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {channel.is_default
                  ? t('channels.defaultStaysPublic')
                  : t(`channels.visibility.${visibility}Hint`)}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.slow}>{t('community.moderation.slowMode')}</Label>
              <select
                id={ids.slow}
                className={selectClass}
                value={slow}
                onChange={(e) => setSlow(Number(e.target.value))}
              >
                {SLOW_MODES.map((s) => (
                  <option key={s} value={s}>
                    {t(`community.moderation.slowModes.${s}`)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t('community.moderation.slowModeExplained')}
              </p>
            </div>
            {channel.kind === 'forum' && (
              <div className="grid gap-2">
                <Label htmlFor={ids.tags}>{t('community.forum.tags')}</Label>
                <Input
                  id={ids.tags}
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  aria-describedby={`${ids.tags}-hint`}
                />
                <p id={`${ids.tags}-hint`} className="text-xs text-muted-foreground">
                  {t('community.forum.tagsHint')}
                </p>
              </div>
            )}
            {wsAdmin && (
              <div className="grid gap-2">
                <Label htmlFor={ids.category}>{t('channels.category')}</Label>
                <select
                  id={ids.category}
                  className={selectClass}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">{t('channels.noCategory')}</option>
                  {categories.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {save.isError && (
              <InlineError id={ids.error} title={errorTitle} problem={problem ?? { status: 0 }} />
            )}
            <DialogFooter className="sm:justify-between">
              {!channel.is_mandatory ? (
                <Button type="button" variant="outline" onClick={() => setConfirmArchive(true)}>
                  <ArchiveIcon aria-hidden strokeWidth={1.75} />
                  {t('glossary.archive')}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  {t('glossary.cancel')}
                </Button>
                <Button type="submit" disabled={save.isPending || name.trim() === ''}>
                  {t('chat.save')}
                </Button>
              </div>
            </DialogFooter>
          </form>
          {channel.visibility === 'private' && !channel.is_default && (
            <ChannelGroupsSection channel={channel} />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        severity="s2"
        title={t('channels.archiveTitle', { channel: channel.name })}
        description={<p>{t('channels.archiveDescription')}</p>}
        impact={t('channels.archiveImpact')}
        confirmLabel={t('channels.archiveConfirm')}
        onConfirm={async () => {
          try {
            await archive();
          } catch {
            toast.error(t('channels.changeFailed'));
          }
        }}
      />
    </>
  );
}

/** Notice in place of the composer for archived channels. */
export function ArchivedNotice({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () => unarchiveChannel(channel.id),
    onSuccess: () => reloadChannels(queryClient),
    onError: () => toast.error(t('channels.changeFailed')),
  });
  return (
    <footer className="shrink-0 px-4 pb-4">
      <div
        data-testid="archived-notice"
        className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-[10px] border border-dashed border-rule-strong px-4 py-3 text-sm text-muted-foreground"
      >
        <ArchiveIcon aria-hidden className="size-4" strokeWidth={1.75} />
        <span className="flex-1">{t('channels.archivedNotice')}</span>
        {channel.can_manage && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => restore.mutate()}
            disabled={restore.isPending}
          >
            {t('glossary.unarchive')}
          </Button>
        )}
      </div>
    </footer>
  );
}
