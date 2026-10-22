// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, GavelIcon, PlusIcon, XIcon } from 'lucide-react';
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
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useActiveWorkspace } from '../chat/active-workspace';
import { directoryQuery } from '../chat/data';
import { workspaceMembersQuery } from '../chat/workspaces';
import { fieldId } from '../automation/automation';
import {
  complianceQuery,
  createHold,
  downloadExport,
  holdsQuery,
  memberAttributesQuery,
  releaseHold,
  setCompliance,
  setMemberAttributes,
  type Compliance,
  type LegalHold,
} from './compliance';

const select =
  'min-h-target rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const COLORS = ['neutral', 'info', 'success', 'warning', 'danger'] as const;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <header className="flex flex-col gap-1">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

const failed = (fallback: string) => (err: unknown) =>
  toast.error((err instanceof ApiError && err.problem.detail) || fallback);

/** Retention, classifications, member attributes, legal holds and eDiscovery. */
export function CompliancePage() {
  const { t } = useTranslation();
  const { id: ws, workspace } = useActiveWorkspace();
  const query = useQuery({ ...complianceQuery(ws ?? ''), enabled: !!ws });
  if (!ws || query.isPending) return <Skeleton className="h-40" />;
  if (!query.data) {
    return (
      <InlineError
        title={t('compliance.loadFailed')}
        problem={query.error instanceof ApiError ? query.error.problem : { status: 500 }}
      />
    );
  }
  const owner = workspace?.role === 'owner';
  return (
    <div className="flex flex-col gap-4" data-testid="compliance">
      <Settings ws={ws} initial={query.data} />
      {query.data.attributes.length > 0 && <MemberAttributes ws={ws} settings={query.data} />}
      {owner && <Holds ws={ws} />}
      {owner && <Export ws={ws} />}
    </div>
  );
}

// --- retention, classifications, attributes ------------------------------------------------

