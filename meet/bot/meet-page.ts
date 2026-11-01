import { chromium, type Browser, type Page } from "playwright";
import { humanClick, moveTo, pressKey, sleep, typeText, wander } from "./human.js";
import type { CallObservation } from "./rules.js";

/** Posted in the Meet chat right after the bot is let in (consent / PDPA). */
export const CONSENT_MESSAGE =
  "🔴 บอทนี้กำลังบันทึกเสียงการประชุมเพื่อจัดทำบันทึกการประชุม (This call is being recorded to write meeting minutes.)";
const CONSENT_PROBE = "This call is being recorded";

// Meet's en-US UI texts, adapted from Vexa (Apache-2.0):
// core/meetings/modules/join/src/googlemeet/selectors.ts and admission.ts.
const WAITING = [
  /asking to be let in/i,
  /you.ll join the call when someone lets you in/i,
  /please wait until a meeting host brings you into the call/i,
  /waiting for the host to let you in/i,
];
const DENIED = [
  /denied your request/i,
  /your request to join was denied/i,
  /you were denied/i,
  /weren.t allowed to join/i,
  /not allowed to join/i,
  /can.t join this video call/i,
  /can.t join this call/i,
  /meeting not found/i,
];
const REMOVED = [/you.ve been removed from the meeting/i];
const ENDED = [
  /the call ended because everyone left/i,
  /your host ended the meeting for everyone/i,
  /^meeting ended$/i,
  /^call ended$/i,
  /you left the meeting/i,
];
/** Meet also renders a tile for the "Backgrounds and effects" preview; it is not a person. */
const PHANTOM_TILE = "visual_effects|backgrounds and effects";

const LAUNCH_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--window-size=1280,720",
  "--window-position=0,0",
  "--lang=en-US",
  "--disable-dev-shm-usage",
];

