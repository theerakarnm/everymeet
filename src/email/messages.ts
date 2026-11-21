import { config, MEET_ADMIT_TIMEOUT_MS, meetPageEnabled } from "../config.js";
import type { EndReason, RecordingEnd } from "../meet/protocol.js";
import type { RefusalReason } from "../meet/session.js";
import { bangkokDateTime, durationTh } from "../util/time.js";

/** One email's content; the caller adds the recipient. */
export interface Mail {
  subject: string;
  text: string;
  html: string;
}

type Part = string | { url: string; label: string };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const base = () => config().PUBLIC_BASE_URL.replace(/\/$/, "");

/** Plain text and a simple HTML version of the same paragraphs; links become a button in HTML. */
function mail(subject: string, parts: Part[]): Mail {
  const text = parts.map((p) => (typeof p === "string" ? p : `${p.label}: ${p.url}`)).join("\n\n");
  const body = parts
    .map((p) =>
      typeof p === "string"
        ? // The summary model writes **bold**; keep it bold in HTML.
          `<p style="margin:0 0 16px;white-space:pre-wrap">${esc(p).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`
        : `<p style="margin:0 0 16px"><a href="${esc(p.url)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#4b54d8;color:#ffffff;text-decoration:none;font-weight:600">${esc(p.label)}</a></p>`,
    )
    .join("");
  const html =
    `<!doctype html><html lang="th"><head><meta charset="utf-8"></head>` +
    `<body style="margin:0;padding:24px;background:#f6f5f2;color:#1c1b19;font-family:'IBM Plex Sans Thai','Noto Sans Thai',system-ui,sans-serif;line-height:1.55">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e1da;border-radius:14px;padding:28px">${body}</div></body></html>`;
  return { subject, text, html };
}

/** Why a Google Meet recording ended, in Thai (it appears only in Thai emails). */
export function describeMeetEnd(reason: EndReason | undefined): string {
  switch (reason) {
    case "stopped":
      return "มีคนกดหยุดบันทึก";
    case "alone":
      return "ไม่มีผู้เข้าร่วมคนอื่นอยู่ในห้องแล้ว";
    case "removed":
      return "บอทถูกนำออกจากห้อง Google Meet";
    case "meeting_ended":
      return "การประชุม Google Meet จบแล้ว";
    case "max_duration":
      return `บันทึกครบเวลาสูงสุด ${config().MEET_MAX_DURATION_MIN} นาที`;
    case "not_admitted":
      return "ไม่มีใครรับบอทเข้าห้อง";
    case "denied":
      return "บอทไม่ได้รับอนุญาตให้เข้าห้อง";
    case "auth_expired":
      return "บัญชี Google ของบอทหมดอายุการเข้าสู่ระบบ";
    case "join_failed":
      return "หน้า Google Meet ไม่มีปุ่มเข้าร่วม";
    default:
      return "เครื่องบันทึก Google Meet หยุดทำงานโดยไม่คาดคิด";
  }
}

export function loginMail(link: string): Mail {
  return mail("ลิงก์เข้าสู่ระบบบันทึก Google Meet", [
    "กดปุ่มด้านล่างเพื่อเข้าสู่ระบบหน้าบันทึก Google Meet ลิงก์นี้ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว",
    { url: link, label: "เข้าสู่ระบบ" },
    "ถ้าคุณไม่ได้ขอลิงก์นี้ ไม่ต้องทำอะไร",
  ]);
}

/** The same content as the Discord minutes post: short summary, playback link, PIN. */
export function minutesMail(o: {
  id: string;
  title: string;
  startedAt: number;
  seconds: number;
  startedBy: string;
  endReason?: string;
  shortSummary: string;
  pin: string;
  note?: string;
}): Mail {
  return mail(`สรุปการประชุม - ${o.title}`, [
    `บันทึกการประชุม ${o.title} เสร็จแล้ว\nเริ่มประชุม: ${bangkokDateTime(o.startedAt)}\nระยะเวลา: ${durationTh(o.seconds)}`,
    o.shortSummary,
    `ฟังเสียง อ่านสรุปฉบับเต็ม และ transcript ได้ที่ปุ่มด้านล่าง ใช้ PIN: ${o.pin}`,
    { url: `${base()}/m/${o.id}`, label: "ฟังเสียงบันทึกการประชุม" },
    ...(o.note ? [`⚠️ ${o.note}`] : []),
    `เริ่มบันทึกโดย ${o.startedBy} | จบเพราะ: ${o.endReason ?? "-"}`,
  ]);
}

