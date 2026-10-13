/**
 * Drives the bot the way Discord would: slash commands, buttons, voice packets and
 * people joining/leaving, with the clock under test control. Voice, R2 and the
 * processing pipeline are replaced by fakes; everything in between is the real code.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Collection } from "discord.js";
import OpusScript from "opusscript";
import { flush, mockR2, r2 } from "./test/setup.js";

let r2Down = false;
mockR2({ failPuts: () => r2Down });

class FakeReceiver {
  speaking = new EventEmitter();
  subscriptions = new Map<string, PassThrough>();
  subscribe(userId: string) {
    const existing = this.subscriptions.get(userId);
    if (existing) return existing;
    const s = new PassThrough({ objectMode: true });
    s.once("close", () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, s);
    return s;
  }
}
class FakeConnection extends EventEmitter {
  receiver = new FakeReceiver();
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}
const joins: { options: any; connection: FakeConnection }[] = [];
mock.module("@discordjs/voice", {
  namedExports: {
    joinVoiceChannel: (options: any) => {
      const connection = new FakeConnection();
      joins.push({ options, connection });
      return connection;
    },
    entersState: async (c: unknown) => c,
    EndBehaviorType: { Manual: 0, AfterSilence: 1, AfterInactivity: 2 },
    VoiceConnectionStatus: { Signalling: "signalling", Connecting: "connecting", Ready: "ready", Disconnected: "disconnected" },
  },
});

const finished: any[] = [];
mock.module(new URL("./pipeline/run.js", import.meta.url).href, {
  namedExports: {
    processMeeting: async (_client: unknown, m: any) => void finished.push(structuredClone(m)),
    recoverUnfinished: async () => {},
  },
});

const { handleInteraction, handleVoiceStateUpdate } = await import("./interactions.js");
const { activeSessions } = await import("./recorder/session.js");
const { keys } = await import("./storage/r2.js");
const { SAMPLE_RATE } = await import("./config.js");

// ---- a fake Discord server --------------------------------------------------

const MIN = 60_000;
let guildSeq = 0;

function makeServer() {
  const gid = `guild${++guildSeq}`;
  const sent: any[] = [];
  const edits: any[] = [];
  const voiceChat: string[] = [];
  const people = new Map<string, any>();
  const inVoice = new Collection<string, any>();

  const textChannel = {
    id: `${gid}-text`,
    isSendable: () => true,
    send: async (payload: any) => {
      sent.push(payload);
      return { edit: async (p: any) => void edits.push(p) };
    },
  };
  const guild: any = {
    id: gid,
    name: "Planthia",
    voiceAdapterCreator: () => ({}),
    members: { me: { id: "bot" }, cache: people, fetch: async (id: string) => people.get(id) },
    channels: { cache: new Map() },
  };
  const voice: any = {
    id: `${gid}-voice`,
    name: "daily-standup",
    guild,
    members: inVoice,
    isVoiceBased: () => true,
    isSendable: () => true,
    send: async (t: string) => void voiceChat.push(t),
    permissionsFor: () => ({ has: () => true }),
  };
  guild.channels.cache.set(voice.id, voice);
  const client: any = { channels: { fetch: async (id: string) => (id === textChannel.id ? textChannel : null) } };

  const person = (id: string, displayName: string, bot = false) => {
    const m = { id, displayName, user: { id, bot, username: displayName }, voice: { channel: null as any } };
    people.set(id, m);
    return m;
  };
  const voiceUpdate = (m: any, from: string | null, to: string | null) =>
    handleVoiceStateUpdate({ channelId: from, guild } as any, { channelId: to, guild } as any);
  const join = (m: any) => {
    m.voice.channel = voice;
    inVoice.set(m.id, m);
    voiceUpdate(m, null, voice.id);
  };
  const leave = (m: any) => {
    m.voice.channel = null;
    inVoice.delete(m.id);
    voiceUpdate(m, voice.id, null);
  };

  const command = async (name: "record" | "end", member: any) => {
    const replies: any[] = [];
    const i: any = {
      commandName: name,
      member,
      guild,
      guildId: guild.id,
      channelId: textChannel.id,
      replied: false,
      deferred: false,
      isChatInputCommand: () => true,
      inCachedGuild: () => true,
      isButton: () => false,
      isRepliable: () => true,
      reply: async (p: any) => {
        i.replied = true;
        replies.push(p);
      },
      deferReply: async () => {
        i.deferred = true;
      },
      editReply: async (p: any) => void replies.push(p),
    };
    await handleInteraction(client, i);
    await flush();
    return replies.map((r) => (typeof r === "string" ? { content: r } : r));
  };

  const clickContinue = async (member: any) => {
    const prompt = sent.find((p) => p.components?.length)!;
    const button = prompt.components[0].toJSON().components[0];
    const responses: any[] = [];
    const i: any = {
      customId: button.custom_id,
      member,
      user: member.user,
      isChatInputCommand: () => false,
      isButton: () => true,
      isRepliable: () => true,
      update: async (p: any) => void responses.push(p),
      reply: async (p: any) => void responses.push(p),
    };
    await handleInteraction(client, i);
    return responses;
  };

  /** One person talks for `seconds`: Discord-style 20 ms Opus packets on their own stream. */
  const speak = async (m: any, seconds: number) => {
    const connection = joins.find((j) => j.options.guildId === guild.id)!.connection;
    connection.receiver.speaking.emit("start", m.id);
    const stream = connection.receiver.subscriptions.get(m.id);
    if (stream) {
      for (const p of opusPackets(seconds)) stream.write(p);
      stream.end(); // what AfterSilence does after a pause
    }
    await flush();
  };

  const session = () => activeSessions.get(guild.id);
  return { guild, voice, textChannel, sent, edits, voiceChat, person, join, leave, command, clickContinue, speak, session };
}

const encoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
function opusPackets(seconds: number): Buffer[] {
  const frame = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    frame.writeInt16LE(v, i * 4);
    frame.writeInt16LE(v, i * 4 + 2);
  }
  const packet = Buffer.from(encoder.encode(frame, 960));
  return Array.from({ length: Math.round(seconds * 50) }, () => packet);
}

const lastFinished = () => finished.at(-1);
const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await flush();
};

beforeEach(() => {
  r2Down = false;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.UTC(2026, 9, 12, 3, 0, 0) });
});
afterEach(async () => {
  await Promise.all([...activeSessions.values()].map((s) => s.end("test cleanup")));
  mock.timers.reset();
});

// ---- commands ---------------------------------------------------------------

test("/record outside a voice channel is refused", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const [reply] = await s.command("record", alice);
  assert.match(reply.content, /Join a voice channel first/);
  assert.ok(reply.flags, "only the caller sees it");
  assert.equal(s.session(), undefined);
});

test("/record joins the caller's channel and announces it", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  s.join(alice);
  const replies = await s.command("record", alice);
  assert.equal(replies.at(-1).content, "I am recording the voice in channel daily-standup");
  assert.ok(s.voiceChat.some((t) => t.includes("I am recording the voice in channel daily-standup")));

  const joined = joins.at(-1)!.options;
  assert.equal(joined.channelId, s.voice.id);
  assert.equal(joined.selfDeaf, false, "the bot must not be deafened, or it hears nothing");
  assert.ok(s.session());
  assert.ok(r2.has(keys.manifest(s.session()!.id)), "meeting is registered in R2 right away");
});

test("anyone can /record, but only one recording per server; other servers are independent", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const bob = s.person("bob", "Bob");
  s.join(alice);
  s.join(bob);
  await s.command("record", alice);
  const [again] = await s.command("record", bob);
  assert.match(again.content, /already recording in \*\*daily-standup\*\*/);

  const other = makeServer();
  const carol = other.person("carol", "Carol");
  other.join(carol);
  assert.equal((await other.command("record", carol)).at(-1).content, "I am recording the voice in channel daily-standup");
  assert.notEqual(other.session()!.id, s.session()!.id);
});

test("/end by anyone stops the recording and hands it to processing", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const dave = s.person("dave", "Dave"); // not even in the voice channel
  s.join(alice);
  await s.command("record", alice);
  const id = s.session()!.id;
  await advance(10 * MIN);

  const [reply] = await s.command("end", dave);
  assert.match(reply.content, /stopped/);
  assert.match(reply.content, /#meeting-of-minutes/);
  assert.equal(s.session(), undefined);
  assert.equal(joins.at(-1)!.connection.destroyed, true, "the bot leaves the channel");

  const m = lastFinished();
  assert.equal(m.id, id);
  assert.equal(m.status, "processing");
  assert.match(m.endReason, /ended by Dave with \/end/);
  assert.equal(m.endedAt - m.startedAt, 10 * MIN);
  assert.equal(JSON.parse(r2.get(keys.manifest(id))!.toString()).status, "processing");

  const [nothing] = await s.command("end", dave);
  assert.match(nothing.content, /Nothing is being recorded/);
});

test("if R2 is down at /record the bot says so and does not stay half-started", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  s.join(alice);
  r2Down = true;
  const replies = await s.command("record", alice);
  assert.match(replies.at(-1).content, /couldn't join/);
  assert.equal(s.session(), undefined, "no leftover session blocks the next /record");
  assert.equal(joins.at(-1)!.connection.destroyed, true, "the bot leaves the channel again");

  r2Down = false;
  assert.equal((await s.command("record", alice)).at(-1).content, "I am recording the voice in channel daily-standup");
});

// ---- recording ---------------------------------------------------------------

