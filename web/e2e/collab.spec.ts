// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_WS,
  expectNoAxeViolations,
  expectTargetSizes,
  GENERAL,
  mockApi,
  mockMessage,
  PEOPLE,
  SESSION,
} from './helpers';

const CANVAS_TAB = {
  id: '01a16000-0000-7000-8000-0000000000c1',
  channel_id: GENERAL.id,
  kind: 'canvas',
  title: 'Launch plan',
  canvas_id: '01a16000-0000-7000-8000-0000000000c2',
  position: 0,
  can_delete: true,
};
const LIST_TAB = {
  id: '01a16000-0000-7000-8000-0000000000d1',
  channel_id: GENERAL.id,
  kind: 'list',
  title: 'Tasks',
  list_id: '01a16000-0000-7000-8000-0000000000d2',
  position: 1,
  can_delete: true,
};

async function mockTabs(page: Page, tabs: unknown[]) {
  await page.route(`**/api/channels/${GENERAL.id}/tabs`, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { tabs } }) : route.fallback(),
  );
}

test('a canvas is created from the tab bar, written and saved', async ({ page }, testInfo) => {
  await mockApi(page, { messages: [mockMessage(1, 'Hello')] });
  const tabs: unknown[] = [];
  await mockTabs(page, tabs);
  let created: unknown;
  await page.route(`**/api/channels/${GENERAL.id}/tabs`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = route.request().postDataJSON();
    tabs.push(CANVAS_TAB);
    return route.fulfill({ status: 201, json: CANVAS_TAB });
  });
  const canvas = {
    id: CANVAS_TAB.canvas_id,
    channel_id: GENERAL.id,
    title: 'Launch plan',
    body: '',
    version: 1,
    updated_at: '2026-10-22T10:00:00Z',
    can_edit: true,
  };
  await page.route(`**/api/canvases/${canvas.id}`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: canvas });
    const { body, version } = route.request().postDataJSON() as { body: string; version: number };
    expect(version).toBe(1);
    return route.fulfill({
      json: {
        ...canvas,
        body,
        version: 2,
        updated_by: { id: SESSION.user.id, display_name: SESSION.user.display_name },
      },
    });
  });
  await page.route(`**/api/canvases/${canvas.id}/editing`, (route) =>
    route.fulfill(
      route.request().method() === 'POST'
        ? {
            json: {
              ...canvas,
              editing_by: { id: SESSION.user.id, display_name: SESSION.user.display_name },
            },
          }
        : { status: 204 },
    ),
  );

  await page.goto(`/c/${GENERAL.id}`);
  await expect(page.getByText('Hello')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Channel tabs' });
  await expect(nav.getByRole('link', { name: 'Messages' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('button', { name: 'Add a tab' }).click();
  await page.getByRole('menuitem', { name: 'Canvas' }).click();
  const dialog = page.getByRole('dialog', { name: 'New canvas' });
  await dialog.getByLabel('Title').fill('Launch plan');
  await dialog.getByRole('button', { name: 'Add tab' }).click();
  expect(created).toEqual({ kind: 'canvas', title: 'Launch plan' });

  await expect(page).toHaveURL(new RegExp(`tab=${CANVAS_TAB.id}`));
  await expect(nav.getByRole('link', { name: 'Launch plan' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const article = page.getByTestId('canvas');
  await expect(article).toContainText('This canvas is empty');
  await article.getByRole('button', { name: 'Edit' }).click();
  const text = article.getByLabel('Canvas text');
  await expect(text).toBeFocused();
  await text.fill('# Goals\n\n- Ship **v1**');
  await page.mouse.move(0, 0);
  await expectTargetSizes(page, testInfo, '[data-testid="canvas"]');
  await expectNoAxeViolations(page, '[data-testid="canvas"]');
  await article.getByRole('button', { name: 'Save' }).click();
  await expect(article.getByRole('heading', { name: 'Goals' })).toBeVisible();
  await expect(article.getByText('Ship v1')).toBeVisible();
  await expect(article).toContainText(`Edited by ${SESSION.user.display_name}`);
});

test("someone else's turn: the canvas says who edits, and Edit waits", async ({ page }) => {
  await mockApi(page, { messages: [] });
  await mockTabs(page, [CANVAS_TAB]);
  await page.route(`**/api/canvases/${CANVAS_TAB.canvas_id}`, (route) =>
    route.fulfill({
      json: {
        id: CANVAS_TAB.canvas_id,
        channel_id: GENERAL.id,
        title: 'Launch plan',
        body: 'Draft',
        version: 4,
        updated_at: '2026-10-22T10:00:00Z',
        editing_by: { id: PEOPLE[1]!.id, display_name: PEOPLE[1]!.display_name },
        can_edit: true,
      },
    }),
  );
  await page.goto(`/c/${GENERAL.id}?tab=${CANVAS_TAB.id}`);
  const article = page.getByTestId('canvas');
  await expect(article.getByRole('status')).toHaveText(`${PEOPLE[1]!.display_name} is editing`);
  await expect(article.getByRole('button', { name: 'Edit' })).toBeDisabled();
});

const LIST = {
  id: LIST_TAB.list_id,
  channel_id: GENERAL.id,
  title: 'Tasks',
  columns: [
    { id: 'status', name: 'Status', kind: 'status' },
    { id: 'owner', name: 'Assignee', kind: 'person' },
    { id: 'due', name: 'Due date', kind: 'date' },
  ],
  board_column: 'status',
  can_edit: true,
  items: [
    {
      id: '01a16000-0000-7000-8000-0000000000e1',
      list_id: LIST_TAB.list_id,
      title: 'Book the room',
      values: { status: 'todo', owner: PEOPLE[1]!.id, due: '2026-10-30' },
      created_at: '2026-10-22T10:00:00Z',
      updated_at: '2026-10-22T10:00:00Z',
      created_by: PEOPLE[2]!.id as string | undefined,
      updated_by: undefined as string | undefined,
    },
  ],
};

test('a task list opens as a board; cards move without dragging', async ({ page }, testInfo) => {
  await mockApi(page, { messages: [] });
  await mockTabs(page, [CANVAS_TAB, LIST_TAB]);
  const list = structuredClone(LIST);
  await page.route(`**/api/lists/${LIST.id}`, (route) => route.fulfill({ json: list }));
  let change: unknown;
  await page.route(`**/api/list-items/*`, (route) => {
    change = route.request().postDataJSON();
    const item = list.items[0]!;
    item.values = { ...item.values, ...(change as { values: Record<string, string> }).values };
    item.updated_by = SESSION.user.id;
    item.updated_at = '2026-10-23T10:00:00Z';
    return route.fulfill({ json: item });
  });
  await page.goto(`/c/${GENERAL.id}?tab=${LIST_TAB.id}`);
  const lanes = page.getByTestId('lane');
  await expect(lanes).toHaveCount(3);
  const todo = page.getByRole('region', { name: 'To do' });
  await expect(todo.getByTestId('card')).toContainText('Book the room');
  await expect(todo.getByTestId('card')).toContainText(PEOPLE[1]!.display_name);
  // Who added the card, on the card itself.
  await expect(todo.getByTestId('card')).toContainText(
    `Added by ${PEOPLE[2]!.display_name}, Oct 22, 2026`,
  );
  await expectTargetSizes(page, testInfo, '[data-testid="list"]');
  await expectNoAxeViolations(page, '[data-testid="list"]');

  await todo.getByRole('button', { name: 'Options for Book the room' }).click();
  await page.getByRole('menuitem', { name: 'Move to In progress' }).click();
  await expect.poll(() => change).toEqual({ values: { status: 'doing' }, to_end: true });
  await expect(page.getByRole('region', { name: 'In progress' }).getByTestId('card')).toContainText(
    'Book the room',
  );

  // The table shows the same rows with their values to change.
  await page.getByRole('button', { name: 'Table' }).click();
  const row = page.getByTestId('list-row');
  await expect(row.getByLabel('Status, Book the room')).toHaveValue('doing');
  await row.getByLabel('Status, Book the room').selectOption('done');
  await expect.poll(() => change).toEqual({ values: { status: 'done' } });
  // The table says who added the row and who changed it last.
  await expect(row.getByTestId('origin-added')).toHaveText(
    `Added by ${PEOPLE[2]!.display_name}, Oct 22, 2026`,
  );
  await expect(row.getByTestId('origin-changed')).toContainText('Changed by');
  await expectNoAxeViolations(page, '[data-testid="list"]');
});

test('rows assigned to me show under Tasks and lead to their list', async ({ page }) => {
  await mockApi(page, { messages: [] });
  await mockTabs(page, [LIST_TAB]);
  await page.route(`**/api/lists/${LIST.id}`, (route) => route.fulfill({ json: LIST }));
  await page.route(`**/api/workspaces/${DEFAULT_WS}/assigned-items`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            item: LIST.items[0],
            list_title: 'Tasks',
            tab_id: LIST_TAB.id,
            channel_id: GENERAL.id,
            channel_name: 'General',
            due: '2020-01-02',
          },
        ],
      },
    }),
  );
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  const item = page.getByTestId('assigned-item');
  await expect(item).toContainText('Book the room');
  await expect(page.getByRole('main')).toContainText('Overdue since');
  await expectNoAxeViolations(page, 'main');
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/c/${GENERAL.id}\\?tab=${LIST_TAB.id}`));
  await expect(page.getByTestId('list')).toBeVisible();
});
