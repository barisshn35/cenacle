// SPDX-License-Identifier: AGPL-3.0-only
import { Outlet, useRouterState } from '@tanstack/react-router';
import { DensityProvider, ThemeProvider } from '@cenacle/ui/theme';
import { TooltipProvider } from '@cenacle/ui/components/tooltip';
import { Toaster } from '@cenacle/ui/components/sonner';
import type { GallerySearch } from './router';

function forcedAppearance(pathname: string, search: GallerySearch): GallerySearch {
  // The dev gallery renders a fixed variant from ?theme=&density= so that
  // tests and reviewers can open every combination by URL.
  if (!import.meta.env.DEV || !pathname.startsWith('/dev/gallery')) return {};
  return search;
}

export function RootLayout() {
  const location = useRouterState({ select: (s) => s.location });
  const forced = forcedAppearance(location.pathname, location.search as GallerySearch);
  return (
    <ThemeProvider forcedTheme={forced.theme}>
      <DensityProvider forcedDensity={forced.density}>
        <TooltipProvider delay={400}>
          <Outlet />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </DensityProvider>
    </ThemeProvider>
  );
}
