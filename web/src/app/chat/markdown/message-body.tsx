// SPDX-License-Identifier: Apache-2.0
import { memo, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { cn } from '@cenacle/ui/lib/utils';
import { CodeBlock } from './code-block';
import { mentionId, toMarkdownMentions } from './mentions';

type Person = { id: string; display_name: string };

function MentionChip({ name, self }: { name: string; self: boolean }) {
  return (
    <span
      data-testid="mention"
      data-self={self || undefined}
      className={cn(
        'rounded px-0.5 font-medium',
        self ? 'bg-mention-bg text-mention' : 'bg-accent text-accent-foreground',
      )}
    >
      @{name}
    </span>
  );
}

function components(selfId: string, people: Person[]): Components {
  return {
    a({ href, children }) {
      // Only links made from <@id> for people the server says are mentioned
      // become chips; a typed look-alike stays an ordinary link.
      const id = mentionId(href);
      const person = id && people.find((p) => p.id === id);
      if (person) return <MentionChip name={person.display_name} self={id === selfId} />;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="underline underline-offset-2 hover:decoration-2"
          data-target-exempt
        >
          {children}
        </a>
      );
    },
    // Images from other sites would tell them who reads the chat: links instead.
    img({ src, alt }) {
      return src ? (
        <a
          href={String(src)}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          data-target-exempt
          className="underline"
        >
          {alt || String(src)}
        </a>
      ) : null;
    },
    pre({ children }) {
      return <>{children}</>;
    },
    code({ className, children }) {
      const text = String(children ?? '');
      const lang = /language-([\w+#-]+)/.exec(className ?? '')?.[1];
      // Fenced blocks end with a newline or name a language; the rest is inline.
      if (lang || text.includes('\n')) {
        return <CodeBlock code={text.replace(/\n$/, '')} language={lang} />;
      }
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
      );
    },
    blockquote({ children }) {
      return (
        <blockquote className="my-1 border-l-3 pl-3 text-muted-foreground">{children}</blockquote>
      );
    },
    ul({ children }) {
      return <ul className="my-1 list-disc pl-5">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="my-1 list-decimal pl-5">{children}</ol>;
    },
    p({ children }) {
      return <p className="my-0.5 first:mt-0 last:mb-0">{children}</p>;
    },
    table({ children }) {
      return (
        <div className="my-1 max-w-full overflow-x-auto">
          <table className="border-collapse text-sm">{children}</table>
        </div>
      );
    },
    th({ children }) {
      return <th className="border px-2 py-1 text-left font-semibold">{children}</th>;
    },
    td({ children }) {
      return <td className="border px-2 py-1">{children}</td>;
    },
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    h5: Heading,
    h6: Heading,
    hr() {
      return <hr className="my-2" />;
    },
  };
}

/** Headings in chat stay text-sized: a message is not a document. */
function Heading({ children }: { children?: ReactNode }) {
  return <p className="my-0.5 font-semibold">{children}</p>;
}

/**
 * A message body: Markdown (GitHub flavour) without raw HTML, sanitized,
 * links opening elsewhere, mentions as chips, code highlighted.
 */
export const MessageBody = memo(function MessageBody({
  body,
  mentions,
  selfId,
}: {
  body: string;
  mentions: Person[];
  selfId: string;
}) {
  return (
    <div className="text-[15px] leading-relaxed break-words [&_li>p]:my-0">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components(selfId, mentions)}
      >
        {toMarkdownMentions(body, mentions)}
      </Markdown>
    </div>
  );
});
