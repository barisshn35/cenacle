// SPDX-License-Identifier: Apache-2.0
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
} from '@tanstack/react-router';
import type { ResolvedDensity, ResolvedTheme } from '@cenacle/ui/theme';
import { RootLayout } from './root';
import { AppShell } from './shell/app-shell';
import { NotFound } from './not-found';

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AppShell,
});

export interface GallerySearch {
  theme?: ResolvedTheme;
  density?: ResolvedDensity;
}

// The component gallery exists only in development. In production builds
// import.meta.env.DEV is false, so the lazy import below is removed by the
// bundler and the route answers "not found".
const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev/gallery',
  validateSearch: (s: Record<string, unknown>): GallerySearch => ({
    theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : undefined,
    density: s.density === 'compact' || s.density === 'comfortable' ? s.density : undefined,
  }),
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: import.meta.env.DEV
    ? lazyRouteComponent(() => import('../dev/gallery'), 'Gallery')
    : NotFound,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, galleryRoute]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
