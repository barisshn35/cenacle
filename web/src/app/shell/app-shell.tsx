// SPDX-License-Identifier: Apache-2.0
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
import { ChannelSidebar } from './channel-sidebar';
import { ChannelView } from './channel-view';
import { DetailsPanel } from './details-panel';
import { SearchPanel } from '../search/search-panel';
import { ThreadPanel } from '../threads/thread-panel';
import { HomeViewPage, type HomeView } from '../threads/views';
import { useLocation } from '@tanstack/react-router';
import type { RightView } from '../../stores/layout';

/** A channel, or a view across channels (threads, activity, saved, unreads). */
function MainView({ mobile = false }: { mobile?: boolean }) {
  const path = useLocation({ select: (l) => l.pathname });
  const view = /^\/(threads|activity|saved|unreads)$/.exec(path)?.[1] as HomeView | undefined;
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
    <SidebarProvider className="h-svh min-h-0 overflow-hidden">
      {isMobile ? <MobileShell /> : <DesktopShell />}
    </SidebarProvider>
  );
}

function DesktopShell() {
  const detailsOpen = useLayout((s) => s.detailsOpen);
  const setDetailsOpen = useLayout((s) => s.setDetailsOpen);
  const rightView = useLayout((s) => s.rightView);
  const detailsRef = usePanelRef();

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
            if (open !== useLayout.getState().detailsOpen) setDetailsOpen(open);
          }}
        >
          {/* Collapsed content is not rendered, so it leaves the tab order and the a11y tree. */}
          {detailsOpen && <RightPanel view={rightView} />}
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
        <SheetContent side="right" showCloseButton={false} className="w-full p-0 sm:max-w-sm">
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
