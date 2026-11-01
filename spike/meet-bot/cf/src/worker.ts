import { DurableObject } from "cloudflare:workers";

interface Env {
  MEET_SPIKE: DurableObjectNamespace<MeetSpike>;
  SPIKE_TOKEN: string;
}

// Exec does not inherit the image ENV, so the variables the Playwright image relies on are set here.
const BASE_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  HOME: "/root",
};
const LIFETIME_MS = 20 * 60 * 1000;

/** One Durable Object per spike run; it owns one container kept alive with `sleep` so files can be read after the run. */
export class MeetSpike extends DurableObject<Env> {
  private async container(): Promise<Container> {
    const c = this.ctx.container;
    if (!c) throw new Error("no container configured");
    if (!c.running) {
      c.start({ enableInternet: true, entrypoint: ["sleep", "infinity"] });
      await c.setInactivityTimeout(LIFETIME_MS);
      await this.ctx.storage.setAlarm(Date.now() + LIFETIME_MS);
    }
    return c;
  }

  async run(env: Record<string, string>): Promise<ReadableStream> {
    const c = await this.container();
    const proc = await c.exec(["/app/entrypoint.sh"], { cwd: "/app", env: { ...BASE_ENV, ...env }, stdout: "pipe", stderr: "combined" });
    return proc.stdout!;
  }

  async exec(cmd: string[]): Promise<ArrayBuffer> {
    const c = await this.container();
    const out = await (await c.exec(cmd, { env: BASE_ENV, stdout: "pipe", stderr: "combined" })).output();
    return out.stdout;
  }

  async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.container?.destroy("stopped");
  }

  override async alarm(): Promise<void> {
    await this.ctx.container?.destroy("lifetime reached");
  }
}

function authorized(request: Request, env: Env): boolean {
  const got = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const want = new TextEncoder().encode(`Bearer ${env.SPIKE_TOKEN}`);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

const FILE_RE = /^[\w.-]+$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SPIKE_TOKEN || !authorized(request, env)) return new Response("unauthorized", { status: 401 });
    const [, run, id, action, name] = new URL(request.url).pathname.split("/");
    if (run !== "run" || !id || !FILE_RE.test(id)) return new Response("not found", { status: 404 });
    const stub = env.MEET_SPIKE.get(env.MEET_SPIKE.idFromName(id));

    if (request.method === "POST" && !action) {
      const body = await request.json<{ meetUrl: string; recordSeconds?: number; prejoinWaitSeconds?: number; screenshotSeconds?: number; authState?: string }>();
      const runEnv: Record<string, string> = {
        MEET_URL: body.meetUrl,
        RECORD_SECONDS: String(body.recordSeconds ?? 60),
        PREJOIN_WAIT_SECONDS: String(body.prejoinWaitSeconds ?? 12),
        ADMIT_TIMEOUT_SECONDS: "180",
        SCREENSHOT_SECONDS: String(body.screenshotSeconds ?? 20),
      };
      if (body.authState) runEnv.MEET_AUTH_STATE_JSON = body.authState;
      return new Response(await stub.run(runEnv), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (request.method === "GET" && action === "files") {
      return new Response(await stub.exec(["ls", "-la", "/out"]));
    }
    if (request.method === "GET" && action === "file" && name && FILE_RE.test(name)) {
      return new Response(await stub.exec(["cat", `/out/${name}`]));
    }
    if (request.method === "GET" && action === "exec") {
      return new Response(await stub.exec(["bash", "-c", "curl -s https://api.ipify.org; echo; nproc; free -m; df -h /dev/shm"]));
    }
    if (request.method === "DELETE" && !action) {
      await stub.stop();
      return new Response("stopped");
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
