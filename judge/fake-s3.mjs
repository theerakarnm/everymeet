/**
 * Fake S3 server for the migration judge: an in-memory object map behind
 * path-style PUT/GET. No dependencies, node:http only.
 *
 * - objects is keyed by the S3 object key (everything after "/{bucket}/"), so
 *   the judge can seed fixtures and assert on plain R2 key strings.
 * - Signatures are ignored, so presigned URLs resolve.
 * - Streamed uploads arrive as aws-chunked bodies (hex-size[;chunk-signature=...]
 *   framing plus a checksum trailer); this server decodes them back to bytes.
 */
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const XML_NO_SUCH_KEY = "<Error><Code>NoSuchKey</Code></Error>";

/** Split "/{bucket}/{key...}" (query ignored) into [bucket, key]; undefined when a part is missing. */
function parseTarget(url) {
  const parts = url.split("?")[0].split("/").filter((p) => p !== "").map(decodeURIComponent);
  if (parts.length < 2) return undefined;
  return [parts[0], parts.slice(1).join("/")];
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** Decode an aws-chunked body: repeated "hex-size[;chunk-signature=...]\r\ndata\r\n", then a 0-size
    chunk, optional trailer headers, and a final empty line. */
export function decodeAwsChunked(buf) {
  const chunks = [];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(13, pos);
    if (nl === -1 || buf[nl + 1] !== 10) throw new Error("bad aws-chunked framing: missing CRLF");
    const header = buf.subarray(pos, nl).toString("latin1");
    pos = nl + 2;
    const size = Number.parseInt(header.split(";")[0], 16);
    if (!Number.isInteger(size) || size < 0) throw new Error(`bad aws-chunked chunk header "${header}"`);
    if (size === 0) {
      for (;;) {
        const tnl = buf.indexOf(13, pos);
        if (tnl === -1) throw new Error("bad aws-chunked framing: unterminated trailers");
        const line = buf.subarray(pos, tnl).toString("latin1");
        pos = tnl + 2;
        if (line === "") return Buffer.concat(chunks);
      }
    }
    if (pos + size > buf.length) throw new Error("bad aws-chunked framing: truncated chunk");
    chunks.push(buf.subarray(pos, pos + size));
    pos += size;
    if (buf[pos] !== 13 || buf[pos + 1] !== 10) throw new Error("bad aws-chunked framing: missing chunk CRLF");
    pos += 2;
  }
}

/** bytes=a-b, bytes=a-, bytes=-n; undefined when malformed (serve 200), unsatisfiable flagged. */
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  let start;
  let end;
  if (m[1] === "") {
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= total) return { unsatisfiable: true };
  return { start, end };
}

