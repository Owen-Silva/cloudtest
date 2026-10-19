#!/usr/bin/env node
// Offline smoke test for cloudtest: help, recipe loading/merging, and the deny-list guard.
// It never contacts GitHub: every repo check here is refused (or fails) before any `gh` call.
// Your own config.local.json and recipes.local/ are NOT used: each case points
// CLOUDTEST_CONFIG and CLOUDTEST_RECIPES_DIR at temp files.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'cloudtest.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudtest-smoke-'));
const emptyRecipes = path.join(tmp, 'recipes-empty');
fs.mkdirSync(emptyRecipes);
const noConfig = path.join(tmp, 'config-empty.json');
fs.writeFileSync(noConfig, '{}\n');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`ok   ${name}`); } else { failed++; console.log(`FAIL ${name}${detail ? `\n     ${String(detail).trim().split('\n').join('\n     ')}` : ''}`); }
}
function cloudtest(args, { cwd = tmp, env = {} } = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLOUDTEST_CONFIG: noConfig, CLOUDTEST_RECIPES_DIR: emptyRecipes, CLOUDTEST_DENY_REPOS: '', MSYS_NO_PATHCONV: '1', ...env },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}
function repoWithOrigin(name, origin, pushUrl) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(['init', '-q', '.'], dir);
  git(['remote', 'add', 'origin', origin], dir);
  if (pushUrl) git(['remote', 'set-url', '--push', 'origin', pushUrl], dir);
  return dir;
}

try {
  let r = cloudtest(['--help']);
  check('--help exits 0 and shows usage', r.code === 0 && /usage/.test(r.out), r.out);

  r = cloudtest(['--recipes']);
  check('--recipes lists the published example', r.code === 0 && /example-node-playwright/.test(r.out), r.out);

  const local = path.join(tmp, 'recipes-local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'mine.json'), JSON.stringify({ description: 'LOCAL-ONE', repo: 'me/proj', command: 'npm test' }));
  fs.writeFileSync(path.join(local, 'example-node-playwright.json'), JSON.stringify({ description: 'LOCAL-OVERRIDE', repo: 'me/proj', command: 'true' }));
  r = cloudtest(['--recipes'], { env: { CLOUDTEST_RECIPES_DIR: local } });
  check('local recipes are merged with published ones', r.code === 0 && /LOCAL-ONE/.test(r.out), r.out);
  check('a local recipe shadows a published one of the same name', /LOCAL-OVERRIDE/.test(r.out) && !/EXAMPLE:/.test(r.out), r.out);

  r = cloudtest(['--recipe', 'does-not-exist']);
  check('unknown recipe exits 125', r.code === 125 && /no recipe "does-not-exist"/.test(r.out), r.out);

  r = cloudtest(['--recipe', '../escape']);
  check('recipe names with paths are refused', r.code === 125 && /no paths/.test(r.out), r.out);

  const denyCfg = path.join(tmp, 'config-deny.json');
  fs.writeFileSync(denyCfg, JSON.stringify({ denyRepos: ['Example-Org/Prod-Site'] }));
  const denied = repoWithOrigin('denied', 'git@github.com:example-org/prod-site.git');
  r = cloudtest(['--dry-run', '--', 'echo hi'], { cwd: denied, env: { CLOUDTEST_CONFIG: denyCfg } });
  check('config deny list refuses the repo (case-insensitive)', r.code === 125 && /REFUSED: origin is example-org\/prod-site/.test(r.out), r.out);

  r = cloudtest(['--dry-run', '--', 'echo hi'], { cwd: denied, env: { CLOUDTEST_DENY_REPOS: 'other/x, example-org/prod-site' } });
  check('CLOUDTEST_DENY_REPOS refuses the repo', r.code === 125 && /REFUSED/.test(r.out), r.out);

  const pushOnly = repoWithOrigin('push-only', 'https://github.com/example-org/fine.git', 'https://github.com/example-org/prod-site.git');
  r = cloudtest(['--dry-run', '--', 'echo hi'], { cwd: pushOnly, env: { CLOUDTEST_CONFIG: denyCfg } });
  check('a deny-listed PUSH url is refused too', r.code === 125 && /REFUSED: origin is example-org\/prod-site/.test(r.out), r.out);

  const badCfg = path.join(tmp, 'config-bad.json');
  fs.writeFileSync(badCfg, '{ not json');
  r = cloudtest(['--dry-run', '--', 'echo hi'], { cwd: denied, env: { CLOUDTEST_CONFIG: badCfg } });
  check('an unparseable config fails closed', r.code === 125 && /cannot read it/.test(r.out), r.out);

  r = cloudtest(['--dry-run', '--', 'echo hi'], { cwd: denied, env: { CLOUDTEST_CONFIG: path.join(tmp, 'missing.json') } });
  check('a CLOUDTEST_CONFIG pointing at a missing file fails closed', r.code === 125 && /does not exist/.test(r.out), r.out);

  r = cloudtest(['--dry-run', '--', 'echo hi'], { cwd: tmp });
  check('outside a git repo exits 125', r.code === 125 && /not inside a git repository/.test(r.out), r.out);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
