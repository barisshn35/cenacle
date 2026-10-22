// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline';

/**
 * Reads a secret without putting it on the command line (shell history,
 * process list). On a terminal input is not echoed; otherwise the first line
 * of stdin is used, e.g. `printf '%s' "$PASSWORD" | cenacle-idp users create ...`.
 */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    let muted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!muted) write.call(rl, s);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}
