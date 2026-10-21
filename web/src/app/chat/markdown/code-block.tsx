// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type CSSProperties } from 'react';
import { highlight, languageOf, type Line } from './highlight';

/** A fenced code block, highlighted once its language has loaded. */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = languageOf(language);
  const [lines, setLines] = useState<Line[] | undefined>();
  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    highlight(code, lang)
      .then((l) => !cancelled && setLines(l))
      .catch(() => undefined); // plain text stays
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return (
    <pre
      data-language={lang}
      className="my-1 max-w-full overflow-x-auto rounded-lg border bg-card px-3 py-2 font-mono text-[13px] leading-relaxed"
    >
      <code>
        {lines
          ? lines.map((line, i) => (
              <span key={i} className="block">
                {line.tokens.map((t, j) => (
                  <span
                    key={j}
                    className="text-(--code-light) dark:text-(--code-dark)"
                    style={{ '--code-light': t.light, '--code-dark': t.dark } as CSSProperties}
                  >
                    {t.content}
                  </span>
                ))}
                {line.tokens.length === 0 && '\n'}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}
