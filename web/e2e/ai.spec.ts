// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { DEFAULT_WS, expectNoAxeViolations, GENERAL, mockApi, mockMessage } from './helpers';

test('without AI, nothing about AI shows anywhere', async ({ page }) => {
  await mockApi(page, { messages: [mockMessage(1, 'Hello')], admin: true });
  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('Hello')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message General' }).fill('draft');
  await expect(page.getByRole('button', { name: /Summarize|Rewrite/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ask AI' })).toHaveCount(0);
  await expect(page.getByText(/\bAI\b/)).toHaveCount(0);
});

test('with AI on: a summary only for me, a rewrite I choose to use, and answers with sources', async ({
  page,
}, testInfo) => {
  await mockApi(page, { messages: [mockMessage(1, 'We ship on Friday')], ai: true });
  await page.route(`**/api/channels/${GENERAL.id}/ai/summary`, (route) =>
    route.fulfill({ json: { text: '- Shipping on **Friday**', sources: [] } }),
  );
  let action: unknown;
  await page.route(`**/api/workspaces/${DEFAULT_WS}/ai/compose`, (route) => {
    action = route.request().postDataJSON();
    return route.fulfill({ json: { text: 'Please ship it on Friday.', sources: [] } });
  });
  await page.route(`**/api/workspaces/${DEFAULT_WS}/ai/ask`, (route) =>
    route.fulfill({
      json: {
        text: 'On Friday [1].',
        sources: [
          {
            message_id: mockMessage(1, '').id,
            channel_id: GENERAL.id,
            channel_name: 'General',
            author_name: 'Ayşe Yılmaz',
            created_at: '2026-10-22T10:00:00Z',
          },
        ],
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}`);
  await page.getByRole('button', { name: 'Summarize the channel' }).click();
  const summary = page.getByRole('dialog', { name: 'Summarize the channel' });
  await expect(summary.getByTestId('ai-answer')).toContainText('Shipping on Friday');
  await expect(summary).toContainText('Written by AI');
  await expectNoAxeViolations(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(summary).toHaveCount(0);

  const box = page.getByRole('textbox', { name: 'Message General' });
  await box.fill('pls ship frday');
  await page.getByRole('button', { name: 'Rewrite with AI' }).click();
  await page.getByRole('menuitem', { name: 'Improve writing' }).click();
  const rewrite = page.getByRole('dialog', { name: 'Rewrite with AI' });
  await expect(rewrite).toContainText('Please ship it on Friday.');
  expect(action).toEqual({ text: 'pls ship frday', action: 'improve' });
  await rewrite.getByRole('button', { name: 'Use this text' }).click();
  await expect(box).toHaveValue('Please ship it on Friday.');

  if (testInfo.project.name === 'fine') {
    await page.getByRole('link', { name: 'Ask AI' }).click();
  } else {
    await page.goto('/ask'); // the sidebar is a sheet on small screens
  }
  await page.getByLabel('Ask about your conversations').fill('When do we ship?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const answer = page.getByTestId('ai-answer');
  await expect(answer).toContainText('On Friday');
  await answer.getByText('Made from 1 message').click();
  await expect(answer.getByRole('link', { name: /Ayşe Yılmaz/ })).toBeVisible();
  await expectNoAxeViolations(page, '[data-testid="ask"]');
});
