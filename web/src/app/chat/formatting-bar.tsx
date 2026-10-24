// SPDX-License-Identifier: AGPL-3.0-only
import {
  BoldIcon,
  CodeIcon,
  EyeIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { codeBlock, linkSelection, prefixLines, wrapSelection } from './composer-keys';

type Edit = (
  value: string,
  start: number,
  end: number,
) => {
  value: string;
  start: number;
  end: number;
};

const FORMATS: { key: string; icon: LucideIcon; keys?: string; edit: Edit }[] = [
  { key: 'bold', icon: BoldIcon, keys: 'Ctrl B', edit: (v, s, e) => wrapSelection(v, s, e, '**') },
  {
    key: 'italic',
    icon: ItalicIcon,
    keys: 'Ctrl I',
    edit: (v, s, e) => wrapSelection(v, s, e, '_'),
  },
  {
    key: 'strike',
    icon: StrikethroughIcon,
    keys: 'Ctrl Shift X',
    edit: (v, s, e) => wrapSelection(v, s, e, '~~'),
  },
  { key: 'code', icon: CodeIcon, keys: 'Ctrl E', edit: (v, s, e) => wrapSelection(v, s, e, '`') },
  { key: 'link', icon: LinkIcon, edit: linkSelection },
  { key: 'quote', icon: QuoteIcon, edit: (v, s, e) => prefixLines(v, s, e, '> ') },
  { key: 'bullets', icon: ListIcon, edit: (v, s, e) => prefixLines(v, s, e, '- ') },
  { key: 'numbers', icon: ListOrderedIcon, edit: (v, s, e) => prefixLines(v, s, e, '1. ') },
  { key: 'codeBlock', icon: SquareCodeIcon, edit: codeBlock },
];

/**
 * Formatting above the message box (v0.32): buttons that write the Markdown
 * for the selection, and a preview of the message as it will look.
 */
export function FormattingBar({
  input,
  value,
  onChange,
  preview,
  onPreview,
}: {
  input: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  preview: boolean;
  onPreview: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const apply = (edit: Edit) => {
    const el = input.current;
    if (!el) return;
    const next = edit(value, el.selectionStart, el.selectionEnd);
    onChange(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  };
  return (
    <div
      role="toolbar"
      aria-label={t('formatting.label')}
      className="-ml-2 flex flex-wrap items-center gap-0.5 border-b pb-1"
    >
      {FORMATS.map(({ key, icon: Icon, keys, edit }) => (
        <Tooltip key={key}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t(`formatting.${key}`)}
                disabled={preview}
                onClick={() => apply(edit)}
              />
            }
          >
            <Icon strokeWidth={1.75} />
          </TooltipTrigger>
          <TooltipContent side="top">
            {t(`formatting.${key}`)}
            {keys && <span className="ml-2 text-muted-foreground">{keys}</span>}
          </TooltipContent>
        </Tooltip>
      ))}
      <Button
        type="button"
        size="sm"
        variant={preview ? 'secondary' : 'ghost'}
        aria-pressed={preview}
        className="ml-auto"
        onClick={() => onPreview(!preview)}
      >
        <EyeIcon aria-hidden strokeWidth={1.75} />
        {t('formatting.preview')}
      </Button>
    </div>
  );
}
