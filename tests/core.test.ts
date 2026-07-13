import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  classifyLimit,
  parseResetToEpoch,
  formatReset,
  humanizeAge,
  parseTranscriptTail,
  collectSessions,
  readGlobalEffort,
  countBuckets,
  scanTokenUsage,
  readLimits,
  readLimitsHistory,
  appendLimitsHistory,
  readOfficialSnapshot,
  writeOfficialSnapshot,
  type HookStatus,
  type RecentTranscript,
} from "../src/core";

// --- helpers ----------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-test-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const NOW = Math.floor(Date.parse("2026-06-17T12:00:00.000Z") / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function writeTranscript(name: string, lines: unknown[]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

// --- classifyLimit ----------------------------------------------------------

describe("classifyLimit", () => {
  it("detects a session limit and parses the reset clock", () => {
    const r = classifyLimit("You've hit your session limit · resets 1:50pm (Europe/Istanbul)", 429);
    expect(r?.kind).toBe("session");
    expect(r?.resetText).toBe("1:50pm");
  });
  it("detects a rate limit", () => {
    const r = classifyLimit("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited", 429);
    expect(r?.kind).toBe("rate");
  });
  it("returns null for non-limit API errors", () => {
    expect(classifyLimit("API Error: 529 Overloaded", 529)).toBeNull();
    expect(classifyLimit("API Error: 500 Internal server error", 500)).toBeNull();
    expect(classifyLimit("", 429)).toBeNull();
  });
});

// --- parseResetToEpoch / formatReset ---------------------------------------

describe("parseResetToEpoch", () => {
  it("parses 12h and 24h clocks to a future epoch within a day", () => {
    const t = parseResetToEpoch("1:50pm", NOW);
    expect(t).toBeDefined();
    const remain = (t as number) - NOW;
    expect(remain).toBeGreaterThan(0);
    expect(remain).toBeLessThanOrEqual(25 * 3600);
    // 24h form resolves to the same instant as the 12h pm form
    expect(parseResetToEpoch("13:50", NOW)).toBe(t);
  });
  it("rolls a passed time to the next day", () => {
    const t = parseResetToEpoch("1:50pm", NOW);
    const future = parseResetToEpoch("1:50pm", (t as number) + 600); // 10 min after it would have passed
    expect((future as number) - ((t as number) + 600)).toBeGreaterThan(23 * 3600);
  });
  it("returns undefined for garbage and out-of-range", () => {
    expect(parseResetToEpoch("nope", NOW)).toBeUndefined();
    expect(parseResetToEpoch("25:99", NOW)).toBeUndefined();
  });
});

describe("formatReset", () => {
  it("shows a left countdown and passes garbage through", () => {
    expect(formatReset("1:50pm", NOW)).toMatch(/left\)$/);
    expect(formatReset("garbage", NOW)).toBe("garbage");
  });
});

// --- humanizeAge ------------------------------------------------------------

describe("humanizeAge", () => {
  it("formats seconds/minutes/hours/days", () => {
    expect(humanizeAge(30)).toBe("30s");
    expect(humanizeAge(90)).toBe("1m");
    expect(humanizeAge(3700)).toBe("1h");
    expect(humanizeAge(90000)).toBe("1d");
    expect(humanizeAge(-5)).toBe("");
  });
});

// --- parseTranscriptTail ----------------------------------------------------

