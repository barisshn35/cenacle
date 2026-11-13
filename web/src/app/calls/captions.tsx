// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState } from 'react';
import { CaptionsIcon, CaptionsOffIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { calls } from '@cenacle/core';
import { Button } from '@cenacle/ui/components/button';
import { useProfile } from '../profile/profiles';
import { canSendCaptions, startCaptionSender } from './captions-sender';
import { errorCode, useCall } from './state';

const HIDE_KEY = 'cenacle.call.captions.hidden';
const LANGUAGE_KEY = 'cenacle.call.captions.language';

type Spoken = 'tr' | 'en' | 'auto';

const selectClass =
  'min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/**
 * The language this person speaks, sent with their speech: the interface's
 * language unless they chose another. Forcing the wrong one makes the
 * speech-to-text server translate instead of write down what was said.
 */
function useSpoken(appLanguage: string) {
  const [chosen, setChosen] = useState<Spoken | null>(() => {
    try {
      const v = localStorage.getItem(LANGUAGE_KEY);
      return v === 'tr' || v === 'en' || v === 'auto' ? v : null;
    } catch {
      return null;
    }
  });
  const spoken: Spoken = chosen ?? (appLanguage.startsWith('tr') ? 'tr' : 'en');
  const choose = (v: Spoken) => {
    setChosen(v);
    try {
      localStorage.setItem(LANGUAGE_KEY, v);
    } catch {
      // Private windows: for this page only.
    }
  };
  return [spoken, choose] as const;
}

/** Turns captions on or off for the whole call. */
export function CaptionsButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('calls');
  const call = useCall((s) => s.call);
  if (!call) return null;
  const on = !!call.captions_on;
  return (
    <Button
      variant="outline"
      aria-pressed={on}
      disabled={disabled}
      onClick={() =>
        void calls
          .setCaptions(call.id, !on)
          .catch((error: unknown) => useCall.setState({ error: errorCode(error) }))
      }
    >
      {on ? (
        <CaptionsOffIcon data-icon="inline-start" />
      ) : (
        <CaptionsIcon data-icon="inline-start" />
      )}
      {on ? t('captions.turnOff') : t('captions.turnOn')}
    </Button>
  );
}

function Line({ userID, text }: { userID: string; text: string }) {
  const name = useProfile(userID)?.display_name;
  return (
    <p>
      {name && <span className="me-1.5 font-semibold">{name}:</span>}
      {text}
    </p>
  );
}

/**
 * While captions are on: who turned them on (everyone sees it), the last
 * lines (each person may hide them on their own screen), and this app sending
 * what its person says.
 */
export function CaptionsArea({ selfID }: { selfID: string }) {
  const { t, i18n } = useTranslation('calls');
  const call = useCall((s) => s.call);
  const lines = useCall((s) => s.captions);
  const audio = useCall((s) => s.local.get('audio'));
  const connected = useCall((s) => s.connection === 'connected');
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const by = useProfile(call?.captions_by ?? undefined)?.display_name;
  const on = !!call?.captions_on;
  const callID = call?.id;
  const [language, setLanguage] = useSpoken(i18n.language);
  const languageID = useId();

  useEffect(() => {
    if (!on || !connected || !audio || !callID) return;
    return startCaptionSender(audio, callID, language);
  }, [on, connected, audio, callID, language]);

  if (!on) return null;
  const toggle = () => {
    setHidden(!hidden);
    try {
      localStorage.setItem(HIDE_KEY, hidden ? '0' : '1');
    } catch {
      // Private windows: for this page only.
    }
  };
  return (
    <div className="grid gap-2" data-testid="captions">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p role="status" className="flex items-center gap-1.5 font-medium">
          <CaptionsIcon aria-hidden className="size-4" />
          {call?.captions_by === selfID
            ? t('captions.onByYou')
            : by
              ? t('captions.onBy', { name: by })
              : t('captions.on')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canSendCaptions() && (
            <>
              <label htmlFor={languageID} className="text-sm">
                {t('captions.spoken')}
              </label>
              <select
                id={languageID}
                className={selectClass}
                value={language}
                onChange={(e) => setLanguage(e.target.value as Spoken)}
              >
                <option value="en" lang="en">
                  English
                </option>
                <option value="tr" lang="tr">
                  Türkçe
                </option>
                <option value="auto">{t('captions.spokenAuto')}</option>
              </select>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={toggle}>
            {hidden ? t('captions.show') : t('captions.hide')}
          </Button>
        </div>
      </div>
      {!canSendCaptions() && (
        <p className="text-xs text-muted-foreground">{t('captions.cannotSend')}</p>
      )}
      {!hidden && (
        <div
          aria-live="polite"
          className="min-h-12 rounded-lg bg-foreground/90 px-3 py-2 text-[15px] leading-snug text-background"
        >
          {lines.length === 0 ? (
            <p className="opacity-70 forced-colors:opacity-100">{t('captions.waiting')}</p>
          ) : (
            lines.map((l) => <Line key={l.key} userID={l.userID} text={l.text} />)
          )}
        </div>
      )}
    </div>
  );
}
