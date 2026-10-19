#!/usr/bin/env node
// cloudtest: run a test command on a GitHub Actions hosted runner instead of
// this machine. Snapshots the current working tree (uncommitted + untracked,
// not ignored) WITHOUT touching the real index/HEAD/branch/stash, pushes it to
// a throwaway refs/heads/cloudtest/* branch, watches the run, downloads the
// log + artifacts, deletes the branch, and exits with the test's exit code.
//
// See README.md next to this file.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------- constants
// Personal settings live OUTSIDE the published files: an untracked config.local.json next to
// this file (gitignored), or the file named by CLOUDTEST_CONFIG. See README "Configure".
const CONFIG_FILE = process.env.CLOUDTEST_CONFIG || path.join(__dirname, 'config.local.json');
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const BRANCH_PREFIX = 'cloudtest/';
const SAFE_REF_RE = /^refs\/heads\/cloudtest\/[A-Za-z0-9._-]+$/;
const JOB_DIR = '.cloudtest-job';
const WORKFLOW_PATH = '.github/workflows/cloudtest.yml';
const ARTIFACT_NAME = 'cloudtest-artifacts';
const MARK_BEGIN = '@@cloudtest-begin@@';
const MARK_EXIT_RE = /^@@cloudtest-exit=(\d+)@@$/;
const TOOL_ERROR_EXIT = 125; // cloudtest itself failed before/around the run
const POLL_MS = 5000;
const ACTIONS = {
  checkout: 'actions/checkout@v7',
  node: 'actions/setup-node@v7',
  python: 'actions/setup-python@v7',
  upload: 'actions/upload-artifact@v7',
};
// Files that must never ride along in a snapshot unless already committed.
const SECRET_NAME_RES = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$|defaults$)[^/]+$/i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials\.json$/i, /^service-account.*\.json$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i,
];
// Stricter rules for --include (force-adding gitignored paths): no exceptions.
const INCLUDE_SECRET_RES = [/^\.env/i, /\.pem$/i, /\.key$/i, /secret/i, /token/i, /credential/i];
const isSecretName = (base, strict) =>
  SECRET_NAME_RES.some((re) => re.test(base)) || (strict && INCLUDE_SECRET_RES.some((re) => re.test(base)));
// Recipes (--recipe <name>): published examples in recipes/ next to this file, plus your own in an
// untracked local dir (recipes.local/ next to this file, gitignored, or CLOUDTEST_RECIPES_DIR).
// Both are merged; a local recipe wins over a published one with the same name.
const RECIPES_DIR = path.join(__dirname, 'recipes');
const LOCAL_RECIPES_DIR = path.resolve(process.env.CLOUDTEST_RECIPES_DIR || path.join(__dirname, 'recipes.local'));
const RECIPE_DIRS = [...new Set([LOCAL_RECIPES_DIR, RECIPES_DIR])];
const RECIPE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECIPE_KEYS = new Set(['description', 'repo', 'os', 'node', 'python', 'setup', 'setupFile', 'include', 'artifacts',
  'timeout', 'env', 'command', 'verified', 'shell', 'install', 'display', 'fetchDepth']);
const SETUP_FILE_DIR = '.cloudtest'; // setupFile lands at .cloudtest/setup.<ext> in the snapshot
// --env / recipe env keys whose VALUES are never printed (masked as ***).
const SECRET_KEY_RE = /secret|token|passw|pwd|key|credential|auth|cookie|session|private|signature|salt|cert/i;
const isSecretKey = (k) => SECRET_KEY_RE.test(k);
const SECRET_VALUES = []; // values of secret-looking env keys; redact() scrubs them everywhere

// ---------------------------------------------------------------- utilities
class CloudtestError extends Error {}

// User config (CONFIG_FILE, optional). Today it holds one setting:
//   { "denyRepos": ["owner/name", ...] }  repos cloudtest refuses unless --allow-deploy-repo,
//   e.g. repos that deploy to production from any pushed branch.
// CLOUDTEST_DENY_REPOS (comma separated) adds to the list. A config file that exists but
// cannot be read or parsed is an ERROR, never "no deny list": the guard fails closed.
let configCache = null;
function loadConfig() {
  if (configCache) return configCache;
  let cfg = {};
  if (process.env.CLOUDTEST_CONFIG && !fs.existsSync(CONFIG_FILE)) {
    throw new CloudtestError(`CLOUDTEST_CONFIG points at ${CONFIG_FILE}, which does not exist`);
  }
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')); } catch (e) {
      throw new CloudtestError(`config ${CONFIG_FILE}: cannot read it (${e.message}); fix or remove it`);
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new CloudtestError(`config ${CONFIG_FILE}: must be a JSON object`);
  }
  const deny = cfg.denyRepos == null ? [] : cfg.denyRepos;
  if (!Array.isArray(deny) || !deny.every((x) => typeof x === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x.trim()))) {
    throw new CloudtestError(`config ${CONFIG_FILE}: "denyRepos" must be an array of "owner/name" strings`);
  }
  const fromEnv = String(process.env.CLOUDTEST_DENY_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const x of fromEnv) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x)) throw new CloudtestError(`CLOUDTEST_DENY_REPOS: "${x}" is not "owner/name"`);
  }
  configCache = { denyRepos: [...new Set([...deny, ...fromEnv].map((x) => x.trim().toLowerCase()))] };
  return configCache;
}

function redact(s) {
  let out = String(s)
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{16,})/g, '***')
    .replace(/\b(github_pat_[A-Za-z0-9_]{16,})/g, '***')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1***@');
  for (const v of SECRET_VALUES) out = out.split(v).join('***');
  return out;
}
const say = (msg) => process.stdout.write(redact(`[cloudtest] ${msg}`) + '\n');
const warn = (msg) => process.stderr.write(redact(`[cloudtest] WARNING: ${msg}`) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Async child process (async so SIGINT cleanup can run while we wait).
let activeChildren = new Set();
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message), raw: Buffer.alloc(0) });
      return;
    }
    activeChildren.add(child);
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      activeChildren.delete(child);
      resolve({ code: -1, stdout: '', stderr: String(e.message), raw: Buffer.alloc(0) });
    });
    child.on('close', (code) => {
      activeChildren.delete(child);
      const raw = Buffer.concat(out);
      resolve({ code: code == null ? -1 : code, stdout: raw.toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), raw });
    });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
async function must(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const what = opts.what || `${cmd} ${args.slice(0, 3).join(' ')}`;
    throw new CloudtestError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
  }
  return r;
}