describe("parseTranscriptTail", () => {
  it("extracts title, entrypoint, cwd, and end_turn state (ignoring trailing meta)", () => {
    const p = writeTranscript("s1.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "first" }] }, timestamp: iso(NOW - 20) },
      { type: "assistant", message: { content: [{ type: "tool_use" }], stop_reason: "tool_use" }, timestamp: iso(NOW - 15) },
      { type: "user", message: { content: [{ type: "tool_result" }] }, timestamp: iso(NOW - 14) },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 10) },
      { type: "ai-title", aiTitle: "My Session Title" },
      { type: "last-prompt", lastPrompt: "go" },
      { type: "attachment", attachment: { type: "hook_success" }, timestamp: iso(NOW - 9) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.title).toBe("My Session Title");
    expect(tx.entrypoint).toBe("claude-vscode");
    expect(tx.cwd).toBe("/repo");
    expect(tx.convKind).toBe("end_turn");
    expect(tx.limit).toBeUndefined();
    expect(tx.activityTs).toBeGreaterThanOrEqual(tx.convTs);
  });

  it("classifies a 429 session limit but not a 529 error", () => {
    const limited = writeTranscript("lim.jsonl", [
      { type: "user", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "x" }] }, timestamp: iso(NOW - 30) },
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:50pm (Europe/Istanbul)" }] }, timestamp: iso(NOW - 10) },
    ]);
    const tx = parseTranscriptTail(limited);
    expect(tx.convKind).toBe("api_error");
    expect(tx.limit?.kind).toBe("session");
    expect(tx.limit?.resetText).toBe("1:50pm");

    const overloaded = writeTranscript("ov.jsonl", [
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 529, message: { content: [{ type: "text", text: "529 Overloaded" }] }, timestamp: iso(NOW - 10) },
    ]);
    const tx2 = parseTranscriptTail(overloaded);
    expect(tx2.convKind).toBe("api_error");
    expect(tx2.limit).toBeUndefined();
  });

  it("returns the cached object when the file is unchanged", () => {
    const p = writeTranscript("c.jsonl", [
      { type: "assistant", message: { content: [], stop_reason: "end_turn" }, timestamp: iso(NOW - 5) },
    ]);
    const a = parseTranscriptTail(p);
    const b = parseTranscriptTail(p, a);
    expect(b).toBe(a);
  });

  it("grows the window to find a conversational line hidden behind a huge last line", () => {
    const huge = "x".repeat(700 * 1024);
    const p = writeTranscript("huge.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "older" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 60) },
      { type: "user", message: { content: [{ type: "tool_result", content: huge }] }, timestamp: iso(NOW - 5) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.convKind).toBe("tool_result");
  });

  it("does not throw on a missing file", () => {
    const tx = parseTranscriptTail(path.join(tmp, "nope.jsonl"));
    expect(tx.convKind).toBe("none");
  });

  it("captures the model from the newest assistant line", () => {
    const p = writeTranscript("model.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "a" }], stop_reason: "end_turn", model: "claude-sonnet-5" }, timestamp: iso(NOW - 30) },
      { type: "user", message: { content: [{ type: "text", text: "next" }] }, timestamp: iso(NOW - 20) },
      { type: "assistant", message: { content: [{ type: "text", text: "b" }], stop_reason: "end_turn", model: "claude-opus-4-8" }, timestamp: iso(NOW - 10) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.model).toBe("claude-opus-4-8");
  });

  it("ignores a '<synthetic>' model (locally-injected line) and keeps the last real one", () => {
    const p = writeTranscript("synth.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "real" }], stop_reason: "end_turn", model: "claude-opus-4-8" }, timestamp: iso(NOW - 20) },
      { type: "assistant", message: { content: [{ type: "text", text: "API Error: Connection closed" }], stop_reason: "stop_sequence", model: "<synthetic>" }, timestamp: iso(NOW - 5) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.model).toBe("claude-opus-4-8");
  });
});

// --- collectSessions (bucket resolution) ------------------------------------

describe("collectSessions", () => {
  function run(hooks: HookStatus[], extra: RecentTranscript[]) {
    const map = new Map<string, HookStatus>();
    for (const h of hooks) map.set(h.session_id, h);
    return collectSessions({
      now: NOW,
      hookStatuses: map,
      extraTranscripts: extra,
      maxAgeSec: 24 * 3600,
      hideEndedOlderThanSec: 24 * 3600,
    });
  }

  it("resolves your-turn, waiting, limited, working and filters sdk/observer", () => {
    const yourTurn = writeTranscript("a.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 40) },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 30) },
    ]);
    const limited = writeTranscript("b.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 40) },
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:50pm (Europe/Istanbul)" }] }, timestamp: iso(NOW - 20) },
    ]);
    const working = writeTranscript("c.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 5) },
      { type: "assistant", message: { content: [{ type: "tool_use" }], stop_reason: "tool_use" }, timestamp: iso(NOW - 2) },
    ]);
    const subagent = writeTranscript("d.jsonl", [
      { type: "user", entrypoint: "sdk-py", cwd: "/repo", message: { content: [{ type: "text", text: "review" }] }, timestamp: iso(NOW - 5) },
    ]);
    const observer = writeTranscript("e.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/Users/x/.claude-mem/observer-sessions", message: { content: [{ type: "text", text: "observe" }] }, timestamp: iso(NOW - 5) },
    ]);

    const hooks: HookStatus[] = [
      { session_id: "a", state: "idle", ts: NOW - 29, cwd: "/repo", transcript_path: yourTurn },
      { session_id: "b", state: "working", ts: NOW - 41, cwd: "/repo", transcript_path: limited }, // hook older than the limit line
      { session_id: "c", state: "working", ts: NOW - 5, cwd: "/repo", transcript_path: working },
      { session_id: "w", state: "waiting", ts: NOW - 1, cwd: "/repo", transcript_path: yourTurn, message: "needs permission" },
      { session_id: "d", state: "working", ts: NOW - 5, cwd: "/repo", transcript_path: subagent },
      { session_id: "e", state: "working", ts: NOW - 5, cwd: "/Users/x/.claude-mem/observer-sessions", transcript_path: observer },
    ];
    const views = run(hooks, []);
    const by = (id: string) => views.find((v) => v.sessionId === id);

    expect(by("a")?.bucket).toBe("attention");
    expect(by("a")?.sub).toBe("your turn");

    expect(by("b")?.bucket).toBe("limited");
    expect(by("b")?.sub).toBe("session limit");
    expect(by("b")?.resetText).toBe("1:50pm");

    expect(by("c")?.bucket).toBe("working");

    expect(by("w")?.bucket).toBe("attention");
    expect(by("w")?.sub).toBe("waiting for you");

    // sdk-py subagent and observer-sessions are filtered out
    expect(by("d")).toBeUndefined();
    expect(by("e")).toBeUndefined();
  });

  it("includes transcript-only sessions discovered via extraTranscripts", () => {
    const p = writeTranscript("f.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 8) },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 6) },
      { type: "ai-title", aiTitle: "Discovered" },
    ]);
    const st = fs.statSync(p);
    const views = run([], [{ sessionId: "f", path: p, mtimeMs: st.mtimeMs }]);
    expect(views.find((v) => v.sessionId === "f")?.title).toBe("Discovered");
  });
});

