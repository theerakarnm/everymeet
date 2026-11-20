import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { keys } from "./keys.js";
import { getText, putText } from "./r2.js";

export type MeetingStatus = "recording" | "processing" | "done" | "failed";

/** A stretch of one speaker's audio, in samples on the shared meeting timeline. */
export interface Utterance {
  start: number;
  end: number;
}

export interface Participant {
  displayName: string;
  utterances: Utterance[];
  /** Segment indexes that hold audio for this user. */
  segments: number[];
  /** Segment indexes already uploaded to R2 as FLAC. */
  uploaded: number[];
}

/** What every recording has, whatever started it. */
interface ManifestBase {
  id: string;
  startedAt: number;
  endedAt?: number;
  endReason?: string;
  /** Last time the recorder was alive; used as the end time after a crash. */
  heartbeatAt: number;
  status: MeetingStatus;
  recovered?: boolean;
  participants: Record<string, Participant>;
  pin?: { salt: string; hash: string };
  outputs?: {
    mixed?: string;
    tracks?: Record<string, string>;
    transcript?: string;
    summaryFull?: string;
    summaryShort?: string;
    postedMessageUrl?: string;
  };
  error?: string;
}

/** A Discord voice channel recording; its minutes are posted in Discord. */
export interface DiscordManifest extends ManifestBase {
  meet?: undefined;
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  /** Text channel where /record was used (fallback output + continue prompts). */
  commandChannelId: string;
  startedBy: { id: string; name: string };
}

/** Which Google Meet call is recorded, for whom, and who gets the minutes. */
export interface MeetInfo {
  url: string;
  code: string;
  /** The calendar event title, or "Google Meet <code>" for a start on the web page. */
  title: string;
  trigger: "calendar" | "web";
  /** Email of the calendar organizer or of the person who pressed start; failure emails go here. */
  startedBy: string;
  /** Who gets the minutes by email: lowercase, unique, includes startedBy, never the bot account. */
  recipients: string[];
}

/** A Google Meet recording (one mixed track); its minutes are emailed. */
export interface MeetManifest extends ManifestBase {
  meet: MeetInfo;
}

export type Manifest = DiscordManifest | MeetManifest;

/** Shown on the playback page and in the transcript header. */
export const meetingTitle = (m: Manifest): string => (m.meet ? m.meet.title : m.voiceChannelName);

export const meetingDir = (id: string) => join(config().DATA_DIR, "meetings", id);

export function saveLocal(m: Manifest): void {
  const dir = meetingDir(m.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "manifest.json.tmp");
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, join(dir, "manifest.json")); // atomic replace
}

export async function saveEverywhere(m: Manifest): Promise<void> {
  saveLocal(m);
  await putText(keys.manifest(m.id), JSON.stringify(m), "application/json");
}

export function loadLocal(id: string): Manifest | undefined {
  const p = join(meetingDir(id), "manifest.json");
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as Manifest;
}

export async function loadRemote(id: string): Promise<Manifest | undefined> {
  const raw = await getText(keys.manifest(id));
  return raw ? (JSON.parse(raw) as Manifest) : undefined;
}

/** Meetings left unfinished on this disk (bot crashed or restarted mid-way). */
export function unfinishedLocal(): Manifest[] {
  const root = join(config().DATA_DIR, "meetings");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => {
      try {
        return loadLocal(id);
      } catch {
        return undefined;
      }
    })
    .filter((m): m is Manifest => !!m && (m.status === "recording" || m.status === "processing"));
}
