// SPDX-License-Identifier: AGPL-3.0-only
// Source: shadcn/ui (style "base-nova", Base UI primitives) https://ui.shadcn.com
// Author: shadcn and contributors. License: MIT.
// Adapted for Cenacle: target size tokens, i18n labels, local imports.
import { useTheme } from '../theme/theme-provider';
import { useTranslation } from 'react-i18next';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react';

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <Sonner
      theme={resolvedTheme}
      visibleToasts={2}
      containerAriaLabel={t('ui:toast.region')}
      className="toaster group"
      // On narrow screens toasts span the width; an app can lift them above
      // its bottom controls (the chat composer) with --toast-mobile-bottom.
      mobileOffset={{ bottom: 'var(--toast-mobile-bottom, 16px)' }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
