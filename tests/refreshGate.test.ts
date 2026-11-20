import { afterEach, describe, expect, it, vi } from "vitest";
import { codexSignature, monitorEventMatters, projectsEventMatters, throttle } from "../src/refreshGate";
import type { CodexProviderSnapshot } from "../src/providers/codex";

const UUID = "e7ec778d-bd90-48a0-8fad-0dbd854ddb1e";

describe("watcher event filter", () => {
  it("monitor dirs: only a <uuid>.json hook record, never the log, state or temp files", () => {
    expect(monitorEventMatters(`${UUID}.json`)).toBe(true);
    expect(monitorEventMatters(`${UUID.toUpperCase()}.json`)).toBe(true);
    for (const name of [
      "csm-debug.log",
      "answer-hook.log",
      "token-offsets.json",
      "token-buckets.json",
      "accounts.json",
      "official-usage.json",
      `official-usage-${UUID}.json`,
      `resets-${UUID}.json`,
      "limits.json",
      "limits-history.jsonl",
      "statusline-last-raw.json",
      "tabs-debug.json",
      `.${UUID}.juxpf7su.tmp`,
      ".accounts.json.123.1700000000000.abc.tmp",
      "token-offsets.json.123.abc.tmp",
      `${UUID}.json.tmp`,
      "answers",
      ".write.lock",
    ]) {
      expect(monitorEventMatters(name), name).toBe(false);
    }
  });

  it("projects: only a top-level session transcript, never a subagent transcript or a tool result", () => {
    expect(projectsEventMatters(`-Users-x-repo/${UUID}.jsonl`)).toBe(true);
    expect(projectsEventMatters(`-Users-x-repo\\${UUID}.jsonl`)).toBe(true); // Windows separators
    for (const name of [
      "-Users-x-repo",
      `-Users-x-repo/${UUID}`,
      `-Users-x-repo/${UUID}/subagents/agent-a1b2c3.jsonl`,
      `-Users-x-repo/${UUID}/tool-results/toolu_01.txt`,
      `-Users-x-repo/${UUID}.jsonl.tmp`,
      "-Users-x-repo/notes.md",
      `${UUID}.jsonl`,
    ]) {
      expect(projectsEventMatters(name), name).toBe(false);
    }
  });

  it("an event without a file name counts: the platform did not say which file changed", () => {
    expect(monitorEventMatters(null)).toBe(true);
    expect(projectsEventMatters(null)).toBe(true);
  });
});

describe("throttle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts runs at least the gap apart: requests inside the gap join one run at its end", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    let last = 0;
    const starts: number[] = [];
    const request = throttle(
      () => {
        last = Date.now();
        starts.push(last - t0);
      },
      1000,
      () => last,
    );
    request(); // nothing ran yet: at once
    vi.advanceTimersByTime(300);
    request();
    request();
    vi.advanceTimersByTime(1200); // t0+1500: the joined run started at t0+1000
    request(); // 500 ms after that run: at the end of its gap
    vi.advanceTimersByTime(3000);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("measures the gap from the last start of any path: an explicit run postpones a waiting request", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    let last = t0; // a refresh (a command, say) started just now
    const run = vi.fn(() => {
      last = Date.now();
    });
    const request = throttle(run, 1000, () => last);
    request();
    vi.advanceTimersByTime(999);
    expect(run).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1); // t0+1000
    vi.advanceTimersByTime(300);
    request(); // waits for t0+2000
    vi.advanceTimersByTime(500);
    last = Date.now(); // an explicit refresh at t0+1800
    vi.advanceTimersByTime(999);
    expect(run).toHaveBeenCalledTimes(1); // t0+2799: still inside the explicit run's gap
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2); // t0+2800
  });

  it("cancel drops a waiting run", () => {
    vi.useFakeTimers();
    const last = Date.now();
    const run = vi.fn();
    const request = throttle(run, 1000, () => last);
    request();
    request.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("codexSignature", () => {
  const row = (over: object = {}) => ({
    key: "codex:t1",
    provider: "codex",
    sessionId: "t1",
    title: "fix the build",
    bucket: "working",
    sub: "working",
    detail: "12s · repo",
    tooltip: "fix the build\nlast activity: 12s ago",
    capabilities: { focus: true, transcript: false, resume: true, kill: false, bulkInput: false },
    lastActivityMs: 1_000_000,
    stale: false,
    matchLabels: ["fix the build"],
    ...over,
  });
  const usage = (pct = 40, ts = 100) => ({
    provider: "codex" as const,
    label: "Codex",
    ts,
    gauges: [{ key: "codex-primary-300", label: "Session (5h)", pct, resetMs: null }],
  });
  const snap = (over: Partial<CodexProviderSnapshot> = {}, rowOver: object = {}): CodexProviderSnapshot => ({
    sessions: [row(rowOver)] as CodexProviderSnapshot["sessions"],
    usage: usage(),
    health: { provider: "codex", state: "ready", updatedAt: 100 },
    ...over,
  });

  it("is equal for two polls that saw the same data at different times", () => {
    const later = snap(
      { usage: usage(40, 105), health: { provider: "codex", state: "ready", updatedAt: 105 } },
      { detail: "17s · repo", tooltip: "fix the build\nlast activity: 17s ago" },
    );
    expect(codexSignature(later)).toBe(codexSignature(snap()));
  });

  it("differs when a session, a gauge or the health changed", () => {
    const base = codexSignature(snap());
    expect(codexSignature(snap({}, { bucket: "attention", sub: "your turn" }))).not.toBe(base);
    expect(codexSignature(snap({}, { lastActivityMs: 1_005_000 }))).not.toBe(base);
    expect(codexSignature(snap({ sessions: [] }))).not.toBe(base);
    expect(codexSignature(snap({ usage: usage(41) }))).not.toBe(base);
    expect(codexSignature(snap({ usage: null }))).not.toBe(base);
    expect(codexSignature(snap({ health: { provider: "codex", state: "degraded", message: "Codex CLI not found.", updatedAt: 100 } }))).not.toBe(base);
  });
});
