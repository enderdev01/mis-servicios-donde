#!/usr/bin/env node
// Verification CLI: the lever agents use to check their own work.
// Every command supports --json. Exit 0 on success, 1 on failure.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const args = argv.filter((a) => a !== "--json");

// Filled by create-verification-skill, e.g. { start: ["npm", "run", "dev"], url: "http://localhost:5173", expect: "<title>My App</title>" }
// `expect`: exact, case-sensitive text only this app's HTML contains (its <title>), so another app on the port is never captured.
// Generic dev-server text like "/@vite/client" is not enough: any other Vite project on the same port has it too.
const APP = {
  start: ["npm", "run", "dev", "--workspace", "@mis-servicios/web", "--", "--host", "127.0.0.1", "--port", "4321"],
  url: "http://127.0.0.1:4321",
  expect: "<title>Mis Servicios | Mapa comunitario de cortes</title>",
};
// The API the feature commands call. Override with --base <url> or CONTROL_API_BASE.
// Local default: the Worker under wrangler dev (npm run db:migrate:local -w @mis-servicios/worker && npm run dev -w @mis-servicios/worker).
const API_BASE = "http://127.0.0.1:8787";

const HELP = `Usage: node scripts/control.mjs <command> [--json]

Commands:
  doctor    Check the environment is ready (node, deps, git hooks, branch)
  verify    Run the project's typecheck, lint and test npm scripts that exist; report each step
            Each step is cut after 10 minutes; set CONTROL_VERIFY_TIMEOUT_MS (milliseconds) to change it
            Skips when this tree was already verified (skuizops Stop gate marker). A passing full run records it
  verify --changed [path...]
            Run those scripts only for the paths given, or for the diff against the merge-base plus untracked files.
            Typecheck and lint see JS/TS files; test also sees C# files. Other paths add no step.
            Does not record the tree: a filtered pass is not the full suite
            Example: node scripts/control.mjs verify --changed src/auth.ts

  screenshot [route] [--out <file.png>] [--wait <ms>] [--full-page] [--port <n>]
            Headless screenshot of a route of the app, "/" by default (needs APP set and Playwright installed in the project)
            Without --out it writes $TMPDIR/<project>-screenshot.png, overwritten on every run
            --port replaces the port of APP.url (default is APP.url's); use it for a worktree's own dev server, which you start first
            Example: node scripts/control.mjs screenshot /settings --full-page

API features (all take --base <url>, default $CONTROL_API_BASE or ${API_BASE}; --json for machine output):
  health                      GET /health. Example: node scripts/control.mjs health --base https://mis-servicios-api.onilabs-dev.workers.dev
  zones                       GET /v1/zones: the approved zones. Example: node scripts/control.mjs zones
  cells [--service s] [--provider p]
                              GET /v1/cells: public outage cells ([] while PUBLIC_MAP_ENABLED is off or nobody reported)
                              Example: node scripts/control.mjs cells --service water
  notice <slug>               GET /v1/zones/<slug>/notice: the printable notice. Example: node scripts/control.mjs notice lince
  report --lat <n> --lng <n> [--status outage|restored] [--service water|electricity|internet] [--provider <p>]
         [--device <id>] [--submission <id>] [--dry-run]
                              POST /v1/reports. WRITES a report, so use --dry-run first to print the request without sending it
                              Example: node scripts/control.mjs report --lat -12.082 --lng -77.045 --dry-run

Every command exits 0 on success and 1 on failure. Add --json for machine-readable output.`;

