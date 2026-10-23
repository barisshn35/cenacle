// SPDX-License-Identifier: AGPL-3.0-only
import { useAI } from '../ai/ai';
import {
  BookmarkIcon,
  CalendarIcon,
  InboxIcon,
  ListIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  GlobeIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareCheckBigIcon,
  ZapIcon,
} from 'lucide-react';
import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@cenacle/ui/components/sidebar';
import { cn } from '@cenacle/ui/lib/utils';
import { useActiveWorkspace } from '../chat/active-workspace';
import { channelsQuery } from '../chat/data';
import { unreadThreadsQuery } from './threads';

/** The views everyone uses daily stay in sight; the rest fold under "More". */
const PRIMARY = new Set(['activity', 'threads', 'saved', 'tasks']);

const LINKS = [
  { view: 'activity', icon: InboxIcon },
  { view: 'threads', icon: MessagesSquareIcon },
  { view: 'saved', icon: BookmarkIcon },
  { view: 'tasks', icon: SquareCheckBigIcon },
  { view: 'unreads', icon: ListIcon },
  { view: 'events', icon: CalendarIcon },
  { view: 'playbooks', icon: ListChecksIcon },
  { view: 'workflows', icon: ZapIcon },
  { view: 'compliance', icon: ShieldCheckIcon },
  { view: 'ask', icon: SparklesIcon },
  { view: 'federation', icon: GlobeIcon },
] as const;

/** At the top of the sidebar: views across the workspace's channels. */
export function HomeLinks() {
  const { t } = useTranslation();
  const path = useLocation({ select: (l) => l.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useActiveWorkspace();
  const ai = useAI();
  const ws = active.id;
  const threads = useQuery(unreadThreadsQuery(ws)).data;
  const [more, setMore] = useState(false);
  const unreadChannels =
    useQuery(channelsQuery).data?.filter((c) => c.workspace_id === ws && c.unread_count > 0)
      .length ?? 0;
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {LINKS.filter(({ view }) =>
            view === 'ask'
              ? ai
              : (view !== 'workflows' && view !== 'compliance' && view !== 'federation') ||
                active.admin,
          )
            // The folded views stay visible while one of them is open.
            .filter(({ view }) => PRIMARY.has(view) || more || path === `/${view}`)
            .map(({ view, icon: Icon }) => {
              const active = path === `/${view}`;
              const count = view === 'threads' ? (threads?.threads ?? 0) : 0;
              const mentions = view === 'threads' ? (threads?.mentions ?? 0) : 0;
              const dot = view === 'unreads' && unreadChannels > 0;
              return (
                <SidebarMenuItem key={view}>
                  <SidebarMenuButton
                    isActive={active}
                    className={cn(
                      (count > 0 || dot) && 'pr-8 font-semibold text-sidebar-foreground',
                    )}
                    render={
                      <Link
                        to={`/${view}`}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => isMobile && setOpenMobile(false)}
                      />
                    }
                  >
                    <Icon aria-hidden strokeWidth={1.75} />
                    <span>{t(`home.${view}`)}</span>
                    {count > 0 && (
                      <span className="sr-only">
                        {t('threads.unreadThreads', { count })}
                        {mentions > 0 && `, ${t('mentions.unread', { count: mentions })}`}
                      </span>
                    )}
                  </SidebarMenuButton>
                  {mentions > 0 ? (
                    <SidebarMenuBadge
                      aria-hidden
                      className="rounded-full bg-mention text-mention-foreground peer-data-active/menu-button:text-mention-foreground peer-hover/menu-button:text-mention-foreground"
                    >
                      {mentions > 99 ? '99+' : mentions}
                    </SidebarMenuBadge>
                  ) : count > 0 || dot ? (
                    <SidebarMenuBadge aria-hidden>
                      <span className="size-2 rounded-full bg-sidebar-foreground" />
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          <SidebarMenuItem>
            <SidebarMenuButton aria-expanded={more} onClick={() => setMore(!more)}>
              <ChevronRightIcon
                aria-hidden
                strokeWidth={1.75}
                className={cn(
                  'transition-transform duration-(--duration-base) ease-(--ease-out)',
                  more && 'rotate-90',
                )}
              />
              <span>{t('home.moreViews')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