// ---------------------------------------------------------------- arguments
const HELP = `cloudtest - run a test command on a GitHub Actions runner instead of this PC

usage (from inside a project's git repo):
  cloudtest [options] -- <test command>
  cloudtest --recipe <name> [options] [-- <command override>]
  cloudtest --recipes

options:
  --recipe <name>        load <name>.json from your local recipes dir (recipes.local/ next to
                         cloudtest.js, or CLOUDTEST_RECIPES_DIR) or recipes/: os, node, python, setup,
                         setupFile, include, artifacts, timeout, env, command. Flags given on the
                         command line beat recipe fields; a command after -- beats the recipe command.
                         Refused when the recipe's "repo" is not this repo's origin
  --recipes              list recipes with their description and "verified" line
  --env KEY=VAL          env var for the setup and test steps (repeatable; beats recipe env per key).
                         Values of secret-looking keys (token, key, secret, passw, auth...) are never
                         printed, but they ARE stored in the pushed snapshot: do not pass real secrets
  --os linux|windows     runner OS (default linux; windows bills 2x)
  --setup "<cmd>"        extra setup command, runs after dependency install
  --artifacts "<glob>"   files to bring back (repeatable, or comma/newline separated)
  --node <ver>           set up Node <ver> (auto: lts/* when package.json exists)
  --python <ver>         set up Python <ver> (auto: 3.12 when requirements.txt/pyproject.toml exists)
  --timeout <min>        job timeout in minutes (default 30)
  --fetch-depth <n>      git history depth of the checkout (default 1; 0 = full history, for tests that git show old commits)
  --display              wrap the command in xvfb-run (Linux). Auto when electron is a dependency
  --no-display           never wrap in xvfb-run
  --no-install           skip automatic dependency install (npm ci / pip install -r)
  --shell bash|pwsh      shell for the command (default bash, on both OSes)
  --dry-run              build the snapshot, print stats, workflow and push target; push nothing
  --cleanup              only delete leftover cloudtest/* branches whose runs have finished
                         (every normal run also does this sweep first)
  --allow-deploy-repo    permit a repo on your deny list (config "denyRepos" / CLOUDTEST_DENY_REPOS;
                         those are normally refused)
  --include <path>       force-add a GITIGNORED path into the snapshot (repeatable), e.g. data/prices.
                         Refuses .env*, *.pem, *.key, names containing secret/token/credential,
                         any file over 50 MB, and a snapshot over 200 MB in total
  --allow-public         permit a PUBLIC repo (uncommitted work would be publicly visible)
  -h, --help             this text

One argument after -- is used as a shell string ("npm test && npm run e2e").
Several arguments are quoted one by one (argv preserved).
Exit code = the test command's exit code; ${TOOL_ERROR_EXIT} = cloudtest itself failed.`;

function normInclude(val) {
  const p = String(val).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const parts = p.split('/');
  if (!p || p === '.' || p.startsWith('/') || p.startsWith(':') || /^[A-Za-z]:/.test(p) || parts.includes('..') ||
      parts[0] === '.git' || parts[0] === '.cloudtest' || /[\r\n]/.test(p)) {
    throw new CloudtestError(`--include must be a path inside the repo, relative to its root (not ., .git or .cloudtest): ${val}`);
  }
  return p;
}
const splitGlobs = (val) => String(val).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function envEntry(k, v, from) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new CloudtestError(`${from}: env name must match [A-Za-z_][A-Za-z0-9_]*: ${k}`);
  if (/^(GITHUB_|RUNNER_|ACTIONS_)/i.test(k) || k.toUpperCase() === 'CLOUDTEST') {
    throw new CloudtestError(`${from}: env name ${k} is reserved by GitHub Actions / cloudtest`);
  }
  if (v === null || v === undefined || typeof v === 'object') throw new CloudtestError(`${from}: env ${k} must be a string, number or boolean`);
  const s = String(v);
  if (/[\r\n\0]/.test(s)) throw new CloudtestError(`${from}: env ${k} must be a single line`);
  return [k, s];
}
const shownEnv = (env) => Object.entries(env).map(([k, v]) => `${k}=${isSecretKey(k) ? '***' : v}`).join(' ');
const maskedEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, isSecretKey(k) ? '***' : v]));

function loadRecipe(name) {
  const n = String(name).replace(/\.json$/i, '');
  if (!RECIPE_NAME_RE.test(n)) throw new CloudtestError(`--recipe name must be letters, digits, . _ - (no paths): ${name}`);
  const dir = RECIPE_DIRS.find((d) => fs.existsSync(path.join(d, `${n}.json`)));
  if (!dir) {
    const have = listRecipeFiles().map((x) => x.name);
    throw new CloudtestError(`no recipe "${n}" (looked in ${RECIPE_DIRS.join(' and ')}). Available: ${have.length ? have.join(', ') : '(none)'}`);
  }
  const file = path.join(dir, `${n}.json`);
  let r;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    throw new CloudtestError(`recipe ${n}: invalid JSON (${e.message})`);
  }
  const from = `recipe ${n}`;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new CloudtestError(`${from}: must be a JSON object`);
  if (typeof r.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo)) {
    throw new CloudtestError(`${from}: "repo" is required, as "Owner/name"`);
  }
  if (typeof r.command !== 'string' || !r.command.trim()) throw new CloudtestError(`${from}: "command" is required (a shell string)`);
  for (const k of ['description', 'os', 'setup', 'setupFile', 'verified', 'shell']) {
    if (r[k] != null && typeof r[k] !== 'string') throw new CloudtestError(`${from}: "${k}" must be a string`);
  }
  for (const k of ['node', 'python']) { // "22" or 22; write "3.10" as a string (3.10 the number is 3.1)
    if (r[k] != null && typeof r[k] !== 'string' && typeof r[k] !== 'number') throw new CloudtestError(`${from}: "${k}" must be a version string`);
  }
  if (r.fetchDepth != null && typeof r.fetchDepth !== 'number') throw new CloudtestError(`${from}: "fetchDepth" must be a number (0 = full history)`);
  if (r.timeout != null && typeof r.timeout !== 'number') throw new CloudtestError(`${from}: "timeout" must be a number of minutes`);
  for (const k of ['include', 'artifacts']) {
    if (r[k] != null && typeof r[k] !== 'string' && !(Array.isArray(r[k]) && r[k].every((x) => typeof x === 'string'))) {
      throw new CloudtestError(`${from}: "${k}" must be a string or an array of strings`);
    }
  }
  for (const k of ['install', 'display']) {
    if (r[k] != null && typeof r[k] !== 'boolean') throw new CloudtestError(`${from}: "${k}" must be true or false`);
  }
  if (r.env != null && (typeof r.env !== 'object' || Array.isArray(r.env))) throw new CloudtestError(`${from}: "env" must be an object of KEY: value`);
  const unknown = Object.keys(r).filter((k) => !RECIPE_KEYS.has(k) && !k.startsWith('_'));
  let setupFile = null;
  if (r.setupFile) {
    const sf = r.setupFile;
    if (!RECIPE_NAME_RE.test(sf)) throw new CloudtestError(`${from}: "setupFile" must be a file name next to the recipe (no paths): ${sf}`);
    const ext = path.extname(sf).slice(1).toLowerCase();
    if (!['ps1', 'sh'].includes(ext)) throw new CloudtestError(`${from}: "setupFile" must end in .ps1 (run with pwsh) or .sh (run with bash): ${sf}`);
    const sfPath = path.join(dir, sf);
    if (!fs.existsSync(sfPath)) throw new CloudtestError(`${from}: setupFile ${sf} not found in ${dir}`);
    setupFile = { name: sf, ext, dir, content: fs.readFileSync(sfPath) };
  }
  return { ...r, name: n, file, setupFileData: setupFile, unknown };
}

// Every recipe across RECIPE_DIRS, local first; a name already seen in an earlier dir is shadowed.
function listRecipeFiles() {
  const seen = new Set();
  const out = [];
  for (const dir of RECIPE_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); } catch { continue; }
    for (const f of files) {
      const name = f.replace(/\.json$/i, '');
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ dir, file: f, name });
    }
  }
  return out;
}

