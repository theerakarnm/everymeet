import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import { config, SAMPLE_RATE } from "../config.js";
import type { Manifest } from "../storage/manifest.js";
import { bangkokDateTime, durationTh } from "../util/time.js";
import { totalSamples } from "./assemble.js";

const canPost = (ch: GuildTextBasedChannel, guild: Guild) => {
  const me = guild.members.me;
  const perms = me ? ch.permissionsFor(me) : null;
  return !!perms?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ]);
};

/** #meeting-of-minutes, else #general, else the channel where /record was used. */
export async function findOutputChannel(client: Client, m: Manifest): Promise<GuildTextBasedChannel> {
  const c = config();
  const guild = await client.guilds.fetch(m.guildId);
  const channels = await guild.channels.fetch();
  for (const name of [c.MINUTES_CHANNEL_NAME, c.FALLBACK_CHANNEL_NAME]) {
    const ch = channels.find(
      (x) =>
        !!x &&
        (x.type === ChannelType.GuildText || x.type === ChannelType.GuildAnnouncement) &&
        x.name.toLowerCase() === name.toLowerCase(),
    ) as GuildTextBasedChannel | undefined;
    if (ch && canPost(ch, guild)) return ch;
  }
  const fallback = await client.channels.fetch(m.commandChannelId);
  if (fallback && fallback.isTextBased() && !fallback.isDMBased()) return fallback;
  throw new Error("No text channel available to post the meeting minutes");
}

export async function publishMinutes(
  client: Client,
  m: Manifest,
  opts: { pin: string; shortSummary: string; fullSummary: string; transcript: string; note?: string },
): Promise<string> {
  const channel = await findOutputChannel(client, m);
  const seconds = totalSamples(m) / SAMPLE_RATE;
  const speakers = Object.values(m.participants)
    .filter((p) => p.utterances.length > 0)
    .map((p) => p.displayName);
  const url = `${config().PUBLIC_BASE_URL.replace(/\/$/, "")}/m/${m.id}`;

  const embed = new EmbedBuilder()
    .setTitle(`สรุปการประชุม - ${m.voiceChannelName}`)
    .setDescription(opts.shortSummary)
    .setColor(0x5865f2)
    .addFields(
      { name: "เริ่มประชุม", value: bangkokDateTime(m.startedAt), inline: true },
      { name: "ระยะเวลา", value: durationTh(seconds), inline: true },
      { name: "ผู้พูด", value: speakers.join(", ").slice(0, 1024) || "-", inline: false },
    )
    .setFooter({ text: `เริ่มบันทึกโดย ${m.startedBy.name} | จบเพราะ: ${m.endReason ?? "-"}`.slice(0, 2048) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("ฟังเสียงบันทึกการประชุม").setURL(url),
  );

  const datePart = new Date(m.startedAt).toISOString().slice(0, 10);
  const files = [
    new AttachmentBuilder(Buffer.from(opts.fullSummary, "utf8"), { name: `summary-full-${datePart}.md` }),
    new AttachmentBuilder(Buffer.from(opts.transcript, "utf8"), { name: `transcript-${datePart}.txt` }),
  ];

  const content = [
    `บันทึกการประชุมห้อง **${m.voiceChannelName}** เสร็จแล้ว - สรุปฉบับเต็มและ transcript อยู่ในไฟล์แนบ`,
    `🔒 ฟังเสียงที่ปุ่มด้านล่าง ใช้ PIN: \`${opts.pin}\``,
    opts.note ? `⚠️ ${opts.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await channel.send({ content, embeds: [embed], components: [row], files });
  return msg.url;
}

export async function notifyFailure(client: Client, m: Manifest, error: string): Promise<void> {
  try {
    const channel = await findOutputChannel(client, m);
    await channel.send(
      `ประมวลผลการประชุมห้อง **${m.voiceChannelName}** (${bangkokDateTime(m.startedAt)}) ไม่สำเร็จ ` +
        `ไฟล์เสียงยังเก็บไว้ใน R2 (meeting id \`${m.id}\`)\nสาเหตุ: ${error.slice(0, 1500)}`,
    );
  } catch {
    // Nothing else we can do; it is in the logs.
  }
}
