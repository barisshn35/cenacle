// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
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
import { reloadChannels, type Channel } from '../chat/data';
import {
  classificationsQuery,
  complianceQuery,
  setChannelCompliance,
  type AccessRule,
} from './compliance';

const select =
  'min-h-target rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** A channel's retention, classification and access rules (workspace admins). */
export function ChannelComplianceButton({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ShieldCheckIcon strokeWidth={1.75} />
        {t('compliance.channel.open')}
      </Button>
      {open && <ChannelComplianceDialog channel={channel} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ChannelComplianceDialog({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const settings = useQuery(complianceQuery(channel.workspace_id)).data;
  const classes = useQuery(classificationsQuery(channel.workspace_id)).data;
  const [retention, setRetention] = useState<number | null>(channel.retention_days ?? null);
  const [classification, setClassification] = useState(channel.classification_id ?? '');
  const [rules, setRules] = useState<(AccessRule & { text: string })[]>(
    (channel.access_rules ?? []).map((r) => ({ ...r, text: r.values.join(', ') })),
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const attributes = settings?.attributes ?? [];
  const everyone = channel.is_default || channel.is_mandatory;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setChannelCompliance(channel.id, {
              retention_days: retention,
              classification_id: classification || null,
              access_rules: rules.map(({ key, text }) => ({
                key,
                values: text
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              })),
            })
              .then((r) => {
                void reloadChannels(queryClient);
                toast.success(
                  r.removed > 0
                    ? t('compliance.channel.savedRemoved', { count: r.removed })
                    : t('compliance.saved'),
                );
                onClose();
              })
              .catch((err: unknown) => setError(err))
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('compliance.channel.title', { name: channel.name })}</DialogTitle>
            <DialogDescription>{t('compliance.channel.hint')}</DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t('compliance.retention.title')}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-target shrink-0 accent-primary"
                checked={retention === null}
                onChange={(e) => setRetention(e.target.checked ? null : 365)}
              />
              {t('compliance.channel.followWorkspace')}
            </label>
            {retention !== null && (
              <span className="flex items-center gap-2">
                <Label htmlFor={`${id}-days`}>{t('compliance.retention.days')}</Label>
                <Input
                  id={`${id}-days`}
                  type="number"
                  min={1}
                  max={36500}
                  className="w-28"
                  value={retention}
                  onChange={(e) => setRetention(Number(e.target.value) || 1)}
                />
              </span>
            )}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-class`}>{t('compliance.channel.classification')}</Label>
            <select
              id={`${id}-class`}
              className={select}
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            >
              <option value="">{t('compliance.channel.followWorkspace')}</option>
              {(classes?.classifications ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {!everyone && attributes.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('compliance.channel.rules')}</legend>
              <p className="text-sm text-muted-foreground">{t('compliance.channel.rulesHint')}</p>
              {rules.map((r, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`${id}-rk-${i}`}>{t('compliance.channel.attribute')}</Label>
                    <select
                      id={`${id}-rk-${i}`}
                      className={select}
                      value={r.key}
                      onChange={(e) =>
                        setRules(rules.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                      }
                    >
                      {attributes.map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor={`${id}-rv-${i}`}>{t('compliance.channel.values')}</Label>
                    <Input
                      id={`${id}-rv-${i}`}
                      value={r.text}
                      required
                      onChange={(e) =>
                        setRules(
                          rules.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('compliance.channel.removeRule')}
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  >
                    <XIcon strokeWidth={1.75} />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={rules.length >= 10}
                  onClick={() =>
                    setRules([...rules, { key: attributes[0]!.key, values: [], text: '' }])
                  }
                >
                  <PlusIcon strokeWidth={1.75} />
                  {t('compliance.channel.addRule')}
                </Button>
              </div>
            </fieldset>
          )}
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
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {t('compliance.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
