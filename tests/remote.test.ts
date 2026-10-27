import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  BUCKET_MAP,
  LAST_TEXT_MAX_BYTES,
  buildSnapshot,
  checkRemoteUrl,
  clipBytes,
  originMatches,
  parseStoredToken,
  nextBackoff,
  shouldPush,
  snapshotHash,
  type FleetMachine,
  type SnapshotAccountInput,
} from "../src/remote";
import { defaultCapabilities, type SessionView } from "../src/providers/types";

const row = (over: Partial<SessionView> = {}): SessionView => ({
  key: "claude:s1",
  provider: "claude",
  sessionId: "s1",
  title: "fix the bug",
  bucket: "working",
  sub: "working",
  detail: "",
  tooltip: "",
  capabilities: defaultCapabilities("claude", { kill: true }),
  cwd: "/Users/x/repo",
  cwdLabel: "repo",
  lastActivityMs: 1_700_000_000_500,
  pid: 4242,
  stale: false,
  model: "claude-opus",
  effort: "high",
  matchLabels: [],
  ...over,
});

const machine: FleetMachine = { cpuPct: 33, memFreeMb: 4100, memTotalMb: 16384, pressure: "normal", sessions: 0 };
const accounts: SnapshotAccountInput[] = [
  { id: "a1", email: "a@example.com", plan: "$200 Max", active: true, gauges: [{ key: "session", label: "5h", pct: 42.4, resetMs: 1000 }] },
  {
    id: "a2",
    email: "b@example.com",
    plan: null,
    active: false,
    gauges: [
      { key: "session", label: "5h", pct: 100, resetMs: 2000 },
      { key: "weekly", label: "7d", pct: null, resetMs: null },
    ],
  },
];

describe("buildSnapshot", () => {
  it("maps every panel group to a contract bucket", () => {
    const cases: [Partial<SessionView>, string][] = [
      [{ bucket: "limited" }, "limited"],
      [{ bucket: "attention", sub: "waiting for you" }, "waiting"],
      [{ bucket: "attention", sub: "your turn" }, "yourTurn"],
      [{ bucket: "working" }, "working"],
      [{ bucket: "ended" }, "ended"],
      [{ bucket: "unknown" }, "idle"],
    ];
    for (const [over, want] of cases) {
      const b = buildSnapshot({ host: "mac", rows: [row(over)], accounts, machine, now: 1 });
      expect(b.sessions[0].bucket).toBe(want);
    }
    expect(Object.keys(BUCKET_MAP).sort()).toEqual(["done", "ended", "limited", "unknown", "waiting", "working"]);
  });

  it("maps the row fields to the session object", () => {
    const b = buildSnapshot({ host: "mac", rows: [row({ tokens: 1234, notifMessage: "needs approval" })], accounts, bestAccountId: "a1", machine, now: 5 });
    expect(b).toMatchObject({ v: 1, host: "mac", sentAt: 5 });
    expect(b.sessions[0]).toEqual({
      id: "s1",
      provider: "claude",
      title: "fix the bug",
      bucket: "working",
      model: "claude-opus",
      effort: "high",
      cwd: "/Users/x/repo",
      project: "repo",
      pid: 4242,
      lastActivityTs: 1_700_000_000,
      lastText: "needs approval",
      closing: null,
      limit: null,
      canResume: true,
      tokens: { ctxPct: null, total: 1234 },
      account: "a@example.com",
    });
  });

  it("adds limit info only to limited rows and no account to codex rows", () => {
    const b = buildSnapshot({
      host: "mac",
      rows: [row({ bucket: "limited", resetText: "1:50pm" }), row({ provider: "codex", sessionId: "c1", key: "codex:c1" })],
      accounts,
      machine,
      now: Date.UTC(2026, 9, 27, 10, 0),
    });
    expect(b.sessions[0].limit?.resetText).toBe("1:50pm");
    expect(typeof b.sessions[0].limit?.resetTs).toBe("number");
    expect(b.sessions[1].limit).toBeNull();
    expect(b.sessions[1].account).toBeNull();
  });

  it("maps accounts: best, exhausted, numeric gauges only", () => {
    const b = buildSnapshot({ host: "mac", rows: [], accounts, bestAccountId: "a1", machine, now: 1 });
    expect(b.accounts[0]).toEqual({
      id: "a1",
      email: "a@example.com",
      tier: "$200 Max",
      active: true,
      best: true,
      exhausted: false,
      gauges: [{ key: "session", label: "5h", pct: 42, resetMs: 1000 }],
    });
    expect(b.accounts[1]).toMatchObject({ best: false, exhausted: true, tier: null });
    expect(b.accounts[1].gauges).toHaveLength(1);
  });

  it("caps lastText at 2 KB and coarsens the machine sample", () => {
    const b = buildSnapshot({ host: "mac", rows: [row({ detail: "é".repeat(5000) })], accounts: [], machine, now: 1 });
    expect(Buffer.byteLength(b.sessions[0].lastText!, "utf8")).toBeLessThanOrEqual(LAST_TEXT_MAX_BYTES);
    expect(b.machine).toEqual({ cpuPct: 30, memFreeMb: 4096, memTotalMb: 16384, pressure: "normal", sessions: 1 });
    expect(b.accounts).toEqual([]);
  });

  it("clipBytes leaves short strings alone", () => {
    expect(clipBytes("abc", 10)).toBe("abc");
    expect(Buffer.byteLength(clipBytes("a".repeat(100), 10))).toBeLessThanOrEqual(10);
  });
});