describe("readGlobalEffort / effort + model surfacing", () => {
  it("reads effortLevel from a settings.json, tolerating missing/broken files", () => {
    const good = path.join(tmp, "settings.json");
    fs.writeFileSync(good, JSON.stringify({ effortLevel: "xhigh", other: 1 }));
    expect(readGlobalEffort(good)).toBe("xhigh");

    const empty = path.join(tmp, "settings-empty.json");
    fs.writeFileSync(empty, JSON.stringify({ theme: "dark" }));
    expect(readGlobalEffort(empty)).toBeUndefined();

    fs.writeFileSync(good, "{ not json");
    expect(readGlobalEffort(good)).toBeUndefined();
    expect(readGlobalEffort(path.join(tmp, "nope.json"))).toBeUndefined();
  });

  it("surfaces the transcript model and the injected global effort onto the view", () => {
    const p = writeTranscript("me.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 20) },
      { type: "assistant", message: { content: [{ type: "text", text: "a" }], stop_reason: "end_turn", model: "claude-opus-4-8" }, timestamp: iso(NOW - 10) },
    ]);
    const map = new Map<string, HookStatus>([
      ["m", { session_id: "m", state: "idle", ts: NOW - 9, cwd: "/repo", transcript_path: p }],
    ]);
    const views = collectSessions({ now: NOW, hookStatuses: map, extraTranscripts: [], maxAgeSec: 24 * 3600, globalEffort: "high" });
    const v = views.find((x) => x.sessionId === "m");
    expect(v?.model).toBe("claude-opus-4-8");
    expect(v?.effort).toBe("high");
    expect(v?.tooltip).toContain("model: claude-opus-4-8");
    expect(v?.tooltip).toContain("effort: high");
  });
});

describe("countBuckets", () => {
  it("counts by bucket", () => {
    const c = countBuckets([
      { bucket: "working" } as any,
      { bucket: "working" } as any,
      { bucket: "limited" } as any,
    ]);
    expect(c.working).toBe(2);
    expect(c.limited).toBe(1);
    expect(c.attention).toBe(0);
  });
});

// --- scanTokenUsage ---------------------------------------------------------

