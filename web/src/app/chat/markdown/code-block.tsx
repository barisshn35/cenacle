// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type CSSProperties } from 'react';
import { CODE_THEMES } from '@cenacle/ui/theme';
import { cn } from '@cenacle/ui/lib/utils';
import { useCodeSettings } from '../../appearance/appearance';
import { highlight, languageOf, type Line } from './highlight';

/**
 * A fenced code block, highlighted once its language has loaded, in the
 * reader's code theme, with line numbers and wrapping as they chose.
 */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = languageOf(language);
  const settings = useCodeSettings();
  const themes = CODE_THEMES[settings.theme];
  const [lines, setLines] = useState<Line[] | undefined>();
  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    highlight(code, lang, themes)
      .then((l) => !cancelled && setLines(l))
      .catch(() => undefined); // plain text stays
    return () => {
      cancelled = true;
    };
  }, [code, lang, themes]);
  const plain = code.replace(/\n$/, '').split('\n');
  const count = lines?.length ?? plain.length;
  return (
    <pre
      data-language={lang}
      data-line-numbers={settings.line_numbers || undefined}
      className={cn(
        'my-1 max-w-full rounded-lg border bg-card px-3 py-2 font-mono text-[0.8125rem] leading-relaxed',
        settings.wrap ? 'break-words whitespace-pre-wrap' : 'overflow-x-auto',
      )}
    >
      <code className={cn(settings.line_numbers && 'grid grid-cols-[auto_1fr] gap-x-3')}>
        {Array.from({ length: count }, (_, i) => {
          const line = lines?.[i];
          return (
            <span key={i} className="contents">
              {settings.line_numbers && (
                <span aria-hidden className="text-end text-muted-foreground select-none">
                  {i + 1}
                </span>
              )}
              <span className="block">
                {line
                  ? line.tokens.map((t, j) => (
                      <span
                        key={j}
                        className="text-(--code-light) dark:text-(--code-dark)"
                        style={{ '--code-light': t.light, '--code-dark': t.dark } as CSSProperties}
                      >
                        {t.content}
                      </span>
                    ))
                  : plain[i]}
                {(line ? line.tokens.length === 0 : plain[i] === '') && '\n'}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}
