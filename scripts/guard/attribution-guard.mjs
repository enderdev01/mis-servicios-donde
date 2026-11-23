// Commits belong to their human author only: reject AI attribution in commit messages and idents.
//   node attribution-guard.mjs <commit message file>   git commit-msg hook
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isMain } from "./scope.mjs";

const NAMES = "claude|anthropic|openai|chatgpt|gpt-\\d[\\w.-]*|copilot|gemini|cursor|codex|fable|opus|sonnet|haiku|devin|aider|windsurf";
const AI = new RegExp(`(?<![\\w.-])(${NAMES})(?![a-z0-9])|noreply@anthropic\\.com`, "i");
const TRAILER = /^\s*#?\s*[\w-]+-by\s*:/i;
const GENERATED = new RegExp(`\\b(generated|created|written|authored|made|built)\\s+(with|by|using)\\b.*(?<![\\w.-])(${NAMES}|ai)(?![a-z0-9])`, "i");
const SCISSORS = "# ------------------------ >8 ------------------------";

export function attributionViolation(message) {
  const lines = message.split("\n");
  const cut = lines.indexOf(SCISSORS);
  const hit = (cut < 0 ? lines : lines.slice(0, cut)).find(
    (line) => (TRAILER.test(line) && AI.test(line)) || GENERATED.test(line),
  );
  return hit ? `AI attribution is forbidden in commits, remove this line: "${hit.trim()}"` : null;
}

// ident is the output of `git var GIT_AUTHOR_IDENT`: "Name <email> timestamp tz". Only the email is checked.
export function identViolation(ident) {
  const email = /<([^>]*)>/.exec(ident)?.[1] ?? "";
  return /@(anthropic|openai)\.com$|copilot|\[bot\]/i.test(email)
    ? `the git identity "${ident.replace(/ \d+ [+-]\d{4}\s*$/, "")}" belongs to an AI tool or bot; commit as yourself`
    : null;
}

if (isMain(import.meta.url)) {
  const problems = [attributionViolation(readFileSync(process.argv[2], "utf8"))];
  for (const v of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const r = spawnSync("git", ["var", v], { encoding: "utf8" });
    if (r.status === 0) problems.push(identViolation(r.stdout));
  }
  const problem = problems.find(Boolean);
  if (problem) {
    process.stderr.write(`Commit policy: ${problem}\n`);
    process.exit(1);
  }
}
