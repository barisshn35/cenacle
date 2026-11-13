// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, expectTargetSizes, mockApi } from './helpers';

test('the system console shows the installation and sets the notification policy', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  await page.route('**/api/admin/overview', (route) =>
    route.fulfill({
      json: {
        version: '0.34.0',
        desktop_apps: [{ version: '0.99.6', platform: 'windows', devices: 3 }],
        counts: {
          users: 120,
          active_users: 88,
          bots: 3,
          workspaces: 2,
          channels: 40,
          messages: 12345,
          files: 10,
          file_bytes: 5_000_000,
        },
        config: [
          { name: 'public_url', value: 'https://chat.example.com' },
          { name: 'oidc_client_secret', value: 'set' },
        ],
        jobs: [
          {
            kind: 'push_notifications',
            available: 0,
            running: 1,
            retryable: 0,
            discarded: 0,
            completed: 900,
          },
        ],
        failures: [],
      },
    }),
  );
  let signedOut = '';
  await page.route(/\/api\/admin\/users(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: '01a15e50-aaaa-7000-8000-000000000011',
            display_name: 'Ayşe Yılmaz',
            email: 'ayse@example.com',
            username: 'ayse',
            is_admin: false,
            guest: false,
            deactivated: false,
            last_seen_at: '2026-10-24T09:00:00Z',
            created_at: '2026-10-01T09:00:00Z',
            workspaces: 2,
            sessions: 3,
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/admin\/users\/[0-9a-f-]{36}\/sessions$/, (route) => {
    signedOut = route.request().url();
    return route.fulfill({ status: 204 });
  });
  let policy = { push_contents: 'full', email_contents: 'full' };
  await page.route('**/api/admin/notification-policy', (route) => {
    if (route.request().method() === 'PUT')
      policy = route.request().postDataJSON() as typeof policy;
    return route.fulfill({ json: policy });
  });
  let sounds = { sounds: { mention: 'chime', direct: 'pop', message: 'drop' }, volume: 70 };
  let applied = false;
  await page.route('**/api/admin/sound-defaults', (route) => {
    if (route.request().method() === 'PUT')
      sounds = route.request().postDataJSON() as typeof sounds;
    return route.fulfill({ json: sounds });
  });
  await page.route('**/api/admin/sound-defaults/apply', (route) => {
    applied = true;
    return route.fulfill({ json: { changed: 12 } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await expect(console.getByText('12,345')).toBeVisible();
  await expect(console.getByText('https://chat.example.com')).toBeVisible();
  await expect(console.getByTestId('console-desktop')).toContainText('0.99.6');
  await expect(console.getByTestId('console-desktop')).toContainText('Windows');
  await expect(console.getByTestId('console-desktop')).toContainText('3 devices');
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');

  await console.getByRole('tab', { name: /People/ }).click();
  await expect(console.getByTestId('console-person')).toContainText('Ayşe Yılmaz');
  await console.getByRole('button', { name: 'Sign Ayşe Yılmaz out everywhere' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect
    .poll(() => signedOut)
    .toContain('/api/admin/users/01a15e50-aaaa-7000-8000-000000000011/sessions');

  await console.getByRole('tab', { name: /Notifications/ }).click();
  await console.getByLabel('Nothing but that something came').check();
  await expect.poll(() => policy.push_contents).toBe('none');

  // The installation's default sounds, and giving them to everyone.
  const defaults = console.getByTestId('sound-defaults');
  await defaults.getByLabel('Other messages', { exact: true }).selectOption('bell');
  await expect.poll(() => sounds.sounds.message).toBe('bell');
  await defaults.getByRole('button', { name: 'Apply to everyone' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Apply to everyone' }).click();
  await expect(page.getByText('Settings of 12 people changed.')).toBeVisible();
  expect(applied).toBe(true);
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
});

test('administrators set the outgoing mail server, its password never shown', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  const off = { host: '', port: 587, security: 'starttls', username: '', from: '' };
  let server: Record<string, unknown> = { ...off, has_password: false, managed: false };
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/admin/mail-server', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      saves.push(body);
      const { password, ...rest } = body;
      server = {
        ...rest,
        has_password: body.username ? !!password || !!server.has_password : false,
        managed: false,
      };
    }
    return route.fulfill({ json: server });
  });
  await page.route('**/api/admin/notification-policy', (route) =>
    route.fulfill({ json: { push_contents: 'full', email_contents: 'full' } }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await console.getByRole('tab', { name: /Notifications/ }).click();
  const form = console.getByRole('form', { name: 'Outgoing mail server' });
  await expect(form.getByTestId('mail-server-off')).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'Account' })).toHaveAttribute(
    'placeholder',
    'meetings@your-company.com',
  );

  // TLS from the start moves the usual port along.
  await form.getByRole('textbox', { name: 'Server' }).fill('mail.example.com');
  await form.getByLabel('TLS from the start (usually port 465)').check();
  await expect(form.getByRole('textbox', { name: 'Port' })).toHaveValue('465');
  await form.getByRole('textbox', { name: 'Account' }).fill('meetings@example.com');
  await form.getByLabel('Password').fill('s3cret-pass');
  await expect(form.getByLabel('Password')).toHaveAttribute('autocomplete', 'new-password');
  await form.getByLabel('Sender').fill('Cenacle <meetings@example.com>');
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await form.getByRole('button', { name: 'Save mail server' }).click();
  await expect(page.getByText('Mail server saved.')).toBeVisible();
  expect(saves.at(-1)).toEqual({
    host: 'mail.example.com',
    port: 465,
    security: 'tls',
    username: 'meetings@example.com',
    password: 's3cret-pass',
    from: 'Cenacle <meetings@example.com>',
  });
  // Saved: the field is empty again, and saving keeps the password.
  await expect(form.getByLabel('Password')).toHaveValue('');
  await expect(form.getByText('A password is saved.')).toBeVisible();
  await form.getByRole('button', { name: 'Save mail server' }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves.at(-1)).not.toHaveProperty('password');

  // A relay inside the network: no account, so no password.
  await form.getByLabel('Unencrypted, inside your network (usually port 25)').check();
  await expect(form.getByRole('textbox', { name: 'Port' })).toHaveValue('25');
  await expect(form.getByRole('textbox', { name: 'Account' })).toHaveCount(0);

  // Turning e-mail off is confirmed first.
  await form.getByRole('button', { name: 'Turn e-mail off' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Turn e-mail off' }).click();
  await expect(page.getByText('E-mail is off.')).toBeVisible();
  expect(saves.at(-1)).toEqual(off);
});

test('a mail server the server settings name is shown, not edited', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  await page.route('**/api/admin/mail-server', (route) =>
    route.fulfill({
      json: {
        host: 'relay.internal',
        port: 25,
        security: 'none',
        username: '',
        from: 'Cenacle <chat@example.com>',
        has_password: false,
        managed: true,
      },
    }),
  );
  await page.route('**/api/admin/notification-policy', (route) =>
    route.fulfill({ json: { push_contents: 'full', email_contents: 'full' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await console.getByRole('tab', { name: /Notifications/ }).click();
  await expect(
    console.getByText(/own settings name the mail server \(relay\.internal\)/),
  ).toBeVisible();
  await expect(console.getByRole('button', { name: 'Save mail server' })).toHaveCount(0);
});

test('the system console sets the session and network policy', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  let saved: Record<string, unknown> | undefined;
  await page.route('**/api/admin/overview', (route) =>
    route.fulfill({
      json: {
        version: '0.35.0',
        desktop_apps: [],
        counts: {
          users: 1,
          active_users: 1,
          bots: 0,
          workspaces: 1,
          channels: 1,
          messages: 0,
          files: 0,
          file_bytes: 0,
        },
        config: [],
        jobs: [],
        failures: [],
      },
    }),
  );
  await page.route('**/api/admin/session-policy', (route) => {
    const base = {
      session_max_hours: 0,
      session_idle_minutes: 0,
      guest_session_max_hours: 0,
      guest_idle_minutes: 0,
      admin_networks: [],
      signin_networks: [],
      operator_max_hours: 720,
      operator_idle_minutes: 0,
      your_address: '10.1.2.3',
    };
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { ...base, ...saved } });
    }
    return route.fulfill({ json: base });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await console.getByRole('tab', { name: /Security/ }).click();
  await expect(console.getByText('Your address is 10.1.2.3')).toBeVisible();
  await console.getByLabel('Guests: end sessions after').fill('8');
  await console
    .getByLabel('Networks that may use the administration')
    .fill('10.0.0.0/8\n192.168.1.7');
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await console.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Security settings saved.')).toBeVisible();
  expect(saved).toMatchObject({
    guest_session_max_hours: 8,
    session_max_hours: 0,
    admin_networks: ['10.0.0.0/8', '192.168.1.7'],
    signin_networks: [],
  });
});

test('the system console shows the audit log and streams it to a SIEM', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Settings opens from the sidebar on wide screens');
  await mockApi(page, { admin: true });
  await page.route('**/api/admin/overview', (route) =>
    route.fulfill({
      json: {
        version: '0.36.0',
        desktop_apps: [],
        counts: {
          users: 1,
          active_users: 1,
          bots: 0,
          workspaces: 1,
          channels: 1,
          messages: 0,
          files: 0,
          file_bytes: 0,
        },
        config: [],
        jobs: [],
        failures: [],
      },
    }),
  );
  const asked: string[] = [];
  await page.route(/\/api\/admin\/audit\?/, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('prefix') ?? '');
    return route.fulfill({
      json: {
        events: [
          {
            id: '01a16400-0000-7000-8000-0000000000a1',
            at: '2026-10-24T10:00:00Z',
            actor: { id: '01a16400-0000-7000-8000-0000000000b1', display_name: 'Yönetici' },
            action: 'instance.session_policy_changed',
            target_type: '',
            target_id: '',
            detail: {},
            workspace: null,
            ip_address: '10.1.2.3',
          },
        ],
        has_more: false,
      },
    });
  });
  let saved: unknown;
  await page.route('**/api/admin/audit-stream', (route) => {
    const base = {
      kind: 'none',
      address: '',
      tls: true,
      has_secret: false,
      last_error: '',
      last_sent_at: null,
    };
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { ...base, ...(saved as object), has_secret: true } });
    }
    return route.fulfill({ json: base });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System console' }).click();
  const console = page.getByRole('dialog', { name: 'System console' });
  await console.getByRole('tab', { name: /Audit log/ }).click();
  await expect(console.getByTestId('audit-events')).toContainText(
    'instance.session_policy_changed',
  );
  await expect(console.getByTestId('audit-events')).toContainText('10.1.2.3');
  await console.getByLabel('Kind').selectOption({ label: 'Federation' });
  await expect.poll(() => asked.at(-1)).toBe('federation.');
  await expect(console.getByRole('link', { name: 'Download (NDJSON)' })).toHaveAttribute(
    'href',
    '/api/admin/audit/export?prefix=federation.',
  );
  await console.getByLabel('Syslog (RFC 5424 over TCP)').check();
  await console.getByLabel('Receiver (host:port)').fill('siem.example.com:6514');
  await expectTargetSizes(page, test.info(), '[role="dialog"]');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await console.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Streaming settings saved.')).toBeVisible();
  expect(saved).toEqual({ kind: 'syslog', address: 'siem.example.com:6514', tls: true });
});
