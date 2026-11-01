import { readFileSync, readdirSync, appendFileSync } from "node:fs";

// Samples CPU (cores used since the last sample) and RSS per process group every METRICS_SECONDS into /out/metrics.jsonl.
const intervalMs = Number(process.env.METRICS_SECONDS ?? 30) * 1000;
const TICKS = 100;
const group = (comm) =>
  comm.startsWith("chrome") ? "chromium" : ["node", "Xvfb", "pulseaudio", "ffmpeg"].includes(comm) ? comm : "other";

function snapshot() {
  const procs = new Map();
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(f[11]) + Number(f[12]);
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
      procs.set(pid, { group: group(comm), ticks, rssKb });
    } catch {}
  }
  return procs;
}

function cgroupMemMb() {
  try { return Math.round(Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")) / 1048576); } catch { return null; }
}

let prev = snapshot();
let prevAt = Date.now();
setInterval(() => {
  const now = snapshot();
  const at = Date.now();
  const dt = (at - prevAt) / 1000;
  const groups = {};
  for (const [pid, p] of now) {
    const g = (groups[p.group] ??= { cpu: 0, rssMb: 0, n: 0 });
    g.cpu += (p.ticks - (prev.get(pid)?.ticks ?? 0)) / TICKS / dt;
    g.rssMb += p.rssKb / 1024;
    g.n += 1;
  }
  for (const g of Object.values(groups)) { g.cpu = +g.cpu.toFixed(3); g.rssMb = Math.round(g.rssMb); }
  appendFileSync("/out/metrics.jsonl", JSON.stringify({ t: new Date(at).toISOString(), cgroupMemMb: cgroupMemMb(), groups }) + "\n");
  prev = now;
  prevAt = at;
}, intervalMs);
