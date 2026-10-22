// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Label } from '@cenacle/ui/components/label';
import { applyUITexts, LANGUAGES, originalText, type Language } from '../../i18n';

type UITexts = components['schemas']['UITexts'];

const uiTextsQuery = {
  queryKey: ['ui-texts'],
  queryFn: () => apiFetch<UITexts>('/api/ui-texts'),
};

/** Instance administrators replace a few interface texts, per language. */
export function UITextsPanel() {
  const { t } = useTranslation();
  const id = useId();
  const texts = useQuery(uiTextsQuery);
  const [lng, setLng] = useState<Language>('en');
  return (
    <div className="flex flex-col gap-3" data-testid="ui-texts-panel">
      <p className="text-sm text-muted-foreground">{t('uiTexts.description')}</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-lng`}>{t('appearance.language')}</Label>
        <select
          id={`${id}-lng`}
          value={lng}
          onChange={(e) => setLng(e.target.value as Language)}
          className="min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l === 'en' ? 'English' : 'Türkçe'}
            </option>
          ))}
        </select>
      </div>
      {texts.data && (
        <TextsForm key={lng} lng={lng} data={texts.data} onSaved={() => void texts.refetch()} />
      )}
    </div>
  );
}

function TextsForm({ lng, data, onSaved }: { lng: Language; data: UITexts; onSaved: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...data.texts[lng] }));
  const save = useMutation({
    mutationFn: () =>
      apiFetch<UITexts>('/api/ui-texts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: lng, texts: values }),
      }),
    onSuccess: (saved) => {
      applyUITexts(saved.texts, saved.editable);
      onSaved();
      toast.success(t('uiTexts.saved'));
    },
    onError: () => toast.error(t('uiTexts.failed')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      {data.editable.map((key) => (
        <div key={key} className="grid gap-1">
          <Label htmlFor={`${id}-${key}`}>{t(`uiTexts.keys.${key.replace('.', '_')}`)}</Label>
          <textarea
            id={`${id}-${key}`}
            rows={2}
            maxLength={500}
            value={values[key] ?? ''}
            placeholder={originalText(lng, key)}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            className="min-h-target w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        {t('uiTexts.hint', { channel: '{{channel}}' })}
      </p>
      <div>
        <Button type="submit" disabled={save.isPending}>
          {t('chat.save')}
        </Button>
      </div>
    </form>
  );
}
