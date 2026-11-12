// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, GENERAL, mockApi, mockMessage } from './helpers';

const fromBot = (attachments: unknown[]) => ({
  ...mockMessage(1, ''),
  author: { id: '01a15e50-b0b0-7000-8000-000000000001', display_name: 'Metrics', is_bot: true },
  attachments,
});

test('a card draws its chart, names it and offers the numbers; a live card changes in place', async ({
  page,
}) => {
  const card = {
    title: 'p95 latency',
    chart: {
      kind: 'bar',
      unit: 'ms',
      labels: ['Mon', 'Tue', 'Wed'],
      series: [
        { name: 'api', values: [120, 180, 90] },
        { name: 'web', values: [60, 75, 70] },
      ],
    },
  };
  const message = fromBot([card]);
  const api = await mockApi(page, { messages: [message] });
  await page.goto(`/c/${GENERAL.id}`);
  const chart = page.getByTestId('card-chart');
  await expect(chart.getByRole('img')).toHaveAccessibleName(
    'Bar chart of api, web, 3 points. The numbers are in the table below.',
  );
  // Two series: a legend names them, so colour is never the only key.
  await expect(chart.getByRole('listitem')).toHaveText(['api', 'web']);
  await chart.getByText('Show the numbers').click();
  const table = chart.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row').nth(2)).toContainText('180');
  await expectNoAxeViolations(page, '[data-testid="card-chart"]');

  // The bot replaced its card: the new numbers show without a reload.
  api.emit('message.updated', {
    ...message,
    attachments: [{ ...card, title: 'p95 latency (now)', chart: { ...card.chart, kind: 'line' } }],
  });
  await expect(page.getByText('p95 latency (now)')).toBeVisible();
  await expect(chart.getByRole('img')).toHaveAccessibleName(/^Line chart of api, web/);
  await expect(page.getByTestId('message').first()).not.toContainText('(edited)');
});
