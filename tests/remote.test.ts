import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_MAX_MS,
  BUCKET_MAP,
  COMMAND_MAX_AGE_MS,
  COMMAND_TIMEOUT_MS,
  LAST_TEXT_MAX_BYTES,
  MACHINE_SAMPLE_MS,
  MAX_COMMANDS_PER_POLL,
  MAX_RESPONSE_BYTES,
  availableMemoryMb,
  buildSnapshot,
  checkRemoteUrl,
  clipBytes,
  commandRefusal,
  freePctFromMemoryPressure,
  maskEmail,
  originMatches,
  parseStoredToken,
  nextBackoff,
  readCappedBody,
  redactSecrets,
  sampleMachine,
  shouldPush,
  snapshotHash,
  withTimeout,
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
    expect(Object.keys(BUCKET_MAP).sort()).toEqual(["background", "done", "ended", "limited", "unknown", "waiting", "working"]);
  });

  it("sends an in-background ⏳ row as yourTurn with its finish time in the optional background field", () => {
    const yourTurn = { bucket: "attention", sub: "your turn" } as const;
    const pending = { kind: "pending", text: "Kapatma: CI · bitiş ~06:15" } as const;
    const b = buildSnapshot({
      host: "mac",
      rows: [
        row({ ...yourTurn, sessionId: "bg", closing: pending, closingTiming: { dueMs: 1_700_000_900_500, overdue: false } }),
        row({ ...yourTurn, sessionId: "nodue", closing: pending, closingTiming: { dueMs: null, overdue: false } }),
        row({ ...yourTurn, sessionId: "late", closing: pending, closingTiming: { dueMs: 1_700_000_900_500, overdue: true } }),
        row({ ...yourTurn, sessionId: "plain" }),
      ],
      accounts,
      machine,
      now: 1,
    });
    expect(b.sessions.map((s) => [s.id, s.bucket, s.background])).toEqual([
      ["bg", "yourTurn", { dueTs: 1_700_000_900 }],
      ["nodue", "yourTurn", { dueTs: null }],
      ["late", "yourTurn", undefined],
      ["plain", "yourTurn", undefined],
    ]);
    expect("background" in b.sessions[3]).toBe(false);
  });

  it("maps the row fields to the session object", () => {
    const b = buildSnapshot({
      host: "mac",
      rows: [row({ tokens: 1234, notifMessage: "needs approval", aiTitle: true })],
      accounts,
      bestAccountId: "a1",
      machine,
      cwdRoots: ["/Users/x"],
      now: 5,
    });
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
      account: "a***@example.com",
      waitReason: null,
      git: null,
      autoResume: null,
      answerable: null,
    });
  });

  it("marks a row answerable from the provider", () => {
    const b = buildSnapshot({
      host: "mac",
      rows: [row({ askPending: true }), row({ sessionId: "s2" })],
      accounts,
      machine,
      now: 1,
      answerable: (v) => (v.askPending ? { deadline: 1_800_000_600 } : null),
    });
    expect(b.sessions.map((s) => s.answerable)).toEqual([{ deadline: 1_800_000_600 }, null]);
  });

  it("asks the git provider per cwd and the auto-resume provider for limited rows only", () => {
    const git = { branch: "feat/x", dirty: 3, pr: null };
    const seen: (string | null)[] = [];
    const b = buildSnapshot({
      host: "mac",
      rows: [row({ bucket: "limited", resetText: "9pm" }), row({ sessionId: "s2", cwd: undefined }), row({ sessionId: "s3" })],
      accounts,
      machine,
      now: 1,
      git: (cwd) => (seen.push(cwd), cwd ? git : null),
      autoResume: (v) => ({ enabled: v.sessionId === "s1", at: 1_800_000_090 }),
    });
    expect(seen).toEqual(["/Users/x/repo", null, "/Users/x/repo"]);
    expect(b.sessions.map((s) => [s.id, s.git, s.autoResume])).toEqual([
      ["s1", git, { enabled: true, at: 1_800_000_090 }],
      ["s2", null, null],
      ["s3", git, null],
    ]);
  });

  it("gives waiting and yourTurn rows a waitReason: question, permission, else idle; null elsewhere", () => {
    const waiting = { bucket: "attention", sub: "waiting for you" } as const;
    const yourTurn = { bucket: "attention", sub: "your turn" } as const;
    const cases: [Partial<SessionView>, string | null][] = [
      [{ ...waiting, askPending: true, notifType: "permission_prompt" }, "question"],
      [{ ...waiting, notifType: "permission_prompt" }, "permission"],
      [{ ...waiting, notifType: "idle_prompt" }, "idle"],
      [{ ...waiting }, "idle"],
      [{ ...yourTurn }, "idle"],
      [{ ...yourTurn, askPending: true }, "question"],
      [{ ...yourTurn, closing: { kind: "pending", text: "CI · bitiş ~06:15" }, closingTiming: { dueMs: 1, overdue: false } }, "idle"],
      [{ bucket: "working", askPending: true }, null],
      [{ bucket: "limited", notifType: "permission_prompt" }, null],
      [{ bucket: "ended" }, null],
      [{ bucket: "unknown" }, null],
    ];
    for (const [over, want] of cases) {
      const b = buildSnapshot({ host: "mac", rows: [row(over)], accounts, machine, now: 1 });
      expect([over, b.sessions[0].waitReason]).toEqual([over, want]);
    }
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
      email: "a***@example.com",
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

  it("carries allowedCwds when given, at most 30, and leaves the field out otherwise", () => {
    const cwds = Array.from({ length: 35 }, (_, i) => `/r/p${i}`);
    const roots = ["/r"];
    expect(buildSnapshot({ host: "mac", rows: [], accounts: [], machine, allowedCwds: cwds, cwdRoots: roots, now: 1 }).allowedCwds).toEqual(cwds.slice(0, 30));
    expect(buildSnapshot({ host: "mac", rows: [], accounts: [], machine, allowedCwds: [], cwdRoots: roots, now: 1 }).allowedCwds).toEqual([]);
    expect("allowedCwds" in buildSnapshot({ host: "mac", rows: [], accounts: [], machine, now: 1 })).toBe(false);
  });

  it("clipBytes leaves short strings alone", () => {
    expect(clipBytes("abc", 10)).toBe("abc");
    expect(Buffer.byteLength(clipBytes("a".repeat(100), 10))).toBeLessThanOrEqual(10);
  });
});

