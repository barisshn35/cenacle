// SPDX-License-Identifier: AGPL-3.0-only
// The features added before 1.0, on the real stack: Cenacle ID, the chat server
// (with e-mail to the development Mailpit), the web app and, with STACK_CALLS=1,
// the media server. What a mocked API cannot show: the server's automatic reply,
// meeting e-mails with their calendar file, a call's hands, reactions, recording
// and captions between two browsers, search by meaning and an assistant over MCP.
import { existsSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { IDP_URL, WEB_URL } from '../playwright.stack.config';
import { ensureAccount, PASSWORD } from './accounts';

const ADMIN = { email: 'deniz@example.com', name: 'Deniz Kaya' }; // CENACLE_ADMIN_EMAIL
const MERT = { email: 'mert@example.com', name: 'Mert Demir' };
// Its own third person: other files turn on two-step verification for theirs.
const SELIN = { email: 'selin@example.com', name: 'Selin Aydın' };
const MAILPIT = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? '18025'}`;
// A recording of speech for the fake microphone (whisper.cpp's sample), for captions.
const SPEECH = process.env.STACK_SPEECH_WAV ?? '';

// The fake microphone speaks (captions need words), else it beeps.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(SPEECH && existsSync(SPEECH) ? [`--use-file-for-fake-audio-capture=${SPEECH}`] : []),
    ],
  },
});

test.beforeAll(() => {
  for (const p of [ADMIN, MERT, SELIN]) ensureAccount(p.email, p.name);
});

async function open(browser: Browser, email: string): Promise<Page> {
  const context: BrowserContext = await browser.newContext({
    permissions: ['camera', 'microphone'],
  });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('link', { name: 'Continue with Cenacle ID' }).click();
  await page.waitForURL(`${IDP_URL}/**`);
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Message General').waitFor();
  return page;
}

/** An API call as the page's person (the session cookie, from the app's origin). */
async function api<T = unknown>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await page.request.fetch(path, {
    method,
    headers: { Origin: WEB_URL, 'Content-Type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function ids(page: Page) {
  const session = await api<{ user: { id: string } }>(page, 'GET', '/api/session');
  const { workspaces } = await api<{ workspaces: { id: string }[] }>(
    page,
    'GET',
    '/api/workspaces',
  );
  const { channels } = await api<{ channels: { id: string; name: string }[] }>(
    page,
    'GET',
    '/api/channels',
  );
  return {
    user: session.user.id,
    workspace: workspaces[0]!.id,
    general: channels.find((c) => c.name === 'General')!.id,
  };
}

interface MailSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Attachments: number;
}

async function mailTo(address: string, subject: RegExp): Promise<MailSummary> {
  let found: MailSummary | undefined;
  await expect
    .poll(
      async () => {
        const r = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json()) as {
          messages: MailSummary[];
        };
        found = r.messages.find(
          (m) => m.To.some((t) => t.Address === address) && subject.test(m.Subject),
        );
        return !!found;
      },
      { timeout: 90_000, intervals: [2000] },
    )
    .toBe(true);
  return found!;
}