export function notRecordedMail(o: { title: string; code: string; end?: RecordingEnd; api?: boolean }): Mail {
  const room = `ห้อง Google Meet ${o.code}`;
  let why: string;
  if (o.end?.detail?.startsWith("container start failed")) {
    why = `เปิดเครื่องบันทึกสำหรับ${room}ไม่ได้ บันทึก Google Meet ได้พร้อมกันสูงสุด 2 ห้อง กรุณาลองใหม่ภายหลัง`;
  } else {
    switch (o.end?.reason) {
      case "auth_expired":
        why =
          `บอทเข้า${room}ไม่ได้ เพราะบัญชี Google ของบอทหมดอายุการเข้าสู่ระบบ ` +
          "กรุณาแจ้งผู้ดูแลบอทให้รัน npm run meet:login ใน meet/ แล้วเปลี่ยนไฟล์ session บนเซิร์ฟเวอร์ (MEET_AUTH_STATE_FILE)";
        break;
      case "not_admitted":
        why = `ไม่มีใครรับบอทเข้า${room}ภายใน ${MEET_ADMIT_TIMEOUT_MS / 60_000} นาที จึงไม่ได้บันทึกอะไร`;
        break;
      case "denied":
        why = `${room}ไม่อนุญาตให้บอทเข้า (ผู้จัดปฏิเสธ หรือ Google Meet ไม่ให้เข้า) จึงไม่ได้บันทึกอะไร`;
        break;
      case "stopped":
        why = `การบันทึก${room}ถูกหยุดก่อนบอทเข้าห้อง จึงไม่ได้บันทึกอะไร`;
        break;
      default:
        why = `บันทึก${room}ไม่ได้ (${describeMeetEnd(o.end?.reason)})`;
    }
  }
  return mail(`บันทึก Google Meet ไม่สำเร็จ - ${o.title}`, [why, ...(meetPageEnabled() && !o.api ? [{ url: `${base()}/meet`, label: "เริ่มบันทึกใหม่" }] : [])]);
}

export function consentMissingMail(o: { title: string; code: string }): Mail {
  return mail(`กรุณาแจ้งผู้เข้าประชุมว่ากำลังบันทึก - ${o.title}`, [
    `บอทกำลังบันทึกห้อง Google Meet ${o.code} แต่โพสต์ข้อความแจ้งการบันทึกในแชท Google Meet ไม่สำเร็จ กรุณาแจ้งผู้เข้าประชุมว่ากำลังบันทึกเสียงการประชุม`,
  ]);
}

export function processingFailedMail(o: { id: string; title: string; startedAt: number; error: string }): Mail {
  return mail(`ประมวลผลบันทึกการประชุมไม่สำเร็จ - ${o.title}`, [
    `ประมวลผลการประชุม ${o.title} (${bangkokDateTime(o.startedAt)}) ไม่สำเร็จ ไฟล์เสียงยังเก็บไว้ (meeting id ${o.id})\nสาเหตุ: ${o.error.slice(0, 1500)}`,
  ]);
}

export function calendarRefusedMail(o: { title: string; code: string; reason: RefusalReason | "start_failed" }): Mail {
  const head = `บอทไม่ได้เข้าห้อง Google Meet ${o.code} ของนัด "${o.title}"`;
  if (o.reason === "already_recording") {
    return mail(`ยังไม่ได้บันทึก Google Meet - ${o.title}`, [
      `${head} เพราะห้องนี้กำลังถูกบันทึกอยู่แล้ว บอทจะลองใหม่ทุกนาทีในช่วงเวลาเริ่มของนัดนี้ ถ้าห้องนี้กำลังบันทึกให้การประชุมอื่น เสียงช่วงนี้จะอยู่ในบันทึกของการประชุมนั้น`,
    ]);
  }
  const why = o.reason === "busy" ? "ตอนนี้บันทึก Google Meet อยู่ 2 ห้องแล้ว ซึ่งเป็นจำนวนสูงสุด" : "เปิดเครื่องบันทึกไม่สำเร็จ";
  return mail(`ไม่ได้บันทึก Google Meet - ${o.title}`, [
    `${head} เพราะ${why} เริ่มบันทึกเองได้ที่หน้าเว็บ`,
    { url: `${base()}/meet`, label: "เริ่มบันทึกเอง" },
  ]);
}