function listRecipes() {
  const all = listRecipeFiles();
  if (!all.length) { process.stdout.write(`no recipes in ${RECIPE_DIRS.join(' or ')}\n`); return; }
  const lines = [];
  for (const dir of RECIPE_DIRS) {
    const files = all.filter((x) => x.dir === dir);
    if (!files.length) continue;
    lines.push(`recipes in ${dir}:`);
    for (const { file: f, name: n } of files) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')); } catch (e) {
        lines.push(`  ${n}  (invalid JSON: ${e.message})`);
        continue;
      }
      lines.push(`  ${n}${r.repo ? `  [${r.repo}, ${r.os || 'linux'}]` : ''}  ${r.description || '(no description)'}`);
      lines.push(`      verified: ${r.verified || '(not verified yet)'}`);
    }
  }
  process.stdout.write(redact(lines.join('\n')) + '\n');
}

// Fill every option the command line did NOT set from the recipe.
function applyRecipe(o, r, set) {
  o.recipe = r;
  if (r.unknown.length) warn(`recipe ${r.name}: ignoring unknown field(s) ${r.unknown.join(', ')}`);
  if (r.os != null && !set.has('os')) o.os = String(r.os).toLowerCase();
  if (r.node != null && !set.has('node')) o.node = String(r.node);
  if (r.python != null && !set.has('python')) o.python = String(r.python);
  if (r.setup != null && !set.has('setup')) o.setup = r.setup;
  if (r.timeout != null && !set.has('timeout')) o.timeout = r.timeout;
  if (r.shell != null && !set.has('shell')) o.shell = String(r.shell).toLowerCase();
  if (r.install != null && !set.has('install')) o.install = r.install;
  if (r.display != null && !set.has('display')) o.display = r.display;
  if (r.fetchDepth != null && !set.has('fetchDepth')) o.fetchDepth = r.fetchDepth;
  // Lists: any --include / --artifacts flag REPLACES the recipe's list.
  if (r.include != null && !set.has('include')) o.include = [].concat(r.include).map(normInclude);
  if (r.artifacts != null && !set.has('artifacts')) o.artifacts = [].concat(r.artifacts).flatMap(splitGlobs);
  // env merges per key; --env KEY=VAL wins over the recipe's KEY.
  if (r.env) {
    const fromRecipe = Object.fromEntries(Object.entries(r.env).map(([k, v]) => envEntry(k, v, `recipe ${r.name}`)));
    o.env = { ...fromRecipe, ...o.env };
  }
  o.setupFile = r.setupFileData;
  if (!set.has('command')) o.command = r.command;
}

function parseArgs(argv) {
  const o = {
    os: 'linux', setup: null, artifacts: [], node: null, python: null, timeout: 30,
    display: null, install: true, shell: 'bash', dryRun: false, allowDeploy: false,
    allowPublic: false, command: null, help: false, include: [],
    fetchDepth: null, env: {}, recipeName: null, recipe: null, setupFile: null, listRecipes: false,
  };
  const set = new Set(); // options given on the command line; they beat recipe fields
  const takesValue = new Set(['--os', '--setup', '--artifacts', '--node', '--python', '--timeout', '--shell', '--include', '--recipe', '--env', '--fetch-depth']);
  let i = 0;
  let cmdArgs = null;
  while (i < argv.length) {
    let a = argv[i];
    if (a === '--') { cmdArgs = argv.slice(i + 1); break; }
    let val;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (takesValue.has(a) && val === undefined) {
      if (i + 1 >= argv.length) throw new CloudtestError(`${a} needs a value`);
      val = argv[++i];
    }
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--os': o.os = String(val).toLowerCase(); set.add('os'); break;
      case '--setup': o.setup = val; set.add('setup'); break;
      case '--artifacts': o.artifacts.push(...splitGlobs(val)); set.add('artifacts'); break;
      case '--include': o.include.push(normInclude(val)); set.add('include'); break;
      case '--node': o.node = val; set.add('node'); break;
      case '--python': o.python = val; set.add('python'); break;
      case '--timeout': o.timeout = Number(val); set.add('timeout'); break;
      case '--shell': o.shell = String(val).toLowerCase(); set.add('shell'); break;
      case '--display': o.display = true; set.add('display'); break;
      case '--no-display': o.display = false; set.add('display'); break;
      case '--no-install': o.install = false; set.add('install'); break;
      case '--fetch-depth': o.fetchDepth = Number(val); set.add('fetchDepth'); break;
      case '--env': {
        const m = /^([^=]+)=(.*)$/s.exec(String(val));
        if (!m) throw new CloudtestError(`--env needs KEY=VAL: ${String(val).split('=')[0]}`);
        const [k, v] = envEntry(m[1], m[2], '--env');
        o.env[k] = v;
        break;
      }
      case '--recipe': o.recipeName = String(val); break;
      case '--recipes': o.listRecipes = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--cleanup': o.cleanup = true; break;
      case '--allow-deploy-repo': o.allowDeploy = true; break;
      case '--allow-public': o.allowPublic = true; break;
      default: throw new CloudtestError(`unknown option ${a} (put the test command after --)`);
    }
    i++;
  }
  if (o.help || o.listRecipes) return o;
  if (cmdArgs && cmdArgs.length) {
    o.command = cmdArgs.length === 1 ? cmdArgs[0] : cmdArgs.map(shQuote).join(' ');
    set.add('command');
  }
  if (o.recipeName) applyRecipe(o, loadRecipe(o.recipeName), set);
  // Secret-looking env values are scrubbed from every line cloudtest prints or saves.
  for (const [k, v] of Object.entries(o.env)) if (isSecretKey(k) && v.length >= 3) SECRET_VALUES.push(v);
  if (!['linux', 'windows'].includes(o.os)) throw new CloudtestError('--os must be linux or windows');
  if (!['bash', 'pwsh'].includes(o.shell)) throw new CloudtestError('--shell must be bash or pwsh');
  if (!Number.isFinite(o.timeout) || o.timeout < 1 || o.timeout > 360) throw new CloudtestError('--timeout must be 1..360 minutes');
  o.timeout = Math.round(o.timeout);
  if (o.fetchDepth != null && (!Number.isInteger(o.fetchDepth) || o.fetchDepth < 0)) throw new CloudtestError('--fetch-depth must be a whole number, 0 = full history');
  for (const [k, v] of [['--node', o.node], ['--python', o.python]]) {
    if (v != null && !/^[A-Za-z0-9.*\/x+-]+$/.test(v)) throw new CloudtestError(`${k} value looks wrong: ${v}`);
  }
  for (const g of o.artifacts) {
    if (/[\r\n]/.test(g) || g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.split(/[\\/]/).includes('..')) {
      throw new CloudtestError(`--artifacts glob must be relative to the repo root: ${g}`);
    }
  }
  if (o.cleanup) return o;
  if (!o.command) throw new CloudtestError('no test command. Usage: cloudtest [options] -- <test command>');
  return o;
}
function shQuote(s) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- repo checks
function parseGithubUrl(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
function assertNotDeployRepo(name, o) {
  if (!name) return;
  if (loadConfig().denyRepos.includes(name.toLowerCase()) && !o.allowDeploy) {
    throw new CloudtestError(
      `REFUSED: origin is ${name}. Pushes to this repo can touch prod pipelines/deploys. ` +
      'Pass --allow-deploy-repo only if you are sure nothing deploys from a cloudtest/* branch.');
  }
}

async function repoInfo(o) {
  const top = await run('git', ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new CloudtestError(`not inside a git repository (cwd ${process.cwd()}): ${top.stderr.trim().slice(0, 300)}`);
  const root = path.resolve(top.stdout.trim());
  const g = (args, extra = {}) => must('git', args, { cwd: root, ...extra });

  const bare = (await g(['rev-parse', '--is-bare-repository'])).stdout.trim();
  if (bare === 'true') throw new CloudtestError('bare repository: nothing to snapshot');

  const originRes = await run('git', ['remote', 'get-url', 'origin'], { cwd: root });
  if (originRes.code !== 0) throw new CloudtestError('this repo has no "origin" remote');
  const originUrl = originRes.stdout.trim();
  const pushRes = await run('git', ['remote', 'get-url', '--push', 'origin'], { cwd: root });
  const pushUrl = pushRes.code === 0 ? pushRes.stdout.trim() : originUrl;

  const name = parseGithubUrl(originUrl);
  const pushName = parseGithubUrl(pushUrl);
  // Refuse deploy repos BEFORE anything else touches the network or the repo.
  assertNotDeployRepo(name, o);
  assertNotDeployRepo(pushName, o);
  if (!name || !pushName) throw new CloudtestError(`origin is not a github.com repo: ${redact(originUrl)}`);
  if (name.toLowerCase() !== pushName.toLowerCase()) {
    throw new CloudtestError(`origin fetch URL (${name}) and push URL (${pushName}) point at different repos; refusing`);
  }

  const headRes = await run('git', ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root });
  const head = headRes.code === 0 ? headRes.stdout.trim() : null;
  const gitPath = async (p) => path.resolve(root, (await g(['rev-parse', '--git-path', p])).stdout.trim());
  return { root, originUrl, pushUrl, name, head, indexPath: await gitPath('index'), excludePath: await gitPath('info/exclude') };
}

async function remoteRepoChecks(repo, o) {
  const r = await run('gh', ['api', `repos/${repo.name}`, '--jq', '{full_name: .full_name, private: .private, archived: .archived, default_branch: .default_branch}']);
  if (r.code !== 0) throw new CloudtestError(`gh cannot see ${repo.name} (is gh logged in?): ${r.stderr.trim().slice(0, 300)}`);
  const info = JSON.parse(r.stdout);
  assertNotDeployRepo(info.full_name, o); // catches renames/redirects
  if (info.archived) throw new CloudtestError(`${info.full_name} is archived; cannot push`);
  if (!info.private && !o.allowPublic) {
    throw new CloudtestError(`REFUSED: ${info.full_name} is PUBLIC. The snapshot (including uncommitted work) would be publicly visible. Pass --allow-public to override.`);
  }
  const p = await run('gh', ['api', `repos/${info.full_name}/actions/permissions`, '--jq', '.enabled']);
  if (p.code === 0 && p.stdout.trim() === 'false') throw new CloudtestError(`GitHub Actions is disabled on ${info.full_name}`);
  repo.fullName = info.full_name;
  return info;
}

function ensureExcluded(excludePath) {
  let text = '';
  try { text = fs.readFileSync(excludePath, 'utf8'); } catch { /* missing is fine */ }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes('.cloudtest/') || lines.includes('/.cloudtest/') || lines.includes('/.cloudtest')) return false;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const prefix = text.length && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludePath, `${prefix}# cloudtest output (local only)\n/.cloudtest/\n`);
  return true;
}