describe("scanTokenUsage", () => {
  function usageLine(sec: number, input: number, output: number, cacheWrite = 0, cacheRead = 0) {
    return {
      type: "assistant",
      message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead } },
      timestamp: iso(sec),
    };
  }

  it("sums 5h/7d windows excluding cache-read, and buckets hourly", () => {
    const p = writeTranscript("t.jsonl", [
      usageLine(NOW - 3600, 1000, 500, 200, 99999), // within 5h -> 1700 (cache_read ignored)
      usageLine(NOW - 3 * 86400, 2000, 1000, 0, 0), // within 7d, outside 5h -> 3000
    ]);
    const offsetsFile = path.join(tmp, "off.json");
    const bucketsFile = path.join(tmp, "buck.json");
    const u = scanTokenUsage([{ path: p }], NOW, { offsetsFile, bucketsFile });
    expect(u.fiveHour).toBe(1700);
    expect(u.sevenDay).toBe(1700 + 3000);
    expect(u.hourly.length).toBe(48);
  });

  it("is incremental: appended lines are counted once, not double", () => {
    const p = writeTranscript("t2.jsonl", [usageLine(NOW - 1800, 1000, 0)]);
    const offsetsFile = path.join(tmp, "off2.json");
    const bucketsFile = path.join(tmp, "buck2.json");
    const u1 = scanTokenUsage([{ path: p }], NOW, { offsetsFile, bucketsFile });
    expect(u1.fiveHour).toBe(1000);
    // append a new line and re-scan with the same state files
    fs.appendFileSync(p, JSON.stringify(usageLine(NOW - 600, 500, 0)) + "\n");
    const u2 = scanTokenUsage([{ path: p }], NOW, { offsetsFile, bucketsFile });
    expect(u2.fiveHour).toBe(1500); // 1000 + 500, old line not recounted
  });

  it("tolerates corrupt/empty state files without throwing", () => {
    const p = writeTranscript("t3.jsonl", [usageLine(NOW - 1800, 1000, 0)]);
    const offsetsFile = path.join(tmp, "off3.json");
    const bucketsFile = path.join(tmp, "buck3.json");
    fs.writeFileSync(offsetsFile, "null"); // literal null
    fs.writeFileSync(bucketsFile, "not json {{{");
    const u = scanTokenUsage([{ path: p }], NOW, { offsetsFile, bucketsFile });
    expect(u.fiveHour).toBe(1000);
  });

  it("keeps a byte-accurate offset across multi-byte UTF-8 content", () => {
    const turkish = "çalışıyor ğüşıöç ".repeat(5);
    const p = writeTranscript("t4.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: turkish }], usage: { input_tokens: 1000, output_tokens: 0 } }, timestamp: iso(NOW - 1800) },
    ]);
    const offsetsFile = path.join(tmp, "off4.json");
    const bucketsFile = path.join(tmp, "buck4.json");
    expect(scanTokenUsage([{ path: p }], NOW, { offsetsFile, bucketsFile }).fiveHour).toBe(1000);
    fs.appendFileSync(
      p,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: turkish }], usage: { input_tokens: 500, output_tokens: 0 } }, timestamp: iso(NOW - 600) }) + "\n",
    );
    // Correct byte offset -> only the new 500 is added (a char-based offset would drift and mis-count).
    expect(scanTokenUsage([{ path: p }], NOW, { offsetsFile, bucketsFile }).fiveHour).toBe(1500);
  });
});

// --- readLimits / readLimitsHistory -----------------------------------------

describe("readLimits", () => {
  it("reads a limits snapshot and tolerates a missing file", () => {
    const f = path.join(tmp, "limits.json");
    fs.writeFileSync(f, JSON.stringify({ fh: 0.07, sd: 0.25, ts: NOW }));
    expect(readLimits(f)?.fh).toBe(0.07);
    expect(readLimits(path.join(tmp, "missing.json"))).toBeUndefined();
  });
  it("reads a bounded history tail", () => {
    const f = path.join(tmp, "hist.jsonl");
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: NOW - i * 60, fh: i }));
    fs.writeFileSync(f, lines.join("\n") + "\n");
    expect(readLimitsHistory(5, f).length).toBe(5);
    expect(readLimitsHistory(240, path.join(tmp, "none.jsonl")).length).toBe(0);
  });
});