function Settings({ ws, initial }: { ws: string; initial: Compliance }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [c, setC] = useState<Compliance>(initial);
  const [busy, setBusy] = useState(false);
  const setClass = (i: number, change: Partial<Compliance['classifications'][number]>) =>
    setC((x) => ({
      ...x,
      classifications: x.classifications.map((cl, j) => (j === i ? { ...cl, ...change } : cl)),
    }));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setCompliance(ws, c)
          .then((saved) => {
            queryClient.setQueryData(complianceQuery(ws).queryKey, saved);
            setC(saved);
            void queryClient.invalidateQueries({ queryKey: ['classifications', ws] });
            toast.success(t('compliance.saved'));
          })
          .catch(failed(t('compliance.saveFailed')))
          .finally(() => setBusy(false));
      }}
    >
      <Section title={t('compliance.retention.title')} hint={t('compliance.retention.hint')}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-target shrink-0 accent-primary"
              checked={c.retention_days === null}
              onChange={(e) => setC({ ...c, retention_days: e.target.checked ? null : 365 })}
            />
            {t('compliance.retention.forever')}
          </label>
          {c.retention_days !== null && (
            <span className="flex items-center gap-2">
              <Label htmlFor={`${id}-days`}>{t('compliance.retention.days')}</Label>
              <Input
                id={`${id}-days`}
                type="number"
                min={1}
                max={36500}
                className="w-28"
                value={c.retention_days}
                onChange={(e) => setC({ ...c, retention_days: Number(e.target.value) || 1 })}
              />
            </span>
          )}
        </div>
      </Section>

      <Section title={t('compliance.classes.title')} hint={t('compliance.classes.hint')}>
        <ol className="flex flex-col gap-2">
          {c.classifications.map((cl, i) => (
            <li key={cl.id ?? `new-${i}`} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-cn-${i}`}>{t('compliance.classes.name')}</Label>
                <Input
                  id={`${id}-cn-${i}`}
                  value={cl.name}
                  required
                  maxLength={60}
                  className="w-40"
                  onChange={(e) => setClass(i, { name: e.target.value })}
                />
              </div>
              <div className="flex min-w-48 flex-1 flex-col gap-1">
                <Label htmlFor={`${id}-cd-${i}`}>{t('compliance.classes.banner')}</Label>
                <Input
                  id={`${id}-cd-${i}`}
                  value={cl.description}
                  maxLength={300}
                  onChange={(e) => setClass(i, { description: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-cc-${i}`}>{t('compliance.classes.color')}</Label>
                <select
                  id={`${id}-cc-${i}`}
                  className={select}
                  value={cl.color}
                  onChange={(e) =>
                    setClass(i, { color: e.target.value as (typeof COLORS)[number] })
                  }
                >
                  {COLORS.map((col) => (
                    <option key={col} value={col}>
                      {t(`compliance.colors.${col}`)}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('compliance.classes.remove', { name: cl.name })}
                onClick={() =>
                  setC({
                    ...c,
                    classifications: c.classifications.filter((_, j) => j !== i),
                    default_classification:
                      c.default_classification === cl.name ? null : c.default_classification,
                  })
                }
              >
                <XIcon strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-end gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={c.classifications.length >= 10}
            onClick={() =>
              setC({
                ...c,
                classifications: [
                  ...c.classifications,
                  { name: '', description: '', color: 'neutral' },
                ],
              })
            }
          >
            <PlusIcon strokeWidth={1.75} />
            {t('compliance.classes.add')}
          </Button>
          {c.classifications.length > 0 && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-default`}>{t('compliance.classes.default')}</Label>
              <select
                id={`${id}-default`}
                className={select}
                value={c.default_classification ?? ''}
                onChange={(e) => setC({ ...c, default_classification: e.target.value || null })}
              >
                <option value="">{t('compliance.classes.none')}</option>
                {c.classifications
                  .filter((cl) => cl.name.trim())
                  .map((cl) => (
                    <option key={cl.name} value={cl.name}>
                      {cl.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
      </Section>

      <Section title={t('compliance.attrs.title')} hint={t('compliance.attrs.hint')}>
        <ul className="flex flex-col gap-2">
          {c.attributes.map((a, i) => (
            <li key={a.key} className="flex items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-an-${i}`}>{t('compliance.attrs.name')}</Label>
                <Input
                  id={`${id}-an-${i}`}
                  value={a.name}
                  required
                  maxLength={60}
                  onChange={(e) =>
                    setC({
                      ...c,
                      attributes: c.attributes.map((x, j) =>
                        j === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
              </div>
              <code className="pb-2 text-xs text-muted-foreground">{a.key}</code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('compliance.attrs.remove', { name: a.name })}
                onClick={() => setC({ ...c, attributes: c.attributes.filter((_, j) => j !== i) })}
              >
                <XIcon strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={c.attributes.length >= 20}
            onClick={() => {
              const name = t('compliance.attrs.newName');
              setC({
                ...c,
                attributes: [
                  ...c.attributes,
                  {
                    key: fieldId(
                      name,
                      c.attributes.map((a) => a.key),
                    ),
                    name,
                  },
                ],
              });
            }}
          >
            <PlusIcon strokeWidth={1.75} />
            {t('compliance.attrs.add')}
          </Button>
        </div>
      </Section>
      <div>
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {t('compliance.save')}
        </Button>
      </div>
    </form>
  );
}

// --- member attributes ------------------------------------------------------------

function MemberAttributes({ ws, settings }: { ws: string; settings: Compliance }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const members = useQuery(workspaceMembersQuery(ws)).data ?? [];
  const attrs = useQuery(memberAttributesQuery(ws)).data ?? [];
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const valuesOf = (userId: string) =>
    edits[userId] ?? attrs.find((a) => a.user_id === userId)?.attributes ?? {};
  return (
    <Section title={t('compliance.members.title')} hint={t('compliance.members.hint')}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">
                {t('compliance.members.person')}
              </th>
              {settings.attributes.map((a) => (
                <th key={a.key} scope="col" className="py-1 pr-2 font-medium">
                  {a.name}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">{t('compliance.members.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members
              .filter((m) => !m.user.is_bot)
              .map((m) => (
                <tr key={m.user.id} className="border-t">
                  <th scope="row" className="py-1 pr-2 text-left font-normal">
                    {m.user.display_name}
                  </th>
                  {settings.attributes.map((a) => (
                    <td key={a.key} className="py-1 pr-2">
                      <Input
                        aria-label={`${a.name}, ${m.user.display_name}`}
                        maxLength={100}
                        value={valuesOf(m.user.id)[a.key] ?? ''}
                        onChange={(e) =>
                          setEdits((x) => ({
                            ...x,
                            [m.user.id]: { ...valuesOf(m.user.id), [a.key]: e.target.value },
                          }))
                        }
                      />
                    </td>
                  ))}
                  <td className="py-1">
                    {edits[m.user.id] && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void setMemberAttributes(ws, m.user.id, edits[m.user.id]!)
                            .then((r) => {
                              setEdits(({ [m.user.id]: _, ...rest }) => rest);
                              void queryClient.invalidateQueries({
                                queryKey: memberAttributesQuery(ws).queryKey,
                              });
                              toast.success(
                                r.removed > 0
                                  ? t('compliance.members.savedRemoved', { count: r.removed })
                                  : t('compliance.saved'),
                              );
                            })
                            .catch(failed(t('compliance.saveFailed')))
                        }
                      >
                        {t('compliance.members.save', { name: m.user.display_name })}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// --- legal holds --------------------------------------------------------------------

function Holds({ ws }: { ws: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const holds = useQuery(holdsQuery(ws)).data ?? [];
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<LegalHold | null>(null);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  const reload = () => queryClient.invalidateQueries({ queryKey: holdsQuery(ws).queryKey });
  return (
    <Section title={t('compliance.holds.title')} hint={t('compliance.holds.hint')}>
      {holds.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('compliance.holds.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {holds.map((h) => (
            <li
              key={h.id}
              data-testid="hold"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-sm"
            >
              <GavelIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
              <span className="font-medium">{h.name}</span>
              <span className="text-muted-foreground">
                {h.released_at
                  ? t('compliance.holds.released', { date: date.format(new Date(h.released_at)) })
                  : t('compliance.holds.keeps', { count: h.message_count })}
              </span>
              <span className="text-muted-foreground">
                {t('compliance.holds.scope', {
                  people: h.user_ids.length,
                  channels: h.channel_ids.length,
                })}
              </span>
              {!h.released_at && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setReleasing(h)}
                >
                  {t('compliance.holds.release')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon strokeWidth={1.75} />
          {t('compliance.holds.add')}
        </Button>
      </div>
      {creating && (
        <HoldDialog
          ws={ws}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(o) => !o && setReleasing(null)}
        severity="s2"
        title={t('compliance.holds.releaseTitle', { name: releasing?.name ?? '' })}
        description={t('compliance.holds.releaseHint')}
        confirmLabel={t('compliance.holds.release')}
        onConfirm={async () => {
          if (!releasing) return;
          await releaseHold(releasing.id);
          await reload();
          setReleasing(null);
        }}
      />
    </Section>
  );
}

/** People and channels to pick, as checkboxes. */
function Picker({
  legend,
  options,
  picked,
  onChange,
}: {
  legend: string;
  options: { id: string; name: string }[];
  picked: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
        {options.map((o) => (
          <label key={o.id} className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-target shrink-0 accent-primary"
              checked={picked.includes(o.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))
              }
            />
            {o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function usePeopleAndChannels(ws: string) {
  const members = useQuery(workspaceMembersQuery(ws)).data ?? [];
  const channels = useQuery(directoryQuery(ws)).data ?? [];
  return {
    people: members
      .filter((m) => !m.user.is_bot)
      .map((m) => ({ id: m.user.id, name: m.user.display_name })),
    channels: channels.map((c) => ({ id: c.id, name: `#${c.name}` })),
  };
}

function HoldDialog({
  ws,
  onClose,
  onSaved,
}: {
  ws: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { people, channels } = usePeopleAndChannels(ws);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [chans, setChans] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            createHold(ws, {
              name: name.trim(),
              description: description.trim(),
              user_ids: users,
              channel_ids: chans,
              starts_at: from ? new Date(`${from}T00:00`).toISOString() : null,
              ends_at: to ? new Date(`${to}T00:00`).toISOString() : null,
            })
              .then(onSaved)
              .catch((err: unknown) => setError(err))
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('compliance.holds.add')}</DialogTitle>
            <DialogDescription>{t('compliance.holds.addHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('compliance.holds.name')}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              required
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-desc`}>{t('compliance.holds.description')}</Label>
            <Input
              id={`${id}-desc`}
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Picker
            legend={t('compliance.holds.people')}
            options={people}
            picked={users}
            onChange={setUsers}
          />
          <Picker
            legend={t('compliance.holds.channels')}
            options={channels}
            picked={chans}
            onChange={setChans}
          />
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-from`}>{t('compliance.holds.from')}</Label>
              <Input
                id={`${id}-from`}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-to`}>{t('compliance.holds.to')}</Label>
              <Input
                id={`${id}-to`}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          {error !== null && (
            <InlineError
              title={t('compliance.saveFailed')}
              problem={error instanceof ApiError ? error.problem : { status: 500 }}
              reason={error instanceof ApiError ? error.problem.detail : undefined}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('collab.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || users.length + chans.length === 0}
              aria-busy={busy}
            >
              {t('compliance.holds.place')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- export -------------------------------------------------------------------------

function Export({ ws }: { ws: string }) {
  const { t } = useTranslation();
  const id = useId();
  const { people, channels } = usePeopleAndChannels(ws);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [chans, setChans] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Section title={t('compliance.export.title')} hint={t('compliance.export.hint')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          downloadExport(ws, {
            since: from,
            until: to,
            q: q.trim(),
            user_ids: users,
            channel_ids: chans,
          })
            .then(() => toast.success(t('compliance.export.done')))
            .catch(failed(t('compliance.export.failed')))
            .finally(() => setBusy(false));
        }}
      >
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-from`}>{t('compliance.holds.from')}</Label>
            <Input
              id={`${id}-from`}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-to`}>{t('compliance.holds.to')}</Label>
            <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor={`${id}-q`}>{t('compliance.export.words')}</Label>
            <Input
              id={`${id}-q`}
              value={q}
              maxLength={200}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Picker
            legend={t('compliance.export.people')}
            options={people}
            picked={users}
            onChange={setUsers}
          />
          <Picker
            legend={t('compliance.export.channels')}
            options={channels}
            picked={chans}
            onChange={setChans}
          />
        </div>
        <div>
          <Button type="submit" disabled={busy} aria-busy={busy}>
            <DownloadIcon strokeWidth={1.75} />
            {t('compliance.export.download')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
