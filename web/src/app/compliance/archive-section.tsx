// SPDX-License-Identifier: AGPL-3.0-only
import { DownloadIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { dateLocale } from '../../i18n/time-format';
import { formatSize } from '../chat/files';

type Schedule = components['schemas']['ArchiveSchedule'];
type Format = components['schemas']['ArchiveFormat'];

const FORMATS: Format[] = ['csv', 'actiance', 'eml'];
const EXT: Record<Format, string> = { csv: 'csv', actiance: 'xml', eml: 'zip' };

const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

async function save(path: string, filename: string) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as ApiError['problem'] | undefined;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: res.statusText,
        status: res.status,
        code: `http_${res.status}`,
      },
    );
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Archive exports: a period now, or every day into the object store. */
export function ArchiveSection({ ws }: { ws: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<Format>('csv');
  const [since, setSince] = useState(weekAgo);
  const [until, setUntil] = useState(today);
  const [busy, setBusy] = useState(false);
  const schedule = useQuery({
    queryKey: ['archive-schedule', ws],
    queryFn: () => apiFetch<Schedule>(`/api/workspaces/${ws}/archive-schedule`),
  });
  const setSchedule = useMutation({
    mutationFn: (f: Schedule['format']) =>
      apiFetch<Schedule>(`/api/workspaces/${ws}/archive-schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: f }),
      }),
    onSuccess: (s) => {
      queryClient.setQueryData(['archive-schedule', ws], s);
      toast.success(t('archive.scheduleSaved'));
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('archive.failed')),
  });
  const download = async () => {
    setBusy(true);
    try {
      // Whole days: from the start of the first to the end of the last (UTC).
      const params = new URLSearchParams({
        format,
        since: `${since}T00:00:00Z`,
        until: new Date(new Date(`${until}T00:00:00Z`).getTime() + 86_400_000).toISOString(),
      });
      await save(
        `/api/workspaces/${ws}/archive?${params}`,
        `cenacle-archive-${since}-${until}.${EXT[format]}`,
      );
    } catch (err) {
      toast.error((err instanceof ApiError && err.problem.detail) || t('archive.failed'));
    } finally {
      setBusy(false);
    }
  };
  const day = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-[10px] border border-rule-strong bg-background p-4"
      data-testid="archive"
    >
      <header className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {t('archive.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('archive.hint')}</p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-format`}>{t('archive.format')}</Label>
          <select
            id={`${id}-format`}
            className="min-h-target h-9 rounded-md border bg-background px-2 text-sm"
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {t(`archive.formats.${f}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-since`}>{t('archive.since')}</Label>
          <Input
            id={`${id}-since`}
            type="date"
            value={since}
            max={until}
            onChange={(e) => setSince(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-until`}>{t('archive.until')}</Label>
          <Input
            id={`${id}-until`}
            type="date"
            value={until}
            min={since}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={busy || !since || !until}
          onClick={() => void download()}
        >
          <DownloadIcon strokeWidth={1.75} />
          {t('archive.download')}
        </Button>
      </div>
      {schedule.data && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-daily`}>{t('archive.daily')}</Label>
            <select
              id={`${id}-daily`}
              className="min-h-target h-9 w-56 rounded-md border bg-background px-2 text-sm"
              value={schedule.data.format}
              disabled={!schedule.data.available || setSchedule.isPending}
              aria-describedby={`${id}-daily-hint`}
              onChange={(e) => setSchedule.mutate(e.target.value as Schedule['format'])}
            >
              <option value="off">{t('archive.off')}</option>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`archive.formats.${f}`)}
                </option>
              ))}
            </select>
            <p id={`${id}-daily-hint`} className="text-xs text-muted-foreground">
              {schedule.data.available ? t('archive.dailyHint') : t('archive.noStorage')}
            </p>
          </div>
          {schedule.data.exports.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm" data-testid="archive-exports">
              {schedule.data.exports.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3">
                  <span>{day.format(new Date(`${e.day}T00:00:00Z`))}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(`archive.formats.${e.format}`)} ·{' '}
                    {t('archive.messages', { count: e.messages })} ·{' '}
                    {formatSize(e.size, i18n.language)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      void save(
                        `/api/archive-exports/${e.id}`,
                        `cenacle-archive-${e.day}.${EXT[e.format]}`,
                      ).catch(() => toast.error(t('archive.failed')))
                    }
                  >
                    <DownloadIcon strokeWidth={1.75} />
                    {t('archive.get')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