describe("hardening edge cases", () => {
  const toMap = (hooks: HookStatus[]) => {
    const m = new Map<string, HookStatus>();
    for (const h of hooks) m.set(h.session_id, h);
    return m;
  };
  const collect = (hooks: HookStatus[], extra: RecentTranscript[] = []) =>
    collectSessions({
      now: NOW,
      hookStatuses: toMap(hooks),
      extraTranscripts: extra,
      maxAgeSec: 24 * 3600,
      hideEndedOlderThanSec: 24 * 3600,
    });

  it("parseTranscriptTail keeps the limit when a same-second non-error line follows a 429", () => {
    const p = writeTranscript("tie.jsonl", [
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:50pm (Europe/Istanbul)" }] }, timestamp: iso(NOW - 10) },
      { type: "user", message: { content: [{ type: "text", text: "resume" }] }, timestamp: iso(NOW - 10) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.convKind).toBe("api_error");
    expect(tx.limit?.kind).toBe("session");
  });

  it("collectSessions: resumed-after-limit is working; non-429 api error is attention", () => {
    const resumed = writeTranscript("r.jsonl", [
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:50pm (Europe/Istanbul)" }] }, timestamp: iso(NOW - 60) },
      { type: "user", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "resume" }] }, timestamp: iso(NOW - 5) },
      { type: "assistant", message: { content: [{ type: "tool_use" }], stop_reason: "tool_use" }, timestamp: iso(NOW - 2) },
    ]);
    const apiErr = writeTranscript("ae.jsonl", [
      { type: "user", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 30) },
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 529, message: { content: [{ type: "text", text: "529 Overloaded" }] }, timestamp: iso(NOW - 10) },
    ]);
    const views = collect([
      { session_id: "r", state: "working", ts: NOW - 2, cwd: "/repo", transcript_path: resumed },
      { session_id: "ae", state: "working", ts: NOW - 31, cwd: "/repo", transcript_path: apiErr },
    ]);
    expect(views.find((v) => v.sessionId === "r")?.bucket).toBe("working");
    const ae = views.find((v) => v.sessionId === "ae");
    expect(ae?.bucket).toBe("attention");
    expect(ae?.sub).toBe("API error");
  });

  it("collectSessions: title falls back to last-prompt when no ai-title", () => {
    const p = writeTranscript("nt.jsonl", [
      { type: "user", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "hi" }] }, timestamp: iso(NOW - 5) },
      { type: "last-prompt", lastPrompt: "do the thing" },
    ]);
    const views = collect([{ session_id: "nt", state: "idle", ts: NOW - 4, cwd: "/repo", transcript_path: p }]);
    expect(views.find((v) => v.sessionId === "nt")?.title).toBe("do the thing");
  });

  it("scanTokenUsage keeps the first line when backfill lands on a boundary (vs mid-line)", () => {
    const usage = (sec: number, inp: number) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: inp, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, timestamp: iso(sec) });
    const filler = JSON.stringify({ type: "system", x: "f", timestamp: iso(NOW - 3600) });
    const l1 = usage(NOW - 1800, 1000);
    const l2 = usage(NOW - 600, 2000);
    const content = filler + "\n" + l1 + "\n" + l2 + "\n";
    const p = path.join(tmp, "bound.jsonl");
    fs.writeFileSync(p, content);
    const size = Buffer.byteLength(content, "utf8");
    const boundaryStart = Buffer.byteLength(filler + "\n", "utf8");
    const onBoundary = scanTokenUsage([{ path: p }], NOW, {
      offsetsFile: path.join(tmp, "o1.json"),
      bucketsFile: path.join(tmp, "b1.json"),
      backfillCap: size - boundaryStart,
    });
    expect(onBoundary.fiveHour).toBe(3000); // l1 kept (boundary) + l2
    const midLine = scanTokenUsage([{ path: p }], NOW, {
      offsetsFile: path.join(tmp, "o2.json"),
      bucketsFile: path.join(tmp, "b2.json"),
      backfillCap: size - (boundaryStart + 10),
    });
    expect(midLine.fiveHour).toBe(2000); // l1 partial dropped, only l2
  });
});

describe("resolve / collectSessions branch coverage", () => {
  const toMap = (hooks: HookStatus[]) => {
    const m = new Map<string, HookStatus>();
    for (const h of hooks) m.set(h.session_id, h);
    return m;
  };
  const collect = (hooks: HookStatus[], opts: Partial<Parameters<typeof collectSessions>[0]> = {}) =>
    collectSessions({ now: NOW, hookStatuses: toMap(hooks), extraTranscripts: [], maxAgeSec: 24 * 3600, hideEndedOlderThanSec: 24 * 3600, ...opts });
  const backdated = (name: string, lines: unknown[], sec: number) => {
    const p = writeTranscript(name, lines);
    fs.utimesSync(p, sec, sec);
    return p;
  };

  it("marks a long-silent working session as stalled", () => {
    const p = backdated("st.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", message: { content: [{ type: "tool_use" }], stop_reason: "tool_use" }, timestamp: iso(NOW - 300) },
    ], NOW - 300);
    const v = collect([{ session_id: "st", state: "working", ts: NOW - 300, cwd: "/repo", transcript_path: p }]).find((x) => x.sessionId === "st");
    expect(v?.bucket).toBe("working");
    expect(v?.stale).toBe(true);
    expect(v?.sub).toBe("working (stalled?)");
  });

  it("hides ended sessions by default, shows them only with showEnded, and respects the cutoff", () => {
    const fresh = writeTranscript("enf.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "bye" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 5) },
    ]);
    const hook = [{ session_id: "enf", state: "ended", ts: NOW - 5, cwd: "/repo", transcript_path: fresh }];
    expect(collect(hook).find((x) => x.sessionId === "enf")).toBeUndefined(); // default: hidden
    expect(collect(hook, { showEnded: true }).find((x) => x.sessionId === "enf")?.bucket).toBe("ended"); // shown
    const old = backdated("eno.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "bye" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 3600) },
    ], NOW - 3600);
    expect(
      collect([{ session_id: "eno", state: "ended", ts: NOW - 3600, cwd: "/repo", transcript_path: old }], { showEnded: true, hideEndedOlderThanSec: 60 }).find((x) => x.sessionId === "eno"),
    ).toBeUndefined(); // showEnded but past cutoff
  });

  it("derives working from assistant-without-stop-reason and from a trailing user prompt", () => {
    const ao = writeTranscript("ao.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "thinking" }] }, timestamp: iso(NOW - 3) },
    ]);
    const ut = writeTranscript("ut.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 10) },
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "next" }] }, timestamp: iso(NOW - 2) },
    ]);
    const views = collect([
      { session_id: "ao", state: "unknownstate", ts: 0, cwd: "/repo", transcript_path: ao },
      { session_id: "ut", state: "unknownstate", ts: 0, cwd: "/repo", transcript_path: ut },
    ]);
    expect(views.find((x) => x.sessionId === "ao")?.bucket).toBe("working");
    expect(views.find((x) => x.sessionId === "ut")?.bucket).toBe("working");
  });

  it("applies workspaceCwd and allowedEntrypoints=[] (allow all)", () => {
    const repo = writeTranscript("wc1.jsonl", [{ type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 3) }]);
    const other = writeTranscript("wc2.jsonl", [{ type: "user", entrypoint: "claude-vscode", cwd: "/other", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 3) }]);
    const sdk = writeTranscript("wc3.jsonl", [{ type: "user", entrypoint: "sdk-py", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 3) }]);
    const ws = collect(
      [
        { session_id: "wc1", state: "working", ts: NOW - 3, cwd: "/repo", transcript_path: repo },
        { session_id: "wc2", state: "working", ts: NOW - 3, cwd: "/other", transcript_path: other },
      ],
      { workspaceCwd: "/repo" },
    );
    expect(ws.find((x) => x.sessionId === "wc1")).toBeDefined();
    expect(ws.find((x) => x.sessionId === "wc2")).toBeUndefined();
    const all = collect([{ session_id: "wc3", state: "working", ts: NOW - 3, cwd: "/repo", transcript_path: sdk }], { allowedEntrypoints: [] });
    expect(all.find((x) => x.sessionId === "wc3")).toBeDefined();
  });

  it("excludes a session with no recent activity (maxAge)", () => {
    const old = backdated("max.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 7200) },
    ], NOW - 7200);
    expect(collect([{ session_id: "mx", state: "idle", ts: NOW - 7200, cwd: "/repo", transcript_path: old }], { maxAgeSec: 3600 }).find((x) => x.sessionId === "mx")).toBeUndefined();
  });
});

