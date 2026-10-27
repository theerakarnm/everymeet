import { createReadStream, createWriteStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";

let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) {
    const c = config();
    client = new S3Client({
      region: "auto",
      endpoint: c.R2_ENDPOINT ?? `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: !!c.R2_ENDPOINT,
      credentials: { accessKeyId: c.R2_ACCESS_KEY_ID, secretAccessKey: c.R2_SECRET_ACCESS_KEY },
    });
  }
  return client;
}

export const keys = {
  manifest: (id: string) => `meetings/${id}/manifest.json`,
  segment: (id: string, userId: string, index: number) =>
    `meetings/${id}/segments/${userId}/${String(index).padStart(4, "0")}.flac`,
  track: (id: string, userId: string) => `meetings/${id}/tracks/${userId}.ogg`,
  mixed: (id: string) => `meetings/${id}/meeting.mp3`,
  transcript: (id: string) => `meetings/${id}/transcript.txt`,
  summaryFull: (id: string) => `meetings/${id}/summary-full.md`,
  summaryShort: (id: string) => `meetings/${id}/summary-short.md`,
};

export async function putFile(key: string, path: string, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: config().R2_BUCKET,
      Key: key,
      Body: createReadStream(path),
      ContentLength: statSync(path).size,
      ContentType: contentType,
    }),
  );
}

export async function putText(key: string, body: string, contentType = "text/plain; charset=utf-8") {
  await s3().send(new PutObjectCommand({ Bucket: config().R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function getText(key: string): Promise<string | undefined> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: config().R2_BUCKET, Key: key }));
    return await res.Body?.transformToString("utf-8");
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return undefined;
    throw err;
  }
}

export async function downloadTo(key: string, path: string): Promise<void> {
  const res = await s3().send(new GetObjectCommand({ Bucket: config().R2_BUCKET, Key: key }));
  await pipeline(res.Body as Readable, createWriteStream(path));
}

/** Short-lived URL; R2 serves Range requests so the browser can seek in long audio. */
export function presign(key: string, downloadName?: string, seconds = 600): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: config().R2_BUCKET,
      Key: key,
      ResponseContentDisposition: downloadName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
        : undefined,
    }),
    { expiresIn: seconds },
  );
}