function plain(res, status, body, contentType = "text/plain") {
  res.writeHead(status, { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function etagOf(body) {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

async function handle(req, res, objects, contentTypes) {
  const target = parseTarget(req.url);
  if (req.method === "PUT") {
    if (!target) return plain(res, 400, "PUT path must be /{bucket}/{key}");
    const raw = await collectBody(req);
    const encodings = String(req.headers["content-encoding"] ?? "").split(",").map((s) => s.trim());
    let body;
    try {
      body = encodings.includes("aws-chunked") ? decodeAwsChunked(raw) : raw;
    } catch (err) {
      return plain(res, 400, `aws-chunked decode failed: ${err.message}`);
    }
    const declared = req.headers["x-amz-decoded-content-length"];
    if (declared !== undefined && Number(declared) !== body.length) {
      return plain(res, 400, `decoded ${body.length} bytes but x-amz-decoded-content-length says ${declared}`);
    }
    objects.set(target[1], body);
    if (req.headers["content-type"]) contentTypes.set(target[1], String(req.headers["content-type"]));
    res.writeHead(200, { etag: etagOf(body) });
    return res.end();
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const body = target ? objects.get(target[1]) : undefined;
    if (body === undefined) return plain(res, 404, XML_NO_SUCH_KEY, "application/xml");
    const base = {
      "content-type": contentTypes.get(target[1]) ?? "application/octet-stream",
      etag: etagOf(body),
      "accept-ranges": "bytes",
    };
    if (req.headers.range) {
      const range = parseRange(String(req.headers.range), body.length);
      if (range?.unsatisfiable) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` });
        return res.end();
      }
      if (range) {
        const headers = {
          ...base,
          "content-range": `bytes ${range.start}-${range.end}/${body.length}`,
          "content-length": String(range.end - range.start + 1),
        };
        res.writeHead(206, headers);
        return res.end(req.method === "HEAD" ? undefined : body.subarray(range.start, range.end + 1));
      }
    }
    res.writeHead(200, { ...base, "content-length": String(body.length) });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  return plain(res, 405, "method not supported");
}

function createFakeS3() {
  const objects = new Map();
  const contentTypes = new Map();
  const server = createServer((req, res) => {
    handle(req, res, objects, contentTypes).catch((err) => {
      if (!res.headersSent) plain(res, 500, String(err?.message ?? err));
      else res.end();
    });
  });
  const close = async () => {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
  };
  return { server, objects, close };
}

export async function startFakeS3() {
  const { server, objects, close } = createFakeS3();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, objects, close };
}

function pseudoRandomBytes(n) {
  const buf = Buffer.alloc(n);
  let s = 0x12345678;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (s >> 16) & 0xff;
  }
  return buf;
}

async function selftest() {
  const assert = (await import("node:assert/strict")).default;
  const fake = await startFakeS3();
  try {
    // The streamed upload is the one that matters: the pipeline's putFile sends
    // createReadStream bodies, which arrive aws-chunked framed.
    const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = new S3Client({
      region: "auto",
      endpoint: fake.url,
      forcePathStyle: true,
      credentials: { accessKeyId: "judge", secretAccessKey: "judge" },
    });
    const file = join(mkdtempSync(join(tmpdir(), "fake-s3-selftest-")), "streamed.bin");
    const streamed = pseudoRandomBytes(300 * 1024);
    writeFileSync(file, streamed);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: "judge-bucket",
          Key: "selftest/streamed.bin",
          Body: createReadStream(file),
          ContentLength: statSync(file).size,
          ContentType: "application/octet-stream",
        }),
      );
      assert.deepEqual(fake.objects.get("selftest/streamed.bin"), streamed, "streamed upload bytes must match");
      await client.send(
        new PutObjectCommand({ Bucket: "judge-bucket", Key: "selftest/note.txt", Body: "hello", ContentType: "text/plain" }),
      );
      assert.equal(fake.objects.get("selftest/note.txt").toString("utf8"), "hello", "plain upload bytes must match");

      const base = `${fake.url}/judge-bucket/selftest/streamed.bin`;
      let res = await fetch(base);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), streamed, "raw GET bytes must match");

      res = await fetch(base, { headers: { range: "bytes=1000-1999" } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get("content-range"), `bytes 1000-1999/${streamed.length}`);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), streamed.subarray(1000, 2000), "range slice must match");

      res = await fetch(base, { headers: { range: "bytes=1000-" } });
      assert.equal(res.status, 206);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), streamed.subarray(1000), "open-ended range must match");

      res = await fetch(base, { headers: { range: "bytes=-500" } });
      assert.equal(res.status, 206);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), streamed.subarray(streamed.length - 500), "suffix range must match");

      res = await fetch(`${fake.url}/judge-bucket/selftest/missing.bin`);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), XML_NO_SUCH_KEY);

      // Presigned URLs carry query-string auth; the fake ignores signatures.
      const signed = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: "judge-bucket", Key: "selftest/streamed.bin" }),
        { expiresIn: 60 },
      );
      res = await fetch(signed);
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), streamed, "presigned GET bytes must match");
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  } finally {
    await fake.close();
  }
  console.log("selftest ok");
}

export async function main(argv) {
  if (argv[0] === "--selftest") return selftest();
  if (argv[0] === "--serve") {
    const { server } = createFakeS3();
    const port = Number(argv[1] ?? 0);
    if (!Number.isInteger(port) || port < 0) throw new Error("--serve needs a port number");
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    console.log(`fake-s3 listening on http://127.0.0.1:${server.address().port}`);
    return undefined;
  }
  console.error("usage: node judge/fake-s3.mjs --serve <port> | --selftest");
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
