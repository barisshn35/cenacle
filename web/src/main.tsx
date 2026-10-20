// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyStoredAppearance } from '@cenacle/ui/theme';
import { initI18n } from './i18n';
import { App } from './app/app';
import './styles.css';

// Apply theme and density before the first paint to avoid a flash.
applyStoredAppearance();

void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
