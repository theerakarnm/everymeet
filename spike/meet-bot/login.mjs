import { chromium } from "playwright";
import { spawn } from "node:child_process";

// Sign-in runs in a plain Chromium process (no automation attached), because Google refuses
// sign-in from automated browsers. Playwright only opens the profile afterwards to export cookies.
const profileDir = "/out/meet-profile";
const statePath = "/out/meet-auth.json";
const commonArgs = ["--password-store=basic", "--no-first-run", "--lang=en-US", "--window-position=0,0", "--window-size=1280,720"];

console.log("Open http://localhost:6080/vnc.html , sign in to the bot Google account, then stop Chromium (pkill -TERM chrome).");
const browser = spawn(chromium.executablePath(), [
  `--user-data-dir=${profileDir}`, ...commonArgs, "--no-sandbox", "https://accounts.google.com/",
], { stdio: "ignore" });
await new Promise((r) => browser.on("exit", r));

const context = await chromium.launchPersistentContext(profileDir, { headless: true, args: commonArgs });
await context.storageState({ path: statePath });
const page = await context.newPage();
await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded" });
const signedIn = !page.url().includes("accounts.google.com");
await context.close();
console.log(signedIn ? `RESULT signed in, saved ${statePath}` : "RESULT not signed in (redirected to accounts.google.com)");
process.exit(signedIn ? 0 : 1);
