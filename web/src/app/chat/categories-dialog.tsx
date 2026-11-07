// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import {
  categoriesQuery,
  channelsQuery,
  createCategory,
  deleteCategory,
  isConversation,
  reloadChannels,
  setChannelCategory,
  updateCategory,
  type Category,
  type Channel,
} from './data';
import { useActiveWorkspace } from './active-workspace';

/** The administrator's categories: add, rename, reorder (no dragging needed), delete. */
export function CategoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const newId = useId();
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Category | null>(null);
  const { id: workspaceId } = useActiveWorkspace();
  const categories = useQuery(categoriesQuery(workspaceId));
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['categories', workspaceId] });
    await reloadChannels(queryClient);
  };
  const failed = () => toast.error(t('channels.changeFailed'));

  const add = useMutation({
    mutationFn: (name: string) => createCategory(workspaceId!, name),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateCategory(id, { name }),
    onSuccess: refresh,
    onError: failed,
  });
  // Moving swaps the positions of two neighbours.
  const move = useMutation({
    mutationFn: async ([a, b]: [Category, Category]) => {
      const [pa, pb] =
        a.position === b.position ? [b.position + 1, b.position] : [b.position, a.position];
      await updateCategory(a.id, { position: pa });
      await updateCategory(b.id, { position: pb });
    },
    onSuccess: refresh,
    onError: failed,
  });

  const list = categories.data ?? [];
  // The workspace's channels (not conversations), to put in the categories here.
  const channels = (useQuery(channelsQuery).data ?? []).filter(
    (c) => c.workspace_id === workspaceId && !isConversation(c) && !c.archived,
  );
  const place = useMutation({
    mutationFn: ({ channel, category }: { channel: string; category: string | null }) =>
      setChannelCategory(channel, category),
    onSuccess: () => reloadChannels(queryClient),
    onError: failed,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() !== '') add.mutate(name.trim());
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('categories.title')}</DialogTitle>
            <DialogDescription>{t('categories.description')}</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-2" data-testid="categories">
            {list.map((c, i) => (
              <li key={c.id} className="grid gap-1.5">
                <div className="flex items-center gap-1">
                  <label htmlFor={`category-${c.id}`} className="sr-only">
                    {t('categories.nameOf', { category: c.name })}
                  </label>
                  <Input
                    id={`category-${c.id}`}
                    defaultValue={c.name}
                    maxLength={80}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== c.name) rename.mutate({ id: c.id, name: v });
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('categories.moveUp', { category: c.name })}
                    disabled={i === 0 || move.isPending}
                    onClick={() => move.mutate([c, list[i - 1]!])}
                  >
                    <ArrowUpIcon strokeWidth={1.75} />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('categories.moveDown', { category: c.name })}
                    disabled={i === list.length - 1 || move.isPending}
                    onClick={() => move.mutate([c, list[i + 1]!])}
                  >
                    <ArrowDownIcon strokeWidth={1.75} />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('categories.deleteNamed', { category: c.name })}
                    onClick={() => setRemoving(c)}
                  >
                    <Trash2Icon strokeWidth={1.75} />
                  </Button>
                </div>
                <CategoryChannels
                  category={c}
                  channels={channels}
                  pending={place.isPending}
                  onPlace={(channel, category) => place.mutate({ channel, category })}
                />
              </li>
            ))}
            {list.length === 0 && (
              <li className="text-sm text-muted-foreground">{t('categories.none')}</li>
            )}
          </ul>
          <form onSubmit={submit} className="grid gap-2">
            <Label htmlFor={newId}>{t('categories.new')}</Label>
            <div className="flex gap-2">
              <Input
                id={newId}
                value={name}
                maxLength={80}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" disabled={add.isPending || name.trim() === ''}>
                {t('categories.add')}
              </Button>
            </div>
            {add.isError && (
              <InlineError
                title={
                  add.error instanceof ApiError && add.error.problem.code === 'channel_name_taken'
                    ? t('categories.nameTaken')
                    : undefined
                }
                problem={add.error instanceof ApiError ? add.error.problem : { status: 0 }}
              />
            )}
          </form>
        </DialogContent>
      </Dialog>
      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          severity="s2"
          irreversible
          title={t('categories.deleteTitle', { category: removing.name })}
          description={<p>{t('categories.deleteDescription')}</p>}
          confirmLabel={t('categories.deleteConfirm')}
          onConfirm={async () => {
            try {
              await deleteCategory(removing.id);
              await refresh();
            } catch {
              failed();
            }
          }}
        />
      )}
    </>
  );
}

/** A category's channels, and a way to add one (moving it from where it is). */
function CategoryChannels({
  category,
  channels,
  pending,
  onPlace,
}: {
  category: Category;
  channels: Channel[];
  pending: boolean;
  onPlace: (channel: string, category: string | null) => void;
}) {
  const { t } = useTranslation();
  const inside = channels.filter((c) => c.category_id === category.id);
  const others = channels.filter((c) => c.category_id !== category.id);
  return (
    <div className="ms-1 grid gap-1 border-s ps-3" data-testid={`category-channels-${category.id}`}>
      {inside.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {inside.map((c) => (
            <li key={c.id} className="flex items-center gap-0.5 rounded-md bg-muted ps-2 text-xs">
              {c.name}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('categories.takeOut', { channel: c.name, category: category.name })}
                disabled={pending}
                onClick={() => onPlace(c.id, null)}
              >
                <XIcon strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('categories.noChannels')}</p>
      )}
      {others.length > 0 && (
        <select
          aria-label={t('categories.addChannel', { category: category.name })}
          className="min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value=""
          disabled={pending}
          onChange={(e) => e.target.value && onPlace(e.target.value, category.id)}
        >
          <option value="">{t('categories.addChannelPrompt')}</option>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
