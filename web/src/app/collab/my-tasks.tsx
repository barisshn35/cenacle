// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarIcon, TableIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useActiveWorkspace } from '../chat/active-workspace';
import { myTasksQuery } from '../automation/automation';
import { TaskCard } from '../automation/cards';
import { assignedQuery } from './collab';

/** What waits for the person: approvals and forms of workflows, then list rows assigned to them. */
export function MyTasks() {
  const { t, i18n } = useTranslation();
  const ws = useActiveWorkspace().id;
  const tasks = useQuery(myTasksQuery(ws));
  const assigned = useQuery(assignedQuery(ws));
  if (tasks.isPending || assigned.isPending) {
    return (
      <>
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </>
    );
  }
  const waiting = tasks.data ?? [];
  const rows = assigned.data ?? [];
  if (waiting.length === 0 && rows.length === 0) {
    return (
      <p role="status" className="py-8 text-center text-sm text-muted-foreground">
        {t('collab.tasks.none')}
      </p>
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  return (
    <>
      {waiting.length > 0 && (
        <section aria-labelledby="tasks-waiting" className="flex flex-col gap-2">
          <h2 id="tasks-waiting" className="text-sm font-semibold">
            {t('collab.tasks.waiting')}
          </h2>
          <ul className="flex flex-col gap-2">
            {waiting.map((task) => (
              <li key={task.id}>
                <TaskCard task={task} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows.length > 0 && (
        <section aria-labelledby="tasks-assigned" className="mt-4 flex flex-col gap-2">
          <h2 id="tasks-assigned" className="text-sm font-semibold">
            {t('collab.tasks.assigned')}
          </h2>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const late = row.due !== undefined && row.due < today;
              return (
                <li key={row.item.id}>
                  <Link
                    to="/c/$channelId"
                    params={{ channelId: row.channel_id }}
                    search={{ tab: row.tab_id }}
                    data-testid="assigned-item"
                    className="flex w-full flex-col gap-1 rounded-xl border bg-card px-4 py-3 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="font-medium break-words">{row.item.title}</span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <TableIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                        {row.list_title}
                      </span>
                      {row.channel_name && <span>#{row.channel_name}</span>}
                      {row.due && (
                        <span
                          className={`flex items-center gap-1 ${late ? 'font-medium text-destructive' : ''}`}
                        >
                          <CalendarIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                          {late
                            ? t('collab.tasks.overdue', {
                                date: date.format(new Date(`${row.due}T00:00`)),
                              })
                            : t('collab.tasks.due', {
                                date: date.format(new Date(`${row.due}T00:00`)),
                              })}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