// ---------------------------------------------------------------- job files
function detectProject(root, files) {
  const has = (p) => files.has(p);
  const d = { node: false, python: false, lockfile: null, electron: false, requirements: false, pyproject: false, nvmrc: null, pyVersionFile: null, lfs: false };
  if (has('package.json')) {
    d.node = true;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
      d.electron = Object.keys(deps).some((k) => k === 'electron' || k === 'electron-nightly');
    } catch { /* unreadable package.json: no electron autodetect */ }
    if (has('package-lock.json') || has('npm-shrinkwrap.json')) d.lockfile = 'npm';
    else if (has('pnpm-lock.yaml')) d.lockfile = 'pnpm';
    else if (has('yarn.lock')) d.lockfile = 'yarn';
    if (has('.nvmrc')) d.nvmrc = '.nvmrc';
    else if (has('.node-version')) d.nvmrc = '.node-version';
  }
  if (has('requirements.txt')) { d.python = true; d.requirements = true; }
  if (has('pyproject.toml')) { d.python = true; d.pyproject = true; }
  if (has('.python-version')) d.pyVersionFile = '.python-version';
  if (has('.gitattributes')) {
    try { d.lfs = /filter=lfs/.test(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')); } catch { /* ignore */ }
  }
  return d;
}

function yamlStr(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function buildJob(o, d, meta) {
  const isLinux = o.os === 'linux';
  const useNode = o.node != null || d.node;
  const usePython = o.python != null || d.python;
  const display = isLinux && (o.display === true || (o.display == null && d.electron));

  // Steps already run with cwd = the checked-out workspace on both OSes.
  const install = ['#!/usr/bin/env bash', 'set -euo pipefail'];
  const baseLen = install.length;
  if (o.install) {
    if (d.node) {
      if (d.lockfile === 'npm') install.push('echo "cloudtest: npm ci"', 'npm ci --no-audit --no-fund');
      else if (d.lockfile === 'pnpm') install.push('echo "cloudtest: pnpm install"', 'corepack enable', 'pnpm install --frozen-lockfile');
      else if (d.lockfile === 'yarn') install.push('echo "cloudtest: yarn install"', 'corepack enable', 'yarn install');
      else install.push('echo "cloudtest: npm install (no lockfile)"', 'npm install --no-audit --no-fund');
    }
    if (d.requirements) install.push('echo "cloudtest: pip install -r requirements.txt"', 'python -m pip install --disable-pip-version-check -r requirements.txt');
    else if (d.pyproject) install.push('echo "cloudtest: pyproject.toml found but no requirements.txt; not auto-installing (use --setup \\"pip install -e .\\")"');
  } else {
    install.push('echo "cloudtest: dependency install skipped (--no-install)"');
  }
  if (install.length === baseLen) install.push('echo "cloudtest: no package.json / requirements.txt, nothing to install"');

  const setup = ['#!/usr/bin/env bash', 'set -euo pipefail', o.setup || 'echo "cloudtest: no --setup command"'];

  let inner;
  const files = {};
  if (o.shell === 'pwsh') {
    files[`${JOB_DIR}/command.ps1`] = `$ErrorActionPreference = 'Continue'\n${o.command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } elseif ($?) { exit 0 } else { exit 1 }\n`;
    inner = `pwsh -NoProfile -NonInteractive -File ${JOB_DIR}/command.ps1`;
  } else {
    files[`${JOB_DIR}/command.sh`] = `${o.command}\n`;
    inner = `bash ${JOB_DIR}/command.sh`;
  }
  const wrapped = display ? `xvfb-run -a -s "-screen 0 1920x1080x24" ${inner}` : inner;
  const test = [
    '#!/usr/bin/env bash', 'set +e',
    `echo "${MARK_BEGIN}"`,
    wrapped,
    'code=$?',
    'echo "@@cloudtest-exit=${code}@@"',
    'exit $code',
  ];

  files[`${JOB_DIR}/install.sh`] = install.join('\n') + '\n';
  files[`${JOB_DIR}/setup.sh`] = setup.join('\n') + '\n';
  files[`${JOB_DIR}/test.sh`] = test.join('\n') + '\n';
  // Keep LF on Windows runners (core.autocrlf=true there would break bash scripts).
  files[`${JOB_DIR}/.gitattributes`] = '* text eol=lf\n';
  // Recipe setupFile: copied in as .cloudtest/setup.<ext>, run before the setup command.
  const sf = o.setupFile;
  const sfPath = sf ? `${SETUP_FILE_DIR}/setup.${sf.ext}` : null;
  if (sf) {
    files[sfPath] = sf.content;
    files[`${SETUP_FILE_DIR}/.gitattributes`] = '* text eol=lf\n';
  }
  files[`${JOB_DIR}/options.json`] = JSON.stringify({
    id: meta.id, base: meta.head, os: o.os, shell: o.shell, setup: o.setup, artifacts: o.artifacts,
    node: useNode ? (o.node || (d.nvmrc ? `file:${d.nvmrc}` : 'lts/*')) : null,
    python: usePython ? (o.python || (d.pyVersionFile ? `file:${d.pyVersionFile}` : '3.12')) : null,
    timeoutMinutes: o.timeout, display, install: o.install, include: o.include, command: o.command,
    ...(o.recipe ? { recipe: o.recipe.name } : {}),
    ...(sf ? { setupFile: `${sf.name} -> ${sfPath}` } : {}),
    ...(Object.keys(o.env).length ? { env: maskedEnv(o.env) } : {}),
  }, null, 2) + '\n';
  // Step env (setup file, setup command, test command). Keys are validated names.
  const envLines = Object.keys(o.env).length
    ? ['        env:', ...Object.entries(o.env).map(([k, v]) => `          ${k}: ${yamlStr(v)}`)]
    : [];

  const y = [];
  y.push('# Injected by cloudtest into a throwaway snapshot commit only. Never on a real branch.');
  y.push('name: cloudtest');
  y.push('on:');
  y.push('  push:');
  y.push("    branches: ['cloudtest/**']");
  y.push('permissions:');
  y.push('  contents: read');
  y.push('jobs:');
  y.push('  test:');
  y.push(`    name: cloudtest ${meta.id} (${o.os})`);
  y.push(`    runs-on: ${isLinux ? 'ubuntu-latest' : 'windows-latest'}`);
  y.push(`    timeout-minutes: ${o.timeout}`);
  y.push('    env:');
  y.push("      CLOUDTEST: '1'");
  y.push("      FORCE_COLOR: '0'");
  y.push('    steps:');
  y.push('      - name: Checkout snapshot');
  y.push(`        uses: ${ACTIONS.checkout}`);
  y.push('        with:');
  y.push('          persist-credentials: false');
  if (o.fetchDepth != null) y.push(`          fetch-depth: ${o.fetchDepth}`);
  if (d.lfs) y.push('          lfs: true');
  if (useNode) {
    y.push('      - name: Set up Node');
    y.push(`        uses: ${ACTIONS.node}`);
    y.push('        with:');
    if (o.node) y.push(`          node-version: ${yamlStr(o.node)}`);
    else if (d.nvmrc) y.push(`          node-version-file: ${yamlStr(d.nvmrc)}`);
    else y.push("          node-version: 'lts/*'");
    y.push('          package-manager-cache: false');
  }
  if (usePython) {
    y.push('      - name: Set up Python');
    y.push(`        uses: ${ACTIONS.python}`);
    y.push('        with:');
    if (o.python) y.push(`          python-version: ${yamlStr(o.python)}`);
    else if (d.pyVersionFile) y.push(`          python-version-file: ${yamlStr(d.pyVersionFile)}`);
    else y.push("          python-version: '3.12'");
  }
  y.push('      - name: Install dependencies');
  y.push('        shell: bash');
  y.push(`        run: bash ${JOB_DIR}/install.sh`);
  if (display) {
    y.push('      - name: Virtual display (xvfb)');
    y.push('        shell: bash');
    y.push('        run: |');
    y.push('          if ! command -v xvfb-run >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq xvfb; fi');
    y.push('          # Ubuntu 24.04 blocks the Chromium/Electron sandbox via AppArmor userns rules.');
    y.push('          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || echo "cloudtest: could not relax apparmor userns (sandbox may fail)"');
  }
  if (sf) {
    y.push(`      - name: Setup file (${sf.name})`);
    y.push('        shell: bash');
    y.push(...envLines);
    y.push(sf.ext === 'ps1'
      ? `        run: pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${sfPath}`
      : `        run: bash ${sfPath}`);
  }
  y.push('      - name: Setup command');
  y.push('        shell: bash');
  y.push(...envLines);
  y.push(`        run: bash ${JOB_DIR}/setup.sh`);
  y.push('      - name: Test command');
  y.push('        shell: bash');
  y.push(...envLines);
  y.push(`        run: bash ${JOB_DIR}/test.sh`);
  if (o.artifacts.length) {
    y.push('      - name: Upload artifacts');
    y.push('        if: always()');
    y.push(`        uses: ${ACTIONS.upload}`);
    y.push('        with:');
    y.push(`          name: ${ARTIFACT_NAME}`);
    y.push('          path: |');
    for (const g of o.artifacts) y.push(`            ${g}`);
    y.push('          retention-days: 1');
    y.push('          if-no-files-found: warn');
    y.push('          include-hidden-files: true');
  }
  files[WORKFLOW_PATH] = y.join('\n') + '\n';
  return { files, display, useNode, usePython };
}

// ---------------------------------------------------------------- snapshot
const tmpFiles = new Set();
process.on('exit', () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* gone */ } } });

