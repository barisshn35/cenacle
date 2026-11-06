#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Publishes a release's files on the public repository's GitHub Releases
// (docs/install/desktop.md, docs/operations/ci.md). The jobs of a v* tag
// pipeline each upload their files to one draft release of that tag; the
// last job checks that everything is there and publishes it:
//
//   github-release.mjs upload <file>...   add files to the tag's draft release
//   github-release.mjs publish            check the draft and publish it
//
// Needs GITHUB_RELEASE_TOKEN (a token that may write the repository's
// contents; without it nothing is published and the job passes), CI_COMMIT_TAG
// and CI_COMMIT_SHA; the repository comes from PUBLIC_SOURCE. An asset of the
// same name is replaced only while the release is a draft: a published
// release is never changed. Nothing is sent to GitHub while public publishing
// is locked (ci/public-publishing next to this script, ci/public-gate.sh).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

// The same reading as ci/public-gate.sh: the first word that is not a comment.
function publishingOpen() {
  try {
    const text = readFileSync(new URL('./public-publishing', import.meta.url), 'utf8');
    const words = text
      .split('\n')
      .map((l) => l.replace(/#.*/, '').replace(/\s/g, ''))
      .filter(Boolean);
    return words[0] === 'open';
  } catch {
    return false;
  }
}

const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const uploads = process.env.GITHUB_UPLOAD_URL ?? 'https://uploads.github.com';
const token = process.env.GITHUB_RELEASE_TOKEN;
const tag = process.env.CI_COMMIT_TAG;
const repo = (process.env.PUBLIC_SOURCE ?? '')
  .replace(/^https:\/\/github\.com\//, '')
  .replace(/\.git$/, '');

const fail = (message) => {
  console.error(`github-release: ${message}`);
  process.exit(1);
};

async function call(method, url, body, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      body,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...headers,
      },
    });
    // GitHub answers 5xx now and then; the request is the same, so try again.
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}

// Drafts are not found by tag (GET /releases/tags/<tag> skips them): look
// through the list, newest first.
async function findRelease() {
  for (let page = 1; page <= 10; page++) {
    const { status, json } = await call(
      'GET',
      `${api}/repos/${repo}/releases?per_page=100&page=${page}`,
    );
    if (status !== 200) fail(`listing releases: HTTP ${status}`);
    const found = json.find((r) => r.tag_name === tag);
    if (found || json.length < 100) return found ?? null;
  }
  return null;
}

async function draftRelease() {
  let release = await findRelease();
  if (release) return release;
  const version = tag.replace(/^v/, '');
  const { status, json } = await call(
    'POST',
    `${api}/repos/${repo}/releases`,
    JSON.stringify({
      tag_name: tag,
      target_commitish: process.env.CI_COMMIT_SHA,
      name: `Cenacle ${version}`,
      body:
        `Cenacle ${version}: what changed is in CHANGELOG.md, how to upgrade in docs/upgrade/README.md, ` +
        'how to verify these files in docs/security/README.md (Verifying a release).',
      draft: true,
      prerelease: version.includes('-'),
    }),
    { 'content-type': 'application/json' },
  );
  if (status === 201) return json;
  // Another job of the pipeline made it in the meantime.
  if (status === 422 && (release = await findRelease())) return release;
  fail(`creating the release of ${tag}: HTTP ${status}`);
}

async function upload(files) {
  const release = await draftRelease();
  if (!release.draft) fail(`the release of ${tag} is already published: not changing it`);
  for (const file of files) {
    const name = basename(file);
    const data = readFileSync(file);
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    const old = release.assets.find((a) => a.name === name);
    if (old) {
      const { status } = await call('DELETE', `${api}/repos/${repo}/releases/assets/${old.id}`);
      if (status !== 204) fail(`replacing ${name}: HTTP ${status}`);
    }
    const { status, json } = await call(
      'POST',
      `${uploads}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      data,
      { 'content-type': 'application/octet-stream', 'content-length': String(statSync(file).size) },
    );
    if (status !== 201) fail(`uploading ${name}: HTTP ${status}`);
    // GitHub may rename an asset (spaces, some characters): the update
    // files name the installers, so a renamed file would not be found.
    if (json.name !== name) fail(`GitHub stored ${name} as ${json.name}`);
    if (json.size !== data.length || (json.digest && json.digest !== digest)) {
      fail(`${name} arrived changed (size ${json.size}, ${json.digest})`);
    }
    console.log(`github-release: ${name} (${data.length} bytes, ${digest})`);
  }
}

// What a release must hold before it is published: the signed checksums, the
// update files with their signatures, the SBOMs, and every file the checksums
// list.
async function publish() {
  const release = await findRelease();
  if (!release) fail(`no draft release of ${tag}`);
  if (!release.draft) return console.log(`github-release: ${tag} is already published`);
  const names = new Set(release.assets.map((a) => a.name));
  const missing = [
    'SHA256SUMS',
    'SHA256SUMS.sigstore.json',
    'latest.yml',
    'latest.yml.sig',
    'index.json',
  ].filter((n) => !names.has(n));
  if (![...names].some((n) => /^latest-linux.*\.yml$/.test(n))) missing.push('latest-linux*.yml');
  if (![...names].some((n) => n.endsWith('.spdx.json'))) missing.push('*.spdx.json');
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS');
  if (sums) {
    const res = await fetch(sums.url, {
      headers: { accept: 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    if (!res.ok) fail(`reading SHA256SUMS: HTTP ${res.status}`);
    for (const line of (await res.text()).split('\n')) {
      const [hash, file] = line.trim().split(/\s+\*?/);
      if (!file) continue;
      const asset = release.assets.find((a) => a.name === file);
      if (!asset) missing.push(file);
      else if (asset.digest && asset.digest !== `sha256:${hash}`)
        fail(`${file} is not the file SHA256SUMS lists`);
    }
  }
  if (missing.length) fail(`not publishing ${tag}, missing: ${missing.join(', ')}`);
  const { status } = await call(
    'PATCH',
    `${api}/repos/${repo}/releases/${release.id}`,
    JSON.stringify({ draft: false, make_latest: release.prerelease ? 'false' : 'true' }),
    { 'content-type': 'application/json' },
  );
  if (status !== 200) fail(`publishing ${tag}: HTTP ${status}`);
  console.log(`github-release: published ${tag} with ${names.size} files`);
}

const [command, ...files] = process.argv.slice(2);
if (!publishingOpen()) {
  console.log(
    'public publishing is locked (ci/public-publishing): nothing published on GitHub Releases',
  );
  process.exit(0);
}
if (!token) {
  console.log('GITHUB_RELEASE_TOKEN is not set: nothing published on GitHub Releases');
  process.exit(0);
}
if (!/^v\d/.test(tag ?? '')) fail('CI_COMMIT_TAG is not a version tag');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
  fail(`PUBLIC_SOURCE does not name a GitHub repository: ${repo}`);
if (command === 'upload' && files.length) await upload(files);
else if (command === 'publish') await publish();
else fail('usage: github-release.mjs upload <file>... | publish');