/** One headful Chromium tab on a Google Meet call, driven like a person would. */
export class MeetPage {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  static async open(meetUrl: string, authState?: string): Promise<MeetPage> {
    const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
    const context = await browser.newContext({
      ...(authState ? { storageState: JSON.parse(authState) } : {}),
      locale: "en-US",
      viewport: null,
      permissions: ["microphone", "camera"],
    });
    const page = await context.newPage();
    // Container Chromium sometimes fails the first navigation with ERR_NETWORK_CHANGED.
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(`${meetUrl}?hl=en`, { waitUntil: "domcontentloaded" });
        break;
      } catch (err) {
        if (attempt >= 3 || !String(err).includes("ERR_NETWORK_CHANGED")) throw err;
        await sleep(2_000);
      }
    }
    await sleep(5_000);
    return new MeetPage(browser, page);
  }

  /** With a bot account session: Google sent us to sign in, or Meet offers the guest name field. */
  async signedOut(): Promise<boolean> {
    return this.page.url().includes("accounts.google.com") || (await this.page.getByPlaceholder(/your name/i).count()) > 0;
  }

  /** Looks around like a person, mutes, types the guest name if needed, and asks to join. False when Meet offers no join button. */
  async prejoin(guestName: string | undefined): Promise<boolean> {
    await wander(12_000);
    const gotIt = this.page.getByRole("button", { name: /^(got it|dismiss)$/i });
    if (await gotIt.count()) await humanClick(this.page, gotIt.first());
    for (const name of [/turn off microphone/i, /turn off camera/i]) {
      const toggle = this.page.getByRole("button", { name });
      if (await toggle.count()) await humanClick(this.page, toggle.first());
    }
    if (guestName) {
      const input = this.page.getByPlaceholder(/your name/i);
      if (await input.count()) {
        await humanClick(this.page, input.first());
        await typeText(guestName);
      }
    }
    const join = this.page.getByRole("button", { name: /(ask to join|join now)/i });
    if (!(await join.count())) return false;
    await wander(3_600);
    await humanClick(this.page, join.first());
    return true;
  }

  async waitForAdmission(
    timeoutMs: number,
    stopRequested: () => boolean,
  ): Promise<"admitted" | "denied" | "not_admitted" | "stopped"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stopRequested()) return "stopped";
      if (await this.anyVisible(DENIED)) return "denied";
      if (!(await this.anyVisible(WAITING)) && (await this.admittedUi())) return "admitted";
      await sleep(2_000);
    }
    return "not_admitted";
  }

  async observe(): Promise<CallObservation> {
    if (await this.anyVisible(REMOVED)) return { inCall: false, endScreen: "removed" };
    if (await this.anyVisible(ENDED)) return { inCall: false, endScreen: "meeting_ended" };
    // Only the People button count feeds the alone rule: tiles undercount in presentation layouts, and a false
    // "alone" would cut a live meeting short, while a missed one only costs container time until the limit.
    return { inCall: await this.stillInCall(), participants: await this.peopleCount() };
  }

  /** Opens the chat, posts `text`, and closes the chat again. True when the message shows in the chat. */
  async postChat(text: string): Promise<boolean> {
    try {
      await this.wakeToolbar();
      const open = this.page.getByRole("button", { name: /chat with everyone/i }).first();
      await humanClick(this.page, open);
      const box = this.page.getByRole("textbox", { name: /send a message/i }).first();
      await box.waitFor({ timeout: 10_000 });
      await humanClick(this.page, box);
      await this.page.keyboard.insertText(text);
      await pressKey("Return");
      await sleep(1_500);
      const posted = (await this.page.getByText(CONSENT_PROBE).count()) > 0;
      await humanClick(this.page, open); // close the panel so the tiles stay countable
      return posted;
    } catch {
      return false;
    }
  }

  /** Clicks "Leave call" like a person and checks the bot is out. */
  async leave(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.wakeToolbar();
      const leave = this.page.getByRole("button", { name: /^leave call$/i });
      if (await leave.count()) await humanClick(this.page, leave.first()).catch(() => {});
      const justLeave = this.page.getByRole("button", { name: /just leave the (meeting|call)/i });
      if (await justLeave.count()) await humanClick(this.page, justLeave.first()).catch(() => {});
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await this.anyVisible([/you left the meeting/i])) || !(await this.stillInCall())) return true;
        await sleep(1_000);
      }
    }
    return false;
  }

  screenshot(): Promise<Buffer> {
    return this.page.screenshot();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** Only valid in the lobby phase: tiles or the self tile, never the Leave button (the lobby has one too). */
  private async admittedUi(): Promise<boolean> {
    return (await this.participantTiles()) > 0 || (await this.selfTile());
  }

  /** After admission: the Leave button is in the DOM (even while the toolbar is hidden), or tiles are. */
  private async stillInCall(): Promise<boolean> {
    return (await this.page.locator('button[aria-label="Leave call"]').count()) > 0 || (await this.admittedUi());
  }

  /** The number Meet shows on the People button (everyone in the call, the bot included). */
  private peopleCount(): Promise<number | undefined> {
    return this.page.evaluate(() => {
      const button = document.querySelector('button[aria-label^="People"], button[aria-label*="Show everyone"]');
      const digits = (button?.textContent ?? "").match(/\d+/)?.[0] ?? button?.getAttribute("aria-label")?.match(/\d+/)?.[0];
      const n = Number(digits);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    });
  }

  private async selfTile(): Promise<boolean> {
    return (await this.page.locator("[data-self-name]").count()) > 0;
  }

  /** Distinct participant ids on screen; the effects preview tile is skipped. */
  private participantTiles(): Promise<number> {
    return this.page.evaluate((phantom) => {
      const re = new RegExp(phantom, "i");
      const ids = [...document.querySelectorAll("[data-participant-id]")]
        .filter((el) => !re.test(`${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`))
        .map((el) => el.getAttribute("data-participant-id"));
      return new Set(ids).size;
    }, PHANTOM_TILE);
  }

  /** The call toolbar hides after a while; moving the mouse near it shows it again. */
  private async wakeToolbar(): Promise<void> {
    await moveTo(540 + Math.random() * 200, 640);
  }

  private async anyVisible(patterns: RegExp[]): Promise<boolean> {
    for (const p of patterns) {
      if (await this.page.getByText(p).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }
}
