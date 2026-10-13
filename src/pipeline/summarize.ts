import type { Manifest } from "../storage/manifest.js";
import { bangkokDateTime } from "../util/time.js";
import { chat } from "./openrouter.js";

/** The short summary must stay under 1500 characters. */
export const SHORT_MAX = 1499;

const SYSTEM = `คุณคือเลขานุการการประชุมมืออาชีพ หน้าที่คือสรุปการประชุมจากบันทึกการถอดเสียง (transcript) เป็นภาษาไทย
กฎ:
- เขียนเป็นภาษาไทย แต่คงศัพท์เทคนิค ชื่อเครื่องมือ ชื่อสินค้า และคำภาษาอังกฤษที่ผู้พูดใช้ไว้ตามเดิม
- ใช้เฉพาะข้อมูลที่อยู่ใน transcript ห้ามแต่งหรือเดาข้อมูลเพิ่ม ถ้าไม่แน่ใจให้เขียนว่า "(ไม่ชัดเจนจากบันทึก)"
- transcript มาจากการถอดเสียงอัตโนมัติ อาจมีคำผิด ให้ตีความตามบริบทอย่างระมัดระวัง
- ระบุชื่อผู้พูดตามที่ปรากฏใน transcript เมื่ออ้างถึงว่าใครพูดหรือรับผิดชอบอะไร
- ห้ามใช้ตาราง (Discord แสดงตารางไม่ได้) ให้ใช้หัวข้อและ bullet แทน`;

function meetingContext(m: Manifest): string {
  const names = Object.values(m.participants).map((p) => p.displayName);
  return `ข้อมูลการประชุม: ห้อง "${m.voiceChannelName}" ในเซิร์ฟเวอร์ "${m.guildName}" เริ่ม ${bangkokDateTime(
    m.startedAt,
  )} ผู้เข้าร่วมที่พูด: ${names.join(", ") || "-"}`;
}

export async function fullSummary(m: Manifest, transcript: string): Promise<{ model: string; text: string }> {
  return chat(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `${meetingContext(m)}

สรุปการประชุมฉบับเต็มในรูปแบบ Markdown ตามโครงนี้ (ข้ามหัวข้อที่ไม่มีข้อมูลได้ โดยเขียนว่า "ไม่มี"):

# สรุปการประชุม
## ภาพรวม
(2-4 ประโยค: ประชุมเรื่องอะไร ผลลัพธ์หลักคืออะไร)
## ประเด็นที่หารือ
(แยกตามหัวข้อ แต่ละหัวข้อสรุปความเห็นของแต่ละฝ่าย)
## สิ่งที่ตัดสินใจแล้ว
## Action Items
(รูปแบบ: - [ ] งาน - ผู้รับผิดชอบ: ชื่อ - กำหนดเสร็จ: วันที่หรือ "ไม่ระบุ")
## ประเด็นที่ยังค้าง / ต้องติดตาม
## ไทม์ไลน์
(ช่วงสำคัญพร้อมเวลา [HH:MM:SS] จาก transcript)

<transcript>
${transcript}
</transcript>`,
      },
    ],
    16_000,
  );
}

export async function shortSummary(m: Manifest, full: string): Promise<{ model: string; text: string }> {
  const ask = (limit: number) =>
    chat(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `${meetingContext(m)}

จากสรุปฉบับเต็มด้านล่าง เขียนสรุปสั้นสำหรับโพสต์ใน Discord ความยาวไม่เกิน ${limit} ตัวอักษร (นับรวมช่องว่าง)
รูปแบบ:
**ภาพรวม:** 1-2 ประโยค
**ตัดสินใจ:** bullet สั้น ๆ
**Action Items:** bullet พร้อมผู้รับผิดชอบ
ห้ามมีหัวข้อ # และห้ามมีข้อความอื่นนอกเหนือจากสรุป

<full_summary>
${full}
</full_summary>`,
        },
      ],
      2_000,
    );

  let res = await ask(1200);
  if (res.text.length > SHORT_MAX) res = await ask(800);
  if (res.text.length > SHORT_MAX) res = { ...res, text: truncate(res.text, SHORT_MAX) };
  return res;
}

/** Cut at the last line break before the limit so the text never ends mid-sentence. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const nl = cut.lastIndexOf("\n");
  return `${nl > limit * 0.6 ? cut.slice(0, nl) : cut}…`;
}