describe("classifyConvLine / extractText / parseResetToEpoch extras", () => {
  it("reads api-error text from a string content body", () => {
    const p = writeTranscript("strc.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", isApiErrorMessage: true, apiErrorStatus: 429, message: { content: "You've hit your session limit · resets 9:05am (Europe/Istanbul)" }, timestamp: iso(NOW - 5) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.limit?.kind).toBe("session");
    expect(tx.limit?.resetText).toBe("9:05am");
  });
  it("distinguishes 12pm (noon) from 12am (midnight)", () => {
    const noon = parseResetToEpoch("12:00pm", NOW);
    const mid = parseResetToEpoch("12:00am", NOW);
    expect(noon).toBeDefined();
    expect(mid).toBeDefined();
    expect(noon).not.toBe(mid);
  });
});

describe("scanTokenUsage edges", () => {
  const usage = (sec: number, inp: number) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: inp, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, timestamp: iso(sec) });

  it("waits for a complete final line (no trailing newline) then counts it", () => {
    const p = path.join(tmp, "nonl.jsonl");
    fs.writeFileSync(p, usage(NOW - 600, 700)); // no trailing newline
    const off = path.join(tmp, "o.json");
    const buck = path.join(tmp, "b.json");
    expect(scanTokenUsage([{ path: p }], NOW, { offsetsFile: off, bucketsFile: buck }).fiveHour).toBe(0);
    fs.appendFileSync(p, "\n");
    expect(scanTokenUsage([{ path: p }], NOW, { offsetsFile: off, bucketsFile: buck }).fiveHour).toBe(700);
  });

  it("re-backfills after the file is truncated/rotated", () => {
    const p = path.join(tmp, "rot.jsonl");
    fs.writeFileSync(p, usage(NOW - 600, 1000) + "\n" + usage(NOW - 500, 2000) + "\n");
    const off = path.join(tmp, "or.json");
    const buck = path.join(tmp, "br.json");
    expect(scanTokenUsage([{ path: p }], NOW, { offsetsFile: off, bucketsFile: buck }).fiveHour).toBe(3000);
    fs.writeFileSync(p, usage(NOW - 100, 500) + "\n"); // truncate/rotate
    expect(scanTokenUsage([{ path: p }], NOW, { offsetsFile: off, bucketsFile: buck }).fiveHour).toBe(3500);
  });
});

