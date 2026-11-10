import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BurnTracker } from "../src/burnTracker";

// --- helpers ----------------------------------------------------------------

let tmp: string;
let slugDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-burn-"));
  slugDir = path.join(tmp, "-work-repo");
  fs.mkdirSync(slugDir);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HOUR = 3_600_000;

/** An assistant line whose 50K Opus 5.5 output tokens cost exactly $1. */
function usageLine(key: string, ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    requestId: key,
    cwd: "/work/repo",
    sessionId: "id-written-in-the-line",
    message: {
      id: `msg_${key}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50_000 },
    },
    ...extra,
  });
}

const aiTitle = (title: string): string => JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "x" });
const customTitle = (title: string): string => JSON.stringify({ type: "custom-title", customTitle: title, sessionId: "x" });
const lines = (...ls: string[]): string => ls.map((l) => `${l}\n`).join("");
const mainFile = (sid: string): string => path.join(slugDir, `${sid}.jsonl`);

function subFile(sid: string, agent: string): string {
  const dir = path.join(slugDir, sid, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `agent-${agent}.jsonl`);
}

const setMtime = (file: string, ms: number): void => fs.utimesSync(file, new Date(ms), new Date(ms));
const keys = (t: BurnTracker): string[] => [...t.records()].map((r) => r.key).sort();
const recordOf = (t: BurnTracker, key: string) => [...t.records()].find((r) => r.key === key);

// --- tracker ----------------------------------------------------------------

describe("BurnTracker", () => {
  it("reads appended lines on each refresh and dedupes repeated request lines", async () => {
    const now = Date.now();
    const file = mainFile("s1");
    fs.writeFileSync(file, lines(usageLine("k1", now - 60_000)));
    const tracker = new BurnTracker({ projectsDir: tmp });
    expect(await tracker.refresh()).toBe(true);
    expect(keys(tracker)).toEqual(["k1"]);
    fs.appendFileSync(file, lines(usageLine("k2", now - 30_000), usageLine("k2", now - 30_000)));
    expect(await tracker.refresh()).toBe(true);
    expect(await tracker.refresh()).toBe(false);
    const s = tracker.summary(HOUR);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ sessionId: "s1", requests: 2 });
    expect(s.totalCost).toBeCloseTo(2, 12);
  });

  it("leaves a trailing partial line for the next refresh", async () => {
    const now = Date.now();
    const file = mainFile("s1");
    const second = usageLine("k2", now - 1000);
    fs.writeFileSync(file, lines(usageLine("k1", now - 2000)) + second.slice(0, 40));
    const tracker = new BurnTracker({ projectsDir: tmp });
    await tracker.refresh();
    expect(keys(tracker)).toEqual(["k1"]);
    fs.appendFileSync(file, `${second.slice(40)}\n`);
    expect(await tracker.refresh()).toBe(true);
    expect(keys(tracker)).toEqual(["k1", "k2"]);
  });

  it("restarts a transcript that shrank from the beginning", async () => {
    const now = Date.now();
    const file = mainFile("s1");
    const pad = { pad: "p".repeat(4000) };
    fs.writeFileSync(file, lines(usageLine("k1", now - 3000, pad), usageLine("k2", now - 2000, pad)));
    const tracker = new BurnTracker({ projectsDir: tmp });
    await tracker.refresh();
    fs.writeFileSync(file, lines(usageLine("k3", now - 1000)));
    expect(await tracker.refresh()).toBe(true);
    expect(keys(tracker)).toEqual(["k1", "k2", "k3"]);
  });

  it("reads a line longer than one 4 MB read chunk", async () => {
    const now = Date.now();
    const big = usageLine("big", now - 2000, { pad: "x".repeat(5 * 1024 * 1024) });
    fs.writeFileSync(mainFile("s1"), lines(big, usageLine("k2", now - 1000)));
    const tracker = new BurnTracker({ projectsDir: tmp });
    await tracker.refresh();
    expect(keys(tracker)).toEqual(["big", "k2"]);
  });

  it("credits subagent transcripts to the parent session by path, even when spawned after the walk", async () => {
    const now = Date.now();
    fs.writeFileSync(mainFile("s1"), lines(usageLine("k1", now - 2000)));
    const tracker = new BurnTracker({ projectsDir: tmp });
    await tracker.refresh();
    fs.writeFileSync(subFile("s1", "a1"), lines(usageLine("sub1", now - 1000, { cwd: "/elsewhere" })));
    expect(await tracker.refresh()).toBe(true);
    expect(recordOf(tracker, "sub1")).toMatchObject({ sessionId: "s1", sub: true });
    expect(recordOf(tracker, "k1")).toMatchObject({ sessionId: "s1", sub: false });
    expect(tracker.cwdOf("s1")).toBe("/work/repo");
    expect(tracker.summary(HOUR).sessions[0].subShare).toBeCloseTo(0.5, 12);
  });

  it("finds a new session only on the next full walk, at most once a minute", async () => {
    let clock = Date.now();
    fs.writeFileSync(mainFile("s1"), lines(usageLine("k1", clock - 2000)));
    const tracker = new BurnTracker({ projectsDir: tmp, now: () => clock });
    await tracker.refresh();
    fs.writeFileSync(mainFile("s2"), lines(usageLine("k2", clock - 1000)));
    clock += 30_000;
    expect(await tracker.refresh()).toBe(false);
    expect(keys(tracker)).toEqual(["k1"]);
    clock += 30_000;
    expect(await tracker.refresh()).toBe(true);
    expect(keys(tracker)).toEqual(["k1", "k2"]);
  });

  it("captures titles: custom over ai, latest wins, subagent titles ignored", async () => {
    const now = Date.now();
    fs.writeFileSync(mainFile("s1"), lines(aiTitle("First"), customTitle("Mine"), aiTitle("Second"), usageLine("k1", now)));
    fs.writeFileSync(mainFile("s2"), lines(aiTitle("One"), aiTitle("Two")));
    fs.writeFileSync(subFile("s2", "a1"), lines(customTitle("agent title")));
    const tracker = new BurnTracker({ projectsDir: tmp });
    expect(await tracker.refresh()).toBe(true);
    expect(tracker.titleOf("s1")).toBe("Mine");
    expect(tracker.titleOf("s2")).toBe("Two");
    expect(tracker.titleOf("nope")).toBeUndefined();
  });

  it("drops records and files older than the horizon, and prunes as time passes", async () => {
    let clock = Date.now();
    fs.writeFileSync(mainFile("s1"), lines(usageLine("old", clock - 2 * HOUR), usageLine("fresh", clock - 60_000)));
    fs.writeFileSync(mainFile("s2"), lines(usageLine("stale-file", clock - 60_000)));
    setMtime(mainFile("s2"), clock - 2 * HOUR);
    const tracker = new BurnTracker({ projectsDir: tmp, horizonMs: HOUR, now: () => clock });
    await tracker.refresh();
    expect(keys(tracker)).toEqual(["fresh"]);
    clock += HOUR;
    await tracker.refresh();
    expect(keys(tracker)).toEqual([]);
  });

  it("credits a request copied by resume to the newer transcript, in either read order", async () => {
    const now = Date.now();
    fs.writeFileSync(mainFile("a-old"), lines(usageLine("k1", now - 300_000)));
    fs.writeFileSync(mainFile("b-new"), lines(usageLine("k1", now - 300_000), usageLine("k2", now - 1000)));
    fs.writeFileSync(mainFile("c-new"), lines(usageLine("k3", now - 300_000), usageLine("k4", now - 1000)));
    fs.writeFileSync(mainFile("d-old"), lines(usageLine("k3", now - 300_000)));
    setMtime(mainFile("a-old"), now - 120_000);
    setMtime(mainFile("d-old"), now - 120_000);
    const tracker = new BurnTracker({ projectsDir: tmp });
    await tracker.refresh();
    expect(recordOf(tracker, "k1")?.sessionId).toBe("b-new");
    expect(recordOf(tracker, "k3")?.sessionId).toBe("c-new");
  });

  it("never rejects on garbage lines or a missing projects dir", async () => {
    const file = mainFile("s1");
    const garbage = ["{not json", '"usage" title"', "null", "[]", '{"type":"assistant","message":{"usage":7}}', "\u0000\u0001"];
    fs.writeFileSync(file, lines(...garbage, "", usageLine("ok", Date.now() - 1000)));
    fs.appendFileSync(file, Buffer.from([0xff, 0xfe, 0x22, 0x75, 0x73, 0x61, 0x67, 0x65, 0x22, 0x0a]));
    const tracker = new BurnTracker({ projectsDir: tmp });
    await expect(tracker.refresh()).resolves.toBe(true);
    expect(keys(tracker)).toEqual(["ok"]);
    await expect(new BurnTracker({ projectsDir: path.join(tmp, "missing") }).refresh()).resolves.toBe(false);
  });

  it("shares one in-flight refresh between concurrent callers", async () => {
    fs.writeFileSync(mainFile("s1"), lines(usageLine("k1", Date.now())));
    const tracker = new BurnTracker({ projectsDir: tmp });
    const first = tracker.refresh();
    expect(tracker.refresh()).toBe(first);
    expect(await first).toBe(true);
    const next = tracker.refresh();
    expect(next).not.toBe(first);
    expect(await next).toBe(false);
  });
});
