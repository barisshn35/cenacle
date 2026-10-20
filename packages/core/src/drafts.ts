// SPDX-License-Identifier: Apache-2.0
import Dexie, { type Table } from 'dexie';

/**
 * Unsent message text, kept per channel in IndexedDB so it survives reloads,
 * crashes and expired sessions (UX plan: "Stable"). Bodies are markdown, the
 * same format the server stores.
 */
export interface Draft {
  workspaceId: string;
  channelId: string;
  body: string;
  /** Epoch milliseconds of the last change. */
  updatedAt: number;
}

export type DraftKey = Pick<Draft, 'workspaceId' | 'channelId'>;

/** Local client database. Later versions add cached channels/messages. */
export class CenacleDatabase extends Dexie {
  drafts!: Table<Draft, [string, string]>;

  constructor(name = 'cenacle') {
    super(name);
    this.version(1).stores({
      // Compound primary key + secondary indexes for listing and pruning.
      drafts: '[workspaceId+channelId], workspaceId, updatedAt',
    });
  }
}

const key = (k: DraftKey): [string, string] => [k.workspaceId, k.channelId];

/** Draft persistence API. The composer uses it from v0.4 on. */
export class DraftStore {
  constructor(
    private readonly db: CenacleDatabase = new CenacleDatabase(),
    private readonly now: () => number = Date.now,
  ) {}

  async get(k: DraftKey): Promise<Draft | undefined> {
    return this.db.drafts.get(key(k));
  }

  /** Saves the body; an empty or whitespace-only body deletes the draft. */
  async save(k: DraftKey, body: string): Promise<Draft | undefined> {
    if (body.trim() === '') {
      await this.delete(k);
      return undefined;
    }
    const draft: Draft = { ...k, body, updatedAt: this.now() };
    await this.db.drafts.put(draft);
    return draft;
  }

  async delete(k: DraftKey): Promise<void> {
    await this.db.drafts.delete(key(k));
  }

  /** Drafts of a workspace (or all), most recently edited first. */
  async list(workspaceId?: string): Promise<Draft[]> {
    const rows =
      workspaceId === undefined
        ? await this.db.drafts.toArray()
        : await this.db.drafts.where('workspaceId').equals(workspaceId).toArray();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Removes drafts not edited for `maxAgeMs`. Returns the number removed. */
  async prune(maxAgeMs: number): Promise<number> {
    return this.db.drafts
      .where('updatedAt')
      .below(this.now() - maxAgeMs)
      .delete();
  }

  /** Removes every draft, e.g. when the user signs out on a shared device. */
  async clear(): Promise<void> {
    await this.db.drafts.clear();
  }
}
