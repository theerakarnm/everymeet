const variant = process.env.VARIANT ?? "base";
const { chromium } = await import(variant === "patchright" ? "patchright" : "playwright");
const url = process.env.MEET_URL;
const browser = await chromium.launch({
  channel: "chrome", headless: false,
  ...(variant !== "base" ? { ignoreDefaultArgs: ["--enable-automation"] } : {}),
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--disable-blink-features=AutomationControlled"],
});
const page = await (await browser.newContext({ locale: "en-US" })).newPage();
await page.goto(url);
await page.waitForTimeout(5000);
await page.getByPlaceholder(/your name/i).fill("Meeting Recorder");
await page.getByRole("button", { name: /(ask to join|join now)/i }).first().click();
console.log("clicked");
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const denied = await page.getByText(/can't join this video call/i).count();
  const inCall = await page.getByRole("button", { name: /leave call/i }).count();
  console.log(i * 5 + 5, "s", { denied, inCall });
  await page.screenshot({ path: `native-${i}.png` });
  if (denied || inCall) { await page.waitForTimeout(8000); await page.screenshot({ path: 'native-final.png' }); break; }
}
await browser.close();
