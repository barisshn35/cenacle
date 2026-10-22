// SPDX-License-Identifier: AGPL-3.0-only
import { STATUS_CODES } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 problem details with Cenacle extensions (`code`, `request_id`). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  request_id: string;
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  p: { status: number; code: string; detail?: string; title?: string; type?: string },
): FastifyReply {
  const body: Problem = {
    type: p.type ?? 'about:blank',
    title: p.title ?? STATUS_CODES[p.status] ?? 'Error',
    status: p.status,
    ...(p.detail ? { detail: p.detail } : {}),
    code: p.code,
    request_id: request.id,
  };
  return reply
    .code(p.status)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .header('cache-control', 'no-store')
    .send(body);
}
