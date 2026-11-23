// Branch policy for every agent and every human:
//   - commits only on work branches: `feat/*`, `fix/*`, `hotfix/*`
//   - never commit or push to a protected branch (or anything under it, e.g. release/1.2)
//
// One policy, three entry points:
//   node branch-guard.mjs claude       Claude Code PreToolUse hook (Bash), reads hook JSON on stdin
//   node branch-guard.mjs pre-commit   git pre-commit / pre-merge-commit hook
//   node branch-guard.mjs pre-push     git pre-push hook, reads "<local ref> <sha> <remote ref> <sha>" lines
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { inScope, isMain, projectDir } from "./scope.mjs";

export const PROTECTED = ["develop", "desarrollo", "desa", "main", "master", "production", "prod", "test", "release"];
export const WORK_PREFIXES = ["feat/", "fix/", "hotfix/"];

const shortName = (ref) => ref.replace(/^refs\/heads\//, "");

export function isProtected(ref) {
  const first = shortName(ref).toLowerCase().split("/")[0];
  return PROTECTED.includes(first);
}

export function isWorkBranch(ref) {
  return WORK_PREFIXES.some((prefix) => shortName(ref).startsWith(prefix));
}

export function commitViolation(branch) {
  if (!branch) return "HEAD is detached or unknown. Create a branch first: git switch -c feat/<name> (or fix/, hotfix/)";
  if (isProtected(branch)) return `"${branch}" is a protected branch. Work on a feat/, fix/ or hotfix/ branch: git switch -c feat/<name>`;
  if (!isWorkBranch(branch)) return `"${branch}" is not a feat/, fix/ or hotfix/ branch. Rename it: git branch -m feat/<name>`;
  return null;
}

export function pushViolation(remoteRef) {
  if (isProtected(remoteRef)) return `Pushing to protected branch "${shortName(remoteRef)}" is forbidden. Open a PR from a feat/, fix/ or hotfix/ branch instead.`;
  if (!isWorkBranch(remoteRef)) return `Only feat/, fix/ and hotfix/ branches may be pushed, got "${shortName(remoteRef)}".`;
  return null;
}

// git global options that take a separate value: `git -c k=v commit`, `git -C dir commit`.
const GIT_OPTIONS_WITH_VALUE = ["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];

// Split `git [global options] <subcommand> [args]` into the subcommand and its arguments.
function parseGit(words) {
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += GIT_OPTIONS_WITH_VALUE.includes(words[i]) ? 2 : 1;
  return { sub: words[i], rest: words.slice(i + 1) };
}

// A `gh` call whose only quoted text is inert data (no `$`, backtick, `;`, `|`...) cannot run git, so its
// text (e.g. an issue body that mentions `git commit`) is not inspected. `gh alias`/`extension` can run shell.
const GH_DATA = /"\$\(cat <<'(\w+)'\n([\s\S]*?)\n\1\n\)"|"(?:\\.|[^"\\$`])*"|'[^']*'/g;
// gh's own commands. Any other first word may be an alias or an extension, which run shell; `alias`, `extension` and
// `config` define them and gh's browser, editor and pager; `copilot` downloads and runs a program.
const GH_BUILTIN = new Set(["api", "attestation", "auth", "browse", "cache", "codespace", "completion", "gist", "gpg-key", "help", "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "version", "workflow", "--help", "-h", "--version"]);
export function isPlainGhCall(command) {
  if (!GH_BUILTIN.has(/^gh[ \t]+([^\s;&|<>]+)/.exec(command)?.[1])) return false;
  // A body line equal to the delimiter would end the heredoc early and run the rest: keep the `$` so it is rejected.
  const rest = command.replace(GH_DATA, (m, tag, body) => (tag && body.split("\n").includes(tag) ? m : ""));
  return !/[;&|<>(){}$`\\#"'\n]/.test(rest);
}

// A small shell parser (issue #61). It understands only plain shapes and returns null for anything else:
// unbalanced quotes, `$(...)`, backticks, subshells, process substitution, line continuations, unterminated heredocs.
// The one `$(...)` it accepts is a quoted-heredoc message, `"$(cat <<'EOF' ... EOF)"`, which only prints text.
const SAFE_CAT = /"\$\(cat <<'(\w+)'\n([\s\S]*?)\n\1\n\)"/g;
const REDIR = /^(\d*[<>]|&>)/;
const REDIR_OP = /^(\d*(>>?|<|<<<|>&|<&)|&>>?)$/; // a bare operator: its target is the next word
// The delimiter must end the word: in `<<EO\F` or `<<'EO'F` the shell's delimiter is `EOF`, not `EO`.
const HEREDOC = /^<<(-?)\s*(["']?)([\w.-]+)\2(?=[\s;&|<>]|$)/;
const lineEnd = (s, i) => (s.indexOf("\n", i) === -1 ? s.length : s.indexOf("\n", i));

function parseShell(command) {
  const src = command.replace(SAFE_CAT, (m, tag, body) => (body.split("\n").includes(tag) ? m : "'\u0001'"));
  const cmds = [], cuts = [], pending = [];
  let cur = null, w = null, sep = null;
  const open = () => {
    if (!cur) cmds.push((cur = { words: [], sep })), (sep = null);
    return cur;
  };
  const flush = (end) => {
    if (w) (w.end = end), open().words.push(w);
    w = null;
  };
  const split = (s, at) => {
    flush(at);
    cur = null;
    sep = s;
  };
  const word = (at) => (w ??= { raw: "", quoted: false, start: at });
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (c === " " || c === "\t") flush(i);
    else if (c === "\n") {
      flush(i);
      // Heredoc bodies start on the next line. An unquoted body still expands `$(...)` and backticks: not understood.
      for (const h of pending.splice(0)) {
        const start = i + 1;
        let j = start, end = -1;
        while (j <= src.length) {
          const e = lineEnd(src, j);
          const line = src.slice(j, e);
          if (!h.quoted && line.endsWith("\\")) return null; // the shell joins it with the next line, which can form the delimiter
          if ((h.dash ? line.replace(/^\t+/, "") : line) === h.word) { end = e; break; }
          if (e === src.length) break;
          j = e + 1;
        }
        if (end === -1 || (!h.quoted && /\$\(|`/.test(src.slice(start, end)))) return null;
        cuts.push({ start, end, owner: h.owner, quoted: h.quoted });
        i = end;
      }
      split("\n", i);
    } else if (c === "\\") {
      if (next === "\n" || next === undefined) return null;
      word(i).raw += c + next;
      w.quoted = true;
      i++;
    } else if (c === "'" || (c === "$" && next === "'")) {
      let j = c === "$" ? i + 2 : i + 1;
      while (j < src.length && src[j] !== "'") j += c === "$" && src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return null;
      word(i).raw += src.slice(i, j + 1);
      w.quoted = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "`" || (src[j] === "$" && src[j + 1] === "(")) return null;
        j += src[j] === "\\" ? 2 : 1;
      }
      if (j >= src.length) return null;
      word(i).raw += src.slice(i, j + 1);
      w.quoted = true;
      i = j;
    } else if (c === "`" || c === "(" || c === ")" || (c === "$" && next === "(") || ((c === "<" || c === ">") && next === "(")) return null;
    else if (c === "#" && !w) {
      const e = lineEnd(src, i);
      cuts.push({ start: i, end: e, owner: null });
      i = e - 1;
    } else if (c === ";") split(";", i);
    else if (c === "&") {
      if (next === "&") split("&&", i), i++;
      else if (w && /[<>]$/.test(w.raw)) w.raw += c; // 2>&1, >&2
      else if (next === ">") word(i).raw += c; // &> file
      else split("&", i);
    } else if (c === "|") {
      if (next === "|") split("||", i), i++;
      else split("|", i), (i += next === "&" ? 1 : 0);
    } else if (c === "<" && next === "<" && src[i + 2] === "<") {
      word(i).raw += "<<<"; // a here-string, not a heredoc: its next `<<` must not be read as one
      i += 2;
    } else if (c === "<" && next === "<") {
      const m = HEREDOC.exec(src.slice(i));
      if (!m) return null;
      flush(i);
      pending.push({ dash: !!m[1], quoted: !!m[2], word: m[3], owner: open() });
      cur.words.push({ raw: m[0], quoted: true, start: i, end: i + m[0].length });
      i += m[0].length - 1;
    } else {
      // The shell expands an unquoted glob or brace (`comm*`, `com{mit,}`): the word may not be what it reads. `${` is a variable.
      if ("*?[".includes(c) || (c === "{" && src[i - 1] !== "$")) word(i).glob = true;
      word(i).raw += c;
    }
  }
  flush(src.length);
  return pending.length ? null : { src, cmds, cuts };
}

// The words a command runs, without leading assignments and redirections.
function argv(words) {
  const out = [];
  for (let k = 0; k < words.length; k++) {
    if (REDIR.test(words[k].raw)) {
      if (REDIR_OP.test(words[k].raw)) k++;
      continue;
    }
    if (!out.length && /^[A-Za-z_]\w*=/.test(words[k].raw)) continue;
    out.push(words[k]);
  }
  return out;
}

const isGit = (w) => !!w && !w.quoted && (w.raw === "git" || w.raw.endsWith("/git"));
// Commands that only print, read or create files: their arguments and heredocs are data, never shell.
const INERT = new Set(["echo", "printf", "cat", "tee", "grep", "head", "tail", "wc", "ls", "mkdir", "touch", "true", "false", "pwd", "cd", "gh"]);
function kind(cmd) {
  const a = argv(cmd.words);
  if (!a.length) return "assign";
  if (isGit(a[0])) return "git";
  if (a[0].quoted || /[$\\]/.test(a[0].raw) || !INERT.has(a[0].raw)) return "other";
  // A prefix assignment (GH_BROWSER=, PAGER=...) can name a program to run.
  if (cmd.words.slice(0, cmd.words.indexOf(a[0])).some((w) => /^[A-Za-z_]\w*=/.test(w.raw))) return "other";
  // The first argument picks gh's subcommand and printf's `-v`: it must be read as the shell passes it, so it has to be plain.
  const first = a[1] && (a[1].quoted || /[$\\]/.test(a[1].raw) ? null : a[1].raw);
  if ((a[0].raw === "gh" || a[0].raw === "printf") && a[1] && first === null) return "other";
  if (a[0].raw === "gh" && !GH_BUILTIN.has(first)) return "other";
  // bash `printf -v` sets a variable that an arithmetic `$[x]` would evaluate, running its `$(...)`. Options come first.
  if (a[0].raw === "printf" && /^-v/.test(first ?? "")) return "other";
  return "inert";
}
// A pipe feeds the left side's output to the right side: only an inert reader may receive it (never git or a shell).
const pipesOk = (p) => p.cmds.every((c) => c.sep !== "|" || (kind(c) === "inert" && argv(c.words)[0].raw !== "cd"));

// The file a word writes to when it holds an unquoted `>` (`>f`, `2>>f`, `x>f`, `&> f`, zsh `>! f`), else undefined. fd copies write none.
function outTarget(words, k) {
  const raw = words[k].raw;
  for (let i = 0, q = null; i < raw.length; i++) {
    const ch = raw[i];
    if (q) (ch === q ? (q = null) : ch === "\\" && q === '"' && i++);
    else if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ">") {
      const [, dup, force, rest] = /^>>?(&?)(!?)(.*)$/s.exec(raw.slice(i)); // `>!`, `>>!`, `>&!`: zsh writes past noclobber
      const target = rest || words[k + 1]?.raw;
      return dup && !force && /^(\d+|-)$/.test(target ?? "") ? undefined : target;
    }
  }
}
// gh reads its config on every run: aliases, extensions, pager, editor, browser. A file written in the same command
// may be that config unless it is a plain literal path outside any `gh` dir and not named config.yml or hosts.yml.
const MAY_BE_GH_CONFIG = (t) => /[$`\\*?[{]|^~(?!\/)/.test(t) || /(^|\/)gh(\/|$)|(^|\/)(config|hosts)\.ya?ml$/i.test(t.replace(/["']/g, ""));
// The files a command writes: `tee` operands and redirect targets.
function writeTargets(c) {
  const a = argv(c.words);
  const tee = a[0]?.raw === "tee" ? a.slice(1).filter((w) => !w.raw.startsWith("-")).map((w) => w.raw) : [];
  return [...tee, ...c.words.map((_, k) => outTarget(c.words, k))].filter((t) => t !== undefined);
}
const writesGhConfig = (p) => p.cmds.some((c) => argv(c.words)[0]?.raw === "gh") && p.cmds.some((c) => writeTargets(c).some(MAY_BE_GH_CONFIG));

// Commands whose text lands in a file, directly or through a pipe: that file can be run later (`bash file` in the next
// call), so the hook-skipping flags are looked for in their text too. A file gh reads as a PR/issue/release body is not.
// shortcut: a body file can still be run by a later call, upgrade if an agent abuses it.
function fileWriters(p) {
  const bodies = new Set();
  for (const c of p.cmds) {
    const a = argv(c.words);
    if (a[0]?.raw !== "gh") continue;
    a.forEach((w, k) => {
      const glued = /^--(?:body|notes)-file=(.+)$/.exec(w.raw);
      if (glued) bodies.add(glued[1]);
      else if (/^(--body-file|--notes-file|-F)$/.test(w.raw) && a[k + 1]) bodies.add(a[k + 1].raw);
    });
  }
  const out = new Set();
  for (let n = p.cmds.length - 1; n >= 0; n--) {
    const c = p.cmds[n], next = p.cmds[n + 1];
    if (writeTargets(c).some((t) => !bodies.has(t) && !/^\/dev\/(null|stdout|stderr)$/.test(t)) || (next?.sep === "|" && out.has(next))) out.add(c);
  }
  return out;
}

// The command with data removed: every argument of an inert command, heredoc bodies fed to one (or to git, which reads
// them as a message or a patch, never as shell), and comments. Only when every command is inert, git, or an assignment,
// so no removed text can reach a shell. Else null. The text of the commands in `keep` stays.
function dataOnly(p, keep = new Set()) {
  if (!p.cmds.every((c) => kind(c) !== "other") || !pipesOk(p) || p.cuts.some((c) => c.owner && !["inert", "git"].includes(kind(c.owner)))) return null;
  if (writesGhConfig(p)) return null;
  const spans = p.cuts.filter((c) => !keep.has(c.owner)).map((c) => [c.start, c.end, ""]);
  for (const c of p.cmds) {
    const head = argv(c.words)[0];
    if (kind(c) !== "inert" || head.raw === "cd" || keep.has(c)) continue;
    for (const w of c.words) if (w !== head) spans.push([w.start, w.end, "\u0001"]);
  }
  let out = "", at = 0;
  for (const [s, e, r] of spans.sort((x, y) => x[0] - y[0])) (out += p.src.slice(at, s) + r), (at = e);
  return out + p.src.slice(at);
}

// Fail closed (PR #76 round 4): what the guard cannot read exactly is never guessed. A git whose directory cannot be
// resolved runs in UNKNOWN, and a commit, merge, push or ref move there is blocked: never judged by the session branch.
const UNKNOWN = Symbol("unresolved dir");

// The words of a text as the shell passes them, split into commands. Each word: v (quotes and backslashes removed), raw,
// exp (holds a `$` or backtick expansion), split (an unquoted one, which may also become several words or a glob), glob
// (an unquoted * ? [ or a brace not after `$`). Redirections and their targets are dropped. An unterminated quote keeps
// the rest as one expanding word.
function lex(s) {
  const cmds = [[]];
  let w = null, target = false;
  const word = (i) => (w ??= { v: "", raw: "", start: i, exp: false, split: false, glob: false, redir: false });
  const end = (i) => {
    if (w) {
      w.raw = s.slice(w.start, i);
      // A here-string is the command's input (a shell runs it): its text stays a word.
      if (w.redir && /^\d*<<</.test(w.v)) (w.redir = false), (w.v = w.v.replace(/^\d*<<</, ""));
      if (w.redir) target = /^\d*&?[<>]+[&|!-]?$/.test(w.v); // a bare operator: the next word is its target
      else if (!w.v && !w.raw.replace(/^\d*<<</, "")) {} // a bare `<<<`: its text is the next word
      else if (target) target = false;
      else cmds.at(-1).push(w);
    }
    w = null;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i], next = s[i + 1];
    if (c === " " || c === "\t") end(i);
    else if (c === "#" && !w) i = lineEnd(s, i) - 1;
    else if (c === "\\") {
      if (next !== "\n") word(i).v += next ?? ""; // a line continuation joins the lines
      i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      word(i).v += s.slice(i + 1, j === -1 ? s.length : j);
      if (j === -1) w.exp = w.split = true;
      i = j === -1 ? s.length : j;
    } else if (c === '"') {
      let j = i + 1;
      for (word(i); j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && '$`"\\\n'.includes(s[j + 1])) w.v += s[++j];
        else (w.v += s[j]), (w.exp ||= s[j] === "$" || s[j] === "`");
      }
      if (j >= s.length) w.exp = w.split = true;
      i = j;
    } else if ((c === "<" || c === ">") && !w?.redir) {
      if (w && !/^\d+$/.test(s.slice(w.start, i))) end(i); // `x>f`: x is a word; `2>f`: 2 is the fd
      word(i).redir = true;
      w.v += c;
    } else if (w?.redir && /[<>&|!-]/.test(c) && /[<>&|!]$/.test(w.v)) w.v += c; // `>>`, `>&`, `>|`, `>!`, `<<-`
    else if (c === "&" && next === ">") {
      end(i);
      word(i).redir = true;
      w.v += c;
    } else if ("\n;&|()`".includes(c)) {
      end(i);
      target = false;
      if (cmds.at(-1).length) cmds.push([]);
    } else {
      word(i);
      if (c === "$") w.exp = w.split = true;
      if ("*?[".includes(c) || (c === "{" && s[i - 1] !== "$")) w.glob = true;
      w.v += c;
    }
  }
  end(s.length);
  return cmds.filter((c) => c.length);
}
const valueOf = (w) => w && lex(w.raw)[0]?.[0];
const dequote = (s) => s.replace(/["'\\]/g, "");

// `!git` is how a gh or git alias runs shell.
const GIT_WORD = /^(!|.*\/)?git$/;
const gitAt = (ws) => ws.findIndex((w) => !w.exp && !w.glob && GIT_WORD.test(w.v));
// Every command of a text that holds a git word. The words of a command that does not run git (bash -c '…',
// python -c "…", eval "…") may be run as shell: they are read the same way, three levels deep.
function gitCalls(s, depth = 0) {
  const out = [];
  for (const ws of lex(s)) {
    const at = gitAt(ws);
    if (at !== -1) out.push({ ws, at });
    // `GH_BROWSER='git …'`, `--editor="git …"`: the text after `=` is a value a program may run.
    else if (depth < 3) for (const w of ws) if (/[\s;&|()`<>]/.test(w.v)) out.push(...gitCalls(w.v.replace(/^[^=\s]*=/, ""), depth + 1));
  }
  return out;
}

// Config that cannot run a command, move the hooks or the work tree (core.pager, core.fsmonitor, alias.* can).
const SAFE_CONFIG = /^(user\.(name|email)|commit\.gpgsign|color\.[\w.-]+|advice\.[\w.-]+|core\.quotepath|init\.defaultbranch)=[^\n]*$/i;
// Subcommands that run hooks or move refs: an expansion in their arguments may become --no-verify, -n or a protected ref.
const RISKY = new Set(["commit", "merge", "cherry-pick", "revert", "rebase", "am", "reset", "push", "pull", "branch", "checkout", "switch", "tag", "update-ref", "commit-tree"]);
const VAR_WORD = /^(?:\$(\w+)|\$\{(\w+)\}|"\$(\w+)"|"\$\{(\w+)\}")$/;
const varName = (m) => m && (m[1] ?? m[2] ?? m[3] ?? m[4]);
const NO_VERIFY = "--no-verify is forbidden: the git hooks enforce the branch policy.";
const COMMIT_N = "git commit -n is --no-verify, which is forbidden: the git hooks enforce the branch policy.";
const UNRESOLVED = "git blocked: a word in this git command holds an expansion the guard cannot resolve ($VAR, ${…}, $(…), a glob or a brace), so git may get another subcommand, option, flag or directory. Write it out: a literal path for -C, literal words for the rest.";
const CONFIG = "git blocked: git -c is limited to user.name, user.email, commit.gpgsign, color.*, advice.*, core.quotepath and init.defaultBranch here; other config can run commands or move the hooks or the work tree.";
const GLOB = "git blocked: the shell expands an unquoted glob or brace (* ? [ {) in this git command, so git may get another subcommand or option. Quote the word or write it out; put file globs after --.";

// The value of a word that is a variable gitDirs resolved to one literal (`$W`, "${W}"), else undefined. Unquoted, a
// value with spaces or globs would split, so it is not resolved.
const resolvedVar = (w, vars) => {
  const m = VAR_WORD.exec(w.raw), d = m && vars.get(varName(m));
  return d && !((m[1] ?? m[2]) && /[\s*?[]/.test(d)) ? d : undefined;
};
const valuesOf = (ws, vars) => ws.map((w) => resolvedVar(w, vars) ?? w.v);

// Why the words of one git call are refused, or null. `vars`: variables gitDirs resolved to one literal.
function wordsProblem(ws, at, vars = new Map()) {
  const lit = (w) => (!w.exp && !w.glob) || resolvedVar(w, vars) !== undefined;
  const vs = valuesOf(ws, vars);
  // git accepts any unambiguous prefix of a long option, so `--no-verif` is `--no-verify`.
  if (vs.slice(at + 1).some((v) => /^--no-v/.test(v))) return NO_VERIFY;
  // xargs and parallel add words git gets from their input.
  if (vs.slice(0, at).some((v) => /(^|\/)(xargs|parallel)$/.test(v))) return UNRESOLVED;
  let k = at + 1;
  for (; ws[k] && (!lit(ws[k]) || vs[k].startsWith("-")); k++) {
    if (!lit(ws[k])) return UNRESOLVED; // an expansion before the subcommand may become one
    if (vs[k] === "-c" || vs[k].startsWith("--config-env")) {
      if (vs[k] !== "-c" || !ws[k + 1] || !lit(ws[k + 1]) || !SAFE_CONFIG.test(vs[k + 1])) return CONFIG;
      k++;
    } else if (GIT_OPTIONS_WITH_VALUE.includes(vs[k]) && ws[k + 1]) {
      if (!lit(ws[k + 1]) && (ws[k + 1].split || ws[k + 1].glob)) return UNRESOLVED; // `-C $W` may split into a subcommand
      k++;
    }
  }
  if (!ws[k]) return null;
  const rest = ws.slice(k + 1);
  if (vs[k] === "commit" && vs.slice(k + 1).some((v) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(v))) return COMMIT_N;
  if (expands(vs.slice(at + 1), (j) => ws[at + 1 + j].glob) || (vs[k] === "push" && rest.some((w) => w.glob))) return GLOB;
  if (!RISKY.has(vs[k])) return null;
  let ended = false;
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    if (lit(w)) {
      ended ||= w.v === "--";
      continue;
    }
    // One word git reads as a value or a path, never as an option: a message, a message file, or after `--`.
    const prev = j > 0 && lit(rest[j - 1]) ? rest[j - 1].v : "";
    const value = ended || /^(-[a-zA-Z]*[mF]|--message|--file)$/.test(prev) || /^(-[a-zA-Z]*[mF]|--message=|--file=)./.test(w.v);
    if (!value || w.split || w.glob) return UNRESOLVED;
  }
  return null;
}

// What a file writer puts in its file, as text a later shell would read: echo/printf arguments, heredoc bodies and
// here-strings. unresolved: the text depends on what the guard cannot see (printf formats, echo escapes, expansions,
// unquoted heredocs). Another file's or program's output is the shortcut noted at checkCommand.
function writerContents(p, writers) {
  return [...writers].map((c) => {
    const a = argv(c.words), head = a[0]?.raw;
    let text = "", unresolved = false;
    if (head === "echo" || head === "printf") {
      const vals = a.slice(1).map((w) => valueOf(w) ?? { v: "" });
      text += vals.map((x) => x.v).join(" ") + "\n";
      unresolved = vals.some((x) => x.exp || x.glob || x.v.includes("\\") || (head === "printf" && x.v.includes("%")));
    }
    c.words.forEach((w, k) => {
      if (!/^\d*<<</.test(w.raw)) return;
      const x = w.raw.replace(/^\d*<<</, "") ? lex(w.raw.replace(/^\d*<<</, ""))[0]?.[0] : valueOf(c.words[k + 1]);
      text += (x?.v ?? "") + "\n";
      unresolved ||= !!x?.exp;
    });
    for (const cut of p.cuts.filter((x) => x.owner === c)) {
      const body = p.src.slice(cut.start, cut.end);
      text += body + "\n";
      unresolved ||= !cut.quoted && /[$\\`]/.test(body);
    }
    return { text, unresolved, raw: p.src.slice(c.words[0]?.start ?? 0, c.words.at(-1)?.end ?? 0) };
  });
}

// Commands that cannot change the shell's directory, besides the inert ones.
const STAYS = new Set(["[", "[[", "test", ":", "export", "sleep"]);

// Directories each git of the command may run in, in order (null = the session cwd, UNKNOWN = not resolved), and the
// variables resolved to one literal path; null when the pipes are not understood.
function gitDirs(p) {
  if (!pipesOk(p)) return null;
  const vars = new Map();
  const literal = (raw, x) => {
    if (!x || x.exp || x.glob || /^~[^/]/.test(raw) || x.v.includes("\n")) return null; // `~user`, `~+`, `~-`
    return /^~(\/|$)/.test(raw) ? homedir() + x.v.slice(1) : x.v;
  };
  // `NAME=/path` alone on its statement, and NAME nowhere else but in `$NAME`/`${NAME}` (no `W+=`, `read W`, zsh `W[1]=`).
  const assign = (c, n) => {
    const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(c.words[0].raw);
    if (!m || c.words.length !== 1) return;
    const once = (p.src.match(new RegExp(`(?<![\\w$])(?<!\\$\\{)${m[1]}\\b`, "g")) ?? []).length === 1;
    const certain = [null, ";", "\n"].includes(c.sep) && [";", "\n", "&&"].includes(p.cmds[n + 1]?.sep);
    vars.set(m[1], (once && certain && literal(m[2], lex(m[2])[0]?.[0] ?? { v: "" })) || null);
  };
  // A literal directory: a quoted or unquoted path, or a variable resolved above. `cd` also needs it to start with `/` or
  // `.`: a bare name may be found through CDPATH.
  const pathOf = (w, cd) => {
    const m = VAR_WORD.exec(w.raw);
    const d = m ? (varName(m) !== "_" && vars.get(varName(m))) || null : literal(w.raw, valueOf(w));
    if (!d || ((m?.[1] ?? m?.[2]) && /[\s*?[]/.test(d))) return null;
    return cd && !/^(\/|\.\.?(\/|$))/.test(d) ? null : d;
  };
  const under = (cwd, d) => (isAbsolute(d) ? [d] : cwd.map((c) => (c === UNKNOWN ? c : c === null ? d : `${c}/${d}`)));
  const dirOf = (a, cwd) => {
    let k = 1, dir = null;
    for (let x = valueOf(a[k]); x && !x.exp && !x.glob && x.v.startsWith("-"); x = valueOf(a[k])) {
      if (x.v === "-C" && dir === null && a[k + 1]) {
        if ((dir = pathOf(a[k + 1], false)) === null) return [UNKNOWN];
        k += 2;
      } else if (x.v === "-c" && SAFE_CONFIG.test(valueOf(a[k + 1])?.v ?? "") && !valueOf(a[k + 1]).exp) k += 2;
      else if (x.v === "--no-pager" || x.v === "-P") k++;
      else return [UNKNOWN]; // `--bare`, `--git-dir`, a second `-C`...: git may act elsewhere (#63)
    }
    const sub = valueOf(a[k]);
    if (sub && (sub.exp || sub.glob)) return [UNKNOWN];
    return dir === null ? cwd : under(cwd, dir); // raw: `git -C` follows symlinks physically, so `..` is not folded
  };
  // ok / fail: the dirs the shell may be in when the last status was zero / non-zero. `&&` runs a command only on ok,
  // `||` only on fail, anything else on either; a skipped command keeps the state it skipped on, so in
  // `cd A || cd B && git …` git may run in A (cd A succeeded, cd B skipped) or in B.
  let ok = [null], fail = [null];
  const union = (...sets) => [...new Set(sets.flat())];
  const out = [];
  p.cmds.forEach((c, n) => {
    const cwd = c.sep === "&&" ? ok : c.sep === "||" ? fail : union(ok, fail);
    let moved = cwd, failed = cwd; // where the command leaves the shell when it succeeds / fails
    const a = argv(c.words);
    const cd = a[0]?.raw === "cd" ? 1 : ["builtin", "command"].includes(a[0]?.raw) && a[1]?.raw === "cd" ? 2 : 0;
    if (!a.length) assign(c, n);
    else if (isGit(a[0])) out.push(dirOf(a, cwd));
    else if (cd) {
      let k = cd;
      while (["-L", "-P"].includes(a[k]?.raw)) k++;
      if (a[k]?.raw === "--") k++;
      const d = a.length === k + 1 ? pathOf(a[k], true) : null; // no operand, `-`, two operands (zsh): not resolved
      moved = d === null ? [UNKNOWN] : under(cwd, d).map((x) => (x === UNKNOWN ? x : normalize(x)));
    } else if (kind(c) === "other" && !STAYS.has(a[0].raw)) moved = failed = [UNKNOWN]; // a function, alias, pushd, eval, zsh autocd…
    ok = union(c.sep === "||" ? ok : [], moved);
    fail = union(c.sep === "&&" ? fail : [], failed);
  });
  return { dirs: out, vars };
}

const UNKNOWN_DIR = (sub) => `git ${sub} blocked: the guard cannot tell which repository this git runs in (a cd, -C or variable it cannot resolve, a command before it that may change directory, or a shape it does not parse). Pass the literal path: git -C <path> … or cd <path> && git …`;
const PROGRAM = "blocked: the program this command runs cannot be read (a variable, glob or substitution in the command name, or a shell given expanded text), so it may be git. Write the command name and the script literally.";
const WRITTEN = "git blocked: git text written to a file holds escapes, format codes or expansions the guard cannot resolve (printf %, echo \\, $VAR, an unquoted heredoc), and a later call could run it with the hooks skipped. Write the text literally and quote the heredoc delimiter.";

// Words before the program: assignments, keywords and commands that run the next word.
const WRAPPERS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "time", "sudo", "env", "command", "builtin", "exec", "nohup", "nice", "xargs", "timeout"]);
const SHELLS = new Set(["eval", "bash", "sh", "zsh", "dash", "ksh", "source", "."]);
// The program each command runs must be readable: `$G commit`, `g*t`, `${G}it` or `$(…)` may be git. A plain `$NAME`
// set outside this command is allowed when the command does not mention git. Text given to a shell is read the same way.
function programProblem(text, command, mentionsGit) {
  const check = (cmds, depth) => {
    for (const ws of cmds) {
      let i = 0;
      while (ws[i] && (/^[A-Za-z_]\w*\+?=/.test(ws[i].raw) || (!ws[i].exp && WRAPPERS.has(ws[i].v)))) i++;
      const w = ws[i];
      if (!w) continue;
      const shell = !w.exp && SHELLS.has(w.v.split("/").pop());
      if (w.exp || (w.glob && !/^\[\[?$/.test(w.v))) {
        const name = varName(VAR_WORD.exec(w.raw));
        const elsewhere = !!name && new RegExp(`(?<![\\w$])(?<!\\$\\{)${name}\\b`).test(command);
        if (mentionsGit || !name || elsewhere) return PROGRAM;
      } else if (shell && mentionsGit && ws.slice(i + 1).some((x) => x.exp)) return PROGRAM;
      if (shell && depth < 3) {
        for (const x of ws.slice(i + 1)) if (/[\s;&|()`<>$]/.test(x.v)) {
          const r = check(lex(x.v), depth + 1);
          if (r) return r;
        }
      }
    }
    return null;
  };
  return check(lex(text), 0);
}

// The words after `git` that the shell may expand into another subcommand, an option or more words: a glob or brace in
// the subcommand or before it, or one that can expand to a leading `-` or (braces) to several words. `glob(k)` says
// whether word k is unquoted; file globs after `--` are only paths.
function expands(words, glob = () => true) {
  let sub = 0;
  while (sub < words.length && words[sub].startsWith("-")) sub += GIT_OPTIONS_WITH_VALUE.includes(words[sub]) ? 2 : 1;
  const end = words.includes("--") ? words.indexOf("--") : words.length;
  return words.some((w, k) => /[*?[{]/.test(w) && glob(k) && (k <= sub || (k < end && (/^[-*?[{]/.test(w) || /\{[^{}]*(,|\.\.)[^{}]*\}/.test(w)))));
}

// Check of a shell command before Claude runs it; it fails closed on what it cannot resolve. The git hooks are the
// authoritative layer.
// shortcut: text written to a file is read as written (literal, quoted, glob and brace forms); a file built from another
// file or program output (cp, base64, curl) and run by a later call is left to the git hooks, upgrade if an agent abuses it.
export function checkCommand(command, currentBranch, branchAt = () => null) {
  const parsed = parseShell(command);
  // The shell drops quotes and backslashes: `"g"it` and `g\it` are git.
  const mentionsGit = /\bgit\b/.test(dequote(command));
  // Text given to echo, cat, a heredoc... is data (#61). When anything else could run text, all of it is inspected.
  const text = (parsed && dataOnly(parsed)) ?? command;
  const program = programProblem(text, command, mentionsGit);
  if (program) return program;
  if (!mentionsGit) return null;
  const res = parsed && gitDirs(parsed);
  const vars = res?.vars ?? new Map();
  // Text written to a file may be run by a later call: it is checked for hook-skipping too, read as a shell would.
  const writers = parsed ? fileWriters(parsed) : new Set();
  const written = (parsed && dataOnly(parsed, writers)) ?? command;
  const contents = parsed ? writerContents(parsed, writers) : [];
  const all = [written, dequote(written), ...contents.map((c) => c.text)].join("\n");
  if (!/\bgit\b/.test(all)) return null;
  if (/(^|[\s"'])--no-v/.test(all)) return NO_VERIFY;
  // An included config file can set core.hooksPath without naming it here.
  if (/\binclude\.path\b|\bincludeif\./i.test(all)) return "Changing git config includes is forbidden: an included file could disable the git hooks.";
  // The one allowed form is the setup step: `git config [--local] core.hooksPath .githooks`.
  const withoutSetup = all.replace(/\bgit\s+config\s+(--local\s+)?core\.hooksPath\s+\.githooks(?![^\s;&|])/gi, "");
  if (/core\.hooksPath/i.test(withoutSetup)) return "Changing core.hooksPath is forbidden: it would disable the branch policy.";
  for (const s of [written, ...contents.map((c) => c.text)]) {
    for (const { ws, at } of gitCalls(s)) {
      const why = wordsProblem(ws, at, vars);
      if (why) return why;
    }
  }
  if (contents.some((c) => c.unresolved && /\bgit\b/.test(dequote(`${c.raw}\n${c.text}`)))) return WRITTEN;
  if (!/\bgit\b/.test(dequote(text))) return null;

  if (isPlainGhCall(command)) return null;

  // The parser's dirs are used only when it saw exactly the gits found here: a git it missed may run anywhere.
  const parsedGits = parsed ? parsed.cmds.filter((c) => isGit(argv(c.words)[0])) : [];
  const lexCalls = gitCalls(text);
  const exact = !!res && lexCalls.length === parsedGits.length;
  const calls = exact
    ? parsedGits.map((c, n) => {
        const a = argv(c.words);
        const prefix = c.words.slice(0, c.words.indexOf(a[0])).map((w) => valueOf(w)?.v ?? "");
        return { ws: a.flatMap((w) => lex(w.raw)[0] ?? []), at: 0, prefix, own: res.dirs[n] };
      })
    : lexCalls.map(({ ws, at }) => ({ ws, at, prefix: ws.slice(0, at).map((w) => w.v), own: [UNKNOWN] }));
  for (const { ws, at, prefix, own } of calls) {
    // These decide which hooks, config and git binary run. GIT_EDITOR, GIT_PAGER and the like are fine.
    if (prefix.some((w) => /^(HOME|PATH|GIT_DIR|GIT_EXEC_PATH|GIT_CONFIG\w*)=/.test(w))) {
      return "Setting HOME, PATH, GIT_DIR, GIT_EXEC_PATH or GIT_CONFIG* for a git command is forbidden: it changes which hooks and config git uses.";
    }
    const why = wordsProblem(ws, at, vars);
    if (why) return why;
    const { sub, rest } = parseGit(valuesOf(ws.slice(at + 1), vars));
    const args = [sub, ...rest.filter((w) => !w.startsWith("-"))];
    // Every dir this git may run in is judged; a violation on any of them blocks, and so does a dir not resolved.
    const branches = () => own.map((d) => (d === UNKNOWN ? d : d === null ? currentBranch : branchAt(d)));

    if (["commit", "merge", "cherry-pick", "revert", "rebase", "am", "reset"].includes(sub)) {
      for (const branch of branches()) {
        if (branch === UNKNOWN) return UNKNOWN_DIR(sub);
        const problem = commitViolation(branch);
        if (problem) return `git ${sub} blocked: ${problem}`;
      }
    }
    // Plumbing and forced branch moves change a ref without running any hook.
    if (sub === "update-ref" || sub === "commit-tree") return `git ${sub} is forbidden: it moves refs without running the git hooks.`;
    const deletes = sub === "branch" && rest.some((w) => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)$/.test(w));
    const forces =
      (sub === "branch" && rest.some((w) => /^(-[a-zA-Z]*[fM][a-zA-Z]*|--force)$/.test(w))) ||
      (sub === "checkout" && rest.includes("-B")) ||
      (sub === "switch" && rest.some((w) => w === "-C" || w === "--force-create"));
    // A delete names every branch it removes; a forced move names the branch first, then its start point.
    const operands = args.slice(1);
    const moved = deletes ? operands.find(isProtected) : forces && isProtected(operands[0] ?? "") ? operands[0] : null;
    if (moved) return `git ${sub} blocked: "${moved}" is a protected branch and cannot be moved, reset or deleted here.`;
    if (sub === "push") {
      // Long options may be abbreviated; --branches is --all.
      if (rest.some((w) => /^--(al|all|b|br|bra|bran|branc|branch|branche|branches|m|mi|mir|mirr|mirro|mirror)(=|$)/.test(w))) return "git push --all/--mirror is forbidden.";
      const heads = branches().map((b) => b ?? "");
      const refspecs = args.slice(2).map((r) => r.replace(/^\+/, "").split(":").pop()); // after "push <remote>"
      const targets = refspecs.length ? refspecs.flatMap((t) => (t === "HEAD" ? heads : [t])) : heads;
      for (const target of targets) {
        if (target === UNKNOWN) return UNKNOWN_DIR("push");
        const problem = pushViolation(target);
        if (problem) return `git push blocked: ${problem}`;
      }
    }
  }
  return null;
}

function currentBranch(cwd) {
  const r = spawnSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fail(message) {
  process.stderr.write(`Branch policy: ${message}\n`);
  process.exit(2);
}

function main(mode) {
  const stdin = readFileSync(0, "utf8");

  if (mode === "claude") {
    const input = JSON.parse(stdin || "{}");
    // Outside the scope roots (~/DEV plus SKUIZOPS_ROOTS) the Claude hook does nothing; installed git hooks still apply.
    if (!inScope(projectDir(input))) return;
    const command = input.tool_input?.command ?? "";
    const cwd = input.cwd ?? process.cwd();
    const problem = checkCommand(command, currentBranch(cwd), (d) => currentBranch(isAbsolute(d) ? d : cwd + "/" + d));
    if (problem) fail(problem);
    return;
  }
  if (mode === "pre-commit") {
    const problem = commitViolation(currentBranch(process.cwd()));
    if (problem) fail(problem);
    return;
  }
  if (mode === "pre-push") {
    for (const line of stdin.split("\n").filter(Boolean)) {
      const remoteRef = line.split(" ")[2];
      const problem = remoteRef && pushViolation(remoteRef);
      if (problem) fail(problem);
    }
    return;
  }
  fail(`unknown mode "${mode}". Use: claude | pre-commit | pre-push`);
}

if (isMain(import.meta.url)) main(process.argv[2]);
