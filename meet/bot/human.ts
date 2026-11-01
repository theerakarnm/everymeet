import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright";

// Meet refuses joins driven by synthetic Playwright input, so clicks and keystrokes go through xdotool
// as real X11 input with human-like timing (spike/meet-bot, verified 2026-10-28).
const run = promisify(execFile);
const xdo = (...args: (string | number)[]) => run("xdotool", args.map(String));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function mousePos(): Promise<{ x: number; y: number }> {
  const { stdout } = await xdo("getmouselocation", "--shell");
  const v = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split("=")));
  return { x: Number(v.X), y: Number(v.Y) };
}

/** Cubic bezier with two random control points, eased, with small jitter and a slight overshoot. */
export async function moveTo(x: number, y: number): Promise<void> {
  const from = await mousePos();
  const dist = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(12, Math.round(dist / rand(12, 20)));
  const bend = () => rand(-0.3, 0.3) * dist;
  const c1 = { x: from.x + (x - from.x) * 0.3 + bend(), y: from.y + (y - from.y) * 0.3 + bend() };
  const c2 = { x: from.x + (x - from.x) * 0.7 + bend(), y: from.y + (y - from.y) * 0.7 + bend() };
  const over = { x: x + rand(-6, 6), y: y + rand(-4, 4) };
  for (let i = 1; i <= steps; i++) {
    const t0 = i / steps;
    const t = t0 < 0.5 ? 2 * t0 * t0 : 1 - (-2 * t0 + 2) ** 2 / 2;
    const u = 1 - t;
    const px = u ** 3 * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * over.x;
    const py = u ** 3 * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * over.y;
    await xdo("mousemove", "--sync", Math.round(px + rand(-1, 1)), Math.round(py + rand(-1, 1)));
    await sleep(rand(6, 18));
  }
  await sleep(rand(60, 140));
  await xdo("mousemove", "--sync", Math.round(x), Math.round(y));
}

async function click(): Promise<void> {
  await sleep(rand(80, 200));
  await xdo("mousedown", 1);
  await sleep(rand(50, 120));
  await xdo("mouseup", 1);
}

export async function typeText(text: string): Promise<void> {
  await sleep(rand(200, 400));
  for (const ch of text) {
    await xdo("type", "--clearmodifiers", "--", ch);
    await sleep(rand(70, 220));
  }
}

export async function pressKey(key: string): Promise<void> {
  await sleep(rand(80, 200));
  await xdo("key", "--clearmodifiers", key);
}

export async function wander(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await moveTo(rand(200, 1080), rand(150, 600));
    await sleep(rand(800, 2500));
  }
}

/** Screen point for a locator: viewport box + window chrome offset, a random point near the center. */
async function screenPoint(page: Page, locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  const o = await page.evaluate(() => ({
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + (window.outerHeight - window.innerHeight),
  }));
  return {
    x: o.x + box.x + box.width / 2 + rand(-box.width / 6, box.width / 6),
    y: o.y + box.y + box.height / 2 + rand(-box.height / 6, box.height / 6),
  };
}

export async function humanClick(page: Page, locator: Locator): Promise<void> {
  const p = await screenPoint(page, locator);
  await moveTo(p.x, p.y);
  await click();
}
