// SPDX-License-Identifier: AGPL-3.0-only
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { instrument, registry } from '../src/metrics.ts';

describe('metrics', () => {
  it('records requests by route pattern', async () => {
    const app = Fastify();
    instrument(app);
    app.get('/accounts/:id', async () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/accounts/secret-123' });
    const out = await registry.metrics();
    expect(out).toContain(
      'cenacle_idp_http_request_duration_seconds_count{method="GET",route="/accounts/:id",code="200"} 1',
    );
    expect(out).not.toContain('secret-123');
    expect(out).toContain('cenacle_idp_process_cpu_seconds_total');
  });
});