describe("buildSnapshot: what leaves the machine", () => {
  it("sends the full cwd only inside a remote.allowedCwds root, else the folder name", () => {
    const rows = [
      row({ sessionId: "in", cwd: "/Users/x/repo/app", cwdLabel: "app" }),
      row({ sessionId: "root" }),
      row({ sessionId: "sibling", cwd: "/Users/x/repo-x", cwdLabel: "repo-x" }),
      row({ sessionId: "climb", cwd: "/Users/x/repo/../secret", cwdLabel: "secret" }),
      row({ sessionId: "out", cwd: "/Users/x/private/notes", cwdLabel: "notes" }),
      row({ sessionId: "none", cwd: undefined, cwdLabel: undefined }),
    ];
    const b = buildSnapshot({ host: "mac", rows, accounts, machine, cwdRoots: ["/Users/x/repo"], now: 1 });
    expect(b.sessions.map((s) => [s.id, s.cwd, s.project])).toEqual([
      ["in", "/Users/x/repo/app", "app"],
      ["root", "/Users/x/repo", "repo"],
      ["sibling", "repo-x", "repo-x"],
      ["climb", "secret", "secret"],
      ["out", "notes", "notes"],
      ["none", null, null],
    ]);
    const noRoots = buildSnapshot({ host: "mac", rows, accounts, machine, now: 1 });
    expect(noRoots.sessions.map((s) => s.cwd)).toEqual(["app", "repo", "repo-x", "secret", "notes", null]);
  });

  it("offers only the allowedCwds entries that lie inside a root", () => {
    const allowedCwds = ["/Users/x/repo/app", "/Users/x/repo-x", "/Users/x/Downloads/tool", "/Users/x/repo"];
    const b = buildSnapshot({ host: "mac", rows: [], accounts: [], machine, allowedCwds, cwdRoots: ["/Users/x/repo"], now: 1 });
    expect(b.allowedCwds).toEqual(["/Users/x/repo/app", "/Users/x/repo"]);
    expect(buildSnapshot({ host: "mac", rows: [], accounts: [], machine, allowedCwds, now: 1 }).allowedCwds).toEqual([]);
  });

  it("sends a title only when it is Claude's AI title, else \"Session in <folder>\"", () => {
    const b = buildSnapshot({
      host: "mac",
      rows: [
        row({ sessionId: "ai", title: "Refactor the parser", aiTitle: true }),
        row({ sessionId: "prompt", title: "my prompt text with details" }),
        row({ sessionId: "cx", provider: "codex", key: "codex:cx", title: "codex preview text" }),
        row({ sessionId: "0123456789", title: "prompt without a folder", cwd: undefined, cwdLabel: undefined }),
      ],
      accounts,
      machine,
      now: 1,
    });
    expect(b.sessions.map((s) => s.title)).toEqual(["Refactor the parser", "Session in repo", "Session in repo", "Session 01234567"]);
    for (const text of ["my prompt text", "codex preview", "without a folder"]) expect(JSON.stringify(b)).not.toContain(text);
  });

  it("masks every account email: the account list and each session's account", () => {
    const people: SnapshotAccountInput[] = [
      { id: "a1", email: "alice@example.com", plan: null, active: true, gauges: [] },
      { id: "a2", email: "bob@example.org", plan: null, active: false, gauges: [] },
      { id: "default", email: "this account", plan: null, active: false, gauges: [] },
    ];
    const b = buildSnapshot({ host: "mac", rows: [row()], accounts: people, machine, now: 1 });
    expect(b.accounts.map((a) => [a.id, a.email])).toEqual([
      ["a1", "a***@example.com"],
      ["a2", "b***@example.org"],
      ["default", "***"],
    ]);
    expect(b.sessions[0].account).toBe("a***@example.com");
    expect(JSON.stringify(b)).not.toMatch(/alice|bob@/);
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain; a value without @ becomes ***", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("élodie@example.fr")).toBe("é***@example.fr");
    expect(maskEmail("@example.com")).toBe("***@example.com");
    expect(maskEmail("this account")).toBe("***");
    expect(maskEmail("")).toBe("***");
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

describe("availableMemoryMb", () => {
  // Real-looking macOS vm_stat output (Apple silicon, 16 KB pages: 64 pages = 1 MB).
  const sample = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                     8254.",
    "Pages active:                                 268942.",
    "Pages inactive:                               328168.",
    "Pages speculative:                              1910.",
    "Pages throttled:                                   0.",
    "Pages wired down:                             324023.",
    "Pages purgeable:                                 612.",
    '"Translation faults":                    17106268484.',
    "Pages copy-on-write:                       604271345.",
    "Pages zero filled:                        7050836470.",
    "Pages reactivated:                        5379542879.",
    "Pages purged:                              392143476.",
    "File-backed pages:                            178927.",
    "Anonymous pages:                              357513.",
    "Pages stored in compressor:                  1334778.",
    "Pages occupied by compressor:                 665134.",
    "Decompressions:                           6039347319.",
    "Compressions:                             6735996240.",
    "Pageins:                                   288630704.",
    "Pageouts:                                     904060.",
    "Swapins:                                    94126809.",
    "Swapouts:                                  106389400.",
    "",
  ].join("\n");

  it("sums free, inactive, speculative and purgeable pages at the reported page size", () => {
    // (8254 + 328168 + 1910 + 612) = 338944 pages; "Pages purged" is not "Pages purgeable".
    expect(availableMemoryMb(sample, 24576)).toBe(338944 / 64);
    // Intel Macs report 4 KB pages: 256 pages = 1 MB.
    expect(availableMemoryMb(sample.replace("page size of 16384 bytes", "page size of 4096 bytes"), 24576)).toBe(338944 / 256);
  });

  it("returns null when the text does not parse", () => {
    expect(availableMemoryMb("", 24576)).toBeNull();
    expect(availableMemoryMb("zsh: command not found: vm_stat", 24576)).toBeNull();
    expect(availableMemoryMb(sample.replace("page size of 16384 bytes", "page size unknown"), 24576)).toBeNull();
    expect(availableMemoryMb(sample.replace(/^Pages speculative:.*$/m, ""), 24576)).toBeNull();
  });

  it("clamps the result to [0, totalMb]", () => {
    expect(availableMemoryMb(sample, 4096)).toBe(4096);
    expect(availableMemoryMb(sample, 0)).toBe(0);
  });
});

describe("freePctFromMemoryPressure", () => {
  // Real-looking `/usr/bin/memory_pressure` output (no arguments: report only).
  const sample = [
    "The system has 25769803776 (1572864 pages with a page size of 16384).",
    "",
    "Stats: ",
    "Pages free: 12626 ",
    "Pages purgeable: 17878 ",
    "Pages purged: 399906192 ",
    "",
    "Swap I/O:",
    "Swapins: 94294909 ",
    "Swapouts: 106762528 ",
    "",
    "Page Q counts:",
    "Pages active: 327939 ",
    "Pages inactive: 325612 ",
    "Pages speculative: 645 ",
    "Pages throttled: 0 ",
    "Pages wired down: 294046 ",
    "",
    "Compressor Stats:",
    "Pages used by compressor: 570810 ",
    "Pages decompressed: 6086666627 ",
    "Pages compressed: 6785198606 ",
    "",
    "File I/O:",
    "Pageins: 289950751 ",
    "Pageouts: 907013 ",
    "",
    "System-wide memory free percentage: 37%",
    "",
  ].join("\n");

  it("reads the system-wide free percentage", () => {
    expect(freePctFromMemoryPressure(sample)).toBe(37);
    expect(freePctFromMemoryPressure(sample.replace("37%", "0%"))).toBe(0);
    expect(freePctFromMemoryPressure(sample.replace("37%", "100%"))).toBe(100);
  });

  it("returns null when the line is missing", () => {
    expect(freePctFromMemoryPressure("")).toBeNull();
    expect(freePctFromMemoryPressure(sample.replace(/^System-wide memory free percentage.*$/m, ""))).toBeNull();
  });

  it("returns null for an out-of-range value", () => {
    expect(freePctFromMemoryPressure(sample.replace("37%", "101%"))).toBeNull();
    expect(freePctFromMemoryPressure(sample.replace("37%", "-5%"))).toBeNull();
  });
});

describe("sampleMachine", () => {
  it("measures at most once per 15 s and always passes pressure and sessions through", async () => {
    expect(MACHINE_SAMPLE_MS).toBe(15_000);
    let calls = 0;
    const measure = () => ({ cpuPct: 10, memFreeMb: 1000 + ++calls, memTotalMb: 24576 });
    const t0 = 1_000_000_000_000;
    expect(await sampleMachine("normal", 1, t0, measure)).toEqual({ cpuPct: 10, memFreeMb: 1001, memTotalMb: 24576, pressure: "normal", sessions: 1 });
    expect(await sampleMachine("warn", 2, t0 + MACHINE_SAMPLE_MS - 1, measure)).toEqual({ cpuPct: 10, memFreeMb: 1001, memTotalMb: 24576, pressure: "warn", sessions: 2 });
    expect(calls).toBe(1);
    expect((await sampleMachine(null, 0, t0 + MACHINE_SAMPLE_MS, measure)).memFreeMb).toBe(1002);
    // A clock that moved back takes a new reading instead of trusting one from the future.
    expect((await sampleMachine(null, 0, t0, measure)).memFreeMb).toBe(1003);
    expect(calls).toBe(3);
  });

  it("awaits an async measurement", async () => {
    const t0 = 2_000_000_000_000;
    const measure = async () => ({ cpuPct: 20, memFreeMb: 2048, memTotalMb: 8192 });
    expect(await sampleMachine("normal", 3, t0, measure)).toEqual({ cpuPct: 20, memFreeMb: 2048, memTotalMb: 8192, pressure: "normal", sessions: 3 });
  });
});

// Built at runtime so no token-shaped literal sits in the repository.
const fake = {
  anthropic: "sk-ant-" + "api03-" + "Ab1".repeat(10),
  github: "ghp_" + "Zx9".repeat(12),
  slack: "xoxb-" + "1234-5678-" + "abcdEFGH".repeat(2),
  aws: "AKIA" + "Q7".repeat(8),
  keyHeader: "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
  hex: "0123456789abcdef".repeat(3),
  hex32: "0123456789abcdef".repeat(2),
  base64: "Qm9" + "aGVsbG8gd29ybGQK".repeat(3) + "==",
  openai: "sk-" + "proj-" + "Ab1Cd2".repeat(5),
  githubOauth: "gho_" + "Zx9".repeat(12),
  githubServer: "ghs_" + "Zx9".repeat(12),
  githubPat: "github_" + "pat_" + "11AB22CD_" + "Ef3".repeat(8),
  slackApp: "xoxa-" + "2-" + "1234abcd".repeat(2),
  google: "AI" + "za" + "Sy" + "Ab1_Cd2-".repeat(5),
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9" + "." + "ey" + "JzdWIiOiIxIn0" + "." + "Ab1Cd2Ef3Gh4".repeat(3),
  bearer: "Ab1Cd2Ef3Gh4Ij5Kl6",
};

describe("redactSecrets", () => {
  it("replaces keys, tokens and private-key headers", () => {
    expect(redactSecrets(`key ${fake.anthropic} end`)).toBe("key [redacted] end");
    expect(redactSecrets(`token=${fake.github}`)).toBe("token=[redacted]");
    expect(redactSecrets(`slack ${fake.slack}`)).toBe("slack [redacted]");
    expect(redactSecrets(`aws ${fake.aws}.`)).toBe("aws [redacted].");
    expect(redactSecrets(`${fake.keyHeader} body`)).toBe("[redacted] body");
  });

  it("replaces common key formats: sk-, GitHub, Slack, Google, JWT and Bearer tokens", () => {
    for (const key of [fake.openai, fake.githubOauth, fake.githubServer, fake.githubPat, fake.slackApp, fake.google, fake.jwt]) {
      expect(redactSecrets(`value ${key} end`)).toBe("value [redacted] end");
    }
    expect(redactSecrets(`Authorization: Bearer ${fake.bearer}`)).toBe("Authorization: Bearer [redacted]");
  });

  it("replaces password values in assignments and JSON and keeps the key", () => {
    expect(redactSecrets("mysql --password=hunter2 -u root")).toBe("mysql --password=[redacted] -u root");
    expect(redactSecrets('{"user": "ann", "password": "hunter 2"}')).toBe('{"user": "ann", "password": "[redacted]"}');
    expect(redactSecrets("PGPASSWORD='s3cret' psql")).toBe("PGPASSWORD='[redacted]' psql");
    expect(redactSecrets("export DB_PASSWD=abc123")).toBe("export DB_PASSWD=[redacted]");
    expect(redactSecrets("login pwd=abc user=ann")).toBe("login pwd=[redacted] user=ann");
    expect(redactSecrets('password: "abc"')).toBe('password: "[redacted]"');
  });

  it("replaces 32+ character hex runs, also after _ or 0x, and mixed base64 runs", () => {
    expect(redactSecrets(`key ${fake.hex32} end`)).toBe("key [redacted] end");
    expect(redactSecrets(`api_key_${fake.hex32}`)).toBe("api_key_[redacted]");
    expect(redactSecrets(`0x${fake.hex32}`)).toBe("[redacted]");
    expect(redactSecrets(`sha ${fake.hex}`)).toBe("sha [redacted]");
    expect(redactSecrets("a".repeat(40))).toBe("[redacted]"); // any 40+ hex run, even a dull one
    expect(redactSecrets(`blob ${fake.base64} tail`)).toBe("blob [redacted] tail");
  });

  it("leaves ordinary text, short ids, session ids and digit-free paths alone", () => {
    for (const ok of [
      "fix the login bug in src/auth/login.ts",
      "commit 3f2a9c1 and issue #12",
      "/Users/bilalsengul/Developer/REPOS/tools/claude-session-monitor",
      "x".repeat(60),
      "0123456789abcdef".repeat(1) + "0123456789abcde",
      "550e8400-e29b-41d4-a716-446655440000",
      "Rotate passwords: staging first",
      "the password reset flow",
      "run pwd then ls; cwd=/Users/x/repo",
      "Bearer token missing",
    ]) {
      expect(redactSecrets(ok)).toBe(ok);
    }
  });
});

describe("buildSnapshot redaction", () => {
  it("redacts the title, the last text and the closing text before they are uploaded", () => {
    const b = buildSnapshot({
      host: "mac",
      rows: [
        row({ title: `use ${fake.github} here`, aiTitle: true, notifMessage: `paste ${fake.anthropic}`, closing: { kind: "done", text: `done ${fake.aws}` } }),
      ],
      accounts,
      machine,
      now: 1,
    });
    expect(b.sessions[0].title).toBe("use [redacted] here");
    expect(b.sessions[0].lastText).toBe("paste [redacted]");
    expect(b.sessions[0].closing).toEqual({ kind: "done", text: "done [redacted]" });
    expect(JSON.stringify(b)).not.toContain(fake.github);
  });
});

describe("commandRefusal", () => {
  const now = 1_800_000_000_000;
  const every = ["resume", "kill", "resumeAll", "switchAccount", "send", "newSession", "autoResume", "answer"];
  it("answers every command when commands are off, before the type and expiry checks", () => {
    expect(commandRefusal({ type: "kill", createdAt: now }, now, false, every)).toBe("remote commands disabled on this Mac");
    expect(commandRefusal({ type: "send" }, now, false, [])).toBe("remote commands disabled on this Mac");
  });
  it("refuses a type missing from the allowlist or one the bridge does not run, before the expiry check", () => {
    expect(commandRefusal({ type: "send", createdAt: now }, now, true, ["resume", "kill"])).toBe("send is not allowed on this Mac");
    expect(commandRefusal({ type: "send", createdAt: now - 121_000 }, now, true, ["kill"])).toBe("send is not allowed on this Mac");
    expect(commandRefusal({ type: "kill", createdAt: now }, now, true, [])).toBe("kill is not allowed on this Mac");
    expect(commandRefusal({ type: "reboot", createdAt: now }, now, true, [...every, "reboot"])).toBe("reboot is not allowed on this Mac");
    for (const type of [undefined, "", 7]) {
      expect(commandRefusal({ type, createdAt: now }, now, true, every)).toBe("a command without a type is not allowed on this Mac");
    }
    for (const type of every) expect(commandRefusal({ type, createdAt: now }, now, true, every)).toBeNull();
  });
  it("lets an allowed command younger than 2 minutes run and expires an older or undated one", () => {
    expect(COMMAND_MAX_AGE_MS).toBe(120_000);
    const refusal = (createdAt: unknown) => commandRefusal({ type: "kill", createdAt }, now, true, ["kill"]);
    expect(refusal(now)).toBeNull();
    expect(refusal(now - 120_000)).toBeNull();
    expect(refusal(now - 120_001)).toBe("expired");
    for (const bad of [undefined, null, "1800000000000", Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(refusal(bad)).toBe("expired");
    }
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("passes a prompt answer through", async () => {
    expect(await withTimeout(Promise.resolve("done"), 50, "late")).toBe("done");
  });
  it("answers the fallback once the time is up", async () => {
    vi.useFakeTimers();
    expect(COMMAND_TIMEOUT_MS).toBe(60_000);
    const p = withTimeout(new Promise<string>(() => undefined), COMMAND_TIMEOUT_MS, "timed out");
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    expect(await p).toBe("timed out");
  });
  it("passes a rejection through", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, "late")).rejects.toThrow("boom");
  });
});

describe("readCappedBody", () => {
  const res = (body: string, contentLength: string | null) => {
    let read = false;
    return {
      headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? contentLength : null) },
      text: async () => {
        read = true;
        return body;
      },
      wasRead: () => read,
    };
  };
  it("returns a body within the cap", async () => {
    expect(MAX_RESPONSE_BYTES).toBe(256 * 1024);
    expect(MAX_COMMANDS_PER_POLL).toBe(20);
    expect(await readCappedBody(res('{"success":true}', "16"))).toBe('{"success":true}');
    expect(await readCappedBody(res("x".repeat(MAX_RESPONSE_BYTES), null))).toHaveLength(MAX_RESPONSE_BYTES);
  });
  it("refuses a declared length over 256 KB without reading the body", async () => {
    const r = res("{}", String(MAX_RESPONSE_BYTES + 1));
    await expect(readCappedBody(r)).rejects.toThrow("too large");
    expect(r.wasRead()).toBe(false);
  });
  it("refuses a body over 256 KB that did not declare it (bytes, not characters)", async () => {
    await expect(readCappedBody(res("x".repeat(MAX_RESPONSE_BYTES + 1), null))).rejects.toThrow("too large");
    await expect(readCappedBody(res("ş".repeat(MAX_RESPONSE_BYTES / 2 + 1), "garbage"))).rejects.toThrow("too large");
  });
});
