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
} catch (e) {
  check('sync section ran without throwing', false, e && e.stack);
}

// ---- push target: by remote name only when it is the vetted URL; the pre-push hook always runs.
// Offline: local bare repos stand in for GitHub, and a tiny pre-push hook stands in for a
// private-info scanner that, like oss-guard, skips commits the named remote already has.
function gitOut(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const MARK = ['PRIVATE', 'MARKER'].join('-');
const HOOK = `#!/bin/sh
# test guard: block any pushed commit whose patch contains the marker; with a remote NAME,
# skip the commits that remote already has (git rev-list --not --remotes=<name>)
remote="$1"
not=""
if git remote | grep -qx "$remote"; then not="--not --remotes=$remote"; fi
while read lref lsha rref rsha; do
  case "$lsha" in 0000000000000000000000000000000000000000) continue ;; esac
  for c in $(git rev-list "$lsha" $not); do
    if git show "$c" | grep -q "${MARK}"; then echo "test-guard: BLOCKED $c" >&2; exit 1; fi
  done
done
exit 0
`;
async function pushTargetTests() {
  const ct = require(TOOL);
  const base = path.join(tmp, 'push');
  fs.mkdirSync(base);

  // canPushByName: plain git config only, no network
  const GH = 'https://github.com/example-org/fine.git';
  const cfgRepo = (name, setup) => {
    const dir = repoWithOrigin(`cpbn-${name}`, GH);
    for (const a of setup || []) git(a, dir);
    return { root: dir, pushUrl: GH, name: 'example-org/fine' };
  };
  check('by name: one push URL that is the vetted URL', await ct.canPushByName(cfgRepo('plain')) === true);
  check('by URL: a second push URL (a by-name push would go to both)',
    await ct.canPushByName(cfgRepo('two', [['remote', 'set-url', '--add', '--push', 'origin', GH], ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/example-org/other.git']])) === false);
  check('by URL: push URL differs from the vetted one',
    await ct.canPushByName({ ...cfgRepo('differs'), pushUrl: 'https://github.com/example-org/other.git' }) === false);
  check('by URL: push URL is a different repo than repo.name',
    await ct.canPushByName({ ...cfgRepo('name'), name: 'example-org/other' }) === false);
  check('by URL: remote.origin.mirror=true', await ct.canPushByName(cfgRepo('mirror', [['config', 'remote.origin.mirror', 'true']])) === false);
  check('by URL: remote.origin.vcs set', await ct.canPushByName(cfgRepo('vcs', [['config', 'remote.origin.vcs', 'x']])) === false);
  check('by URL: not a github.com URL', await ct.canPushByName({ root: repoWithOrigin('cpbn-local', path.join(base, 'nowhere.git')), pushUrl: path.join(base, 'nowhere.git'), name: 'example-org/fine' }) === false);

  // pushSnapshot against a bare remote, with the test guard as the pre-push hook
  const bare = path.join(base, 'remote.git');
  git(['init', '-q', '--bare', bare], base);
  const hooks = path.join(base, 'hooks');
  const noHooks = path.join(base, 'no-hooks');
  fs.mkdirSync(hooks); fs.mkdirSync(noHooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), HOOK);
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  for (const a of [['init', '-q', '-b', 'main', '.'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'],
    ['config', 'core.autocrlf', 'false'], ['config', 'core.hooksPath', hooks], ['remote', 'add', 'origin', bare]]) git(a, work);
  const commit = (file, text, msg) => { fs.writeFileSync(path.join(work, file), text); git(['add', file], work); git(['commit', '-q', '-m', msg], work); };
  // an old fixture with the marker, already on the remote (pushed before the guard existed)
  commit('fixture.txt', `${MARK}\n`, 'old fixture');
  git(['-c', `core.hooksPath=${noHooks}`, 'push', '-q', 'origin', 'main'], work);
  commit('clean.txt', 'ok\n', 'local unpushed clean commit');
  git(['branch', 'extra'], work); // must never be pushed: a widened refspec would carry it
  git(['config', 'remote.origin.push', '+refs/heads/*:refs/heads/*'], work);
  const snapshot = () => gitOut(['commit-tree', gitOut(['rev-parse', 'HEAD^{tree}'], work), '-p', 'HEAD', '-m', 'cloudtest snapshot'], work);
  const repo = { root: work, pushUrl: bare, name: null };
  const remoteRefs = () => gitOut(['ls-remote', bare], work);
  const tryPush = async (sha, ref, byName) => { try { await ct.pushSnapshot(repo, sha, ref, byName); return null; } catch (e) { return String(e.message); } };

  const snap1 = snapshot();
  let err = await tryPush(snap1, 'refs/heads/cloudtest/smoke-url', false);
  check('by URL the hook rescans all history and blocks on the old pushed fixture (the bug)', err && /test-guard: BLOCKED/.test(err), err);
  err = await tryPush(snap1, 'refs/heads/cloudtest/smoke-name', true);
  check('by name the hook skips what origin has: clean snapshot pushes', err === null, err);
  const refs = remoteRefs();
  check('by name pushes exactly the one ref (remote.origin.push does not widen it)',
    /refs\/heads\/cloudtest\/smoke-name/.test(refs) && !/refs\/heads\/extra/.test(refs) && refs.split('\n').length === 2, refs);
  check('by name records the remote-tracking ref', gitOut(['rev-parse', 'refs/remotes/origin/cloudtest/smoke-name'], work) === snap1);
  await ct.dropTrackingRef(repo, 'refs/heads/cloudtest/smoke-name', snap1);
  check('dropTrackingRef deletes it', spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/remotes/origin/cloudtest/smoke-name'], { cwd: work }).status !== 0);

  // a NEW commit carrying the marker is still blocked by name
  commit('new.txt', `leak ${MARK}\n`, 'new private commit');
  const snap2 = snapshot();
  err = await tryPush(snap2, 'refs/heads/cloudtest/smoke-new', true);
  check('by name the hook still blocks a NEW commit with private info', err && /test-guard: BLOCKED/.test(err), err);
  check('and nothing reached the remote', !/smoke-new/.test(remoteRefs()));
  check('and no tracking ref was written', spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/remotes/origin/cloudtest/smoke-new'], { cwd: work }).status !== 0);
  git(['reset', '-q', '--hard', 'HEAD~1'], work);

  // private info only in the snapshot commit itself (an uncommitted file) is blocked too
  fs.writeFileSync(path.join(work, 'wip.txt'), `wip ${MARK}\n`);
  git(['add', 'wip.txt'], work);
  const tree3 = gitOut(['write-tree'], work);
  const snap3 = gitOut(['commit-tree', tree3, '-p', 'HEAD', '-m', 'cloudtest snapshot'], work);
  err = await tryPush(snap3, 'refs/heads/cloudtest/smoke-wip', true);
  check('by name the hook blocks private info in the snapshot commit itself', err && /test-guard: BLOCKED/.test(err), err);

  err = await tryPush(snap1, 'refs/heads/main', true);
  check('a non-cloudtest ref is still refused', err && /internal safety stop/.test(err), err);
}

// ---- recipe "githubToken": opt-in GITHUB_TOKEN = the job's own token in the job env. Offline:
// parseArgs + buildJob in-process against temp recipes; nothing is pushed.
function githubTokenTests() {
  const dir = path.join(tmp, 'recipes-token');
  fs.mkdirSync(dir);
  const base = { repo: 'me/proj', command: 'npm test' };
  fs.writeFileSync(path.join(dir, 'tok-on.json'), JSON.stringify({ ...base, githubToken: true }));
  fs.writeFileSync(path.join(dir, 'tok-off.json'), JSON.stringify({ ...base, githubToken: false }));
  fs.writeFileSync(path.join(dir, 'tok-unset.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'tok-bad.json'), JSON.stringify({ ...base, githubToken: 'yes' }));
  process.env.CLOUDTEST_RECIPES_DIR = dir; // read once, when cloudtest.js is first required
  process.env.CLOUDTEST_CONFIG = noConfig;
  const ct = require(TOOL);
  const LINE = '      GITHUB_TOKEN: ${{ github.token }}';
  const job = (args) => ct.buildJob(ct.parseArgs(args), {}, { id: 'smoke', head: null });
  const wf = (args) => job(args).files['.github/workflows/cloudtest.yml'];
  const on = wf(['--recipe', 'tok-on']);
  check('githubToken true: the job env has GITHUB_TOKEN = github.token', on.split('\n').includes(LINE), on);
  const env = on.slice(on.indexOf('    env:\n'), on.indexOf('    steps:'));
  check('githubToken true: the line sits in the job env, next to CLOUDTEST', env.includes(LINE) && env.includes("CLOUDTEST: '1'"), env);
  check('githubToken true: permissions stay contents: read', /^permissions:\n {2}contents: read\njobs:/m.test(on), on);
  check('githubToken true: checkout still has persist-credentials: false', /persist-credentials: false/.test(on));
  check('githubToken true: options.json says so, without any token value',
    /"githubToken": "job token/.test(job(['--recipe', 'tok-on']).files['.cloudtest-job/options.json']));
  for (const n of ['tok-off', 'tok-unset']) {
    check(`githubToken ${n === 'tok-off' ? 'false' : 'unset'}: no GITHUB_TOKEN anywhere in the workflow`, !/GITHUB_TOKEN|github\.token/.test(wf(['--recipe', n])));
  }
  check('no recipe: no GITHUB_TOKEN in the workflow', !/GITHUB_TOKEN|github\.token/.test(wf(['--', 'true'])));
  let err = null;
  try { ct.parseArgs(['--recipe', 'tok-bad']); } catch (e) { err = e.message; }
  check('githubToken must be true or false', err && /"githubToken" must be true or false/.test(err), err);
}
try { githubTokenTests(); } catch (e) { check('githubToken section ran without throwing', false, e && e.stack); }

pushTargetTests().catch((e) => check('push-target section ran without throwing', false, e && e.stack)).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
