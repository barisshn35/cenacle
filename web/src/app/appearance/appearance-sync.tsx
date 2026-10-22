// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDensity, useTheme } from '@cenacle/ui/theme';
import { useActiveWorkspace } from '../chat/active-workspace';
import { appearanceQuery, showAppearance } from './appearance';

/**
 * Keeps the page in the person's appearance: their saved settings (on every
 * device) over the active workspace's defaults. Theme and density, which the
 * page also remembers locally, follow the saved settings once they arrive.
 */
export function AppearanceSync() {
  const appearance = useQuery(appearanceQuery);
  const { workspace } = useActiveWorkspace();
  const { setTheme } = useTheme();
  const { setDensity } = useDensity();
  const synced = useRef(false);

  useEffect(() => {
    const a = appearance.data;
    if (!a) return;
    showAppearance(a, workspace?.appearance);
    if (!synced.current) {
      synced.current = true;
      setTheme(a.theme);
      setDensity(a.density);
    }
  }, [appearance.data, workspace?.appearance, setTheme, setDensity]);
  return null;
}
