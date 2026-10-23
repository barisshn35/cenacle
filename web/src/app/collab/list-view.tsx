// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ColumnsIcon,
  KanbanSquareIcon,
  MoreHorizontalIcon,
  MoveRightIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { useActiveWorkspace } from '../chat/active-workspace';
import { workspaceMembersQuery } from '../chat/workspaces';
import { fieldId } from '../automation/automation';
import {
  applyItem,
  createItem,
  deleteItem,
  listQuery,
  STATUSES,
  updateItem,
  updateList,
  type ItemList,
  type ListColumn,
  type ListItem,
} from './collab';

const control =
  'min-h-target w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm outline-none hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:hover:border-transparent';

function useNames() {
  const ws = useActiveWorkspace().id;
  const members = useQuery({ ...workspaceMembersQuery(ws ?? ''), enabled: !!ws }).data ?? [];
  const people = members.filter((m) => !m.user.is_bot).map((m) => m.user);
  return { people, name: (id: string) => people.find((p) => p.id === id)?.display_name ?? '' };
}

/** A list: rows with typed columns, as a table or as a board. */
export function ListView({ listId }: { listId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const query = useQuery(listQuery(listId));
  const list = query.data;
  const [chosen, setView] = useState<'table' | 'board' | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  // A list with a board opens as the board.
  const view = chosen ?? (list?.board_column ? 'board' : 'table');

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (!list) {
    return (
      <div className="p-6">
        <InlineError
          title={t('collab.list.loadFailed')}
          problem={query.error instanceof ApiError ? query.error.problem : { status: 500 }}
        />
      </div>
    );
  }
  const board = list.board_column ? list.columns.find((c) => c.id === list.board_column) : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="list"
    >
      <header className="flex flex-wrap items-center gap-2 px-6 pt-5 pb-3">
        <h2 id={`${id}-title`} className="font-display mr-auto text-2xl font-medium">
          {list.title}
        </h2>
        {board && (
          <div role="group" aria-label={t('collab.list.view')} className="flex gap-1">
            <Button
              variant="ghost"
              className="aria-pressed:bg-accent aria-pressed:text-foreground"
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
            >
              <TableIcon strokeWidth={1.75} />
              {t('collab.list.table')}
            </Button>
            <Button
              variant="ghost"
              className="aria-pressed:bg-accent aria-pressed:text-foreground"
              aria-pressed={view === 'board'}
              onClick={() => setView('board')}
            >
              <KanbanSquareIcon strokeWidth={1.75} />
              {t('collab.list.board')}
            </Button>
          </div>
        )}
        {list.can_edit && (
          <Button variant="outline" onClick={() => setColumnsOpen(true)}>
            <ColumnsIcon strokeWidth={1.75} />
            {t('collab.list.columns')}
          </Button>
        )}
      </header>
      {board && view === 'board' ? <Board list={list} column={board} /> : <Table list={list} />}
      {columnsOpen && <ColumnsDialog list={list} onClose={() => setColumnsOpen(false)} />}
    </section>
  );
}

// --- changing rows ---------------------------------------------------------------

function useRowActions(list: ItemList) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reload = () => queryClient.invalidateQueries({ queryKey: ['list', list.id] });
  const failed = (err: unknown) =>
    toast.error((err instanceof ApiError && err.problem.detail) || t('collab.list.changeFailed'));
  return {
    change: (item: ListItem, change: Parameters<typeof updateItem>[1]) =>
      updateItem(item.id, change)
        .then((updated) => {
          applyItem(queryClient, updated);
          if (change.before || change.to_end) void reload();
        })
        .catch(failed),
    add: (title: string, values: Record<string, string> = {}) =>
      createItem(list.id, title, values).then(reload).catch(failed),
    remove: (item: ListItem) =>
      deleteItem(item.id)
        .then(() => {
          void reload();
          showUndoToast({
            message: t('collab.list.deleted', { title: item.title }),
            onUndo: () => void createItem(list.id, item.title, item.values).then(reload),
          });
        })
        .catch(failed),
  };
}

