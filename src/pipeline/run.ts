import { rmSync } from "node:fs";
import type { Client } from "discord.js";
import { emitWebhook } from "../api/events.js";
import { config, SAMPLE_RATE, SEGMENT_SAMPLES } from "../config.js";
import { sendEmail } from "../email/send.js";
import { minutesMail, processingFailedMail } from "../email/messages.js";
import { emailStarter, meetingDir, saveEverywhere, saveLocal, unfinishedLocal, type Manifest, type MeetManifest } from "../storage/manifest.js";
import { keys } from "../storage/keys.js";
import { putFile, putText } from "../storage/r2.js";
import { generatePin, hashPin } from "../util/pin.js";
import { pLimit } from "../util/limit.js";
import { logger } from "../util/log.js";
import { markMeetSpeech } from "../meet/speech.js";
import { MeetSession } from "../meet/session.js";
import { buildRawTracks, encodeTracks, mixTracks, totalSamples } from "./assemble.js";
import { transcribeMeeting } from "./transcribe.js";
import { fullSummary, shortSummary } from "./summarize.js";
import { notifyFailure, publishMinutes } from "./publish.js";

const log = logger("pipeline");
/** ffmpeg and transcription are heavy; process at most two meetings at once. */
const queue = pLimit(2);

export function processMeeting(client: Client, m: Manifest): Promise<void> {
  return queue(() => run(client, m));
}

async function run(client: Client, m: Manifest): Promise<void> {
  const started = Date.now();
  log.info(`processing ${m.id}`);
  try {
    m.outputs ??= {};

    // 0. A Google Meet recording is one mixed track without speech marks; find where people spoke.
    if (m.meet) await markMeetSpeech(m);

    // 1. Audio: per-speaker tracks + one mixed file, all to R2.
    const raw = await buildRawTracks(m);
    // A Meet recording has a single mixed track, which meeting.mp3 already is.
    const tracks = m.meet ? {} : await encodeTracks(raw);
    m.outputs.tracks = {};
    for (const [userId, path] of Object.entries(tracks)) {
      const key = keys.track(m.id, userId);
      await putFile(key, path, "audio/ogg");
      m.outputs.tracks[userId] = key;
    }
    const mixed = await mixTracks(m, raw);
    await putFile(keys.mixed(m.id), mixed, "audio/mpeg");
    m.outputs.mixed = keys.mixed(m.id);
    await saveEverywhere(m);

    // 2. Transcript.
    const t = await transcribeMeeting(m, raw);
    await putText(keys.transcript(m.id), t.text);
    m.outputs.transcript = keys.transcript(m.id);
    log.info(`${m.id}: ${t.lines.length} lines from ${t.totalChunks} requests (${t.failedChunks} failed) via ${t.modelsUsed.join(", ")}`);

    // 3. Summaries (Thai).
    let full: string;
    let short: string;
    if (t.lines.length === 0) {
      full = "# สรุปการประชุม\n\nไม่พบเสียงพูดในการบันทึกนี้";
      short = "ไม่พบเสียงพูดในการบันทึกนี้";
    } else {
      full = (await fullSummary(m, t.text)).text;
      short = (await shortSummary(m, full)).text;
    }
    await putText(keys.summaryFull(m.id), full, "text/markdown; charset=utf-8");
    await putText(keys.summaryShort(m.id), short, "text/markdown; charset=utf-8");
    m.outputs.summaryFull = keys.summaryFull(m.id);
    m.outputs.summaryShort = keys.summaryShort(m.id);

    // 4. PIN, then the minutes: by email for Google Meet, in Discord otherwise. Only the hash is stored.
    const pin = generatePin();
    m.pin = hashPin(pin);
    await saveEverywhere(m);

    const notes: string[] = [];
    if (m.recovered) {
      notes.push(
        m.meet
          ? "บอท Google Meet หยุดทำงานระหว่างประชุม เสียงช่วงท้ายอาจขาดหายไปบางส่วน"
          : "บอทรีสตาร์ทระหว่างประชุม เสียงช่วงท้ายอาจขาดหายไปบางส่วน",
      );
    }
    if (t.failedChunks > 0) notes.push(`ถอดเสียงไม่สำเร็จ ${t.failedChunks} จาก ${t.totalChunks} ช่วง`);
    const note = notes.join(" / ") || undefined;
    if (m.meet) {
      const starter = emailStarter(m);
      // Webhook mode: the caller sends its own emails after minutes.ready. Nobody spoke: only the starter is told.
      if (starter) await emailMinutes(m, t.lines.length > 0 ? m.meet.recipients : [starter], { pin, shortSummary: short, note });
    } else {
      m.outputs.postedMessageUrl = await publishMinutes(client, m, {
        pin,
        shortSummary: short,
        fullSummary: full,
        transcript: t.text,
        note,
      });
    }

    m.status = "done";
    await saveEverywhere(m);
    if (m.meet) emitWebhook(m, "minutes.ready", short);
    log.info(`done ${m.id} in ${Math.round((Date.now() - started) / 1000)}s`);
    if (config().CLEANUP_LOCAL) rmSync(meetingDir(m.id), { recursive: true, force: true });
  } catch (err) {
    log.error(`processing ${m.id} failed`, err);
    m.status = "failed";
    m.error = (err as Error).message;
    try {
      await saveEverywhere(m);
    } catch {
      saveLocal(m);
    }
    if (m.meet) {
      const starter = emailStarter(m);
      if (starter) {
        await sendEmail({ to: starter, ...processingFailedMail({ id: m.id, title: m.meet.title, startedAt: m.startedAt, error: m.error }) })
          .catch((e) => log.error(`could not email the failure of ${m.id}`, e));
      }
      emitWebhook(m, "recording.failed");
    } else {
      await notifyFailure(client, m, m.error);
    }
  }
}

