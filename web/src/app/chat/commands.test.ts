// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseCommand } from './commands';

describe('parseCommand', () => {
  it('splits the command from its text', () => {
    expect(parseCommand('/remind me in 10m stand up')).toEqual({
      command: 'remind',
      text: 'me in 10m stand up',
    });
    expect(parseCommand('/LEAVE')).toEqual({ command: 'leave', text: '' });
    expect(parseCommand('/deploy\nprod')).toEqual({ command: 'deploy', text: 'prod' });
  });

  it('leaves messages alone', () => {
    expect(parseCommand('hello /me')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/ space')).toBeNull();
    expect(parseCommand('/path/to/file')).toBeNull();
  });
});
