import { spawn } from "node:child_process";
import { chromium } from "playwright";

// Sign-in runs in a plain Chromium process with no automation attached, because Google refuses sign-in from
// automated browsers. Playwright opens the profile only afterwards, to export the session.
const profileDir = "/out/meet-profile";
const statePath = "/out/meet-auth.json";
const commonArgs = ["--password-store=basic", "--no-first-run", "--lang=en-US", "--window-position=0,0", "--window-size=1280,720"];

console.log("Open http://localhost:6080/vnc.html, sign in to the bot Google account, then close Chromium.");
const browser = spawn(chromium.executablePath(), [`--user-data-dir=${profileDir}`, ...commonArgs, "--no-sandbox", "https://accounts.google.com/"], {
  stdio: "ignore",
});
await new Promise((resolve) => browser.on("exit", resolve));

const context = await chromium.launchPersistentContext(profileDir, { headless: true, args: commonArgs });
await context.storageState({ path: statePath });
const page = await context.newPage();
await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded" });
const signedIn = !page.url().includes("accounts.google.com");
await context.close();
console.log(
  signedIn
    ? `RESULT signed in, saved ${statePath}. Copy it to the bot server (MEET_AUTH_STATE_FILE) and delete auth/meet-profile.`
    : "RESULT not signed in (redirected to accounts.google.com)",
);
process.exit(signedIn ? 0 : 1);
