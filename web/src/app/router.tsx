// SPDX-License-Identifier: Apache-2.0
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
} from '@tanstack/react-router';
import { isUnauthenticated } from '@cenacle/core/api';
import type { ResolvedDensity, ResolvedTheme } from '@cenacle/ui/theme';
import { RootLayout } from './root';
import { AppShell } from './shell/app-shell';
import { NotFound } from './not-found';
import { RequireSession } from './auth/require-session';
import { SigninPage } from './auth/signin';
import { sessionQuery, signinSearchFor, validateSigninSearch } from './auth/session';
import { queryClient } from './query-client';

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

// Everything below this pathless layout needs a session. Without one the
// router goes to /signin before rendering; other failures (server down) are
// shown by RequireSession with a retry.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ location }) => {
    try {
      await queryClient.ensureQueryData(sessionQuery);
    } catch (err) {
      if (isUnauthenticated(err)) {
        throw redirect({ to: '/signin', search: signinSearchFor(location.href), replace: true });
      }
    }
  },
  component: RequireSession,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: AppShell,
});

const signinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  validateSearch: validateSigninSearch,
  component: SigninPage,
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
  routeTree: rootRoute.addChildren([appRoute.addChildren([indexRoute]), signinRoute, galleryRoute]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
