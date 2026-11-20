import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSwitchLock } from "../src/accountSwitch";
import { DebugLog, KEEP, ROTATE_LINES, classify, type DebugLogOptions } from "../src/debugLog";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-log-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const GONE_PID = 2_000_000_000; // above every platform's pid range: no process carries it
const lines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const parsed = (file: string): any[] => lines(file).map((l) => JSON.parse(l));
const msgs = (file: string): string[] => parsed(file).map((l) => l.msg);
const range = (from: number, to: number, prefix: string): string[] => Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`);

function writer(file: string, pid: number, opts: Partial<DebugLogOptions> = {}): DebugLog {
  return new DebugLog({ file, pid, lock: (f) => acquireSwitchLock(f), nowMs: () => NOW, ...opts });
}

describe("classify", () => {
  it("takes the feature from the leading word, a stage failure is an error, a reported failure a warning", () => {
    expect(classify("wake: activation registry=3 pending=1")).toEqual({ feature: "wake", lvl: "info" });
    expect(classify("restart guard: tab opened")).toEqual({ feature: "restart-guard", lvl: "info" });
    expect(classify("continuity: heartbeat not written: EACCES")).toEqual({ feature: "continuity", lvl: "info" });
    expect(classify("stage failed: continuity: TypeError: x; repeats are counted, not logged")).toEqual({ feature: "stage", lvl: "error" });
    expect(classify("oauth refresh failed (acct 1c2b3a4d, transient)")).toEqual({ feature: "oauth", lvl: "warn" });
    expect(classify("usage: fetch error TypeError: fetch failed")).toEqual({ feature: "usage", lvl: "warn" });
    expect(classify("auto-resume scheduled in 12s")).toEqual({ feature: "auto-resume", lvl: "info" });
    expect(classify("sessions=3 {}")).toEqual({ feature: "sessions", lvl: "info" });
    expect(classify("(no word)")).toEqual({ feature: "general", lvl: "info" });
  });
});

describe("DebugLog", () => {
  it("writes one JSON object per line with ts, pid, win, ver, feature, lvl and msg, and keeps the old text searchable", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    const log = writer(file, 4242);
    log.write("before identify");
    log.identify("c7464c24ed54e168", "2.40.0");
    log.write("wake: activation registry=3 pending=1");
    log.write("stage failed: continuity: Error: x; repeats are counted, not logged");
    log.write("activated: version 2.40.0 pid 4242 window c7464c24ed54e168", "activation", "info");
    const out = parsed(file);
    expect(out[0]).toEqual({ ts: "2026-11-20T12:00:00.000Z", pid: 4242, win: "empty-4242", ver: "", feature: "before", lvl: "info", msg: "before identify" });
    expect(Object.keys(out[1])).toEqual(["ts", "pid", "win", "ver", "feature", "lvl", "msg"]);
    expect(out[1]).toEqual({
      ts: "2026-11-20T12:00:00.000Z",
      pid: 4242,
      win: "c7464c24ed54e168",
      ver: "2.40.0",
      feature: "wake",
      lvl: "info",
      msg: "wake: activation registry=3 pending=1",
    });
    expect(out[2]).toMatchObject({ feature: "stage", lvl: "error" });
    expect(out[3]).toMatchObject({ feature: "activation", lvl: "info", msg: "activated: version 2.40.0 pid 4242 window c7464c24ed54e168" });
    expect(fs.readFileSync(file, "utf8")).toContain("wake: activation registry=3 pending=1");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps a message with quotes and line breaks on one line, and caps a long one", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    const log = writer(file, 1);
    log.write('use: "a@x.com"\nsecond line');
    log.write("x".repeat(5_000));
    expect(lines(file)).toHaveLength(2);
    expect(msgs(file)[0]).toBe('use: "a@x.com"\nsecond line');
    expect(msgs(file)[1]).toBe(`${"x".repeat(2_000)}…`);
  });

  it("creates a missing folder private (0700)", () => {
    const dir = path.join(tmpDir(), "a", "session-monitor");
    writer(path.join(dir, "csm-debug.log"), 1).write("hello");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(msgs(path.join(dir, "csm-debug.log"))).toEqual(["hello"]);
  });

  it("replaces a symlink in place of the log with a file and never writes through it", () => {
    const dir = tmpDir();
    const target = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(target, "keep\n");
    const file = path.join(dir, "csm-debug.log");
    fs.symlinkSync(target, file);
    writer(file, 1).write("hello");
    expect(fs.readFileSync(target, "utf8")).toBe("keep\n");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(msgs(file)).toEqual(["hello"]);
  });

  it("rotates by lines: the full file becomes .1, older ones shift, the oldest beyond keep is dropped, and no line is cut", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    const log = writer(file, 1, { rotateLines: 10, keep: 3, countStep: 1 });
    for (let i = 0; i < 45; i++) log.write(`line ${i}`);
    expect(msgs(`${file}.3`)).toEqual(range(10, 20, "line "));
    expect(msgs(`${file}.2`)).toEqual(range(20, 30, "line "));
    expect(msgs(`${file}.1`)).toEqual(range(30, 40, "line "));
    expect(msgs(file)).toEqual(range(40, 45, "line "));
    expect(fs.existsSync(`${file}.4`)).toBe(false);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("counts the lines already in the file, an older version's plain lines too", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    fs.writeFileSync(file, range(0, 8, "2026-11-19T10:00:00.000Z old ").join("\n") + "\n");
    const log = writer(file, 1, { rotateLines: 10, keep: 3, countStep: 1 });
    log.write("new 0");
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    log.write("new 1");
    expect(lines(`${file}.1`)).toHaveLength(10);
    expect(lines(`${file}.1`)[0]).toBe("2026-11-19T10:00:00.000Z old 0");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("two writers on one file: every line is whole JSON, none is lost, and each threshold rotates once", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    const a = writer(file, 101, { rotateLines: 20, keep: 5, countStep: 1 });
    const b = writer(file, 202, { rotateLines: 20, keep: 5, countStep: 1 });
    a.identify("aaaaaaaaaaaaaaaa", "2.40.0");
    b.identify("bbbbbbbbbbbbbbbb", "2.40.0");
    for (let i = 0; i < 50; i++) {
      a.write(`a ${i}`);
      b.write(`b ${i}`);
    }
    const files = [1, 2, 3, 4, 5].map((n) => `${file}.${n}`);
    for (const f of files) expect(lines(f)).toHaveLength(20);
    expect(fs.existsSync(file)).toBe(false); // the 100th line filled the fifth file
    const all = files.flatMap(parsed);
    expect(new Set(all.map((l) => l.msg)).size).toBe(100);
    expect(all.filter((l) => l.pid === 101 && l.win === "aaaaaaaaaaaaaaaa").map((l) => l.msg).sort()).toEqual(range(0, 50, "a ").sort());
    expect(all.filter((l) => l.pid === 202 && l.win === "bbbbbbbbbbbbbbbb")).toHaveLength(50);
  });

  it("a writer whose count is behind another's rotation leaves the new file alone", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    const a = writer(file, 101, { rotateLines: 10, keep: 3, countStep: 1 });
    const b = writer(file, 202, { rotateLines: 10, keep: 3, countStep: 1 });
    for (let i = 0; i < 9; i++) a.write(`a ${i}`);
    b.write("b 0"); // the 10th line: b rotates
    a.write("a 9"); // a counted 9 lines of the old file; the new one has 1
    expect(lines(`${file}.1`)).toHaveLength(10);
    expect(msgs(file)).toEqual(["a 9"]);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
  });

  it("does not rotate while another live writer holds the lock, and takes over a lock whose holder is gone", () => {
    const file = path.join(tmpDir(), "csm-debug.log");
    const log = writer(file, 1, { rotateLines: 5, keep: 2, countStep: 1 });
    fs.writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()} other-window`);
    for (let i = 0; i < 7; i++) log.write(`x ${i}`);
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    expect(lines(file)).toHaveLength(7);
    fs.writeFileSync(`${file}.lock`, `${GONE_PID} ${Date.now()} gone-window`);
    log.write("x 7");
    expect(msgs(`${file}.1`)).toEqual(range(0, 8, "x "));
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("keeps at least 7 days at the rate measured on 2026-11-20 (214 lines an hour, 293 in the busiest hour)", () => {
    expect((KEEP * ROTATE_LINES) / 214 / 24).toBeGreaterThanOrEqual(7);
    expect((KEEP * ROTATE_LINES) / 293 / 24).toBeGreaterThanOrEqual(7);
  });

  it("never throws, even when the log cannot be written", () => {
    const dir = tmpDir();
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    expect(() => writer(path.join(blocker, "csm-debug.log"), 1).write("lost")).not.toThrow();
  });
});
