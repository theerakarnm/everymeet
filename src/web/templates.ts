import type { RecordingState } from "../meet/protocol.js";
import type { User } from "../users/store.js";
import { bangkokDateTime } from "../util/time.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `
:root{--bg:#f6f5f2;--card:#fff;--text:#1c1b19;--muted:#6b6862;--line:#e4e1da;--accent:#4b54d8;--accent-ink:#fff;--err:#b4232f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1d1b;--text:#f1efe9;--muted:#a3a097;--line:#33312d;--accent:#8e95ff;--accent-ink:#141413;--err:#ff7b86}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"IBM Plex Sans Thai","Noto Sans Thai",system-ui,sans-serif;line-height:1.55}
main{max-width:560px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
h1{font-size:24px;margin:0 0 4px;word-break:break-word}
.meta{color:var(--muted);font-size:14px;margin:0 0 24px}
label{display:block;font-size:14px;margin-bottom:8px}
input,textarea{width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
input.pin{font-size:28px;letter-spacing:.4em;text-align:center}
textarea{resize:vertical}
label.next{margin-top:16px}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0}
.meta a,.refresh{color:var(--accent)}
.refresh{display:inline-block;margin-top:12px;font-size:14px}
li.rec{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 2px}
li.rec small{display:block;color:var(--muted);font-size:13px}
li.rec form{flex:none}
button.stop{width:auto;margin:0;padding:8px 14px;background:transparent;color:var(--err);border:1px solid var(--err)}
button.enable{width:auto;margin:0;padding:8px 14px;background:transparent;color:var(--accent);border:1px solid var(--accent)}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
.err{color:var(--err);font-size:14px;margin:12px 0 0}
audio{width:100%;margin:8px 0 20px}
h2{font-size:15px;margin:24px 0 8px}
ul{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}
li{border-bottom:1px solid var(--line)}
li a{display:flex;justify-content:space-between;gap:12px;padding:12px 2px;color:var(--text);text-decoration:none}
li a:hover{color:var(--accent)}
li span{color:var(--muted);font-size:13px;white-space:nowrap}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600&display=swap">
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** One Google Meet recording as the recorder page lists it. */
export interface MeetRecordingView {
  id: string;
  title: string;
  code: string;
  state: RecordingState;
  trigger: "calendar" | "web";
  startedBy: string;
  stopping: boolean;
}

const STATE: Record<RecordingState, string> = {
  starting: "กำลังเปิดเครื่องบันทึก",
  joining: "กำลังเข้าห้อง",
  waiting: "รอผู้จัดรับเข้าห้อง",
  recording: "กำลังบันทึก",
  ended: "กำลังจบการบันทึก",
};

const meetCard = (title: string, body: string) =>
  shell(title, `<div class="card"><p class="eyebrow">บันทึก Google Meet</p>${body}</div>`);

export const page = {
  notFound: () =>
    shell(
      "ไม่พบการประชุม",
      `<div class="card"><p class="eyebrow">Meeting minutes</p><h1>ไม่พบการประชุมนี้</h1><p class="meta">ลิงก์อาจไม่ถูกต้อง หรือการประชุมยังประมวลผลไม่เสร็จ</p></div>`,
    ),

  pin: (o: { id: string; title: string; error?: string }) =>
    shell(
      "ใส่ PIN",
      `<div class="card"><p class="eyebrow">บันทึกการประชุม</p><h1>${esc(o.title)}</h1>
<p class="meta">ใส่ PIN 6 หลักที่บอทส่งมาพร้อมลิงก์นี้</p>
<form method="post" action="/m/${esc(o.id)}" autocomplete="off">
<label for="pin">PIN</label>
<input id="pin" class="pin" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<button type="submit">เปิดบันทึก</button></form></div>`,
    ),

  player: (o: {
    id: string;
    title: string;
    guild: string;
    started: string;
    duration: string;
    tracks: { userId: string; name: string }[];
  }) => {
    const base = `/m/${esc(o.id)}/file`;
    const tracks = o.tracks
      .map((t) => `<li><a href="${base}/track/${esc(t.userId)}">${esc(t.name)}<span>.ogg</span></a></li>`)
      .join("");
    return shell(
      `บันทึกการประชุม - ${o.title}`,
      `<div class="card"><p class="eyebrow">${esc(o.guild)}</p><h1>${esc(o.title)}</h1>
<p class="meta">${esc(o.started)} · ${esc(o.duration)}</p>
<audio controls preload="metadata" src="${base}/audio"></audio>
<h2>ดาวน์โหลด</h2><ul>
<li><a href="${base}/audio?download=1">เสียงการประชุม (รวมทุกคน)<span>.mp3</span></a></li>
<li><a href="${base}/summary">สรุปฉบับเต็ม<span>.md</span></a></li>
<li><a href="${base}/transcript">Transcript ทั้งหมด<span>.txt</span></a></li>
</ul>
${tracks ? `<h2>เสียงแยกรายคน</h2><ul>${tracks}</ul>` : ""}</div>`,
    );
  },

  meetLogin: (o: { error?: string; email?: string }) =>
    meetCard(
      "เข้าสู่ระบบ",
      `<h1>เข้าสู่ระบบ</h1>
<p class="meta">ใส่อีเมลของคุณ แล้วบอทจะส่งลิงก์เข้าสู่ระบบไปให้ ลิงก์ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว ยังไม่มีบัญชีก็ใส่อีเมลได้เลย การเข้าสู่ระบบครั้งแรกจะสร้างบัญชีให้</p>
<form method="post" action="/meet/login">
<label for="email">อีเมล</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(o.email ?? "")}">
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<button type="submit">ส่งลิงก์เข้าสู่ระบบ</button></form>`,
    ),

  meetLoginSent: () =>
    meetCard(
      "ตรวจอีเมลของคุณ",
      `<h1>ตรวจอีเมลของคุณ</h1><p class="meta">ถ้าอีเมลนี้ใช้งานได้ ลิงก์เข้าสู่ระบบจะไปถึงภายในไม่กี่นาที ลิงก์ใช้ได้ 15 นาทีและใช้ได้ครั้งเดียว</p>`,
    ),

  meetAccountDisabled: () =>
    meetCard(
      "บัญชีถูกปิดการใช้งาน",
      `<h1>บัญชีถูกปิดการใช้งาน</h1><p class="meta">บัญชีนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ</p>`,
    ),

  meetConfirm: (o: { token: string }) =>
    meetCard(
      "ยืนยันการเข้าสู่ระบบ",
      `<h1>ยืนยันการเข้าสู่ระบบ</h1><p class="meta">กดปุ่มด้านล่างเพื่อเข้าสู่ระบบในเบราว์เซอร์นี้</p>
<form method="post" action="/meet/auth"><input type="hidden" name="t" value="${esc(o.token)}">
<button type="submit">เข้าสู่ระบบ</button></form>`,
    ),

  meetLinkInvalid: () =>
    meetCard(
      "ลิงก์ใช้ไม่ได้",
      `<h1>ลิงก์ใช้ไม่ได้</h1><p class="meta">ลิงก์หมดอายุหรือถูกใช้ไปแล้ว <a href="/meet">ขอลิงก์ใหม่</a></p>`,
    ),

  meetRecorder: (o: {
    email: string;
    recordings: MeetRecordingView[];
    error?: string;
    values?: { url: string; emails: string };
    isAdmin?: boolean;
  }) => {
    const items = o.recordings
      .map(
        (r) => `<li class="rec"><div>${esc(r.title)}<small>${esc(r.code)} · ${r.stopping ? "กำลังหยุด" : STATE[r.state]} · ${
          r.trigger === "calendar" ? "จากปฏิทิน" : "จากหน้าเว็บ"
        } · เริ่มโดย ${esc(r.startedBy)}</small></div>${
          r.stopping
            ? ""
            : `<form method="post" action="/meet/stop"><input type="hidden" name="id" value="${esc(r.id)}"><button class="stop" type="submit">หยุดบันทึก</button></form>`
        }</li>`,
      )
      .join("");
    return meetCard(
      "บันทึก Google Meet",
      `<h1>บันทึก Google Meet</h1>
<p class="meta">เข้าสู่ระบบเป็น ${esc(o.email)} วางลิงก์ Google Meet แล้วกดเริ่มบันทึก บอทจะเข้าห้องและส่งบันทึกการประชุมทางอีเมลเมื่อการประชุมจบ</p>
<form method="post" action="/meet/start" autocomplete="off">
<label for="url">ลิงก์ Google Meet</label>
<input id="url" name="url" type="text" inputmode="url" placeholder="https://meet.google.com/abc-defg-hij" required value="${esc(o.values?.url ?? "")}">
<label for="emails" class="next">ส่งบันทึกให้อีเมลเพิ่มเติม (ไม่บังคับ)</label>
<textarea id="emails" name="emails" rows="3" placeholder="name@example.com">${esc(o.values?.emails ?? "")}</textarea>
<p class="hint">คั่นด้วยจุลภาคหรือขึ้นบรรทัดใหม่ บันทึกจะส่งถึงคุณเสมอ</p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}
<button type="submit">เริ่มบันทึก</button></form>
<h2>การบันทึกของคุณ</h2>
${items ? `<ul>${items}</ul>` : `<p class="meta">ยังไม่มีการบันทึกที่กำลังทำงาน</p>`}
<a class="refresh" href="/meet">รีเฟรชสถานะ</a>${o.isAdmin ? ` · <a class="refresh" href="/meet/admin">จัดการผู้ใช้</a>` : ""}`,
    );
  },

  meetAdmin: (o: { email: string; users: User[]; error?: string }) => {
    const items = o.users
      .map((u) => {
        const next = u.status === "active" ? "disabled" : "active";
        const button =
          u.email === o.email
            ? ""
            : `<form method="post" action="/meet/admin/status"><input type="hidden" name="email" value="${esc(u.email)}"><input type="hidden" name="status" value="${next}"><button class="${next === "disabled" ? "stop" : "enable"}" type="submit">${
                next === "disabled" ? "ปิดการใช้งาน" : "เปิดการใช้งาน"
              }</button></form>`;
        return `<li class="rec"><div>${esc(u.email)}<small>${u.isAdmin ? "ผู้ดูแล · " : ""}${
          u.status === "active" ? "ใช้งานได้" : "ปิดการใช้งาน"
        } · สมัครเมื่อ ${bangkokDateTime(u.createdAt)} · เข้าล่าสุด ${u.lastLoginAt ? bangkokDateTime(u.lastLoginAt) : "-"}</small></div>${button}</li>`;
      })
      .join("");
    return meetCard(
      "จัดการผู้ใช้",
      `<h1>จัดการผู้ใช้</h1><p class="meta">${o.users.length} บัญชี · <a href="/meet">กลับหน้าบันทึก</a></p>
${o.error ? `<p class="err">${esc(o.error)}</p>` : ""}<ul>${items}</ul>`,
    );
  },
};
