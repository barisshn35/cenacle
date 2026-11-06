// SPDX-License-Identifier: AGPL-3.0-only
// Tests ci/github-release.mjs against a stand-in for GitHub's releases API:
// node --test ci/github-release.test.mjs
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A copy of the script next to a lock file of the test's choosing: the
// repository's own ci/public-publishing stays locked until 1.0.
function scriptWith(lock) {
  const dir = mkdtempSync(join(tmpdir(), 'github-release-script-'));
  copyFileSync(new URL('./github-release.mjs', import.meta.url), join(dir, 'github-release.mjs'));
  writeFileSync(join(dir, 'public-publishing'), `# test\n${lock}\n`);
  return join(dir, 'github-release.mjs');
}
const script = scriptWith('open');
const locked = scriptWith('locked');

function fakeGitHub() {
  const state = { releases: [], nextId: 1, requests: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    let m;
    if (req.method === 'GET' && url.pathname === '/repos/Cenacle-TR/cenacle/releases')
      return send(200, state.releases);
    if (req.method === 'POST' && url.pathname === '/repos/Cenacle-TR/cenacle/releases') {
      const input = JSON.parse(body);
      const release = { id: state.nextId++, assets: [], ...input };
      state.releases.unshift(release);
      return send(201, release);
    }
    if (
      (m = url.pathname.match(/^\/repos\/Cenacle-TR\/cenacle\/releases\/(\d+)\/assets$/)) &&
      req.method === 'POST'
    ) {
      const release = state.releases.find((r) => r.id === Number(m[1]));
      const id = state.nextId++;
      const asset = {
        id,
        name: url.searchParams.get('name'),
        size: body.length,
        digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        url: `http://${req.headers.host}/download/${id}`,
        data: body.toString(),
      };
      release.assets.push(asset);
      return send(201, asset);
    }
    if (
      (m = url.pathname.match(/^\/repos\/Cenacle-TR\/cenacle\/releases\/assets\/(\d+)$/)) &&
      req.method === 'DELETE'
    ) {
      for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(m[1]));
      return send(204);
    }
    if ((m = url.pathname.match(/^\/download\/(\d+)$/))) {
      const asset = state.releases.flatMap((r) => r.assets).find((a) => a.id === Number(m[1]));
      res.writeHead(200);
      return res.end(asset.data);
    }
    if (
      (m = url.pathname.match(/^\/repos\/Cenacle-TR\/cenacle\/releases\/(\d+)$/)) &&
      req.method === 'PATCH'
    ) {
      const release = state.releases.find((r) => r.id === Number(m[1]));
      Object.assign(release, JSON.parse(body));
      return send(200, release);
    }
    send(404, { message: 'Not Found' });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

function run(url, args, env = {}, path = script) {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      [path, ...args],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_API_URL: url,
          GITHUB_UPLOAD_URL: url,
          GITHUB_RELEASE_TOKEN: 'test',
          CI_COMMIT_TAG: 'v1.0.0',
          CI_COMMIT_SHA: 'abc123',
          PUBLIC_SOURCE: 'https://github.com/Cenacle-TR/cenacle.git',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }),
    ),
  );
}

function files(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'github-release-'));
  return Object.entries(contents).map(([name, text]) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  });
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

test('jobs add files to one draft, which is published once complete', async () => {
  const gh = await fakeGitHub();
  try {
    const setup = 'installer';
    const [exe, sums, latest, sig, linux, index] = files({
      'Cenacle-1.0.0-setup.exe': setup,
      SHA256SUMS: `${sha(setup)}  Cenacle-1.0.0-setup.exe\n`,
      'latest.yml': 'version: 1.0.0',
      'latest.yml.sig': 'sig',
      'latest-linux.yml': 'version: 1.0.0',
      'index.json': '{}',
    });
    assert.equal((await run(gh.url, ['upload', exe, sums, latest, sig, linux, index])).code, 0);
    assert.equal(gh.state.releases.length, 1);
    assert.equal(gh.state.releases[0].draft, true);
    assert.equal(gh.state.releases[0].target_commitish, 'abc123');

    // Not yet signed, no SBOM: stays a draft.
    let r = await run(gh.url, ['publish']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /missing: SHA256SUMS\.sigstore\.json, \*\.spdx\.json/);
    assert.equal(gh.state.releases[0].draft, true);

    const [bundle, sbom] = files({
      'SHA256SUMS.sigstore.json': '{}',
      'cenacle-server-1.0.0-linux-amd64.spdx.json': '{}',
    });
    assert.equal((await run(gh.url, ['upload', bundle])).code, 0);
    assert.equal((await run(gh.url, ['upload', sbom])).code, 0);
    // The same release, not a second one.
    assert.equal(gh.state.releases.length, 1);

    r = await run(gh.url, ['publish']);
    assert.equal(r.code, 0, r.out);
    assert.equal(gh.state.releases[0].draft, false);
    assert.equal(gh.state.releases[0].make_latest, 'true');

    // A published release is never changed.
    r = await run(gh.url, ['upload', exe]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /already published/);
  } finally {
    gh.server.close();
  }
});

test('a file the checksums list but the release lacks stops publishing', async () => {
  const gh = await fakeGitHub();
  try {
    const [sums, ...rest] = files({
      SHA256SUMS: `${sha('x')}  Cenacle-1.0.0-amd64.deb\n`,
      'SHA256SUMS.sigstore.json': '{}',
      'latest.yml': '',
      'latest.yml.sig': '',
      'latest-linux.yml': '',
      'index.json': '{}',
      'a.spdx.json': '{}',
    });
    await run(gh.url, ['upload', sums, ...rest]);
    const r = await run(gh.url, ['publish']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /missing: Cenacle-1\.0\.0-amd64\.deb/);
  } finally {
    gh.server.close();
  }
});

test('re-uploading a file to the draft replaces it', async () => {
  const gh = await fakeGitHub();
  try {
    const [first] = files({ 'index.json': 'one' });
    const [second] = files({ 'index.json': 'two' });
    await run(gh.url, ['upload', first]);
    assert.equal((await run(gh.url, ['upload', second])).code, 0);
    const assets = gh.state.releases[0].assets;
    assert.equal(assets.length, 1);
    assert.equal(assets[0].data, 'two');
  } finally {
    gh.server.close();
  }
});

test('without a token nothing is published and the job passes', async () => {
  const gh = await fakeGitHub();
  try {
    const r = await run(gh.url, ['publish'], { GITHUB_RELEASE_TOKEN: '' });
    assert.equal(r.code, 0);
    assert.match(r.out, /not set/);
    assert.deepEqual(gh.state.requests, []);
  } finally {
    gh.server.close();
  }
});

test('while public publishing is locked nothing reaches GitHub, token or not', async () => {
  const gh = await fakeGitHub();
  try {
    const [exe] = files({ 'Cenacle-0.99.5-setup.exe': 'exe' });
    for (const args of [['upload', exe], ['publish']]) {
      const r = await run(gh.url, args, { CI_COMMIT_TAG: 'v0.99.5' }, locked);
      assert.equal(r.code, 0);
      assert.match(r.out, /locked/);
    }
    assert.deepEqual(gh.state.requests, []);
  } finally {
    gh.server.close();
  }
});
