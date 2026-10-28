import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { humanClick, type, wander } from "./human.mjs";

const url = process.env.MEET_URL;
const botName = process.env.BOT_NAME ?? "Meeting Recorder";
const admitTimeoutMs = Number(process.env.ADMIT_TIMEOUT_SECONDS ?? 300) * 1000;
const recordSeconds = Number(process.env.RECORD_SECONDS ?? 60);
if (!url) throw new Error("MEET_URL is required");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const shot = (page, name) => page.screenshot({ path: `/out/${name}.png` }).catch(() => {});

const browser = await chromium.launch({
  headless: false,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,720",
    "--window-position=0,0",
    "--lang=en-US",
    "--disable-dev-shm-usage",
    ...(process.env.FAKE_DEVICES ? ["--use-fake-device-for-media-stream"] : []),
  ],
});
const authStateFile = process.env.MEET_AUTH_STATE_JSON ? JSON.parse(process.env.MEET_AUTH_STATE_JSON) : process.env.MEET_AUTH_STATE_FILE;
const context = await browser.newContext({
  ...(authStateFile ? { storageState: authStateFile } : {}),
  locale: "en-US",
  viewport: null,
  permissions: ["microphone", "camera"],
});
const page = await context.newPage();

log("env", JSON.stringify(await page.evaluate(() => ({ ua: navigator.userAgent, webdriver: navigator.webdriver, plugins: navigator.plugins.length }))));
log("goto", url);
for (let attempt = 1; ; attempt++) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    break;
  } catch (e) {
    if (attempt >= 3 || !String(e).includes("ERR_NETWORK_CHANGED")) throw e;
    log("goto failed with ERR_NETWORK_CHANGED, retrying", attempt);
    await page.waitForTimeout(2000);
  }
}
await page.waitForTimeout(5000);
await shot(page, "01-landing");
if (page.url().includes("accounts.google.com")) {
  log("RESULT bot account session expired; run login again");
  await browser.close();
  process.exit(5);
}
log(authStateFile ? "using bot account session" : "joining as guest");

await page.evaluate(() => {
  window.__lastMouse = null;
  addEventListener("mousemove", (e) => { window.__lastMouse = { x: e.clientX, y: e.clientY, trusted: e.isTrusted }; }, true);
});
await wander(Number(process.env.PREJOIN_WAIT_SECONDS ?? 12) * 1000);
log("mouse seen by page", JSON.stringify(await page.evaluate(() => window.__lastMouse)));

const gotIt = page.getByRole("button", { name: /^(got it|dismiss)$/i });
if (await gotIt.count()) await humanClick(page, gotIt.first());

const nameInput = page.getByPlaceholder(/your name/i);
if (await nameInput.count()) {
  await humanClick(page, nameInput);
  await type(botName);
  log("name typed:", await nameInput.inputValue());
} else {
  log(authStateFile ? "no name input (signed in)" : "no name input (blocked?)");
}
await shot(page, "02-prejoin");

const joinBtn = page.getByRole("button", { name: /(ask to join|join now)/i });
if (!(await joinBtn.count())) {
  log("RESULT no join button; see 02-prejoin.png");
  await browser.close();
  process.exit(2);
}
await wander(Number(process.env.PREJOIN_WAIT_SECONDS ?? 12) * 300);
await humanClick(page, joinBtn.first());
log("join clicked, waiting for admission");
await page.waitForTimeout(3000);
await shot(page, "03-waiting");

const leave = page.getByRole("button", { name: /leave call/i });
const deadline = Date.now() + admitTimeoutMs;
let inCall = false;
while (Date.now() < deadline) {
  if (await leave.count()) { inCall = true; break; }
  const denied = await page.getByText(/(denied your request|removed from the meeting|can't join this video call)/i).count();
  if (denied) { log("RESULT denied/blocked"); await shot(page, "04-denied"); await browser.close(); process.exit(3); }
  await page.waitForTimeout(2000);
}
if (!inCall) { log("RESULT admit timeout"); await shot(page, "04-timeout"); await browser.close(); process.exit(4); }

log("IN CALL");
await page.waitForTimeout(2000);
await shot(page, "05-in-call");

const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "pulse", "-i", "meet.monitor",
  "-ac", "1", "-ar", "24000", "-t", String(recordSeconds), "/out/mixed.flac",
], { stdio: ["ignore", "ignore", "inherit"] });
const ffDone = new Promise((r) => ff.on("exit", r));
log("recording", recordSeconds, "s");

const snap = setInterval(() => shot(page, `06-call-${Date.now()}`), 20000);
await ffDone;
clearInterval(snap);
await shot(page, "07-end");
log("RESULT ok, recorded mixed.flac");
await browser.close();