test('an automatic reply while away, and a named group conversation', async ({ browser }) => {
  test.setTimeout(120_000);
  const deniz = await open(browser, ADMIN.email);
  const mert = await open(browser, MERT.email);
  try {
    const d = await ids(deniz);
    const m = await ids(mert);
    // A chat account is made at the first sign-in.
    await (await open(browser, SELIN.email)).context().close();
    const z = await api<{ users: { id: string; email: string }[] }>(
      mert,
      'GET',
      `/api/users?workspace_id=${m.workspace}&q=selin&limit=5`,
    );
    const from = new Date(Date.now() - 60_000).toISOString();
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await api(deniz, 'PUT', '/api/me/out-of-office', { from, until, message: 'Back on Monday.' });

    // Mert writes to Deniz: the server answers once, in Deniz's name.
    const dm = await api<{ id: string }>(
      mert,
      'POST',
      `/api/workspaces/${m.workspace}/conversations`,
      {
        user_ids: [d.user],
      },
    );
    await mert.goto(`/c/${dm.id}`);
    await mert.getByRole('textbox', { name: /^Message / }).fill('Can you look at the budget?');
    await mert.keyboard.press('Enter');
    // The reply is a message in the conversation (the header also says Deniz is away).
    const replies = mert.getByTestId('message').filter({ hasText: 'Back on Monday.' });
    await expect(replies).toHaveCount(1, { timeout: 15_000 });
    await mert.getByRole('textbox', { name: /^Message / }).fill('And the plan?');
    await mert.keyboard.press('Enter');
    await expect(mert.getByText('And the plan?')).toBeVisible();
    await expect(replies).toHaveCount(1);
    await api(deniz, 'DELETE', '/api/me/out-of-office');

    // A group of three gets a name everyone sees.
    const group = await api<{ id: string }>(
      mert,
      'POST',
      `/api/workspaces/${m.workspace}/conversations`,
      {
        user_ids: [d.user, z.users[0]!.id],
      },
    );
    await api(mert, 'PUT', `/api/channels/${group.id}/title`, { title: 'Roadmap' });
    await expect(
      deniz.getByRole('navigation', { name: 'Channels' }).getByText('Roadmap'),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await deniz.context().close();
    await mert.context().close();
  }
});

test('a meeting: the invitation e-mail with its calendar file, an answer, a cancellation', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  const deniz = await open(browser, ADMIN.email);
  const mert = await open(browser, MERT.email);
  try {
    await deniz.goto('/calendar');
    await deniz.getByRole('button', { name: 'New meeting' }).click();
    const dialog = deniz.getByRole('dialog', { name: 'New meeting' });
    await dialog.getByLabel('Title').fill('Release review');
    await dialog.getByLabel('Find people').fill('Mert');
    await dialog.getByRole('button', { name: `Invite ${MERT.name}` }).click();
    await dialog.getByLabel('Agenda').fill('1. Results\n2. Plans');
    await dialog.getByRole('button', { name: 'Plan meeting' }).click();
    await expect(dialog).toBeHidden();

    // The invitation reaches Mert's inbox with the meeting as a calendar file.
    const invite = await mailTo(MERT.email, /^Invitation: Release review/);
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${invite.ID}`)).json()) as {
      HTML: string;
      Text: string;
      Attachments: { FileName: string; ContentType: string }[];
      Inline: { ContentType: string }[];
    };
    expect(full.Attachments.some((a) => a.FileName === 'meeting.ics')).toBe(true);
    expect(full.Inline.some((a) => a.ContentType === 'image/png')).toBe(true);
    expect(full.HTML).toContain('Release review');
    expect(full.Text).toContain('Agenda:');

    // Mert answers in the calendar; Deniz sees it.
    await mert.goto('/calendar');
    await mert.getByRole('button', { name: 'Agenda', exact: true }).click();
    await mert.getByTestId('calendar-item').filter({ hasText: 'Release review' }).first().click();
    const details = mert.getByTestId('meeting');
    await details.getByRole('button', { name: 'Going', exact: true }).click();
    await expect(details.getByRole('button', { name: 'Going', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await deniz.goto('/calendar');
    await deniz.getByTestId('calendar-item').filter({ hasText: 'Release review' }).first().click();
    const mine = deniz.getByTestId('meeting');
    await expect(mine.getByRole('listitem').filter({ hasText: MERT.name })).toContainText('Going');

    // Cancelled: Mert gets the cancellation (its calendar file removes the meeting).
    await mine.getByRole('button', { name: 'Cancel the meeting' }).click();
    await deniz
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel the meeting' })
      .click();
    const cancelled = await mailTo(MERT.email, /^Cancelled: Release review/);
    expect(cancelled.Attachments).toBeGreaterThan(0);
  } finally {
    await deniz.context().close();
    await mert.context().close();
  }
});

test('an assistant reads over MCP and leaves a draft the person sends', async ({ browser }) => {
  const deniz = await open(browser, ADMIN.email);
  const mert = await open(browser, MERT.email);
  try {
    await api(deniz, 'PUT', '/api/admin/assistants', { enabled: true });
    const m = await ids(mert);
    await mert.getByLabel('Message General').fill('The launch moves to Thursday.');
    await mert.keyboard.press('Enter');

    // The token is made in the settings and shown once.
    await mert.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = mert.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Assistants' }).click();
    await settings.getByLabel('Name').fill('Desk');
    await settings.getByLabel('Leave drafts in message boxes').check();
    await settings.getByRole('button', { name: 'Make the token' }).click();
    const token = await settings.getByLabel('Token', { exact: true }).inputValue();
    expect(token).toMatch(/^cnp_/);
    await mert.keyboard.press('Escape');

    const rpc = async (method: string, params: unknown, id: number) => {
      const res = await fetch(`${WEB_URL}/api/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { result: { structuredContent?: unknown; isError?: boolean } };
    };
    const init = await rpc(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
      1,
    );
    expect(JSON.stringify(init)).toContain('cenacle');
    const read = await rpc(
      'tools/call',
      { name: 'read_messages', arguments: { channel_id: m.general } },
      2,
    );
    expect(JSON.stringify(read.result.structuredContent)).toContain(
      'The launch moves to Thursday.',
    );
    const draft = await rpc(
      'tools/call',
      {
        name: 'draft_message',
        arguments: { channel_id: m.general, text: 'Thursday works for me.' },
      },
      3,
    );
    expect(draft.result.isError).toBeFalsy();

    // The draft waits above the message box; nothing was sent.
    const bar = mert.getByTestId('assistant-draft');
    await expect(bar).toContainText('Thursday works for me.', { timeout: 15_000 });
    await expect(
      mert.getByRole('article').filter({ hasText: 'Thursday works for me.' }),
    ).toHaveCount(0);
    await bar.getByRole('button', { name: 'Put in the message box' }).click();
    await expect(mert.getByLabel('Message General')).toHaveValue('Thursday works for me.');

    // Turned off, the token stops at once.
    await api(deniz, 'PUT', '/api/admin/assistants', { enabled: false });
    const off = await fetch(`${WEB_URL}/api/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(off.status).toBe(401);
  } finally {
    await deniz.context().close();
    await mert.context().close();
  }
});

test.describe('in a call', () => {
  test.skip(process.env.STACK_CALLS !== '1', 'the media server runs with STACK_CALLS=1');

  test('hands, reactions, a recording posted to the channel, and live captions', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const deniz = await open(browser, ADMIN.email);
    const mert = await open(browser, MERT.email);
    const captions = !!process.env.STACK_CAPTIONS_URL && !!SPEECH;
    try {
      const d = await ids(deniz);
      await api(deniz, 'PUT', `/api/workspaces/${d.workspace}/calls/settings`, {
        enabled: true,
        guest_start: false,
        max_participants: 8,
        max_bitrate: 2_500_000,
        recording: true,
        ...(captions ? { captions: true } : {}),
      });
      await deniz.reload();
      await deniz.getByRole('button', { name: 'Start call', exact: true }).click();
      await deniz.getByTestId('prejoin').getByRole('button', { name: 'Start call' }).click();
      await expect(deniz.getByRole('dialog').getByText('Connected', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await mert.reload();
      await mert
        .getByRole('region', { name: 'Call in progress' })
        .getByRole('button', { name: 'Join call' })
        .click();
      await mert.getByTestId('prejoin').getByRole('button', { name: 'Join' }).click();
      const mertCall = mert.getByRole('dialog');
      await expect(mertCall.getByText('Connected', { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      // A raised hand and a reaction reach the other person.
      await deniz.getByRole('button', { name: 'Raise hand' }).click();
      await expect(mertCall.getByTestId('raised-hand')).toContainText('Hand 1', {
        timeout: 15_000,
      });
      await deniz.getByRole('button', { name: 'React', exact: true }).click();
      await deniz.getByRole('button', { name: 'React with 👍' }).click();
      await expect(mertCall.getByText(`${ADMIN.name} reacted 👍`)).toBeAttached({
        timeout: 15_000,
      });

      // Recording: everyone sees it; stopped, the file is in the channel.
      await deniz.getByRole('button', { name: 'Record', exact: true }).click();
      await expect(mertCall.getByText(`${ADMIN.name} is recording this call`)).toBeVisible({
        timeout: 15_000,
      });
      if (captions) {
        await deniz.getByRole('button', { name: 'Captions', exact: true }).click();
        await expect(mertCall.getByText(/country/i).first()).toBeVisible({ timeout: 60_000 });
      } else {
        await deniz.waitForTimeout(4000);
      }
      await deniz.getByRole('button', { name: 'Stop recording', exact: true }).click();
      await expect(deniz.getByText('The recording is in the channel.')).toBeVisible({
        timeout: 60_000,
      });
      await deniz.getByRole('button', { name: 'Leave call', exact: true }).click();
      await mert.getByRole('button', { name: 'Leave call', exact: true }).click();
      await expect(mert.getByText(/Call recording .*\.webm/).first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await deniz.context().close();
      await mert.context().close();
    }
  });
});

test('search by meaning with an embedding model', async ({ browser }) => {
  test.skip(
    !process.env.STACK_AI_EMBEDDING_MODEL,
    'needs STACK_AI_URL and STACK_AI_EMBEDDING_MODEL',
  );
  test.setTimeout(240_000);
  const deniz = await open(browser, ADMIN.email);
  try {
    const d = await ids(deniz);
    await api(deniz, 'PUT', `/api/workspaces/${d.workspace}/ai`, { enabled: true });
    await api(deniz, 'PUT', '/api/me/ai', { accepted: true });
    const indexed = async () =>
      (await api<{ indexed: number }>(deniz, 'GET', '/api/admin/semantic-search')).indexed;
    // Messages of the earlier tests may be in the index already.
    const before = await indexed();
    await deniz
      .getByLabel('Message General')
      .fill('We ship the new version on the fourth of December.');
    await deniz.keyboard.press('Enter');
    await deniz.getByLabel('Message General').fill('Lunch is pizza today.');
    await deniz.keyboard.press('Enter');
    // The index is made in the background (every 20 seconds).
    await expect
      .poll(indexed, { timeout: 120_000, intervals: [3000] })
      .toBeGreaterThanOrEqual(before + 2);
    await deniz.reload();
    await deniz.getByRole('button', { name: 'Search messages and files' }).click();
    const panel = deniz.getByTestId('search-panel');
    await panel.getByRole('searchbox', { name: 'Search for' }).fill('release date');
    await panel.getByLabel('Search by meaning').check();
    await expect(panel.getByText('We ship the new version on the fourth of December.')).toBeVisible(
      {
        timeout: 30_000,
      },
    );
  } finally {
    await deniz.context().close();
  }
});
