// SPDX-License-Identifier: Apache-2.0
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { directoryQuery } from '../chat/data';
import type { Workspace } from '../chat/workspaces';
import {
  bannerQuery,
  removeBanner,
  setBanner,
  setTerms,
  setWelcome,
  termsQuery,
  welcomeQuery,
  withdrawTerms,
  type BannerInput,
} from './community';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const areaClass =
  'rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** In the workspace settings (owners, admins): what new members see first. */
export function WelcomeForm({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const ids = { message: useId(), rules: useId() };
  const queryClient = useQueryClient();
  const welcome = useQuery(welcomeQuery(workspace.id));
  const directory = useQuery(directoryQuery(workspace.id));
  const [draft, setDraft] = useState<{ message: string; rules: string; channels: string[] } | null>(
    null,
  );
  const current = draft ?? {
    message: welcome.data?.message ?? '',
    rules: (welcome.data?.rules ?? []).join('\n'),
    channels: welcome.data?.channel_ids ?? [],
  };
  const save = useMutation({
    mutationFn: () =>
      setWelcome(workspace.id, {
        message: current.message.trim(),
        rules: current.rules
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        channel_ids: current.channels,
      }),
    onSuccess: (w) => {
      queryClient.setQueryData(welcomeQuery(workspace.id).queryKey, w);
      setDraft(null);
      toast.success(t('community.welcome.saved'));
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('community.welcome.failed')),
  });
  const publicChannels = (directory.data ?? []).filter(
    (c) => c.visibility === 'public' && c.kind !== 'direct' && c.kind !== 'group' && !c.archived,
  );
  if (!welcome.data) return null;
  return (
    <section
      aria-labelledby={`${ids.message}-title`}
      className="grid gap-2"
      data-testid="welcome-form"
    >
      <h3
        id={`${ids.message}-title`}
        className="text-xs font-medium text-muted-foreground uppercase"
      >
        {t('community.welcome.settingsTitle')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('community.welcome.settingsHint')}</p>
      <div className="grid gap-1">
        <Label htmlFor={ids.message}>{t('community.welcome.message')}</Label>
        <textarea
          id={ids.message}
          rows={3}
          maxLength={4000}
          value={current.message}
          onChange={(e) => setDraft({ ...current, message: e.target.value })}
          className={areaClass}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={ids.rules}>{t('community.welcome.rulesLabel')}</Label>
        <textarea
          id={ids.rules}
          rows={3}
          value={current.rules}
          onChange={(e) => setDraft({ ...current, rules: e.target.value })}
          className={areaClass}
          aria-describedby={`${ids.rules}-hint`}
        />
        <p id={`${ids.rules}-hint`} className="text-xs text-muted-foreground">
          {t('community.welcome.rulesHint')}
        </p>
      </div>
      {publicChannels.length > 0 && (
        <fieldset className="flex flex-col">
          <legend className="mb-1 text-sm font-medium">{t('community.welcome.suggest')}</legend>
          {publicChannels.map((c) => (
            <label key={c.id} data-target className="flex min-h-target items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-target-exempt
                className="size-4 accent-primary"
                checked={current.channels.includes(c.id)}
                onChange={(e) =>
                  setDraft({
                    ...current,
                    channels: e.target.checked
                      ? [...current.channels, c.id]
                      : current.channels.filter((x) => x !== c.id),
                  })
                }
              />
              #{c.name}
            </label>
          ))}
        </fieldset>
      )}
      <Button
        size="sm"
        className="self-start"
        disabled={save.isPending || !draft}
        onClick={() => save.mutate()}
      >
        {t('community.welcome.save')}
      </Button>
    </section>
  );
}

/** In the settings of instance administrators: the banner and the terms of service. */
export function AnnouncementsPanel() {
  const { t } = useTranslation();
  const ids = { text: useId(), level: useId(), terms: useId() };
  const queryClient = useQueryClient();
  const banner = useQuery(bannerQuery);
  const terms = useQuery(termsQuery);
  const [form, setForm] = useState<BannerInput | null>(null);
  const current: BannerInput = form ?? {
    text: banner.data?.text ?? '',
    level: banner.data?.level ?? 'info',
    dismissible: banner.data?.dismissible ?? true,
  };
  const [termsText, setTermsText] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const failed = (err: unknown) =>
    toast.error((err instanceof ApiError && err.problem.detail) || t('community.admin.failed'));
  const saveBanner = useMutation({
    mutationFn: () => setBanner({ ...current, text: current.text.trim() }),
    onSuccess: () => {
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: bannerQuery.queryKey });
      toast.success(t('community.admin.bannerSaved'));
    },
    onError: failed,
  });
  const dropBanner = useMutation({
    mutationFn: removeBanner,
    onSuccess: () => {
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: bannerQuery.queryKey });
    },
    onError: failed,
  });
  const publish = useMutation({
    mutationFn: () => setTerms((termsText ?? '').trim()),
    onSuccess: () => {
      setTermsText(null);
      void queryClient.invalidateQueries({ queryKey: termsQuery.queryKey });
      toast.success(t('community.admin.termsPublished'));
    },
    onError: failed,
  });
  const withdraw = useMutation({
    mutationFn: withdrawTerms,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: termsQuery.queryKey }),
    onError: failed,
  });
  const text = termsText ?? terms.data?.terms?.text ?? '';
  return (
    <div className="flex flex-col gap-6" data-testid="announcements-panel">
      <section aria-labelledby={`${ids.text}-title`} className="grid gap-2">
        <h3 id={`${ids.text}-title`} className="text-sm font-semibold">
          {t('community.admin.banner')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('community.admin.bannerHint')}</p>
        <div className="grid gap-1">
          <Label htmlFor={ids.text}>{t('community.admin.bannerText')}</Label>
          <Input
            id={ids.text}
            value={current.text}
            maxLength={500}
            onChange={(e) => setForm({ ...current, text: e.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={ids.level}>{t('community.admin.level')}</Label>
          <select
            id={ids.level}
            className={selectClass}
            value={current.level}
            onChange={(e) => setForm({ ...current, level: e.target.value as BannerInput['level'] })}
          >
            {(['info', 'warning', 'critical'] as const).map((l) => (
              <option key={l} value={l}>
                {t(`community.admin.levels.${l}`)}
              </option>
            ))}
          </select>
        </div>
        <label data-target className="flex min-h-target items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-target-exempt
            className="size-4 accent-primary"
            checked={current.dismissible ?? true}
            onChange={(e) => setForm({ ...current, dismissible: e.target.checked })}
          />
          {t('community.admin.dismissible')}
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={saveBanner.isPending || !current.text.trim()}
            onClick={() => saveBanner.mutate()}
          >
            {t('community.admin.showBanner')}
          </Button>
          {banner.data && (
            <Button
              size="sm"
              variant="ghost"
              disabled={dropBanner.isPending}
              onClick={() => dropBanner.mutate()}
            >
              {t('community.admin.removeBanner')}
            </Button>
          )}
        </div>
      </section>
      <section aria-labelledby={`${ids.terms}-title`} className="grid gap-2">
        <h3 id={`${ids.terms}-title`} className="text-sm font-semibold">
          {t('community.admin.terms')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('community.admin.termsHint')}</p>
        <Label htmlFor={ids.terms}>{t('community.admin.termsText')}</Label>
        <textarea
          id={ids.terms}
          rows={8}
          maxLength={20000}
          value={text}
          onChange={(e) => setTermsText(e.target.value)}
          className={areaClass}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={publish.isPending || !text.trim() || termsText === null}
            onClick={() => setConfirm(true)}
          >
            {t('community.admin.publishTerms')}
          </Button>
          {terms.data?.terms && (
            <Button
              size="sm"
              variant="ghost"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate()}
            >
              {t('community.admin.withdrawTerms')}
            </Button>
          )}
        </div>
      </section>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        severity="s2"
        title={t('community.admin.publishConfirmTitle')}
        description={t('community.admin.publishConfirm')}
        confirmLabel={t('community.admin.publishTerms')}
        onConfirm={async () => {
          await publish.mutateAsync();
        }}
      />
    </div>
  );
}