function run(cmd, cmdArgs) {
  const start = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, ms: Date.now() - start, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// Async run with a timeout: detached so the step leads a process group and the kill reaches npm's shell and node grandchildren.
function runStep(cmd, cmdArgs, timeoutMs) {
  const start = Date.now();
  return new Promise((done) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (d) => (output += d);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      // A grandchild that escaped the group could keep the pipes open: do not wait for them.
      setTimeout(() => finish(null), 1000);
    }, timeoutMs);
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      const text = output.trim();
      done({ ok: !timedOut && code === 0, ms: Date.now() - start, output: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s\n${text}`.trim() : text, timedOut });
    };
    child.on("error", (e) => { output += e.message; finish(1); });
    child.on("close", finish);
  });
}

function report(ok, data, text) {
  process.stdout.write(json ? `${JSON.stringify({ ok, ...data }, null, 2)}\n` : `${text}\n`);
  process.exit(ok ? 0 : 1);
}

// The Node major the project pins (.nvmrc, .node-version or package.json engines.node), or null.
// Returns { file, min, exact }: `exact` for a fixed major ("24", "v24.1", "^24", "24.x"), `min` for ">=24".
function nodePin() {
  for (const file of [".nvmrc", ".node-version"]) {
    const major = existsSync(join(root, file)) && readFileSync(join(root, file), "utf8").trim().match(/^v?(\d+)/)?.[1];
    if (major) return { file, exact: Number(major) };
  }
  let range = "";
  try {
    range = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines?.node ?? "";
  } catch {}
  const min = range.match(/^>=\s*v?(\d+)/)?.[1];
  if (min) return { file: "package.json engines.node", min: Number(min) };
  const exact = range.match(/^[\^~]?v?(\d+)(\.[\dx*]+)*$/)?.[1];
  return exact ? { file: "package.json engines.node", exact: Number(exact) } : null;
}

// First .githooks stub that is missing, not executable or does not run its guard, else null.
function hookProblem() {
  const guards = { "pre-commit": "branch-guard.mjs", "pre-merge-commit": "branch-guard.mjs", "pre-push": "branch-guard.mjs", "commit-msg": "attribution-guard.mjs" };
  for (const [name, guard] of Object.entries(guards)) {
    const file = join(root, ".githooks", name);
    if (!existsSync(file)) return `.githooks/${name} is missing. Copy it from the skuizops plugin templates/githooks`;
    if (!(statSync(file).mode & 0o111)) return `.githooks/${name} is not executable. Run: chmod +x .githooks/${name}`;
    if (!readFileSync(file, "utf8").includes(guard)) return `.githooks/${name} does not run ${guard}. Restore it from the skuizops plugin templates/githooks`;
  }
  return null;
}

async function doctor() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const pin = nodePin();
  const hooksPath = run("git", ["config", "--get", "core.hooksPath"]);
  const branch = run("git", ["symbolic-ref", "--short", "-q", "HEAD"]);
  const isRepo = run("git", ["rev-parse", "--is-inside-work-tree"]).ok;

  let branchProblem = null;
  try {
    const { commitViolation } = await import("./guard/branch-guard.mjs");
    branchProblem = commitViolation(branch.ok ? branch.output : null);
  } catch {
    branchProblem = "scripts/guard/branch-guard.mjs is missing. Copy it from the skuizops plugin (see the create-verification-skill skill)";
  }

  const checks = [
    { name: "node", ok: major > 22 || (major === 22 && minor >= 18), fix: "Install Node 22.18+" },
    ...(pin
      ? [{
          name: `node matches project pin (${pin.file})`,
          ok: pin.exact ? major === pin.exact : major >= pin.min,
          fix: `the project pins Node ${pin.exact ?? `>=${pin.min}`} but this shell runs ${process.versions.node}. Switch with: nvm use (or fnm use)`,
        }]
      : []),
    ...(existsSync(join(root, "package.json"))
      ? [{ name: "dependencies", ok: existsSync(join(root, "node_modules")), fix: "npm install" }]
      : []),
    { name: "git repository", ok: isRepo, fix: "git init" },
    { name: "git hooks", ok: hooksPath.output === ".githooks" && !hookProblem(), fix: hooksPath.output === ".githooks" ? hookProblem() : "git config core.hooksPath .githooks" },
    { name: "work branch (feat/, fix/, hotfix/)", ok: isRepo && !branchProblem, fix: branchProblem ?? "git init" },
  ];
  const ok = checks.every((c) => c.ok);
  const text = checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `  ->  ${c.fix}`}`).join("\n");
  report(ok, { checks }, text);
}

// Same bytes as treeState() in the plugin verify-gate. A full verify that passes records this string;
// the Stop hook then skips. verify --changed must not record it: a filtered pass is not the suite the hook trusts.
function gitQuiet(...args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function treeState() {
  const head = gitQuiet("rev-parse", "HEAD");
  const status = gitQuiet("status", "--porcelain");
  if (head.status !== 0 || status.status !== 0) return null;
  if (status.stdout.trim() === "") return head.stdout.trim();
  const diff = gitQuiet("diff", "HEAD", "--binary");
  const untracked = gitQuiet("ls-files", "-z", "--others", "--exclude-standard");
  if (diff.status !== 0 || untracked.status !== 0) return null;
  const hash = createHash("sha256").update(head.stdout).update(diff.stdout);
  try {
    for (const file of untracked.stdout.split("\0").filter(Boolean)) hash.update(`\0${file}\0`).update(readFileSync(join(root, file)));
  } catch {
    return null;
  }
  return `dirty:${hash.digest("hex")}`;
}

function markerPath() {
  const found = gitQuiet("rev-parse", "--git-path", "skuizops-verified");
  if (found.status !== 0) return null;
  const rel = found.stdout.trim();
  return rel ? resolve(root, rel) : null;
}

function recordedState() {
  const marker = markerPath();
  if (!marker) return null;
  try {
    return readFileSync(marker, "utf8").trim();
  } catch {
    return null;
  }
}

function recordState(state) {
  const marker = markerPath();
  if (!marker || !state) return;
  try {
    writeFileSync(marker, `${state}\n`);
  } catch {}
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function parseVerifyArgs(lineArgs) {
  const paths = [];
  let changed = false;
  for (const arg of lineArgs) {
    if (arg === "--changed") changed = true;
    else if (arg === "--") continue;
    else if (arg.startsWith("--")) return { error: `unknown verify flag "${arg}"` };
    else paths.push(arg);
  }
  return { changed, paths };
}

// null when git cannot say. Paths are relative to the project.
function changedPaths() {
  const base = ["origin/HEAD", "origin/main", "origin/develop", "origin/master"]
    .map((ref) => gitQuiet("merge-base", "HEAD", ref))
    .find((r) => r.status === 0 && r.stdout.trim());
  const diff = gitQuiet("diff", "--name-only", base ? base.stdout.trim() : "HEAD");
  const untracked = gitQuiet("ls-files", "--others", "--exclude-standard");
  if (diff.status !== 0 || untracked.status !== 0) return null;
  return [...new Set(`${diff.stdout}\n${untracked.stdout}`.split("\n").map((s) => s.trim()).filter(Boolean))];
}

// A directory argument stands for every file under it (tracked or untracked), as a prefix.
function expandDirs(paths) {
  return paths.flatMap((p) => {
    if (!existsSync(join(root, p)) || !statSync(join(root, p)).isDirectory()) return [p];
    return gitQuiet("ls-files", "--cached", "--others", "--exclude-standard", "--", p).stdout.split("\n").filter(Boolean);
  });
}

// Typecheck and lint take JS/TS. Test also takes C# so a Unity script still reaches the test script.
// Deleted files are dropped: eslint and the test runner fail on a path that no longer exists.
function filesFor(step, files) {
  const code = files.filter((f) => CODE_FILE.test(f) && existsSync(join(root, f)));
  if (step === "typecheck" || step === "lint") return code;
  return [...code, ...files.filter((f) => f.endsWith(".cs") && existsSync(join(root, f)))];
}

// tsc refuses files on the command line next to a tsconfig (TS5112), so typecheck runs each affected
// workspace's own script; a file outside every workspace runs the root script.
function typecheckArgs(files) {
  const args = [];
  let rootToo = false;
  const workspaces = new Set();
  for (const f of files) {
    const dir = f.split("/").slice(0, 2).join("/");
    if (existsSync(join(root, dir, "package.json"))) workspaces.add(dir);
    else rootToo = true;
  }
  for (const dir of workspaces) {
    const name = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name;
    args.push(["run", "typecheck", "--silent", "-w", name, "--if-present"]);
  }
  if (rootToo || args.length === 0) args.push(["run", "typecheck", "--silent"]);
  return args;
}

// Several commands become one step: the first failure wins, times add up.
async function runTypecheck(files, timeoutMs) {
  const all = [];
  for (const a of typecheckArgs(files)) {
    const r = await runStep("npm", a, timeoutMs);
    all.push(r);
    if (!r.ok) break;
  }
  const last = all[all.length - 1];
  return { ...last, ms: all.reduce((n, r) => n + r.ms, 0) };
}

async function verify(lineArgs = []) {
  const timeoutEnv = process.env.CONTROL_VERIFY_TIMEOUT_MS;
  if (timeoutEnv !== undefined && !/^[1-9]\d*$/.test(timeoutEnv)) {
    const error = `CONTROL_VERIFY_TIMEOUT_MS must be a positive number of milliseconds, got "${timeoutEnv}"`;
    report(false, { error }, `FAIL ${error}`);
  }
  const timeoutMs = Number(timeoutEnv ?? 600000);
  const parsed = parseVerifyArgs(lineArgs);
  if (parsed.error) report(false, { error: parsed.error }, `FAIL ${parsed.error}  ->  see: node scripts/control.mjs --help`);
  if (!parsed.changed) {
    const state = treeState();
    if (state && recordedState() === state) report(true, { skipped: "tree already verified" }, "ok  verify (tree already verified, skipped)");
  }
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  } catch {}
  const found = ["typecheck", "lint", "test"].filter((name) => scripts[name]);
  // Fall back to a project-defined "verify" script when the standard ones are absent.
  const names = found.length ? found : scripts.verify ? ["verify"] : [];
  if (names.length === 0) {
    report(false, { error: "no typecheck, lint, test or verify script" }, "FAIL no typecheck, lint, test or verify script in package.json  ->  add at least one, then re-run verify");
  }
  let changedFiles = null;
  if (parsed.changed) {
    changedFiles = parsed.paths.length ? expandDirs(parsed.paths) : changedPaths();
    if (!changedFiles) report(false, { error: "could not list changed paths" }, "FAIL verify --changed could not list changed paths  ->  pass the paths, or run verify");
  }
  const before = parsed.changed ? null : treeState();
  const steps = [];
  for (const step of names) {
    if (parsed.changed) {
      const matched = filesFor(step, changedFiles);
      if (matched.length === 0) {
        steps.push({ step, ok: true, ms: 0, output: "", skipped: "no matching paths" });
        continue;
      }
      if (step === "typecheck") steps.push({ step, ...(await runTypecheck(matched, timeoutMs)) });
      else steps.push({ step, ...(await runStep("npm", ["run", step, "--silent", "--", ...matched], timeoutMs)) });
    } else steps.push({ step, ...(await runStep("npm", ["run", step, "--silent"], timeoutMs)) });
  }
  const ok = steps.every((s) => s.ok);
  if (ok && !parsed.changed && before && treeState() === before) recordState(before);
  const text = steps
    .map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.step} ${s.skipped ? "(no matching paths)" : s.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `(${s.ms}ms)`}${s.ok ? "" : `\n${s.output.split("\n").slice(-20).join("\n")}`}`)
    .join("\n");
  report(ok, { ...(parsed.changed ? { changed: changedFiles } : {}), steps: steps.map(({ output, ...s }) => (s.ok ? s : { ...s, output })) }, text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const answers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);

// { status, text } of a page, or null if it fails to load. Long timeout: SSR streams the body after the headers.
const page = (url) => fetch(url, { signal: AbortSignal.timeout(15000) }).then(async (r) => ({ status: r.status, text: await r.text() }), () => null);
const isApp = (p) => Boolean(p?.text.includes(APP.expect));
const got = (p) => (p ? `HTTP ${p.status}` : "no page within 15s");

const PW_HINT = "npm i -D playwright && npx playwright install chromium";
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// Directories of the processes listening on `port` (via lsof), or null when it cannot tell.
function servedFrom(port) {
  const ls = (a) => spawnSync("lsof", a, { encoding: "utf8", timeout: 5000 });
  const pids = (ls(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).stdout ?? "").split("\n").filter(Boolean);
  const dirs = pids.flatMap((pid) => (ls(["-a", "-p", pid, "-d", "cwd", "-Fn"]).stdout ?? "").split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)));
  return dirs.length ? dirs : null;
}

async function screenshot(lineArgs) {
  const flag = (name) => (lineArgs.includes(name) ? lineArgs[lineArgs.indexOf(name) + 1] : undefined);
  const route = lineArgs.find((a, i) => !a.startsWith("--") && !["--out", "--wait", "--port"].includes(lineArgs[i - 1])) ?? "/";
  if (!APP.url) {
    report(false, { error: "APP not set" }, "FAIL APP is not set  ->  set APP = { start, url, expect } in scripts/control.mjs (see the create-verification-skill skill)");
  }
  if (!APP.expect) {
    report(false, { error: "APP.expect not set" }, "FAIL APP.expect is not set  ->  set it to text the app's HTML always contains (e.g. \"/@vite/client\" or its <title>) in scripts/control.mjs");
  }
  const invalid = (error) => report(false, { error }, `FAIL ${error}`);
  const wait = flag("--wait");
  // Capped below the 120 s Playwright timeout; huge values also overflow Node timers.
  const outArg = flag("--out");
  if (lineArgs.includes("--out") && (!outArg || outArg.startsWith("--"))) invalid(`--out needs a file path, got "${outArg ?? ""}"`);
  if (lineArgs.includes("--wait") && !/^\d{1,5}$/.test(wait ?? "")) invalid(`--wait needs a number of milliseconds up to 99999, got "${wait ?? ""}"`);
  const portArg = flag("--port");
  if (lineArgs.includes("--port") && (!/^\d{1,5}$/.test(portArg ?? "") || Number(portArg) < 1 || Number(portArg) > 65535)) invalid(`--port needs a port number from 1 to 65535, got "${portArg ?? ""}"`);
  const url = portArg ? Object.assign(new URL(APP.url), { port: portArg }).href : APP.url;
  // The origin check also catches "//host" and "/\host", which URL parsing sends to another host.
  if (!route.startsWith("/") || new URL(route, url).origin !== new URL(url).origin) invalid(`route must be a path starting with a single "/", got "${route}"`);
  const timeoutEnv = process.env.CONTROL_START_TIMEOUT_MS;
  if (timeoutEnv !== undefined && !/^[1-9]\d*$/.test(timeoutEnv)) invalid(`CONTROL_START_TIMEOUT_MS must be a positive number of milliseconds, got "${timeoutEnv}"`);
  // The project's own binary: npx would silently fall back to a global Playwright.
  const pwBin = join(root, "node_modules", ".bin", "playwright");
  if (!existsSync(pwBin)) {
    report(false, { error: "Playwright is not installed in this project", fix: PW_HINT }, `FAIL Playwright is not installed in this project  ->  ${PW_HINT}`);
  }
  const target = new URL(route, url).href;
  // Resolved from the caller's cwd (Playwright runs from the project root); absolute, so "-x.png" is never read as a flag.
  // One fixed file per project, so repeated runs never pile up temp directories.
  const out = outArg ? resolve(outArg) : join(tmpdir(), `${basename(root)}-screenshot.png`);
  let server = null;
  let pwChild = null;
  let exited = false;
  let warning = null;
  let log = "";
  const tail = () => log.trim().split("\n").slice(-10).join("\n");
  // Only ever kills a server this run started.
  const stop = () => {
    if (pwChild?.pid && pwChild.exitCode === null) try { process.kill(-pwChild.pid, "SIGKILL"); } catch {}
    if (server?.pid && !exited) try { process.kill(-server.pid, "SIGKILL"); } catch {}
  };
  const fail = (error, text) => {
    stop();
    report(false, { error, detail: text }, `FAIL ${text}`);
  };
  for (const [sig, code] of Object.entries(SIGNALS)) process.on(sig, () => { stop(); process.exit(code); });
  const { port, protocol } = new URL(url);
  const home = (await answers(url)) ? await page(url) : null;
  if (home && !isApp(home)) {
    fail("port taken", `${url} answers (${got(home)}) but its page does not contain APP.expect ("${APP.expect}"): another app holds the port, or the app is failing  ->  check what listens (lsof -nP -iTCP:${port || (protocol === "https:" ? 443 : 80)} -sTCP:LISTEN), stop it if it is not this app, then retry`);
  }
  if (home) {
    // A second checkout of the same app passes isApp, so check the server runs from this project.
    const dirs = servedFrom(new URL(url).port || (protocol === "https:" ? 443 : 80));
    const rootReal = realpathSync(root);
    const inside = (d) => { const r = relative(rootReal, d); return !r.startsWith("..") && !isAbsolute(r); };
    if (dirs && !dirs.some(inside)) fail("other checkout", `${url} is served from ${dirs.join(", ")}, not from this project (${rootReal}): another checkout holds the port  ->  stop it, or run this checkout's server on another port and pass --port <n>`);
    if (!dirs) warning = `could not confirm that ${url} is served from this checkout (lsof missing or no listener found)`;
  }
  if (!home) {
    if (portArg) fail("app not running", `${url} does not answer and --port was given  ->  start this checkout's dev server on port ${portArg} first, then retry`);
    if (!APP.start) fail("app not running", `${url} does not answer and APP.start is not set  ->  start the app or set APP.start in scripts/control.mjs`);
    server = spawn(APP.start[0], APP.start.slice(1), { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    server.on("error", (e) => { log += `${e.message}\n`; exited = true; });
    server.on("exit", () => (exited = true));
    for (const stream of [server.stdout, server.stderr]) stream.on("data", (d) => (log += d));
    const deadline = Date.now() + Number(timeoutEnv ?? 60000);
    let up = false;
    while (!up && !exited && Date.now() < deadline) {
      await sleep(500);
      up = await answers(url);
    }
    if (!up && exited) fail("app did not start", `"${APP.start.join(" ")}" exited before ${url} answered  ->  last output:\n${tail()}`);
    if (!up) fail("app did not start", `${url} did not answer after starting "${APP.start.join(" ")}"  ->  last output:\n${tail()}`);
    const started = await page(url);
    if (!isApp(started)) fail("not the app", `"${APP.start.join(" ")}" started but ${url} (${got(started)}) does not contain APP.expect ("${APP.expect}")  ->  fix APP.expect or url in scripts/control.mjs`);
  }
  const pw = await new Promise((resolve) => {
    // Own process group so an interrupt can kill Playwright and its browser together.
    const child = (pwChild = spawn(pwBin, ["screenshot", ...(lineArgs.includes("--full-page") ? ["--full-page"] : []), ...(wait ? ["--wait-for-timeout", wait] : []), target, out], { cwd: root, detached: true }));
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 120000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (d) => (output += d));
    child.on("error", (e) => { output += e.message; });
    child.on("close", (status) => { clearTimeout(timer); resolve({ ok: status === 0, output: timedOut ? `${output}\nPlaywright timed out after 120s` : output }); });
  });
  stop();
  if (!pw.ok) {
    const msg = pw.output.trim();
    const missing = /Executable doesn't exist|playwright install/i.test(msg);
    report(false, { error: msg, ...(missing ? { fix: PW_HINT } : {}) }, `FAIL screenshot of ${target}  ->  ${missing ? `Playwright browser is missing: ${PW_HINT}` : msg.split("\n").slice(-10).join("\n")}`);
  }
  report(true, { url: target, file: out, ...(warning ? { warning } : {}) }, `ok screenshot ${target} -> ${out}${warning ? `\nwarning: ${warning}` : ""}`);
}

const flagOf = (lineArgs, name) => {
  const at = lineArgs.indexOf(name);
  const value = at === -1 ? undefined : lineArgs[at + 1];
  return value && !value.startsWith("--") ? value : undefined;
};
const fail = (error, fix) => report(false, { error, fix }, `FAIL ${error}  ->  ${fix}`);

// { status, data, base } of one API call; exits with a fix when the API does not answer.
async function api(lineArgs, method, path, body) {
  const given = flagOf(lineArgs, "--base") ?? process.env.CONTROL_API_BASE ?? API_BASE;
  let base;
  try {
    base = new URL(given).origin;
  } catch {
    fail(`--base must be a URL, got "${given}"`, "pass e.g. --base http://127.0.0.1:3000");
  }
  let res;
  try {
    res = await fetch(new URL(path, base), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    fail(`${base} did not answer (${e.cause?.code ?? e.message})`, "start the Worker (npm run db:migrate:local -w @mis-servicios/worker && npm run dev -w @mis-servicios/worker) or pass --base <url>");
  }
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, base };
}

async function health(lineArgs) {
  const { status, data, base } = await api(lineArgs, "GET", "/health");
  const ok = status === 200 && data?.status === "ok";
  report(ok, { base, status, data }, ok ? `ok  health ${base} -> 200 {"status":"ok"}` : `FAIL health ${base} -> HTTP ${status} ${JSON.stringify(data)}  ->  the API is up but unhealthy: check its logs`);
}

async function zones(lineArgs) {
  const { status, data, base } = await api(lineArgs, "GET", "/v1/zones");
  const ok = status === 200 && Array.isArray(data);
  const slugs = ok ? data.map((z) => z.slug) : [];
  report(ok, { base, status, count: slugs.length, slugs }, ok ? `ok  zones ${base}: ${slugs.length} approved (${slugs.join(", ") || "none: apply the D1 migrations with npm run db:migrate:local -w @mis-servicios/worker"})` : `FAIL zones ${base} -> HTTP ${status}  ->  a 500 means the API cannot reach the database`);
}

async function cells(lineArgs) {
  const query = new URLSearchParams();
  for (const name of ["service", "provider"]) if (flagOf(lineArgs, `--${name}`)) query.set(name, flagOf(lineArgs, `--${name}`));
  const { status, data, base } = await api(lineArgs, "GET", `/v1/cells${query.size ? `?${query}` : ""}`);
  const ok = status === 200 && Array.isArray(data);
  report(ok, { base, status, count: ok ? data.length : 0, cells: ok ? data : data }, ok ? `ok  cells ${base}: ${data.length} cell(s)${data.length ? "" : " (empty: map gate off, no zones, or nobody reported)"}` : `FAIL cells ${base} -> HTTP ${status}  ->  a 500 means the API cannot reach the database`);
}

async function notice(lineArgs) {
  const slug = lineArgs.find((a) => !a.startsWith("--") && lineArgs[lineArgs.indexOf(a) - 1] !== "--base");
  if (!slug) fail("no zone slug", "pass one, e.g. notice lince (list them with: zones)");
  const { status, data, base } = await api(lineArgs, "GET", `/v1/zones/${encodeURIComponent(slug)}/notice`);
  const ok = status === 200 && typeof data?.title === "string";
  report(ok, { base, status, data }, ok ? `ok  notice ${slug}: ${data.title}` : `FAIL notice ${slug} -> HTTP ${status}  ->  404 means the zone is unknown or not approved: list the slugs with: zones`);
}

const REPORT_STATUSES = ["outage", "restored"];
const PROVIDERS = { water: "sedapal", electricity: "luz_del_sur", internet: "claro" };

async function sendReport(lineArgs) {
  const lat = Number(flagOf(lineArgs, "--lat"));
  const lng = Number(flagOf(lineArgs, "--lng"));
  if (!flagOf(lineArgs, "--lat") || !flagOf(lineArgs, "--lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    fail("--lat and --lng are required numbers", "e.g. report --lat -12.082 --lng -77.045 --dry-run (a point inside an approved zone)");
  }
  const status = flagOf(lineArgs, "--status") ?? "outage";
  const service = flagOf(lineArgs, "--service") ?? "water";
  if (!REPORT_STATUSES.includes(status)) fail(`--status must be outage or restored, got "${status}"`, "pass --status outage|restored");
  if (!PROVIDERS[service]) fail(`--service must be water, electricity or internet, got "${service}"`, "pass --service water|electricity|internet");
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const body = {
    submissionId: flagOf(lineArgs, "--submission") ?? `control-${stamp}`,
    // The API only accepts a signed id from POST /v1/device; it is fetched after the dry-run exit.
    deviceId: flagOf(lineArgs, "--device") ?? "<issued by POST /v1/device>",
    services: [service],
    providers: { [service]: flagOf(lineArgs, "--provider") ?? PROVIDERS[service] },
    status,
    latitude: lat,
    longitude: lng,
  };
  const base = new URL(flagOf(lineArgs, "--base") ?? process.env.CONTROL_API_BASE ?? API_BASE).origin;
  if (lineArgs.includes("--dry-run")) report(true, { dryRun: true, method: "POST", url: `${base}/v1/reports`, body }, `ok  dry run: would POST ${base}/v1/reports\n${JSON.stringify(body, null, 2)}`);
  if (!flagOf(lineArgs, "--device")) {
    const issued = await api(lineArgs, "POST", "/v1/device", {});
    if (issued.status !== 201 || typeof issued.data?.deviceId !== "string") report(false, { base: issued.base, status: issued.status, data: issued.data }, `FAIL device -> HTTP ${issued.status} ${JSON.stringify(issued.data)}  ->  503 device_unavailable means DEVICE_TOKEN_SECRET is unset; 429 is the per-IP issue limit`);
    body.deviceId = issued.data.deviceId;
  }
  const res = await api(lineArgs, "POST", "/v1/reports", body);
  const ok = res.status === 201 && res.data?.accepted === true;
  report(ok, { base: res.base, status: res.status, data: res.data, sent: body }, ok ? `ok  report accepted (${body.submissionId}) at ${res.base}` : `FAIL report -> HTTP ${res.status} ${JSON.stringify(res.data)}  ->  503 intake_paused: intake is off; 422 outside_pilot_zone: the point is outside every approved area; 400 report_unavailable: invalid body; 401 device_invalid: --device is not a signed id; 409 already_reported: this device reported in the last hour; 429: a rate limit`);
}

// Add one function per user-facing feature, then register it below. Example:
//
// function greet(lineArgs) {
//   const name = lineArgs[0];
//   if (!name) report(false, { error: "no name" }, "Error: pass a name, e.g. greet Ada");
//   report(true, { greeting: `Hello, ${name}` }, `Hello, ${name}`);
// }
// ...and in the dispatch: else if (command === "greet") greet(rest);
// Also add the command to HELP and a row to .claude/verification/features/README.md.

// eslint-disable-next-line no-unused-vars -- `rest` is used by feature commands added below.
const [command, ...rest] = args;
if (command === "doctor") await doctor();
else if (command === "verify") await verify(rest);
else if (command === "screenshot") await screenshot(rest);
else if (command === "health") await health(rest);
else if (command === "zones") await zones(rest);
else if (command === "cells") await cells(rest);
else if (command === "notice") await notice(rest);
else if (command === "report") await sendReport(rest);
else {
  process.stdout.write(`${HELP}\n`);
  process.exit(command && command !== "--help" && command !== "help" ? 1 : 0);
}
