/**
 * Mutation validator for the judge: proves the scenarios actually catch
 * behavior changes, not just that both implementations agree.
 *
 * For each patch in judge/mutations/*.patch it:
 *   1. applies the patch to the Node source with `git apply`,
 *   2. runs `node judge/run.mjs --impl node`,
 *   3. asserts at least one scenario FAILS,
 *   4. reverts with `git apply -R` (never `git checkout -- src`, which would
 *      wipe uncommitted work),
 *   5. prints `caught <mutation> by <scenario>`.
 *
 * Exit 0 only if every mutation was caught and the source tree is restored.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JUDGE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = dirname(JUDGE_DIR);
const MUTATIONS_DIR = join(JUDGE_DIR, "mutations");

function git(args) {
  const res = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runJudge() {
  const res = spawnSync(process.execPath, [join("judge", "run.mjs"), "--impl", "node"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const failedScenarios = (out) =>
  out
    .split("\n")
    .filter((l) => l.startsWith("FAIL "))
    .map((l) => l.slice("FAIL ".length).trim());

const patches = readdirSync(MUTATIONS_DIR).filter((f) => f.endsWith(".patch")).sort();
if (patches.length === 0) {
  console.error(`no patches found in ${MUTATIONS_DIR}`);
  process.exit(1);
}

let caughtCount = 0;
let fatal = null;

for (const file of patches) {
  const name = basename(file, ".patch");
  const patch = join(MUTATIONS_DIR, file);
  const apply = git(["apply", patch]);
  if (apply.code !== 0) {
    console.log(`MISSED ${name} (patch failed to apply: ${apply.stderr.trim()})`);
    fatal ??= `patch ${name} failed to apply`;
    continue;
  }
  let scenarios = [];
  try {
    const run = runJudge();
    scenarios = failedScenarios(run.stdout);
    if (run.code === 0) {
      console.log(`MISSED ${name} (judge exited 0, all scenarios passed)`);
      fatal ??= `mutation ${name} was not caught`;
    } else if (scenarios.length === 0) {
      console.log(`MISSED ${name} (judge exited ${run.code} but no scenario FAILed)`);
      fatal ??= `mutation ${name} crashed the judge instead of failing a scenario`;
    } else {
      console.log(`caught ${name} by ${scenarios[0]}`);
      caughtCount += 1;
    }
  } finally {
    const revert = git(["apply", "-R", patch]);
    if (revert.code !== 0) {
      fatal = `revert of ${name} failed; source tree is left MUTATED: ${revert.stderr.trim()}`;
      console.error(fatal);
      break;
    }
  }
}

const restored = git(["status", "--short", "src"]);
if (restored.stdout.trim() !== "" && fatal === null) {
  fatal = `source tree not restored after mutations: ${restored.stdout.trim()}`;
  console.error(fatal);
}

console.log(`${caughtCount}/${patches.length} mutations caught`);
process.exit(fatal === null && caughtCount === patches.length ? 0 : 1);