describe("more branch coverage", () => {
  it("classifyLimit: session limit with no reset clock has undefined resetText", () => {
    const r = classifyLimit("You've hit your session limit", 429);
    expect(r?.kind).toBe("session");
    expect(r?.resetText).toBeUndefined();
  });

  it("parseTranscriptTail: a 429 with non-limit text is api_error with no limit", () => {
    const p = writeTranscript("n429.jsonl", [
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { content: [{ type: "text", text: "429 too many requests, retry" }] }, timestamp: iso(NOW - 5) },
    ]);
    const tx = parseTranscriptTail(p);
    expect(tx.convKind).toBe("api_error");
    expect(tx.limit).toBeUndefined();
  });

  it("parseTranscriptTail: tool_use detected via a content block without stop_reason", () => {
    const p = writeTranscript("tub.jsonl", [
      { type: "assistant", entrypoint: "claude-vscode", message: { content: [{ type: "tool_use", name: "Read" }] }, timestamp: iso(NOW - 3) },
    ]);
    expect(parseTranscriptTail(p).convKind).toBe("tool_use");
  });

  it("rate-limit sub, no-cwd, permission_mode/message tooltip, unknown entrypoint, dedup", () => {
    const rate = writeTranscript("rate.jsonl", [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "q" }] }, timestamp: iso(NOW - 30) },
      { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { content: [{ type: "text", text: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited" }] }, timestamp: iso(NOW - 10) },
    ]);
    const noCwd = writeTranscript("nocwd.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, timestamp: iso(NOW - 3) },
    ]);
    const st = fs.statSync(rate);
    const hooks = new Map<string, HookStatus>();
    hooks.set("rate", { session_id: "rate", state: "working", ts: NOW - 31, cwd: "/repo", transcript_path: rate });
    hooks.set("nc", { session_id: "nc", state: "waiting", ts: NOW - 1, transcript_path: noCwd, permission_mode: "bypassPermissions", message: "needs permission to use Bash" });
    const views = collectSessions({
      now: NOW,
      hookStatuses: hooks,
      extraTranscripts: [{ sessionId: "rate", path: rate, mtimeMs: st.mtimeMs }],
      maxAgeSec: 24 * 3600,
      hideEndedOlderThanSec: 24 * 3600,
    });
    const rl = views.find((v) => v.sessionId === "rate");
    expect(rl?.bucket).toBe("limited");
    expect(rl?.sub).toBe("rate limited");
    const nc = views.find((v) => v.sessionId === "nc");
    expect(nc?.bucket).toBe("attention");
    expect(nc?.sub).toBe("waiting for you");
    expect(nc?.cwdLabel).toBeUndefined();
    expect(nc?.tooltip).toContain("mode: bypassPermissions");
    expect(nc?.tooltip).toContain("notification: needs permission");
  });

  it("readLimits rejects an array; tokensOfLine handles missing fields; scan skips invalid ts", () => {
    const f = path.join(tmp, "arr.json");
    fs.writeFileSync(f, JSON.stringify([1, 2, 3]));
    expect(readLimits(f)).toBeUndefined();
    const p = writeTranscript("part.jsonl", [
      { type: "assistant", message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: 800 } }, timestamp: iso(NOW - 600) },
      { type: "assistant", message: { content: [{ type: "text", text: "y" }], usage: { input_tokens: 100 } }, timestamp: "not-a-date" },
    ]);
    const u = scanTokenUsage([{ path: p }], NOW, { offsetsFile: path.join(tmp, "po.json"), bucketsFile: path.join(tmp, "pb.json") });
    expect(u.fiveHour).toBe(800);
  });
});

describe("defensive branch coverage", () => {
  it("handles an empty transcript and an assistant line with no message", () => {
    const empty = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(empty, "");
    expect(parseTranscriptTail(empty).convKind).toBe("none");
    const noMsg = writeTranscript("nomsg.jsonl", [{ type: "assistant", timestamp: iso(NOW - 3) }]);
    expect(parseTranscriptTail(noMsg).convKind).toBe("assistant_other");
  });

  it("respects the per-call byte budget across files (deferring later files)", () => {
    const usage = (sec: number, inp: number) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: inp, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, timestamp: iso(sec) });
    const f1 = path.join(tmp, "f1.jsonl");
    const f2 = path.join(tmp, "f2.jsonl");
    fs.writeFileSync(f1, usage(NOW - 600, 1000) + "\n");
    fs.writeFileSync(f2, usage(NOW - 500, 2000) + "\n");
    const off = path.join(tmp, "bo.json");
    const buck = path.join(tmp, "bb.json");
    const size1 = fs.statSync(f1).size;
    const u1 = scanTokenUsage([{ path: f1 }, { path: f2 }], NOW, { offsetsFile: off, bucketsFile: buck, maxBytesPerCall: size1 });
    expect(u1.fiveHour).toBe(1000); // f2 deferred this call
    const u2 = scanTokenUsage([{ path: f1 }, { path: f2 }], NOW, { offsetsFile: off, bucketsFile: buck, maxBytesPerCall: size1 });
    expect(u2.fiveHour).toBe(3000); // f2 picked up next call
  });
});

