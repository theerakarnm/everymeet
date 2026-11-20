import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";

export type UserStatus = "active" | "disabled";

/** Someone who signed up on the Google Meet page, or the seeded admin. */
export interface User {
  /** Lowercase; unique. */
  email: string;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt?: number;
  /** When this person's Google Meet recordings started, last 24 hours only (MEET_MAX_DAILY_PER_USER). */
  recentStarts: number[];
}

const userSchema: z.ZodType<User> = z.object({
  email: z.string(),
  status: z.enum(["active", "disabled"]),
  isAdmin: z.boolean(),
  createdAt: z.number(),
  lastLoginAt: z.number().optional(),
  recentStarts: z.array(z.number()),
});
const fileSchema = z.object({ users: z.array(userSchema) });

const DAY_MS = 24 * 60 * 60_000;
const key = (email: string) => email.trim().toLowerCase();

/**
 * The users, in one JSON file. The bot process is the only writer: the users stay in memory and every change
 * rewrites the file atomically (temp file + rename), so a crash leaves the old or the new file, never a mix.
 */
export class UserStore {
  private readonly users = new Map<string, User>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    // Starting with no users over a damaged file would silently drop every account and the admin flag.
    // The errors never quote the file: it holds every address.
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${path} is not valid JSON: restore it from a backup before starting the bot`);
    }
    const parsed = fileSchema.safeParse(saved);
    if (!parsed.success) {
      const where = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(top level)"))].join(", ");
      throw new Error(`${path} is not a valid users file (${where}): restore it from a backup before starting the bot`);
    }
    for (const u of parsed.data.users) this.users.set(u.email, u);
  }

  get(email: string): User | undefined {
    return this.users.get(key(email));
  }

  /** The user, when they exist and are not disabled. */
  active(email: string): User | undefined {
    const u = this.get(email);
    return u?.status === "active" ? u : undefined;
  }

  /** Oldest account first. */
  list(): User[] {
    return [...this.users.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A login link was confirmed: the first one creates the account. A disabled user is returned unchanged. */
  signIn(email: string, now: number): User {
    const u = this.get(email) ?? { email: key(email), status: "active", isAdmin: false, createdAt: now, recentStarts: [] };
    if (u.status === "active") u.lastLoginAt = now;
    this.users.set(u.email, u);
    this.save();
    return u;
  }

  setStatus(email: string, status: UserStatus): User | undefined {
    const u = this.get(email);
    if (!u) return undefined;
    u.status = status;
    this.save();
    return u;
  }

  /** SEED_ADMIN_EMAIL at boot: creates that user as an active admin, or makes the existing one an active admin again. */
  seedAdmin(email: string, now: number): void {
    const u = this.get(email) ?? { email: key(email), status: "active", isAdmin: true, createdAt: now, recentStarts: [] };
    u.status = "active";
    u.isAdmin = true;
    this.users.set(u.email, u);
    this.save();
  }

  /** Recordings this person started in the 24 hours before `now`. */
  startsToday(email: string, now: number): number {
    return this.get(email)?.recentStarts.filter((t) => t > now - DAY_MS).length ?? 0;
  }

  /** Counts one start for the daily limit; callers only pass people who exist (web users, calendar organizers). */
  recordStart(email: string, now: number): void {
    const u = this.get(email);
    if (!u) return;
    u.recentStarts = [...u.recentStarts.filter((t) => t > now - DAY_MS), now];
    this.save();
  }

  /** The file holds every address, so only the bot user may read it; fsync makes the rename survive a power cut. */
  private save(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      fchmodSync(fd, 0o600); // a temp file left over from a crash keeps its old mode otherwise
      writeSync(fd, JSON.stringify({ users: this.list() }, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path); // atomic replace
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

let shared: UserStore | undefined;

/** The bot's users, in DATA_DIR/users.json (on the meeting-data volume in production). */
export const users = (): UserStore => (shared ??= new UserStore(join(config().DATA_DIR, "users.json")));
