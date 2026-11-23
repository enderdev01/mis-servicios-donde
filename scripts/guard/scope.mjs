// Where the plugin's Claude Code hooks are active. The plugin is installed for the whole user,
// but its hooks only act on projects under ~/DEV plus any roots added with SKUIZOPS_ROOTS,
// a ":"-separated list of absolute paths. The variable adds roots, it never replaces ~/DEV.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve symlinks through the deepest existing ancestor, so a link cannot hide its target.
export function real(path) {
  let head = path;
  const tail = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return path;
  }
}

// macOS volumes are case-insensitive by default: compare folded.
export const fold = (path) => real(resolve(path)).toLowerCase();
export const under = (path, root) => path === root || path.startsWith(`${root}${sep}`);

export function scopeRoots(env = process.env) {
  const added = env.SKUIZOPS_ROOTS?.split(delimiter).filter(Boolean) ?? [];
  return [...new Set([join(env.HOME ?? "", "DEV"), ...added].map((root) => resolve(root)))];
}

export function inScope(dir, env = process.env) {
  if (!dir) return false;
  const target = fold(dir);
  return scopeRoots(env).some((root) => under(target, fold(root)));
}

// Projects the human trusts to run their own code from hooks (the verify gate and the linter).
// The list lives outside every repo, so a cloned project cannot trust itself. One absolute path per line.
export function trustFile(env = process.env) {
  return join(env.HOME ?? "", ".config", "skuizops", "trusted-projects");
}

// { top, main } of the git work tree holding `dir`, or null outside git. `main` is the main worktree root:
// for a linked worktree (git worktree add) the parent of the common .git dir, else `top` itself.
// A linked worktree only counts when git structures owned by the main repo vouch for it: its admin dir must be
// <common>/worktrees/<name>, and that dir's own `gitdir` back-pointer must name <top>/.git. Nothing inside the candidate
// directory is believed (a forged .git file + commondir + gitdir all live there). Used only to find the untracked manifest, never for trust.
function layout(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { encoding: "utf8" });
  const [top, gitDir, common] = r.status === 0 ? r.stdout.split("\n") : [];
  if (!top || !gitDir || !common) return null;
  // git < 2.31 does not know --path-format and echoes the flag back: fail closed.
  // shortcut: no unit test (needs a git < 2.31 binary or an injected spawn), add one if layout() gains an injectable runner.
  if ([top, gitDir, common].some((l) => l.startsWith("--"))) return null;
  if (gitDir === common || basename(common) !== ".git") return { top, main: top };
  try {
    const worktrees = join(common, "worktrees");
    if (real(dirname(gitDir)) !== real(worktrees)) return { top, main: top };
    const backPointer = readFileSync(join(worktrees, basename(gitDir), "gitdir"), "utf8").trim();
    if (real(backPointer) !== real(join(top, ".git"))) return { top, main: top };
  } catch {
    return { top, main: top };
  }
  return { top, main: dirname(common) };
}

export const mainWorktree = (dir) => (dir ? layout(dir)?.main ?? null : null);

// Exact match only, compared through symlinks: a trusted folder does not trust the projects inside it.
// A linked worktree is not trusted through its main worktree: every inheritance check we tried could be forged
// from inside the candidate directory, so each worktree is trusted on its own with /skuizops:trust.
export function isTrusted(dir, env = process.env) {
  if (!dir || dir.includes("\n")) return false;
  let roots;
  try {
    roots = readFileSync(trustFile(env), "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/"));
  } catch {
    return false;
  }
  const target = real(resolve(dir));
  return roots.some((root) => real(resolve(root)) === target);
}

// Single-quoted so a hostile directory name cannot run code when the human pastes the command.
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
export const trustHint = (dir, env = process.env) =>
  dir.includes("\n")
    ? "this directory name contains a newline and cannot be trusted: rename it."
    : `mkdir -p ${sh(dirname(trustFile(env)))} && echo ${sh(resolve(dir))} >> ${sh(trustFile(env))}`;

// Git top level of `dir` when it sits inside a work tree, else `dir`. `dir` is resolved through symlinks first,
// so a link resolves to its target's own repo, never to the repo that holds the link. Fails closed to `dir`.
export function projectRoot(dir) {
  if (!dir) return dir;
  const actual = real(resolve(dir));
  const r = spawnSync("git", ["-C", actual, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = r.status === 0 ? r.stdout.trim() : "";
  if (!top || top.startsWith("--")) return dir;
  const root = real(top);
  return under(fold(actual), fold(root)) ? root : dir;
}

// The folder the session was opened in, as Claude Code reports it (not resolved to the repo root).
export function sessionDir(input = {}) {
  return process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
}

// The project directory a hook is running for: the git root of the session folder.
export function projectDir(input = {}) {
  return projectRoot(sessionDir(input));
}

// True when the module at `metaUrl` is the script node was started with.
// Both paths are resolved through symlinks: comparing raw paths made scripts silently skip
// their entry point (and the branch guard fail open) when launched via a symlinked path.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
