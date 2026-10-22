// SPDX-License-Identifier: Apache-2.0
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SmilePlusIcon, XIcon } from 'lucide-react';
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
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { EmojiPickerPanel } from '../chat/reactions';
import { CLEAR, clearAt, type Clear } from './format';
import {
  clearCustomStatus,
  myProfileQuery,
  saved,
  setCustomStatus,
  type CustomStatus,
} from './profiles';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Ready-made statuses (their text is translated; the saved text is the shown one). */
const PRESETS = [
  { emoji: '📅', key: 'meeting', clear: '1h' },
  { emoji: '🚌', key: 'commuting', clear: '30m' },
  { emoji: '🤒', key: 'sick', clear: 'today' },
  { emoji: '🌴', key: 'holiday', clear: 'never' },
  { emoji: '🏠', key: 'remote', clear: 'today' },
] as const;

export function CustomStatusDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = { text: useId(), clear: useId() };
  const me = useQuery(myProfileQuery);
  const current = me.data?.status ?? null;
  const [emoji, setEmoji] = useState(current?.emoji ?? '');
  const [text, setText] = useState(current?.text ?? '');
  const [clear, setClear] = useState<Clear>(current?.expires_at ? 'today' : 'never');
  const [picking, setPicking] = useState(false);
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (s: CustomStatus) => setCustomStatus(s),
    onSuccess: (profile) => {
      saved(queryClient, profile);
      onOpenChange(false);
    },
    onError: () => toast.error(t('profile.statusFailed')),
  });
  const remove = useMutation({
    mutationFn: clearCustomStatus,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: myProfileQuery.queryKey });
      if (me.data) void queryClient.invalidateQueries({ queryKey: ['profile', me.data.id] });
      onOpenChange(false);
    },
    onError: () => toast.error(t('profile.statusFailed')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!emoji && !text.trim()) return;
    save.mutate({ emoji, text: text.trim(), expires_at: clearAt(clear) });
  };
  const pick = (s: { emoji: string; text: string }, c?: Clear) => {
    setEmoji(s.emoji);
    setText(s.text);
    if (c) setClear(c);
  };
  const recent = me.data?.recent_statuses ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('profile.statusTitle')}</DialogTitle>
            <DialogDescription>{t('profile.statusDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={ids.text}>{t('profile.statusText')}</Label>
            <div className="flex gap-2">
              <Popover open={picking} onOpenChange={setPicking}>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={
                        emoji ? t('profile.emojiChosen', { emoji }) : t('profile.emojiChoose')
                      }
                    />
                  }
                >
                  {emoji ? (
                    <span className="text-lg leading-none">{emoji}</span>
                  ) : (
                    <SmilePlusIcon strokeWidth={1.75} />
                  )}
                </PopoverTrigger>
                <PopoverContent align="start">
                  <PopoverTitle className="sr-only">{t('profile.emojiChoose')}</PopoverTitle>
                  <EmojiPickerPanel
                    onPick={(e) => {
                      setEmoji(e);
                      setPicking(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Input
                id={ids.text}
                value={text}
                maxLength={100}
                autoComplete="off"
                placeholder={t('profile.statusPlaceholder')}
                onChange={(e) => setText(e.target.value)}
              />
              {(emoji || text) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('profile.statusEmpty')}
                  onClick={() => pick({ emoji: '', text: '' })}
                >
                  <XIcon strokeWidth={1.75} />
                </Button>
              )}
            </div>
          </div>
          <section aria-labelledby={`${ids.text}-suggested`} className="grid gap-1">
            <h3
              id={`${ids.text}-suggested`}
              className="text-xs font-medium text-muted-foreground uppercase"
            >
              {recent.length ? t('profile.recentAndSuggested') : t('profile.suggested')}
            </h3>
            <ul className="grid gap-0.5" data-testid="status-suggestions">
              {[
                ...recent.map((s) => ({ s, clear: undefined as Clear | undefined })),
                ...PRESETS.map((p) => ({
                  s: { emoji: p.emoji, text: t(`profile.presets.${p.key}`) },
                  clear: p.clear as Clear,
                })),
              ]
                .filter(
                  (x, i, all) =>
                    all.findIndex((y) => y.s.emoji === x.s.emoji && y.s.text === x.s.text) === i,
                )
                .slice(0, 8)
                .map(({ s, clear: c }) => (
                  <li key={`${s.emoji}|${s.text}`}>
                    <button
                      type="button"
                      className="flex min-h-target w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                      onClick={() => pick(s, c)}
                    >
                      <span aria-hidden className="w-5 text-center">
                        {s.emoji}
                      </span>
                      <span className="truncate">{s.text || s.emoji}</span>
                      {c && c !== 'never' && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t(`profile.clear.${c}`)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
          <div className="grid gap-2">
            <Label htmlFor={ids.clear}>{t('profile.clearAfter')}</Label>
            <select
              id={ids.clear}
              className={selectClass}
              value={clear}
              onChange={(e) => setClear(e.target.value as Clear)}
            >
              {CLEAR.map((c) => (
                <option key={c} value={c}>
                  {t(`profile.clear.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter className="sm:justify-between">
            {current ? (
              <Button
                type="button"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t('profile.statusClear')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('glossary.cancel')}
              </Button>
              <Button type="submit" disabled={save.isPending || (!emoji && !text.trim())}>
                {t('chat.save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
