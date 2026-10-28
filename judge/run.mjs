/**
 * Portable parity judge runner: drives the same scenarios against the Node bot
 * and the Rust port over a fake S3, a fake OpenRouter and real ffmpeg.
 * Usage: node judge/run.mjs --impl node|rust [--record-golden] [--only <scenario>]
 *
 * Prints one line per scenario ("PASS <name>" / "FAIL <name>" / "SKIP <name>"
 * when --record-golden recorded it instead), then a final "N/N". Exit 0 only
 * if every scenario passed. Goldens in judge/golden/ are recorded from Node.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeS3 } from "./fake-s3.mjs";
import { startFakeOpenRouter } from "./fake-openrouter.mjs";
import { FIXTURE_ID, FIXTURE_STARTED_AT, makeMeetingFixture } from "./fixtures.mjs";
import * as webScenarios from "./scenarios/web.mjs";
import * as pipelineScenarios from "./scenarios/pipeline.mjs";
import * as compatScenarios from "./scenarios/crypto-compat.mjs";

const JUDGE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(JUDGE_DIR);
const GOLDEN_DIR = join(JUDGE_DIR, "golden");
const RUST_BIN_DIR = join(REPO_ROOT, "rust", "target", "release");

const JUDGE_PIN = "123456";
/** Fake values; the playback host never resolves, it only appears in the minutes link and cookie flags. */
const SESSION_SECRET = "judge-session-secret-0123456789abcdef";
const PUBLIC_BASE_URL = "https://meet.judge.test";
const R2_BUCKET = "judge-bucket";

function parseArgs(argv) {
  const args = { impl: "node", recordGolden: false, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--impl") args.impl = argv[++i];
    else if (argv[i] === "--record-golden") args.recordGolden = true;
    else if (argv[i] === "--only") args.only = argv[++i];
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (args.impl !== "node" && args.impl !== "rust") throw new Error("--impl must be node or rust");
  if (args.recordGolden && args.impl !== "node") {
    throw new Error("--record-golden records from the Node bot; run it with --impl node");
  }
  return args;
}

/**
 * Preflight reserves 18701 for the node web server and 18702 for the rust one,
 * so parallel --impl runs never collide; JUDGE_NODE_PORT / JUDGE_RUST_PORT
 * override the defaults.
 */
const webPortFor = (impl) =>
  Number(process.env[impl === "node" ? "JUDGE_NODE_PORT" : "JUDGE_RUST_PORT"] ?? (impl === "node" ? 18701 : 18702));

/** Run a command to completion, capturing stdout/stderr. */
function runCmd(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
    );
  });
}

function baseEnv(dataDir, s3Url, orUrl, webPort) {
  return {
    DISCORD_TOKEN: "judge",
    DISCORD_CLIENT_ID: "judge",
    R2_ACCOUNT_ID: "judge",
    R2_ACCESS_KEY_ID: "judge",
    R2_SECRET_ACCESS_KEY: "judge",
    R2_BUCKET,
    R2_ENDPOINT: s3Url,
    OPENROUTER_API_KEY: "judge",
    OPENROUTER_BASE_URL: `${orUrl}/api/v1`,
    TRANSCRIBE_MODEL_PRIMARY: "microsoft/mai-transcribe-2",
    TRANSCRIBE_MODEL_FALLBACK: "google/gemini-3.5-transcribe",
    SUMMARY_MODEL_PRIMARY: "anthropic/claude-sonnet-5.5",
    SUMMARY_MODEL_FALLBACK: "openai/gpt-6.1-sol-pro",
    TRANSCRIBE_CONCURRENCY: "4",
    PUBLIC_BASE_URL,
    WEB_PORT: String(webPort),
    SESSION_SECRET,
    TRUST_PROXY: "true",
    DATA_DIR: dataDir,
    JUDGE_PIN,
    CLEANUP_LOCAL: "false",
  };
}

/** Wait until GET /healthz answers 2xx; fail fast when the server process dies. */
async function waitHealthy(baseUrl, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`web server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`web server did not become healthy within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const stopChild = (child) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once("close", done);
    child.kill("SIGTERM");
    setTimeout(() => {
      child.removeListener("close", done);
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000).unref();
  });

/**
 * Opens one fully isolated context: temp DATA_DIR, fake S3, fake OpenRouter and
 * (with opts.web) the implementation's web server. The runner closes everything
 * it opened once the scenario finishes.
 */
