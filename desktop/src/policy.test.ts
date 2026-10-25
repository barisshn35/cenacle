// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseRegistry, policyFrom } from './policy.js';

describe('policy', () => {
  it('reads the values reg.exe prints', () => {
    const out = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Cenacle\\Desktop',
      '    Server    REG_SZ    https://chat.example.com',
      '    LockServer    REG_DWORD    0x1',
      '    DisableUpdates    REG_DWORD    0x0',
      '',
    ].join('\r\n');
    expect(parseRegistry(out)).toEqual({
      server: 'https://chat.example.com',
      lockserver: '1',
      disableupdates: '0',
    });
  });

  it('lets the machine win over the user, and leaves the rest undecided', () => {
    const machine = { server: 'https://chat.example.com', lockserver: '1' };
    const user = { server: 'https://other.example.com', disableupdates: '1' };
    expect(policyFrom([machine, user])).toEqual({
      server: 'https://chat.example.com',
      lockServer: true,
      disableUpdates: true,
    });
    expect(policyFrom([{}, {}])).toEqual({ server: '', lockServer: false, disableUpdates: false });
    expect(policyFrom([{ server: 'chat', lockserver: true, disableupdates: 'no' }])).toEqual({
      server: 'chat',
      lockServer: true,
      disableUpdates: false,
    });
  });
});
