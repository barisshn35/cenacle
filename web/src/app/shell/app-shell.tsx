// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from '@cenacle/ui/components/resizable';
import { SidebarProvider } from '@cenacle/ui/components/sidebar';
import { Sheet, SheetContent, SheetTitle } from '@cenacle/ui/components/sheet';
import { useLayout } from '../../stores/layout';
import { useRememberWorkspace } from '../chat/active-workspace';
import { MessageEnvProvider } from '../richer/message-env-provider';
import { ChannelSidebar } from './channel-sidebar';
import { ChannelView } from './channel-view';
import { DetailsPanel } from './details-panel';
import { SearchPanel } from '../search/search-panel';
import { ThreadPanel } from '../threads/thread-panel';
import { OnboardingDialog } from '../community/onboarding';
import { CallHost } from '../calls/call-host';
import { HomeViewPage, type HomeView } from '../threads/views';
import { useLocation } from '@tanstack/react-router';
import type { RightView } from '../../stores/layout';

/** The view across channels at the path, if it is one (threads, inbox, saved, …). */
function useHomeView() {
  const path = useLocation({ select: (l) => l.pathname });
  return /^\/(threads|activity|saved|unreads|tasks|events|playbooks|workflows|compliance|ask|federation)$/.exec(
    path,
  )?.[1] as HomeView | undefined;
}

/** A channel, or a view across channels (threads, activity, saved, unreads). */
function MainView({ mobile = false }: { mobile?: boolean }) {
  const view = useHomeView();
  return view ? <HomeViewPage view={view} mobile={mobile} /> : <ChannelView mobile={mobile} />;
}

function RightPanel({ view }: { view: RightView }) {
  if (view === 'search') return <SearchPanel />;
  if (view === 'thread') return <ThreadPanel />;
  return <DetailsPanel />;
}
import { WorkspaceRail } from './workspace-rail';
import { useTranslation } from 'react-i18next';

/**
 * Application shell (placeholder data, no backend yet):
 * workspace rail | channel sidebar | messages | details.
 * Panels resize by dragging, by keyboard on the handles (arrow keys) and the
 * details panel also opens/closes with a button (WCAG 2.5.7).
 */
export function AppShell() {
  const isMobile = useIsMobile();
  useRememberWorkspace();
  return (
    <MessageEnvProvider>
      <SidebarProvider className="h-full min-h-0 overflow-hidden">
        <SkipLink />
        {isMobile ? <MobileShell /> : <DesktopShell />}
        <OnboardingDialog />
        <CallHost />
      </SidebarProvider>
    </MessageEnvProvider>
  );
}

/** The first stop of the keyboard: past the navigation to the message box (WCAG 2.4.1). */
function SkipLink() {
  const { t } = useTranslation();
  return (
    <a
      href="#main-content"
      className="fixed top-2 left-2 z-50 flex min-h-11 -translate-y-24 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground focus:translate-y-0"
      onClick={(e) => {
        e.preventDefault();
        const main = document.getElementById('main-content');
        const box = main?.querySelector<HTMLElement>('[role="textbox"], textarea');
        (box ?? main)?.focus();
      }}
    >
      {t('shell.skipToMain')}
    </a>
  );
}

function DesktopShell() {
  const panelOpen = useLayout((s) => s.detailsOpen);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const rightView = useLayout((s) => s.rightView);
  const detailsRef = usePanelRef();
  // Views across channels have no channel details; search and threads still open.
  const view = useHomeView();
  const detailsOpen = panelOpen && !(view && rightView === 'details');

  // Keep the panel in sync with the toggle button.
  useEffect(() => {
    const panel = detailsRef.current;
    if (!panel) return;
    if (detailsOpen && panel.isCollapsed()) panel.expand();
    if (!detailsOpen && !panel.isCollapsed()) panel.collapse();
  }, [detailsOpen, detailsRef]);

  return (
    <div className="flex h-full w-full">
      <WorkspaceRail />
      <ResizablePanelGroup orientation="horizontal" id="cenacle-shell">
        <ResizablePanel id="sidebar" defaultSize={264} minSize={200} maxSize={420}>
          <ChannelSidebar />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="main" minSize={360}>
          <MainView />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="details"
          panelRef={detailsRef}
          defaultSize={300}
          minSize={240}
          maxSize={480}
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            const open = size.inPixels > 0;
            // Collapsed for a view, the panel keeps the person's choice for channels.
            if (!open && view && rightView === 'details') return;
            if (open !== useLayout.getState().detailsOpen) setDetailsOpen(open);
          }}
        >
          {/* Collapsed content is not rendered, so it leaves the tab order and the a11y tree. */}
          {detailsOpen && (
            // Each view comes in from the side (its width is not animated: that lays out every frame).
            <div
              key={rightView}
              className="h-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-end-2 motion-safe:duration-(--duration-base) motion-safe:ease-(--ease-out)"
            >
              <RightPanel view={rightView} />
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function MobileShell() {
  const { t } = useTranslation();
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const rightView = useLayout((s) => s.rightView);
  return (
    <>
      <ChannelSidebar mobile />
      <div className="flex h-full w-full">
        <MainView mobile />
      </div>
      {/* On small screens the details panel is a full-height sheet. */}
      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-sm"
        >
          <SheetTitle className="sr-only">
            {rightView === 'search'
              ? t('search.title')
              : rightView === 'thread'
                ? t('threads.title')
                : t('shell.details')}
          </SheetTitle>
          <RightPanel view={rightView} />
        </SheetContent>
      </Sheet>
    </>
  );
}
