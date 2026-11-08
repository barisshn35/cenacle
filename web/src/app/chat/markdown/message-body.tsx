// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useMemo, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { cn } from '@cenacle/ui/lib/utils';
import { CodeBlock } from './code-block';
import { mentionId, toMarkdownMentions } from './mentions';
import { broadcastLink, emojiLink, groupLink, onlyEmoji, toMarkdownExtras } from './extras';
import { useMentionableGroups, type MentionGroup } from '../../groups/groups';
import { useActiveWorkspace } from '../active-workspace';
import { CustomEmojiImage } from '../../richer/emoji';
import { useCustomEmoji } from '../../richer/use-custom-emoji';
import type { CustomEmoji } from '../../richer/richer';

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

function components(
  selfId: string,
  people: Person[],
  emoji: Map<string, CustomEmoji>,
  groups: Map<string, MentionGroup>,
  asDocument: boolean,
): Components {
  return {
    a({ href, children }) {
      const name = emojiLink(href);
      if (name) return <CustomEmojiImage name={name} emoji={emoji} />;
      const many = broadcastLink(href);
      if (many) return <MentionChip name={many} self />;
      const handle = groupLink(href);
      const group = handle && groups.get(handle);
      if (group) return <MentionChip name={group.handle} self={group.is_member} />;
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
        <blockquote className="my-1 border-s-3 ps-3 text-muted-foreground">{children}</blockquote>
      );
    },
    ul({ children }) {
      return <ul className="my-1 list-disc ps-5">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="my-1 list-decimal ps-5">{children}</ol>;
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
      return <th className="border px-2 py-1 text-start font-semibold">{children}</th>;
    },
    td({ children }) {
      return <td className="border px-2 py-1">{children}</td>;
    },
    ...(asDocument
      ? {
          // Under the document's own title (h2): # is h3, ## is h4, the rest h5.
          h1: ({ children }) => <h3 className="mt-4 text-xl font-semibold">{children}</h3>,
          h2: ({ children }) => <h4 className="mt-3 text-lg font-semibold">{children}</h4>,
          h3: DocHeading,
          h4: DocHeading,
          h5: DocHeading,
          h6: DocHeading,
        }
      : { h1: Heading, h2: Heading, h3: Heading, h4: Heading, h5: Heading, h6: Heading }),
    hr() {
      return <hr className="my-2" />;
    },
  };
}

/** Headings in chat stay text-sized: a message is not a document. */
function Heading({ children }: { children?: ReactNode }) {
  return <p className="my-0.5 font-semibold">{children}</p>;
}

function DocHeading({ children }: { children?: ReactNode }) {
  return <h5 className="mt-2 font-semibold">{children}</h5>;
}

/**
 * A message body: Markdown (GitHub flavour) without raw HTML, sanitized,
 * links opening elsewhere, mentions as chips, code highlighted.
 */
export const MessageBody = memo(function MessageBody({
  body,
  mentions,
  selfId,
  broadcast,
  document = false,
}: {
  body: string;
  mentions: Person[];
  selfId: string;
  /** The message's mentions of many (@channel, @here), shown as chips. */
  broadcast?: string[];
  /** A document (a canvas): headings are headings. */
  document?: boolean;
}) {
  const emoji = useCustomEmoji();
  const names = useMemo(() => new Set(emoji.keys()), [emoji]);
  const groups = useMentionableGroups(useActiveWorkspace().id);
  const handles = useMemo(() => new Set(groups.keys()), [groups]);
  // Emoji on their own (an emote) are shown large.
  const jumbo = !document && onlyEmoji(body, names);
  return (
    <div
      className={cn(
        'text-[0.9375rem] leading-(--line-height-base,1.625) break-words [&_li>p]:my-0',
        jumbo && 'text-[2rem] leading-tight',
      )}
      data-jumbo={jumbo || undefined}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components(selfId, mentions, emoji, groups, document)}
      >
        {toMarkdownExtras(toMarkdownMentions(body, mentions), names, broadcast ?? [], handles)}
      </Markdown>
    </div>
  );
});