function RowMenu({
  list,
  item,
  index,
  moveTo,
}: {
  list: ItemList;
  item: ListItem;
  index: number;
  /** Lanes of the board to move the card to (instead of dragging). */
  moveTo?: { label: string; onSelect: () => void }[];
}) {
  const { t } = useTranslation();
  const { change, remove } = useRowActions(list);
  const items = list.items;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('collab.list.rowOptions', { title: item.title })}
          />
        }
      >
        <MoreHorizontalIcon strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {moveTo?.map((m) => (
          <DropdownMenuItem key={m.label} onClick={m.onSelect}>
            <MoveRightIcon strokeWidth={1.75} />
            {t('collab.list.moveTo', { lane: m.label })}
          </DropdownMenuItem>
        ))}
        {!moveTo && index > 0 && (
          <DropdownMenuItem onClick={() => void change(item, { before: items[index - 1]!.id })}>
            <ArrowUpIcon strokeWidth={1.75} />
            {t('collab.list.moveUp')}
          </DropdownMenuItem>
        )}
        {!moveTo && index < items.length - 1 && (
          <DropdownMenuItem
            onClick={() =>
              void change(
                item,
                index < items.length - 2 ? { before: items[index + 2]!.id } : { to_end: true },
              )
            }
          >
            <ArrowDownIcon strokeWidth={1.75} />
            {t('collab.list.moveDown')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void remove(item)}>
          <Trash2Icon strokeWidth={1.75} />
          {t('collab.list.deleteRow')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A text field that saves when it loses focus (or on Enter). */
function CommitInput({
  value,
  onCommit,
  ...props
}: Omit<React.ComponentProps<'input'>, 'value' | 'onChange'> & {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // Someone else changed it.
    setShown(value);
    setText(value);
  }
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };
  return (
    <input
      {...props}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}

function Cell({
  column,
  item,
  label,
  disabled,
  onChange,
}: {
  column: ListColumn;
  item: ListItem;
  label: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const { people } = useNames();
  const value = item.values[column.id] ?? '';
  const common = { 'aria-label': label, disabled, className: control };
  switch (column.kind) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={label}
          disabled={disabled}
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : '')}
          className="size-4 accent-primary"
        />
      );
    case 'status':
    case 'select':
    case 'person': {
      const options: [string, string][] =
        column.kind === 'status'
          ? STATUSES.map((s) => [s, t(`collab.status.${s}`)])
          : column.kind === 'person'
            ? people.map((p) => [p.id, p.display_name])
            : (column.options ?? []).map((o) => [o, o]);
      return (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      );
    }
    case 'date':
      return (
        <input {...common} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      );
    case 'number':
      return <CommitInput {...common} inputMode="decimal" value={value} onCommit={onChange} />;
    default:
      return <CommitInput {...common} value={value} maxLength={2000} onCommit={onChange} />;
  }
}

function AddRow({ onAdd, label }: { onAdd: (title: string) => Promise<unknown>; label: string }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const text = title.trim();
        if (!text) return;
        setTitle('');
        void onAdd(text);
      }}
    >
      <Input
        aria-label={label}
        placeholder={label}
        value={title}
        maxLength={500}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button type="submit" variant="outline" disabled={!title.trim()}>
        <PlusIcon strokeWidth={1.75} />
        {t('collab.list.add')}
      </Button>
    </form>
  );
}

// --- table -------------------------------------------------------------------------

function Table({ list }: { list: ItemList }) {
  const { t } = useTranslation();
  const { change, add } = useRowActions(list);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="sticky top-0 border-b bg-background px-2 py-2 font-medium">
              {t('collab.list.title')}
            </th>
            {list.columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                className="sticky top-0 border-b bg-background px-2 py-2 font-medium"
              >
                {c.name}
              </th>
            ))}
            <th scope="col" className="sticky top-0 w-10 border-b bg-background">
              <span className="sr-only">{t('collab.list.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((item, i) => (
            <tr key={item.id} className="align-middle" data-testid="list-row">
              <th scope="row" className="min-w-48 border-b px-1 py-0.5 text-left font-normal">
                <CommitInput
                  aria-label={t('collab.list.title')}
                  value={item.title}
                  maxLength={500}
                  disabled={!list.can_edit}
                  className={`${control} font-medium`}
                  onCommit={(title) => title && void change(item, { title })}
                />
              </th>
              {list.columns.map((c) => (
                <td key={c.id} className="min-w-36 border-b px-1 py-0.5">
                  <Cell
                    column={c}
                    item={item}
                    label={`${c.name}, ${item.title}`}
                    disabled={!list.can_edit}
                    onChange={(v) => void change(item, { values: { [c.id]: v } })}
                  />
                </td>
              ))}
              <td className="border-b px-1">
                {list.can_edit && <RowMenu list={list} item={item} index={i} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.items.length === 0 && (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          {t('collab.list.empty')}
        </p>
      )}
      {list.can_edit && (
        <div className="mt-3 max-w-md">
          <AddRow label={t('collab.list.addRow')} onAdd={(title) => add(title)} />
        </div>
      )}
    </div>
  );
}