/**
 * Emails the minutes to each recipient on their own; fails only when nobody got them.
 * No idempotency key: processing that is retried after a crash makes a new PIN, so a second email is the correct one.
 */
async function emailMinutes(m: MeetManifest, recipients: string[], o: { pin: string; shortSummary: string; note?: string }): Promise<void> {
  const mail = minutesMail({
    id: m.id,
    title: m.meet.title,
    startedAt: m.startedAt,
    seconds: totalSamples(m) / SAMPLE_RATE,
    startedBy: m.meet.startedBy ?? "-",
    endReason: m.endReason,
    ...o,
  });
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendEmail({ to, ...mail });
      sent++;
    } catch (err) {
      log.error(`minutes email for ${m.id} not sent`, err);
    }
  }
  if (sent === 0) throw new Error("the minutes email could not be sent to anyone");
  log.info(`${m.id}: minutes emailed to ${sent} of ${recipients.length}`);
}

/**
 * After a crash or restart. Google Meet recordings ran on in the cloud and are re-attached; Discord recordings
 * are closed at their last heartbeat. Meetings that were mid-processing are retried. Meet needs no Discord login,
 * so boot runs "meet" first and "discord" once the client is ready.
 */
export async function recoverUnfinished(client: Client, source: "meet" | "discord"): Promise<void> {
  for (const m of unfinishedLocal()) {
    if ((source === "meet") !== !!m.meet) continue;
    if (m.meet && m.status === "recording") {
      MeetSession.resume(m, (done) => void processMeeting(client, done));
      continue;
    }
    if (m.status === "recording") {
      log.warn(`recovering ${m.id}: recorder stopped unexpectedly, closing at last heartbeat`);
      m.endedAt = m.heartbeatAt;
      m.endReason = "the bot restarted during the meeting";
      m.recovered = true;
      m.status = "processing";
      // Utterances still open at the crash are lost; everything written to disk is kept.
      const end = Math.round(((m.endedAt - m.startedAt) * SAMPLE_RATE) / 1000);
      for (const p of Object.values(m.participants)) {
        p.utterances = p.utterances.filter((u) => u.start < end).map((u) => ({ ...u, end: Math.min(u.end, end) }));
        p.segments = p.segments.filter((s) => s * SEGMENT_SAMPLES < end);
      }
      saveLocal(m);
    }
    void processMeeting(client, m);
  }
}

