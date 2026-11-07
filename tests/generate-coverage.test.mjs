import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render, writeCoverage } from '../plugins/grc-engineer/scripts/generate-coverage.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const oldDate = new Date('2026-08-09T04:00:00Z');
const newDate = new Date('2026-11-01T04:00:00Z');
function fixture() {
  return {
    scfFrameworks: [
      { framework_id: 'general-alpha', display_name: 'Alpha', scf_controls_mapped: 10, framework_controls_mapped: 12 },
      { framework_id: 'general-beta', display_name: 'Beta', scf_controls_mapped: 20, framework_controls_mapped: 24 },
    ],
    shipped: {
      plugins: new Map([['general-alpha', { slug: 'alpha', depth: 'stub', display_name: 'Alpha' }]]),
      unmapped: [{ slug: 'custom', description: 'Custom baseline' }],
    },
  };
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grc-coverage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a date-only regeneration preserves bytes and mtime', async t => {
  const out = path.join(await temp(t), 'coverage.md');
  const before = render({ ...fixture(), generatedAt: oldDate });
  assert.equal(await writeCoverage(out, before), true);
  await fs.utimes(out, oldDate, oldDate);
  const stat = await fs.stat(out);
  assert.equal(await writeCoverage(out, render({ ...fixture(), generatedAt: newDate })), false);
  assert.equal(await fs.readFile(out, 'utf8'), before);
  assert.equal((await fs.stat(out)).mtimeMs, stat.mtimeMs);
});

const changes = {
  'SCF mapping counts': data => { data.scfFrameworks[1].scf_controls_mapped++; },
  'framework control counts': data => { data.scfFrameworks[1].framework_controls_mapped++; },
  'framework metadata': data => { data.scfFrameworks[0].display_name = 'Alpha revised'; },
  'framework additions': data => { data.scfFrameworks.push({ framework_id: 'general-gamma', display_name: 'Gamma', scf_controls_mapped: 1, framework_controls_mapped: 2 }); },
  'plugin coverage': data => { data.shipped.plugins.set('general-beta', { slug: 'beta', depth: 'reference', display_name: 'Beta' }); },
  'plugin SCF reassignment': data => { const plugin = data.shipped.plugins.get('general-alpha'); data.shipped.plugins.delete('general-alpha'); data.shipped.plugins.set('general-beta', plugin); },
  'plugin depth': data => { data.shipped.plugins.get('general-alpha').depth = 'full'; },
  'unmapped plugin metadata': data => { data.shipped.unmapped[0].description = 'Revised baseline'; },
};
for (const [name, change] of Object.entries(changes)) {
  test(`${name} still updates the document and date`, async t => {
    const out = path.join(await temp(t), 'coverage.md');
    await writeCoverage(out, render({ ...fixture(), generatedAt: oldDate }));
    const data = fixture();
    change(data);
    const expected = render({ ...data, generatedAt: newDate });
    assert.equal(await writeCoverage(out, expected), true);
    assert.equal(await fs.readFile(out, 'utf8'), expected);
    assert.match(expected, /Last generated: 2026-11-01/);
    assert.equal(await writeCoverage(out, render({ ...data, generatedAt: oldDate })), false);
  });
}

test('write errors propagate instead of being treated as unchanged', async t => {
  const dir = await temp(t);
  await assert.rejects(writeCoverage(dir, 'coverage'), { code: 'EISDIR' });
});

test('offline CLI leaves no Git diff for unchanged coverage; real SCF and plugin changes remain PR-eligible', async t => {
  const dir = await temp(t);
  const scripts = 'plugins/grc-engineer/scripts';
  await fs.mkdir(path.join(dir, scripts), { recursive: true });
  for (const file of ['generate-coverage.js', 'scf-client.js']) {
    await fs.copyFile(path.join(root, scripts, file), path.join(dir, scripts, file));
  }
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  const manifest = path.join(dir, 'plugins/frameworks/alpha/.claude-plugin/plugin.json');
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  const plugin = { framework_metadata: { scf_framework_id: 'general-alpha', depth: 'stub' } };
  await fs.writeFile(manifest, JSON.stringify(plugin));
  await fs.mkdir(path.join(dir, 'docs'));
  const cache = path.join(dir, 'cache');
  await fs.mkdir(path.join(cache, '_unknown/api'), { recursive: true });
  await fs.mkdir(path.join(cache, 'test/api'), { recursive: true });
  await fs.writeFile(path.join(cache, '_unknown/api/summary.json'), '{"scf_version":"test"}');
  const index = path.join(cache, 'test/api/crosswalks.json');
  const data = fixture();
  await fs.writeFile(index, JSON.stringify({ frameworks: data.scfFrameworks }));
  const run = () => execFileSync(process.execPath, [`${scripts}/generate-coverage.js`, '--offline'], {
    cwd: dir, env: { ...process.env, CLAUDE_GRC_SCF_CACHE: cache }, encoding: 'utf8',
  });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const doc = 'docs/FRAMEWORK-COVERAGE.md';
  git('init', '--quiet');
  run();
  const baseline = (await fs.readFile(path.join(dir, doc), 'utf8')).replace(/^Last generated: .*$/m, 'Last generated: 2026-08-09');
  await fs.writeFile(path.join(dir, doc), baseline);
  git('add', doc);
  git('-c', 'user.name=Coverage test', '-c', 'user.email=coverage@example.invalid', 'commit', '--quiet', '-m', 'baseline');
  const diffStatus = () => spawnSync('git', ['diff', '--exit-code', '--', doc], { cwd: dir }).status;
  assert.match(run(), /Unchanged docs\/FRAMEWORK-COVERAGE.md/);
  assert.equal(diffStatus(), 0, 'no diff for create-pull-request to publish');
  data.scfFrameworks[1].scf_controls_mapped++;
  await fs.writeFile(index, JSON.stringify({ frameworks: data.scfFrameworks }));
  assert.match(run(), /Wrote docs\/FRAMEWORK-COVERAGE.md/);
  assert.equal(diffStatus(), 1, 'SCF change produces the document diff consumed by the PR action');
  git('add', doc);
  git('-c', 'user.name=Coverage test', '-c', 'user.email=coverage@example.invalid', 'commit', '--quiet', '-m', 'SCF update');
  plugin.framework_metadata.depth = 'full';
  await fs.writeFile(manifest, JSON.stringify(plugin));
  run();
  assert.equal(diffStatus(), 1, 'plugin change also produces a PR-eligible diff');
  assert.match(await fs.readFile(path.join(dir, doc), 'utf8'), /\| full \|/);
});

test('weekly workflow tests the generator and publishes its document through the PR action', async () => {
  const workflow = await fs.readFile(path.join(root, '.github/workflows/coverage-update.yml'), 'utf8');
  assert.match(workflow, /cron: '0 4 \* \* SUN'/);
  assert.match(workflow, /run: node --test tests\/generate-coverage\.test\.mjs/);
  assert.match(workflow, /run: node plugins\/grc-engineer\/scripts\/generate-coverage\.js/);
  assert.match(workflow, /uses: peter-evans\/create-pull-request@v6/);
  assert.match(workflow, /add-paths: docs\/FRAMEWORK-COVERAGE\.md/);
  assert.match(workflow, /branch: bot\/regenerate-coverage/);
  assert.match(workflow, /delete-branch: true/);
  assert.doesNotMatch(workflow, /^\s+if:/m, 'no no-op gate that would prevent stale PR cleanup');
});
