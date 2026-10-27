/**
 * Fake OpenRouter server for the migration judge: deterministic transcript and
 * summary replies keyed by the SHA-256 of the request payload. No dependencies,
 * node:http only.
 *
 * The base URL is "${url}/api/v1". `calls` records {path, body} per request. A
 * `script(call)` returning {status, body} overrides the default response for
 * that call; returning a falsy value falls back to the defaults.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

function sha8(data) {
  return createHash("sha256").update(data).digest("hex").slice(0, 8);
}

/** Seconds of audio in a RIFF/WAVE buffer (mono 16-bit 24 kHz is 48000 bytes per second). */
export function wavSeconds(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE buffer");
  }
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(pos + 16);
    if (id === "data") {
      if (byteRate <= 0) throw new Error("WAVE fmt chunk missing or malformed");
      return size / byteRate;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAVE data chunk not found");
}

function respond(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)) });
  res.end(json);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** The second segment lands at the end of the request audio, so a transcript
    golden catches toSessionSample and line-to-speaker mapping bugs. */
function defaultSttReply(wav) {
  const sha = sha8(wav);
  const seconds = wavSeconds(wav);
  return {
    text: `ข้อความทดสอบ ${sha}`,
    segments: [
      { start: 0.1, end: 1, text: `${sha} #1` },
      { start: seconds - 1.0, end: seconds, text: `${sha} #2` },
    ],
  };
}

function defaultChatReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user")?.content ?? "";
  return { choices: [{ message: { content: `สรุป ${sha8(Buffer.from(String(lastUser), "utf8"))}` } }] };
}

export async function startFakeOpenRouter(script) {
  const calls = [];
  const server = createServer((req, res) => {
    (async () => {
      const raw = await collectBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8") || "null");
      } catch {
        return respond(res, 400, { error: { message: "request body is not JSON" } });
      }
      const call = { path: req.url, body };
      calls.push(call);
      let scripted;
      try {
        scripted = script ? script(call) : undefined;
      } catch (err) {
        return respond(res, 500, { error: { message: String(err?.message ?? err) } });
      }
      if (scripted) return respond(res, scripted.status, scripted.body);
      if (call.path.endsWith("/audio/transcriptions")) {
        return respond(res, 200, defaultSttReply(Buffer.from(String(call.body?.input_audio?.data ?? ""), "base64")));
      }
      if (call.path.endsWith("/chat/completions")) {
        return respond(res, 200, defaultChatReply(call.body));
      }
      return respond(res, 404, { error: { message: `no route for ${call.path}` } });
    })().catch((err) => {
      if (!res.headersSent) respond(res, 500, { error: { message: String(err?.message ?? err) } });
      else res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
  };
  return { url, calls, close };
}

function makeWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function selftest() {
  const assert = (await import("node:assert/strict")).default;
  const wav = makeWav(Buffer.alloc(48000 * 2)); // two seconds of mono 16-bit 24 kHz
  const seconds = wavSeconds(wav);
  const fake = await startFakeOpenRouter();
  try {
    let res = await fetch(`${fake.url}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m/test", input_audio: { data: wav.toString("base64"), format: "wav" } }),
    });
    assert.equal(res.status, 200);
    const stt = await res.json();
    assert.equal(stt.text, `ข้อความทดสอบ ${sha8(wav)}`);
    assert.equal(stt.segments.length, 2);
    assert.equal(stt.segments[0].start, 0.1);
    assert.ok(stt.segments[0].text.endsWith("#1"));
    assert.equal(stt.segments[1].start, seconds - 1.0);
    assert.equal(stt.segments[1].end, seconds);
    assert.ok(stt.segments[1].text.endsWith("#2"));

    res = await fetch(`${fake.url}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "c/test",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "สวัสดี" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "สรุปหน่อย" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const chat = await res.json();
    assert.equal(chat.choices[0].message.content, `สรุป ${sha8(Buffer.from("สรุปหน่อย", "utf8"))}`);

    res = await fetch(`${fake.url}/api/v1/other`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);

    assert.equal(fake.calls.length, 3);
    assert.deepEqual(fake.calls.map((c) => c.path), [
      "/api/v1/audio/transcriptions",
      "/api/v1/chat/completions",
      "/api/v1/other",
    ]);
    assert.equal(fake.calls[0].body.input_audio.format, "wav");
  } finally {
    await fake.close();
  }

  // A scripted fake overrides matching calls; non-matching ones use the defaults.
  const scripted = await startFakeOpenRouter((call) =>
    call.path.endsWith("/audio/transcriptions") ? { status: 400, body: { error: { message: "no verbose" } } } : undefined,
  );
  try {
    let res = await fetch(`${scripted.url}/api/v1/audio/transcriptions`, {
      method: "POST",
      body: JSON.stringify({ model: "m/test", input_audio: { data: wav.toString("base64"), format: "wav" } }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, "no verbose");
    res = await fetch(`${scripted.url}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, `สรุป ${sha8(Buffer.from("x", "utf8"))}`);
    assert.equal(scripted.calls.length, 2);
  } finally {
    await scripted.close();
  }
  console.log("selftest ok");
}

export async function main(argv) {
  if (argv[0] === "--selftest") return selftest();
  console.error("usage: node judge/fake-openrouter.mjs --selftest");
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
