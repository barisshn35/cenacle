// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  reloadWorkspaces,
  setWorkspacePermissions,
  type Permission,
  type Workspace,
} from './workspaces';

const ROLES = ['admin', 'member', 'guest'] as const;

/**
 * The workspace's permission scheme: which roles may do what. Owners always
 * may; each change applies at once.
 */
export function PermissionsSetting({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Shown as ticked at once; a failed change goes back to the saved scheme.
  const [current, setCurrent] = useState<Record<string, string[]>>(workspace.permissions ?? {});
  const set = useMutation({
    mutationFn: (next: Record<string, string[]>) => setWorkspacePermissions(workspace.id, next),
    onSuccess: () => reloadWorkspaces(queryClient),
    onError: () => {
      setCurrent(workspace.permissions ?? {});
      toast.error(t('channels.changeFailed'));
    },
  });
  const toggle = (permission: Permission, role: string, on: boolean) => {
    const roles = current[permission] ?? [];
    const next = {
      ...current,
      [permission]: on ? [...roles, role] : roles.filter((r) => r !== role),
    };
    setCurrent(next);
    set.mutate(next);
  };
  return (
    <section aria-labelledby="permissions-title" className="grid gap-3">
      <div className="grid gap-1">
        <h3 id="permissions-title" className="text-sm font-semibold">
          {t('permissions.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('permissions.hint')}</p>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="permissions-table">
          <thead>
            <tr className="border-b bg-muted/40 text-start text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">
                {t('permissions.permission')}
              </th>
              {ROLES.map((role) => (
                <th key={role} scope="col" className="w-20 px-2 py-2 text-center font-medium">
                  {t(`workspaces.roles.${role}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((permission) => (
              <tr key={permission} className="border-b last:border-b-0">
                <th scope="row" className="px-3 py-2 text-start font-normal">
                  <span className="block font-medium">{t(`permissions.names.${permission}`)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`permissions.hints.${permission}`)}
                  </span>
                </th>
                {ROLES.map((role) => {
                  const on = (current[permission] ?? []).includes(role);
                  return (
                    <td key={role} className="px-2 py-1 text-center">
                      <label className="inline-flex min-h-target min-w-target cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          className="hit-target size-4"
                          checked={on}
                          aria-label={t('permissions.toggle', {
                            role: t(`workspaces.roles.${role}`),
                            permission: t(`permissions.names.${permission}`),
                          })}
                          onChange={(e) => toggle(permission, role, e.target.checked)}
                        />
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t('permissions.owners')}</p>
    </section>
  );
}
