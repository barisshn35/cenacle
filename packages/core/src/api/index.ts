// SPDX-License-Identifier: Apache-2.0

/**
 * Typed API client of the chat server. Types in ./schema.ts are generated
 * from the server's OpenAPI spec with `pnpm --filter @cenacle/core gen:api`
 * (spec-first, oapi-codegen on the server side). The spec arrives in v0.3.
 */
export type { paths } from './schema';

/** RFC 9457 problem details returned by every Cenacle API error. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  request_id?: string;
}

export function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Problem).status === 'number' &&
    typeof (value as Problem).code === 'string'
  );
}
