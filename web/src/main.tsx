// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyStoredAppearance } from '@cenacle/ui/theme';
import { initI18n, loadUITexts } from './i18n';
import { App } from './app/app';
import { applyCachedAppearance } from './app/appearance/appearance';
import './styles.css';

// Apply theme and density before the first paint to avoid a flash.
applyStoredAppearance();
applyCachedAppearance();

void initI18n().then(() => {
  void loadUITexts();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