async function openCtx(world, opened, opts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "judge-run-"));
  const s3 = await startFakeS3();
  const or = await startFakeOpenRouter(opts.script);
  const webPort = webPortFor(world.impl);
  const env = baseEnv(dataDir, s3.url, or.url, webPort);
  const webLog = [];
  const ctx = {
    impl: world.impl,
    recordGolden: world.recordGolden,
    id: FIXTURE_ID,
    startedAt: FIXTURE_STARTED_AT,
    pin: JUDGE_PIN,
    env,
    dataDir,
    s3Url: s3.url,
    s3objects: s3.objects,
    s3Text: (key) => s3.objects.get(key)?.toString("utf8"),
    s3Bytes: (key) => s3.objects.get(key),
    orCalls: or.calls,
    webUrl: `http://127.0.0.1:${webPort}`,
    webLog,
    readGolden: (name) => readFileSync(join(GOLDEN_DIR, name), "utf8"),
    writeGolden: (name, data) => {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(join(GOLDEN_DIR, name), data);
    },
    judgeCli: (args) =>
      world.impl === "node"
        ? runCmd("node", ["--import", "tsx", "src/judge-cli.ts", ...args], env)
        : runCmd(join(RUST_BIN_DIR, "judge-cli"), args, env),
    seedFixture: () => makeMeetingFixture(dataDir, s3),
    seedR2Manifest: (m) => s3.objects.set(`meetings/${FIXTURE_ID}/manifest.json`, Buffer.from(JSON.stringify(m))),
    processMeeting: async () => {
      const run = await ctx.judgeCli(["process", FIXTURE_ID]);
      if (run.code !== 0) throw new Error(`judge-cli process failed (${run.code}):
${run.stderr}${run.stdout}`);
      return run;
    },
    get: (path, o = {}) =>
      fetch(`${ctx.webUrl}${path}`, {
        redirect: "manual",
        headers: o.cookie ? { cookie: o.cookie } : undefined,
      }),
    postForm: (path, fields, o = {}) =>
      fetch(`${ctx.webUrl}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(o.ip ? { "x-forwarded-for": o.ip } : {}),
        },
        body: new URLSearchParams(fields),
      }),
  };
  let child;
  if (opts.web) {
    child =
      world.impl === "node"
        ? spawn("node", ["--import", "tsx", "src/judge-web.ts"], {
            env: { ...process.env, ...env },
            cwd: REPO_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(join(RUST_BIN_DIR, "meetbot"), ["web-only"], {
            env: { ...process.env, ...env },
            cwd: REPO_ROOT,
            stdio: ["ignore", "pipe", "pipe"],
          });
    child.stdout.on("data", (d) => webLog.push(d.toString()));
    child.stderr.on("data", (d) => webLog.push(d.toString()));
    await waitHealthy(ctx.webUrl, child);
  }
  opened.push({
    stop: async () => {
      await stopChild(child);
      await s3.close();
      await or.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    webLog,
  });
  return ctx;
}

const SCENARIOS = [
  ["web/pin-gate", webScenarios.pinGate, true],
  ["web/login-and-files", webScenarios.loginAndFiles, true],
  ["web/lockout", webScenarios.lockout, true],
  ["web/security-headers", webScenarios.securityHeaders, true],
  ["web/html-snapshot", webScenarios.htmlSnapshot, true],
  ["pipeline/happy", pipelineScenarios.happy, false],
  ["pipeline/fallback", pipelineScenarios.fallback, false],
  ["pipeline/short-summary-limit", pipelineScenarios.shortSummaryLimit, false],
  ["pipeline/empty", pipelineScenarios.empty, false],
  ["pipeline/segment-from-r2", pipelineScenarios.segmentFromR2, false],
  ["recovery/closes-at-heartbeat", pipelineScenarios.closesAtHeartbeat, false],
  ["crypto/golden-vectors", compatScenarios.goldenVectors, false],
  ["time/format", compatScenarios.timeFormat, false],
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pass = [];
  const fail = [];
  const skipped = [];
  for (const [name, fn, wantsWeb] of SCENARIOS) {
    if (args.only && name !== args.only) continue;
    const world = { impl: args.impl, recordGolden: args.recordGolden };
    const opened = [];
    const open = (opts = {}) => openCtx(world, opened, { web: wantsWeb, ...opts });
    try {
      const result = await fn(open);
      if (result === "recorded") {
        skipped.push(name);
        console.log(`SKIP ${name}`);
      } else {
        pass.push(name);
        console.log(`PASS ${name}`);
      }
    } catch (err) {
      fail.push(name);
      console.log(`FAIL ${name}`);
      const stack = String(err?.stack ?? err).split("\n");
      console.log(stack.slice(0, 15).map((l) => `  ${l}`).join("\n"));
      for (const entry of opened) {
        const logs = entry.webLog?.join("").trim();
        if (logs) console.log(`  --- web server log ---\n${logs.split("\n").slice(-15).map((l) => `  ${l}`).join("\n")}`);
      }
    } finally {
      for (const entry of opened.reverse()) await entry.stop();
    }
  }
  console.log(`${pass.length}/${pass.length + fail.length}${skipped.length ? ` (${skipped.length} recorded)` : ""}`);
  process.exitCode = fail.length === 0 ? 0 : 1;
}

await main();