describe("appendLimitsHistory", () => {
  it("appends a point and throttles a second write within the gap", () => {
    const file = path.join(tmp, "hist.jsonl");
    const t0 = 1_780_000_000;
    appendLimitsHistory({ src: "ext", fh: 4, sd: 1, ts: t0 }, file, 55);
    appendLimitsHistory({ src: "ext", fh: 5, sd: 1, ts: t0 + 10 }, file, 55);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).fh).toBe(4);
  });
  it("writes again after the gap has passed", () => {
    const file = path.join(tmp, "hist2.jsonl");
    appendLimitsHistory({ src: "ext", fh: 4, ts: 1_780_000_000 }, file, 0);
    appendLimitsHistory({ src: "ext", fh: 6, ts: 1_780_000_100 }, file, 0);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("scanTokenUsage offset pruning", () => {
  it("drops offsets for transcripts far outside the scan set", () => {
    const offsetsFile = path.join(tmp, "offsets.json");
    const bucketsFile = path.join(tmp, "buckets.json");
    const stale: Record<string, { offset: number; size: number }> = {};
    for (let i = 0; i < 150; i++) stale[`/gone/tx-${i}.jsonl`] = { offset: 100, size: 100 };
    fs.writeFileSync(offsetsFile, JSON.stringify(stale));
    scanTokenUsage([], 1_780_000_000, { offsetsFile, bucketsFile });
    const after = JSON.parse(fs.readFileSync(offsetsFile, "utf8"));
    expect(Object.keys(after).length).toBe(0);
  });
  it("keeps offsets when the map is small (below the prune threshold)", () => {
    const offsetsFile = path.join(tmp, "offsets2.json");
    const bucketsFile = path.join(tmp, "buckets2.json");
    fs.writeFileSync(offsetsFile, JSON.stringify({ "/gone/a.jsonl": { offset: 1, size: 1 } }));
    scanTokenUsage([], 1_780_000_000, { offsetsFile, bucketsFile });
    const after = JSON.parse(fs.readFileSync(offsetsFile, "utf8"));
    expect(Object.keys(after).length).toBe(1);
  });
});

describe("scanTokenUsage v2 breakdowns", () => {
  function modelLine(sec: number, input: number, model: string) {
    return {
      type: "assistant",
      message: { content: [{ type: "text", text: "x" }], model, usage: { input_tokens: input, output_tokens: 0 } },
      timestamp: iso(sec),
    };
  }

  it("tracks per-session and per-model buckets", () => {
    const p1 = writeTranscript("sess-a.jsonl", [modelLine(NOW - 1800, 1000, "claude-fable-5")]);
    const p2 = writeTranscript("sess-b.jsonl", [modelLine(NOW - 1800, 300, "claude-haiku-4-5-20251001")]);
    const offsetsFile = path.join(tmp, "o.json");
    const bucketsFile = path.join(tmp, "b.json");
    const u = scanTokenUsage([{ path: p1 }, { path: p2 }], NOW, { offsetsFile, bucketsFile });
    expect(u.bySession5h["sess-a"]).toBe(1000);
    expect(u.bySession5h["sess-b"]).toBe(300);
    expect(u.byModel7d["claude-fable-5"].tokens).toBe(1000);
    expect(u.byModel7d["claude-haiku-4-5-20251001"].inTok).toBe(300);
  });

  it("migrates a v1 buckets file (plain hour map) without losing totals", () => {
    const offsetsFile = path.join(tmp, "o2.json");
    const bucketsFile = path.join(tmp, "b2.json");
    const hour = Math.floor((NOW - 3600) / 3600);
    fs.writeFileSync(bucketsFile, JSON.stringify({ [hour]: 5000 }));
    const u = scanTokenUsage([], NOW, { offsetsFile, bucketsFile });
    expect(u.fiveHour).toBe(5000);
    const after = JSON.parse(fs.readFileSync(bucketsFile, "utf8"));
    expect(after.v).toBe(2);
    expect(after.global[String(hour)]).toBe(5000);
  });
});

describe("official usage snapshot", () => {
  it("round-trips and rejects garbage", () => {
    const file = path.join(tmp, "snap.json");
    const snap = {
      gauges: [{ key: "session", label: "Session (5h)", pct: 42, resetMs: 1780000000000 }],
      ts: 1_780_000_000,
      backoffUntil: 1_780_000_300,
      backoffSec: 120,
    };
    writeOfficialSnapshot(snap, file);
    const back = readOfficialSnapshot(file)!;
    expect(back.gauges[0].pct).toBe(42);
    expect(back.backoffSec).toBe(120);
    fs.writeFileSync(file, "not json");
    expect(readOfficialSnapshot(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ ts: "x", gauges: {} }));
    expect(readOfficialSnapshot(file)).toBeUndefined();
  });
});