describe("snapshotHash", () => {
  const base = { host: "mac", rows: [row()], accounts, machine };
  it("ignores sentAt and key order", () => {
    const a = buildSnapshot({ ...base, now: 1 });
    const b = buildSnapshot({ ...base, now: 999_999 });
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    const reordered = JSON.parse(JSON.stringify({ machine: a.machine, accounts: a.accounts, sessions: a.sessions, host: a.host, v: 1, sentAt: 7 }));
    expect(snapshotHash(reordered)).toBe(snapshotHash(a));
  });
  it("stays stable under small machine jitter and changes on a real change", () => {
    const a = buildSnapshot({ ...base, now: 1 });
    const jitter = buildSnapshot({ ...base, machine: { ...machine, cpuPct: 34, memFreeMb: 4000 }, now: 2 });
    expect(snapshotHash(jitter)).toBe(snapshotHash(a));
    const changed = buildSnapshot({ ...base, rows: [row({ bucket: "attention", sub: "your turn" })], now: 3 });
    expect(snapshotHash(changed)).not.toBe(snapshotHash(a));
    expect(snapshotHash(a)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("shouldPush", () => {
  it("pushes the first snapshot", () => {
    expect(shouldPush({ changed: false, lastPushTs: 0, now: 1000 })).toBe(true);
  });
  it("pushes a change only after 10 s", () => {
    expect(shouldPush({ changed: true, lastPushTs: 100_000, now: 109_999 })).toBe(false);
    expect(shouldPush({ changed: true, lastPushTs: 100_000, now: 110_000 })).toBe(true);
  });
  it("sends a heartbeat after 2 min without a change", () => {
    expect(shouldPush({ changed: false, lastPushTs: 100_000, now: 219_999 })).toBe(false);
    expect(shouldPush({ changed: false, lastPushTs: 100_000, now: 220_000 })).toBe(true);
  });
});

describe("nextBackoff", () => {
  it("starts at 2 s, doubles, caps at 60 s", () => {
    const seq: number[] = [];
    let b = 0;
    for (let i = 0; i < 7; i++) seq.push((b = nextBackoff(b)));
    expect(seq).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(nextBackoff(BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
  });
});

describe("remote url + token origin binding", () => {
  it("originMatches compares scheme, host and port only", () => {
    expect(originMatches("https://relay.example.com", "https://relay.example.com/")).toBe(true);
    expect(originMatches("https://relay.example.com", "https://relay.example.com/sub/path")).toBe(true);
    expect(originMatches("https://relay.example.com", "https://evil.example.com")).toBe(false);
    expect(originMatches("https://relay.example.com", "http://relay.example.com")).toBe(false);
    expect(originMatches("https://relay.example.com", "https://relay.example.com:8443")).toBe(false);
    expect(originMatches("https://relay.example.com", "https://relay.example.com.evil.io")).toBe(false);
    expect(originMatches(null, "https://relay.example.com")).toBe(false);
    expect(originMatches("https://relay.example.com", "not a url")).toBe(false);
  });
  it("checkRemoteUrl accepts https and local http only", () => {
    expect(checkRemoteUrl("https://relay.example.com/")).toEqual({ url: "https://relay.example.com", origin: "https://relay.example.com" });
    expect(checkRemoteUrl("http://localhost:8787")).toEqual({ url: "http://localhost:8787", origin: "http://localhost:8787" });
    expect(checkRemoteUrl("http://127.0.0.1:8787")).toMatchObject({ origin: "http://127.0.0.1:8787" });
    expect(checkRemoteUrl("http://relay.example.com")).toHaveProperty("error");
    expect(checkRemoteUrl("ftp://relay.example.com")).toHaveProperty("error");
    expect(checkRemoteUrl("relay.example.com")).toHaveProperty("error");
  });
  it("parseStoredToken needs {origin, token}; a bare legacy string is unbound", () => {
    expect(parseStoredToken(JSON.stringify({ origin: "https://r.example", token: "t" }))).toEqual({ origin: "https://r.example", token: "t" });
    expect(parseStoredToken("plain-token")).toBeNull();
    expect(parseStoredToken(JSON.stringify({ token: "t" }))).toBeNull();
    expect(parseStoredToken(undefined)).toBeNull();
  });
});
