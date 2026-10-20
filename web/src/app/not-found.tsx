// SPDX-License-Identifier: Apache-2.0
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState } from '@cenacle/ui/components/error-state';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-full items-center justify-center">
      <ErrorState
        politeness="status"
        problem={{ status: 404, code: 'not_found' }}
        actions={
          <Button nativeButton={false} render={<Link to="/" />}>
            {t('notFound.home')}
          </Button>
        }
      />
    </main>
  );
}
