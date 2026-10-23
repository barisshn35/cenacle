// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { newestOwn, wrapSelection } from './composer-keys';
import type { Message } from './data';

describe('composer keys', () => {
  it('wraps the selection and unwraps it again', () => {
    const on = wrapSelection('say hello now', 4, 9, '**');
    expect(on).toEqual({ value: 'say **hello** now', start: 6, end: 11 });
    expect(wrapSelection(on.value, on.start, on.end, '**')).toEqual({
      value: 'say hello now',
      start: 4,
      end: 9,
    });
  });

  it('puts the caret between the markers without a selection', () => {
    expect(wrapSelection('x ', 2, 2, '_')).toEqual({ value: 'x __', start: 3, end: 3 });
  });

  it('finds the newest message one can edit', () => {
    const m = (id: string, author: string, extra: Partial<Message> = {}) =>
      ({ id, author: { id: author }, body: id, ...extra }) as unknown as Message;
    const list = [m('1', 'me'), m('2', 'other'), m('3', 'me', { body: '' })];
    expect(newestOwn(list, 'me')?.id).toBe('1');
    expect(newestOwn([m('4', 'other')], 'me')).toBeUndefined();
  });
});