async function buildSnapshot(repo, o, id) {
  const tmpIndex = path.join(os.tmpdir(), `cloudtest-${id}-${process.pid}.index`);
  tmpFiles.add(tmpIndex);
  tmpFiles.add(`${tmpIndex}.lock`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: 'cloudtest', GIT_AUTHOR_EMAIL: 'cloudtest@localhost',
    GIT_COMMITTER_NAME: 'cloudtest', GIT_COMMITTER_EMAIL: 'cloudtest@localhost',
    GIT_OPTIONAL_LOCKS: '0',
  };
  const g = (args, extra = {}) => must('git', args, { cwd: repo.root, env, ...extra });
  try {
    // Start from a COPY of the real index (keeps stat cache, so add -A is fast).
    // The real index file is only read, never written.
    if (fs.existsSync(repo.indexPath)) fs.copyFileSync(repo.indexPath, tmpIndex);
    else if (repo.head) await g(['read-tree', repo.head]);

    // Pre-flight on what add -A would pick up (modified + untracked-not-ignored),
    // BEFORE hashing anything into the object store.
    const cand = (await g(['ls-files', '-z', '-m', '-o', '--exclude-standard', '--', '.', ':(exclude).cloudtest'])).stdout
      .split('\0').filter(Boolean);
    const big = [];
    const secret = [];
    let preTotal = 0;
    const checkFile = (rel, strict, secretList) => {
      const base = rel.split('/').pop();
      if (isSecretName(base, strict)) secretList.push(rel);
      try {
        const st = fs.statSync(path.join(repo.root, rel));
        if (st.isFile()) {
          preTotal += st.size;
          if (st.size > MAX_FILE_BYTES) big.push(`${rel} (${fmtBytes(st.size)})`);
          return st.size;
        }
      } catch { /* deleted file */ }
      return 0;
    };
    for (const rel of new Set(cand)) checkFile(rel, false, secret);
    if (secret.length) {
      throw new CloudtestError(`REFUSED: the snapshot would include uncommitted secret-looking file(s): ${secret.join(', ')}. ` +
        'Add them to .gitignore (or commit them if they are not secrets) and retry.');
    }

    // --include: everything untracked under the path, ignored or not (that is
    // exactly what "git add -f <path>" will pick up). Strict secret rules apply.
    const included = [];
    for (const inc of o.include) {
      const files = (await g(['ls-files', '-z', '-o', '--', inc])).stdout.split('\0').filter(Boolean)
        .filter((f) => !f.startsWith('.cloudtest/'));
      const incSecret = [];
      let bytes = 0;
      for (const rel of files) bytes += checkFile(rel, true, incSecret);
      if (incSecret.length) {
        throw new CloudtestError(`REFUSED: --include ${inc} would pick up secret-looking file(s): ${incSecret.slice(0, 10).join(', ')}` +
          `${incSecret.length > 10 ? ` (+${incSecret.length - 10} more)` : ''}. --include never takes .env*, *.pem, *.key or ` +
          'names containing secret/token/credential. Narrow the path.');
      }
      if (!files.length && !fs.existsSync(path.join(repo.root, inc))) throw new CloudtestError(`--include ${inc}: path does not exist`);
      included.push({ path: inc, files: files.length, bytes });
    }
    if (big.length) throw new CloudtestError(`REFUSED: file(s) over 50 MB would be in the snapshot: ${big.join(', ')}. Ignore or remove them.`);
    if (preTotal > MAX_TOTAL_BYTES) {
      throw new CloudtestError(`REFUSED: uncommitted + included files alone total ${fmtBytes(preTotal)} (limit ${fmtBytes(MAX_TOTAL_BYTES)}).`);
    }

    // Whole tree (cwd is the repo root). No exclude pathspec here: git add errors
    // when a pathspec names an ignored path. .cloudtest/ is excluded via
    // .git/info/exclude, and dropped again below in case it was ever tracked.
    await g(['add', '-A']);
    for (const inc of included) if (inc.files) await g(['add', '-f', '--', inc.path]);
    await g(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.cloudtest']);

    // Drop the repo's own workflows (snapshot only) so its CI never fires.
    const wf = (await g(['ls-files', '-z', '--', '.github/workflows'])).stdout.split('\0').filter(Boolean);
    if (wf.length) await g(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.github/workflows']);
    const stale = (await g(['ls-files', '-z', '--', JOB_DIR])).stdout.split('\0').filter(Boolean);
    if (stale.length) await g(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', JOB_DIR]);

    // Detect project type from the snapshot's file list.
    const fileSet = new Set((await g(['ls-files', '-z'])).stdout.split('\0').filter(Boolean));
    const d = detectProject(repo.root, fileSet);
    const job = buildJob(o, d, { id, head: repo.head });
    for (const [p, content] of Object.entries(job.files)) {
      const sha = (await g(['hash-object', '-w', '--stdin', '--no-filters'], { input: content })).stdout.trim();
      await g(['update-index', '--add', '--cacheinfo', `100644,${sha},${p}`]);
    }
    const tree = (await g(['write-tree'])).stdout.trim();

    // Stats + hard size check over the whole tree.
    const ls = (await g(['ls-tree', '-r', '-l', '-z', tree])).stdout.split('\0').filter(Boolean);
    let count = 0;
    let total = 0;
    const bigAll = [];
    for (const line of ls) {
      const m = /^\d+ (\w+) [0-9a-f]+\s+(-|\d+)\t(.*)$/s.exec(line);
      if (!m) continue;
      if (m[1] !== 'blob') continue;
      count++;
      const size = m[2] === '-' ? 0 : Number(m[2]);
      total += size;
      if (size > MAX_FILE_BYTES) bigAll.push(`${m[3]} (${fmtBytes(size)})`);
    }
    if (bigAll.length) throw new CloudtestError(`REFUSED: file(s) over 50 MB in the snapshot: ${bigAll.join(', ')}`);
    if (total > MAX_TOTAL_BYTES) {
      throw new CloudtestError(`REFUSED: snapshot totals ${fmtBytes(total)} (limit ${fmtBytes(MAX_TOTAL_BYTES)}). Narrow --include or ignore large files.`);
    }

    // Changed vs HEAD (for the summary line).
    let changed = [];
    if (repo.head) {
      changed = (await g(['diff-index', '--cached', '--name-status', '--no-renames', repo.head, '--', '.',
        `:(exclude)${JOB_DIR}`, `:(exclude)${SETUP_FILE_DIR}`, ":(exclude).github/workflows"])).stdout.split('\n').filter(Boolean);
    }

    const commitArgs = ['commit-tree', tree, '-m', `cloudtest snapshot ${id}`, '-m', `base: ${repo.head || '(none)'}`];
    if (repo.head) commitArgs.splice(2, 0, '-p', repo.head);
    const commit = (await g(commitArgs)).stdout.trim();
    return { commit, tree, count, total, changed, removedWorkflows: wf, detect: d, job, included };
  } finally {
    for (const f of [tmpIndex, `${tmpIndex}.lock`]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  }
}

// ---------------------------------------------------------------- remote ops
function ghCredArgs(url) {
  // Use gh's token for github.com https pushes so no credential GUI ever pops.
  if (/^https:\/\/github\.com\//i.test(url)) return ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
  return [];
}
const pushEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' });

async function pushSnapshot(repo, sha, ref) {
  if (!SAFE_REF_RE.test(ref)) throw new CloudtestError(`internal safety stop: refusing to push to ${ref}`);
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new CloudtestError('internal safety stop: bad snapshot sha');
  // Push to the URL (not the remote name): no remote-tracking ref is created
  // locally, and remote.origin.push / mirror config cannot widen the refspec.
  const args = [...ghCredArgs(repo.pushUrl), 'push', '--no-follow-tags', '--recurse-submodules=no', '--quiet',
    repo.pushUrl, `${sha}:${ref}`];
  await must('git', args, { cwd: repo.root, env: pushEnv(), what: 'git push' });
}

let deletePromise = null;
function deleteRemoteBranch(repo, ref) {
  if (deletePromise) return deletePromise;
  deletePromise = (async () => {
    if (!SAFE_REF_RE.test(ref)) return false;
    const gone = async () => {
      const ls = await run('git', [...ghCredArgs(repo.pushUrl), 'ls-remote', repo.pushUrl, ref], { cwd: repo.root, env: pushEnv() });
      return ls.code === 0 && ls.stdout.trim() === '';
    };
    // API delete first (no local hooks, no local refs touched).
    const r = await run('gh', ['api', '-X', 'DELETE', `repos/${repo.fullName || repo.name}/git/${ref}`]);
    if (r.code === 0) return true;
    if (await gone()) return true; // push never landed, or already deleted
    const d = await run('git', [...ghCredArgs(repo.pushUrl), 'push', '--quiet', repo.pushUrl, `:${ref}`], { cwd: repo.root, env: pushEnv() });
    if (d.code === 0) return true;
    return gone();
  })();
  return deletePromise;
}

// Leftover branches from a hard-killed cloudtest (e.g. the Bash tool was
// interrupted, so no cleanup ran). Delete any cloudtest/* branch older than
// 3 min whose runs have all completed. Live runs (parallel calls) are left alone.
async function sweepStale(repo, currentRef) {
  const ls = await run('git', [...ghCredArgs(repo.pushUrl), 'ls-remote', repo.pushUrl, 'refs/heads/cloudtest/*'], { cwd: repo.root, env: pushEnv() });
  if (ls.code !== 0) { warn('could not list remote cloudtest/* branches for the stale sweep'); return 0; }
  let n = 0;
  for (const line of ls.stdout.split('\n').filter(Boolean)) {
    const ref = line.split('\t')[1];
    if (!ref || ref === currentRef || !SAFE_REF_RE.test(ref)) continue;
    const name = ref.replace(/^refs\/heads\//, '');
    const m = /^cloudtest\/(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)-/.exec(name);
    if (m) {
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (Date.now() - t < 3 * 60000) continue;
    }
    const r = await run('gh', ['run', 'list', '--repo', repo.fullName, '--branch', name, '--limit', '10', '--json', 'status']);
    if (r.code !== 0) continue;
    let runs;
    try { runs = JSON.parse(r.stdout); } catch { continue; }
    if (runs.some((x) => x.status !== 'completed')) continue;
    const d = await run('gh', ['api', '-X', 'DELETE', `repos/${repo.fullName}/git/${ref}`]);
    if (d.code === 0) { say(`swept leftover branch ${name}`); n++; }
    else warn(`could not delete leftover branch ${name}`);
  }
  return n;
}

async function findRun(repo, branch, sha) {
  const deadline = Date.now() + 150000;
  let tries = 0;
  while (Date.now() < deadline) {
    if (aborted) return null;
    const r = await run('gh', ['run', 'list', '--repo', repo.fullName, '--branch', branch, '--limit', '10',
      '--json', 'databaseId,headSha,status,conclusion,url,workflowName,event']);
    if (r.code === 0) {
      try {
        const runs = JSON.parse(r.stdout).filter((x) => x.headSha === sha);
        if (runs.length) return runs.find((x) => x.workflowName === 'cloudtest') || runs[0];
      } catch { /* retry */ }
    }
    tries++;
    if (tries === 6) say('waiting for GitHub to register the run...');
    await sleep(3000);
  }
  return null;
}

async function watchRun(repo, runId, timeoutMin) {
  const t0 = Date.now();
  const hardStop = t0 + (timeoutMin + 20) * 60000;
  let last = '';
  let fails = 0;
  for (;;) {
    if (aborted) return null;
    const r = await run('gh', ['run', 'view', String(runId), '--repo', repo.fullName, '--json', 'status,conclusion,jobs,url']);
    if (r.code === 0) {
      fails = 0;
      let v;
      try { v = JSON.parse(r.stdout); } catch { v = null; }
      if (v) {
        const job = (v.jobs || [])[0];
        let step = null;
        if (job && Array.isArray(job.steps)) step = job.steps.find((s) => s.status === 'in_progress') || null;
        const line = v.status === 'completed' ? `completed: ${v.conclusion}` : `${v.status}${step ? `: ${step.name}` : ''}`;
        if (line !== last) { say(`${fmtDur(Date.now() - t0)} ${line}`); last = line; }
        if (v.status === 'completed') return v;
      }
    } else if (++fails >= 12) {
      throw new CloudtestError(`lost contact with the run: ${r.stderr.trim().slice(0, 300)}`);
    }
    if (Date.now() > hardStop) {
      warn('run exceeded its timeout by 20 min; cancelling');
      await run('gh', ['run', 'cancel', String(runId), '--repo', repo.fullName]);
      return null;
    }
    await sleep(POLL_MS);
  }
}

async function fetchJobLog(repo, runId, jobId) {
  for (let i = 0; i < 6; i++) {
    if (jobId) {
      const r = await run('gh', ['api', `repos/${repo.fullName}/actions/jobs/${jobId}/logs`]);
      if (r.code === 0 && r.raw.length) return r.raw;
    }
    const v = await run('gh', ['run', 'view', String(runId), '--repo', repo.fullName, '--log']);
    if (v.code === 0 && v.raw.length) return v.raw;
    await sleep(3000);
  }
  return null;
}

function stripTs(line) {
  return line
    .replace(/^﻿/, '')
    .replace(/^[^\t\n]*\t[^\t\n]*\t(?=﻿?\d{4}-\d\d-\d\dT)/, '') // "gh run view --log" job/step prefix
    .replace(/^﻿/, '')
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '');
}
function testSection(logText) {
  const lines = logText.split(/\r?\n/).map(stripTs);
  const b = lines.findIndex((l) => l === MARK_BEGIN);
  let exit = null;
  let e = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = MARK_EXIT_RE.exec(lines[i]);
    if (m) { exit = Number(m[1]); e = i; break; }
  }
  if (b >= 0) return { lines: lines.slice(b + 1, e > b ? e : lines.length), exit, ran: true };
  // The test never started: show the step that failed (its "Run ..." group up to the first error),
  // not the post-job cleanup noise at the end of the log.
  const err = lines.findIndex((l) => l.startsWith('##[error]'));
  if (err >= 0) {
    let g = err;
    while (g > 0 && !lines[g].startsWith('##[group]Run ')) g--;
    return { lines: lines.slice(g, err + 1), exit, ran: false, failedStep: true };
  }
  return { lines, exit, ran: false };
}

function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countFiles(path.join(dir, ent.name));
    else n++;
  }
  return n;
}

// ---------------------------------------------------------------- main
let aborted = false;
let cleanup = null; // async () => void, set once a branch may exist

function onSignal(sig) {
  if (aborted) { process.exit(130); }
  aborted = true;
  process.stderr.write(`\n[cloudtest] ${sig}: cancelling run and deleting the remote branch...\n`);
  Promise.resolve(cleanup ? cleanup(true) : null)
    .catch(() => {})
    .finally(() => process.exit(130));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (o.listRecipes) { listRecipes(); return 0; }

  const repo = await repoInfo(o); // refuses deploy repos before anything else
  if (o.recipe && o.recipe.repo.toLowerCase() !== repo.name.toLowerCase()) {
    throw new CloudtestError(`REFUSED: recipe ${o.recipe.name} is for ${o.recipe.repo}, but this repo's origin is ${repo.name}`);
  }
  if (o.recipe) {
    say(`recipe ${o.recipe.name}: ${o.recipe.description || '(no description)'}`);
    say(`recipe verified: ${o.recipe.verified || '(not verified yet)'}`);
  }
  if (o.setupFile) say(`setup file: ${path.basename(o.setupFile.dir)}/${o.setupFile.name} -> ${SETUP_FILE_DIR}/setup.${o.setupFile.ext} (${o.setupFile.ext === 'ps1' ? 'pwsh' : 'bash'}), runs before the setup command`);
  if (Object.keys(o.env).length) say(`env (setup + test steps): ${shownEnv(o.env)}`);
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const id = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const branch = `${BRANCH_PREFIX}${id}`;
  const ref = `refs/heads/${branch}`;

  await remoteRepoChecks(repo, o);
  if (o.cleanup) {
    const n = await sweepStale(repo, null);
    say(`cleanup done: ${n} leftover branch(es) deleted`);
    return 0;
  }
  ensureExcluded(repo.excludePath);
  if (!o.dryRun) await sweepStale(repo, ref);

  const snap = await buildSnapshot(repo, o, id);
  const nUncommitted = snap.changed.length;
  say(`snapshot ${snap.commit.slice(0, 7)}  ${snap.count} files  ${fmtBytes(snap.total)}  base ${repo.head ? repo.head.slice(0, 7) : '(no commits)'}  ` +
    `${nUncommitted} uncommitted change(s)${snap.removedWorkflows.length ? `  (${snap.removedWorkflows.length} repo workflow(s) removed in snapshot)` : ''}`);
  for (const inc of snap.included) {
    say(`--include ${inc.path}: ${inc.files ? `${inc.files} gitignored/untracked file(s), ${fmtBytes(inc.bytes)} force-added` : 'nothing untracked there (already in the snapshot if tracked)'}`);
  }

  if (o.dryRun) {
    const d = snap.detect;
    say(`DRY RUN: nothing pushed`);
    say(`push target: ${repo.fullName} ${ref}`);
    say(`os ${o.os}  node ${snap.job.useNode ? 'yes' : 'no'}  python ${snap.job.usePython ? 'yes' : 'no'}  lockfile ${d.lockfile || '-'}  ` +
      `xvfb ${snap.job.display ? 'yes' : 'no'}  timeout ${o.timeout}m  command: ${o.command}`);
    if (snap.changed.length) say(`uncommitted vs HEAD: ${snap.changed.slice(0, 20).join(' | ')}${snap.changed.length > 20 ? ' | ...' : ''}`);
    if (snap.removedWorkflows.length) say(`removed in snapshot: ${snap.removedWorkflows.join(', ')}`);
    process.stdout.write(redact(`----- ${WORKFLOW_PATH} -----\n${snap.job.files[WORKFLOW_PATH]}----- ${JOB_DIR}/test.sh -----\n${snap.job.files[`${JOB_DIR}/test.sh`]}`));
    if (o.setup || o.recipe) process.stdout.write(redact(`----- ${JOB_DIR}/setup.sh -----\n${snap.job.files[`${JOB_DIR}/setup.sh`]}`));
    return 0;
  }

  const outDir = path.join(repo.root, '.cloudtest', id);
  fs.mkdirSync(outDir, { recursive: true });
  const meta = { id, repo: repo.fullName, branch, base: repo.head, snapshot: snap.commit, os: o.os, command: o.command, recipe: o.recipe ? o.recipe.name : null, startedAt: now.toISOString() };
  const writeMeta = () => fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
  writeMeta();

  let runInfo = null;
  let branchMaybeExists = false;
  cleanup = async (interrupted) => {
    if (interrupted && runInfo) await run('gh', ['run', 'cancel', String(runInfo.databaseId), '--repo', repo.fullName]);
    if (branchMaybeExists) {
      const ok = await deleteRemoteBranch(repo, ref);
      if (ok) say(`deleted remote branch ${branch}`);
      else warn(`could NOT delete remote branch ${branch}; delete it with: git push origin --delete ${branch}`);
    }
  };

  const wall0 = Date.now();
  let exitCode = TOOL_ERROR_EXIT;
  try {
    say(`push -> ${repo.fullName} ${ref}`);
    branchMaybeExists = true;
    await pushSnapshot(repo, snap.commit, ref);
    if (aborted) return 130;

    runInfo = await findRun(repo, branch, snap.commit);
    if (aborted) return 130;
    if (!runInfo) throw new CloudtestError('no workflow run appeared for the snapshot within 150 s (Actions disabled, or minutes exhausted?)');
    meta.runId = runInfo.databaseId;
    meta.url = runInfo.url;
    writeMeta();
    say(`run ${runInfo.url}`);

    const final = await watchRun(repo, runInfo.databaseId, o.timeout);
    if (aborted) return 130;
    // Run finished: the branch is no longer needed. Delete it now.
    await cleanup(false);
    branchMaybeExists = false;

    const job = final && final.jobs && final.jobs[0];
    const jobId = job ? job.databaseId : null;
    const logBuf = await fetchJobLog(repo, runInfo.databaseId, jobId);
    let section = { lines: [], exit: null, ran: false };
    if (logBuf) {
      // Scrub secret-looking --env/recipe env values (GitHub echoes step env into the log).
      fs.writeFileSync(path.join(outDir, 'log.txt'), SECRET_VALUES.length ? redact(logBuf.toString('utf8')) : logBuf);
      section = testSection(logBuf.toString('utf8'));
      const tail = section.lines.slice(-40);
      process.stdout.write(redact(`----- ${section.ran ? 'test output' : section.failedStep ? 'failed step' : 'job log'} (last ${tail.length} lines) -----\n${tail.join('\n')}\n-----\n`));
      say(`log: ${path.relative(process.cwd(), path.join(outDir, 'log.txt')) || path.join(outDir, 'log.txt')}`);
    } else {
      warn('could not download the job log');
    }

    if (o.artifacts.length) {
      const artDir = path.join(outDir, 'artifacts');
      const a = await run('gh', ['run', 'download', String(runInfo.databaseId), '--repo', repo.fullName, '-n', ARTIFACT_NAME, '-D', artDir]);
      if (a.code === 0) say(`artifacts: ${countFiles(artDir)} file(s) in ${path.relative(process.cwd(), artDir) || artDir}`);
      else warn(`no artifacts downloaded (${(a.stderr || '').trim().split('\n')[0] || 'nothing matched the glob?'})`);
    }

    const conclusion = final ? final.conclusion : 'unknown';
    if (section.exit != null) exitCode = section.exit;
    else if (conclusion === 'success') exitCode = 0;
    else {
      exitCode = conclusion === 'cancelled' ? 130 : 1;
      const failed = job && (job.steps || []).find((s) => s.conclusion === 'failure');
      warn(`test command did not report an exit code (run ${conclusion}${failed ? `, step "${failed.name}" failed` : ''})`);
    }
    // Test passed but a later step (e.g. artifact upload) failed: keep the test's code, say so.
    if (exitCode === 0 && conclusion !== 'success') warn(`test passed but the run concluded "${conclusion}"`);

    const started = job && job.startedAt ? Date.parse(job.startedAt) : NaN;
    const completed = job && job.completedAt ? Date.parse(job.completedAt) : NaN;
    const jobMs = completed - started;
    const mult = o.os === 'windows' ? 2 : 1;
    const billed = isFinite(jobMs) && jobMs > 0 ? Math.max(1, Math.ceil(jobMs / 60000)) * mult : 0;
    Object.assign(meta, { conclusion, exitCode, jobSeconds: isFinite(jobMs) ? Math.round(jobMs / 1000) : null, billedMinutes: billed, finishedAt: new Date().toISOString() });
    writeMeta();
    process.stdout.write(`${exitCode === 0 ? 'PASS' : 'FAIL'}  exit ${exitCode}  job ${fmtDur(jobMs)}  wall ${fmtDur(Date.now() - wall0)}  ` +
      `billed ~${billed} min (${o.os}${mult > 1 ? ' x2' : ''})  ${runInfo.url}\n`);
    return exitCode;
  } finally {
    if (branchMaybeExists && !aborted) await cleanup(false);
  }
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
if (process.platform !== 'win32') process.on('SIGHUP', () => onSignal('SIGHUP'));

main().then(
  (code) => { if (!aborted) process.exit(code); },
  (err) => {
    if (aborted) return;
    process.stderr.write(redact(`[cloudtest] ERROR: ${err instanceof CloudtestError ? err.message : (err && err.stack) || err}`) + '\n');
    process.exit(TOOL_ERROR_EXIT);
  },
);