test("each speaker gets their own track, placed at the real time they spoke; bots are ignored", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const bob = s.person("bob", "Bob");
  const music = s.person("music", "MusicBot", true);
  for (const m of [alice, bob, music]) s.join(m);
  await s.command("record", alice);

  await advance(5_000);
  await s.speak(alice, 2);
  await advance(55_000);
  await s.speak(bob, 3);
  await s.speak(music, 1);
  await advance(30_000);
  await s.speak(alice, 1);
  await s.command("end", alice);

  const m = lastFinished();
  assert.deepEqual(Object.keys(m.participants).sort(), ["alice", "bob"]);
  assert.equal(m.participants.alice.displayName, "Alice");
  const sec = (n: number) => n / SAMPLE_RATE;
  const a = m.participants.alice.utterances;
  const b = m.participants.bob.utterances;
  assert.equal(a.length, 2);
  assert.equal(sec(a[0].start), 5);
  assert.equal(sec(a[0].end - a[0].start), 2);
  assert.equal(sec(a[1].start), 90);
  assert.equal(b.length, 1);
  assert.equal(sec(b[0].start), 60);
  assert.equal(sec(b[0].end - b[0].start), 3);
  assert.equal((m.endedAt - m.startedAt) / 1000, 91, "meeting length includes the last words");
});

test("finished 5-minute segments are backed up to R2 while the meeting is still running", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  s.join(alice);
  await s.command("record", alice);
  const id = s.session()!.id;
  await advance(10_000);
  await s.speak(alice, 2);

  await advance(5 * MIN + 30_000); // a segment is closed 15 s after its end, on the next 15 s tick
  const key = keys.segment(id, "alice", 0);
  const deadline = performance.now() + 10_000;
  while (!r2.has(key) && performance.now() < deadline) await flush(); // ffmpeg runs for real
  assert.ok(r2.has(key), "segment 0 uploaded as FLAC");
  assert.ok(s.session(), "still recording");
  const manifest = JSON.parse(r2.get(keys.manifest(id))!.toString());
  assert.deepEqual(manifest.participants.alice.uploaded, [0]);
});

// ---- auto-end rules ----------------------------------------------------------

function promptOf(s: ReturnType<typeof makeServer>) {
  const prompts = s.sent.filter((p) => p.components?.length);
  return prompts.map((p) => ({ content: p.content as string, button: p.components[0].toJSON().components[0] }));
}

test("after 2 hours it asks to continue, and ends 5 minutes later if nobody clicks", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  s.join(alice);
  await s.command("record", alice);

  await advance(120 * MIN - 1_000);
  assert.equal(promptOf(s).length, 0);
  await advance(1_000);
  const [prompt] = promptOf(s);
  assert.ok(prompt, "prompt posted in the channel where /record was used");
  assert.equal(prompt.button.label, "Continue recording");
  assert.match(prompt.content, /Continue recording\?/);

  await advance(5 * MIN - 1_000);
  assert.ok(s.session(), "still recording just before the 5 minutes are up");
  await advance(1_000);
  assert.equal(s.session(), undefined);
  assert.match(lastFinished().endReason, /nobody clicked "Continue recording" within 5 minutes/);
  assert.deepEqual(s.edits.at(-1).components, [], "the button is removed");
});

test("anyone clicking Continue keeps the same recording, and it asks again 2 hours later", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const bob = s.person("bob", "Bob");
  s.join(alice);
  s.join(bob);
  await s.command("record", alice);
  const id = s.session()!.id;

  await advance(120 * MIN);
  await advance(2 * MIN);
  const [response] = await s.clickContinue(bob);
  assert.match(response.content, /Recording continues in \*\*daily-standup\*\* \(confirmed by Bob\)/);
  assert.deepEqual(response.components, []);

  await advance(10 * MIN);
  assert.equal(s.session()?.id, id, "not ended after the 5 minutes");
  await advance(110 * MIN);
  assert.equal(promptOf(s).length, 2, "asked again 2 hours after the click");
  await advance(5 * MIN);
  assert.equal(s.session(), undefined);
});

test("when everyone leaves for 3 minutes the recording ends", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const bob = s.person("bob", "Bob");
  s.join(alice);
  s.join(bob);
  await s.command("record", alice);

  s.leave(alice);
  await advance(5 * MIN);
  assert.ok(s.session(), "one person left is still a meeting");
  s.leave(bob);
  await advance(3 * MIN - 1_000);
  assert.ok(s.session());
  await advance(1_000);
  assert.equal(s.session(), undefined);
  assert.match(lastFinished().endReason, /everyone left the channel for 3 minutes/);
});

test("rejoining within 3 minutes resets the timer and keeps the same recording", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  s.join(alice);
  await s.command("record", alice);
  const id = s.session()!.id;

  s.leave(alice);
  await advance(2 * MIN);
  s.join(alice);
  await advance(2 * MIN);
  assert.equal(s.session()?.id, id);

  s.leave(alice);
  await advance(2 * MIN);
  assert.equal(s.session()?.id, id, "the 3 minutes start again from the second leave");
  await advance(1 * MIN);
  assert.equal(s.session(), undefined);
  assert.equal(lastFinished().id, id);
});

test("a bot left alone in the channel does not count as a participant", async () => {
  const s = makeServer();
  const alice = s.person("alice", "Alice");
  const music = s.person("music", "MusicBot", true);
  s.join(alice);
  s.join(music);
  await s.command("record", alice);
  s.leave(alice);
  await advance(3 * MIN);
  assert.equal(s.session(), undefined);
});