// --- board -------------------------------------------------------------------------

function Board({ list, column }: { list: ItemList; column: ListColumn }) {
  const { t } = useTranslation();
  const { change, add } = useRowActions(list);
  const { name } = useNames();
  const [over, setOver] = useState<string | null>(null);
  const lanes: { value: string; label: string }[] = [
    ...(column.kind === 'status'
      ? STATUSES.map((s) => ({ value: s as string, label: t(`collab.status.${s}`) }))
      : (column.options ?? []).map((o) => ({ value: o, label: o }))),
    { value: '', label: t('collab.list.noValue') },
  ];
  const known = new Set(lanes.map((l) => l.value));
  const laneOf = (item: ListItem) => {
    const v = item.values[column.id] ?? '';
    return known.has(v) ? v : '';
  };
  const moveTo = (item: ListItem, lane: string) =>
    change(item, { values: { [column.id]: lane }, to_end: true });
  const drop = (lane: string) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const item = list.items.find((i) => i.id === e.dataTransfer.getData('text/x-cenacle-row'));
    if (item && laneOf(item) !== lane) void moveTo(item, lane);
  };
  const people = list.columns.filter((c) => c.kind === 'person');
  const dates = list.columns.filter((c) => c.kind === 'date');

  return (
    <div className="flex min-h-0 flex-1 items-start gap-3 overflow-auto px-6 pb-6">
      {lanes.map((lane) => {
        const cards = list.items.filter((i) => laneOf(i) === lane.value);
        if (lane.value === '' && cards.length === 0) return null;
        return (
          <section
            key={lane.value || '-'}
            aria-label={lane.label}
            data-testid="lane"
            onDragOver={(e) => {
              if (!list.can_edit) return;
              e.preventDefault();
              setOver(lane.value);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={drop(lane.value)}
            className={`flex w-72 shrink-0 flex-col gap-2 rounded-[10px] border bg-muted/40 p-2 ${over === lane.value ? 'ring-2 ring-ring/50' : ''}`}
          >
            <h3 className="flex items-center justify-between px-1 text-sm font-medium">
              {lane.label}
              <span className="text-xs text-muted-foreground">{cards.length}</span>
            </h3>
            <ul className="flex flex-col gap-2">
              {cards.map((item) => (
                <li
                  key={item.id}
                  draggable={list.can_edit}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/x-cenacle-row', item.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  data-testid="card"
                  className="flex items-start gap-1 rounded-lg border bg-card p-2 text-sm shadow-xs"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1 px-1 py-0.5">
                    <span className="font-medium break-words">{item.title}</span>
                    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      {people.map(
                        (c) =>
                          item.values[c.id] && (
                            <span key={c.id}>
                              <span className="sr-only">{c.name}: </span>
                              {name(item.values[c.id]!)}
                            </span>
                          ),
                      )}
                      {dates.map(
                        (c) =>
                          item.values[c.id] && (
                            <span key={c.id}>
                              <span className="sr-only">{c.name}: </span>
                              <time dateTime={item.values[c.id]}>
                                {new Date(`${item.values[c.id]}T00:00`).toLocaleDateString()}
                              </time>
                            </span>
                          ),
                      )}
                    </span>
                  </div>
                  {list.can_edit && (
                    <RowMenu
                      list={list}
                      item={item}
                      index={0}
                      moveTo={lanes
                        .filter((l) => l.value !== lane.value)
                        .map((l) => ({
                          label: l.label,
                          onSelect: () => void moveTo(item, l.value),
                        }))}
                    />
                  )}
                </li>
              ))}
            </ul>
            {list.can_edit && (
              <AddRow
                label={t('collab.list.addCard', { lane: lane.label })}
                onAdd={(title) => add(title, lane.value ? { [column.id]: lane.value } : {})}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

// --- columns -----------------------------------------------------------------------

const KINDS: ListColumn['kind'][] = [
  'text',
  'number',
  'select',
  'status',
  'person',
  'date',
  'checkbox',
];

function ColumnsDialog({ list, onClose }: { list: ItemList; onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [columns, setColumns] = useState<(ListColumn & { optionsText?: string })[]>(() =>
    list.columns.map((c) => ({ ...c, optionsText: (c.options ?? []).join('\n') })),
  );
  const [board, setBoard] = useState(list.board_column ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, change: Partial<ListColumn & { optionsText: string }>) =>
    setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...change } : c)));
  const groupable = columns.filter((c) => c.kind === 'status' || c.kind === 'select');

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            const out: ListColumn[] = columns.map(({ optionsText, ...c }) => ({
              ...c,
              name: c.name.trim(),
              ...(c.kind === 'select'
                ? {
                    options: (optionsText ?? '')
                      .split('\n')
                      .map((o) => o.trim())
                      .filter(Boolean),
                  }
                : { options: undefined }),
            }));
            updateList(list.id, {
              columns: out,
              board_column: groupable.some((c) => c.id === board) ? board : null,
            })
              .then((l) => {
                queryClient.setQueryData(listQuery(list.id).queryKey, l);
                onClose();
              })
              .catch((err: unknown) => setError(err))
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('collab.list.columnsTitle')}</DialogTitle>
            <DialogDescription>{t('collab.list.columnsHint')}</DialogDescription>
          </DialogHeader>
          <ol className="flex flex-col gap-3">
            {columns.map((c, i) => (
              <li key={c.id} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor={`${id}-${c.id}-name`}>{t('collab.list.columnName')}</Label>
                    <Input
                      id={`${id}-${c.id}-name`}
                      value={c.name}
                      required
                      maxLength={80}
                      onChange={(e) => set(i, { name: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-${c.id}-kind`}>{t('collab.list.columnKind')}</Label>
                    <select
                      id={`${id}-${c.id}-kind`}
                      value={c.kind}
                      onChange={(e) => set(i, { kind: e.target.value as ListColumn['kind'] })}
                      className="min-h-target rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`collab.kind.${k}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('collab.list.removeColumn', { name: c.name })}
                    onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))}
                  >
                    <XIcon strokeWidth={1.75} />
                  </Button>
                </div>
                {c.kind === 'select' && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-${c.id}-options`}>{t('collab.list.options')}</Label>
                    <textarea
                      id={`${id}-${c.id}-options`}
                      rows={3}
                      value={c.optionsText ?? ''}
                      onChange={(e) => set(i, { optionsText: e.target.value })}
                      className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={columns.length >= 20}
              onClick={() => {
                const name = t('collab.list.newColumn');
                setColumns((cs) => [
                  ...cs,
                  {
                    id: fieldId(
                      name,
                      cs.map((c) => c.id),
                    ),
                    name,
                    kind: 'text',
                  },
                ]);
              }}
            >
              <PlusIcon strokeWidth={1.75} />
              {t('collab.list.addColumn')}
            </Button>
          </div>
          {groupable.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-board`}>{t('collab.list.boardBy')}</Label>
              <select
                id={`${id}-board`}
                value={board}
                onChange={(e) => setBoard(e.target.value)}
                className="min-h-target rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="">{t('collab.list.noBoard')}</option>
                {groupable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error !== null && (
            <InlineError
              title={t('collab.list.columnsFailed')}
              problem={error instanceof ApiError ? error.problem : { status: 500 }}
              reason={error instanceof ApiError ? error.problem.detail : undefined}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('collab.cancel')}
            </Button>
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {t('collab.list.saveColumns')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
