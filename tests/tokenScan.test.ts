import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scanTokenUsage } from "../src/core";

const NOW = Math.floor(Date.parse("2026-06-17T12:00:00.000Z") / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const MiB = 1024 * 1024;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-scan-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scanTokenUsage reads at most 4 MiB per call", () => {
  it("stops one call at 4 MiB across files and picks the rest up on the next call, counting every line once", () => {
    const pad = "x".repeat(1000);
    const N = 2900; // ~3.3 MB per file: each file fits the backfill, both together do not fit one call
    const line = (i: number) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: pad }], usage: { input_tokens: 10, output_tokens: 0 } },
        timestamp: iso(NOW - 600 - (i % 100)),
      });
    const write = (name: string): string => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, Array.from({ length: N }, (_, i) => line(i)).join("\n") + "\n");
      return p;
    };
    const a = write("big-a.jsonl");
    const b = write("big-b.jsonl");
    const size = fs.statSync(a).size;
    expect(size).toBeGreaterThan(3 * MiB);
    expect(size).toBeLessThan(4 * MiB);
    const offsetsFile = path.join(tmp, "offsets.json");
    const bucketsFile = path.join(tmp, "buckets.json");
    // Bytes consumed so far, from the persisted per-file offsets.
    const consumed = (): number => {
      const o = JSON.parse(fs.readFileSync(offsetsFile, "utf8"));
      return (o[a]?.offset ?? 0) + (o[b]?.offset ?? 0);
    };

    scanTokenUsage([{ path: a }, { path: b }], NOW, { offsetsFile, bucketsFile });
    const first = consumed();
    expect(first).toBeLessThanOrEqual(4 * MiB);
    expect(first).toBeGreaterThan(4 * MiB - 2048); // the budget is spent, short of the last partial line

    const u = scanTokenUsage([{ path: a }, { path: b }], NOW, { offsetsFile, bucketsFile });
    expect(consumed() - first).toBeLessThanOrEqual(4 * MiB);
    expect(consumed()).toBe(2 * size);
    expect(u.fiveHour).toBe(2 * N * 10);
  });
});

describe("scanTokenUsage prefilter", () => {
  it("never JSON-parses a line without \"usage\" and still counts the usage lines", () => {
    const marker = "NO-USAGE-LINE";
    const p = path.join(tmp, "mixed.jsonl");
    const lines = [
      { type: "user", message: { content: [{ type: "tool_result", content: `${marker} tool output` }] }, timestamp: iso(NOW - 700) },
      { type: "assistant", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 1000, output_tokens: 0 } }, timestamp: iso(NOW - 650) },
      { type: "assistant", message: { content: [{ type: "text", text: `${marker} no usage here` }] }, timestamp: iso(NOW - 640) },
      { type: "system", content: marker, timestamp: iso(NOW - 630) },
      { type: "assistant", message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 500, output_tokens: 0 } }, timestamp: iso(NOW - 600) },
    ];
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const parse = vi.spyOn(JSON, "parse");
    const u = scanTokenUsage([{ path: p }], NOW, { offsetsFile: path.join(tmp, "o.json"), bucketsFile: path.join(tmp, "b.json") });
    expect(u.fiveHour).toBe(1500);
    expect(parse.mock.calls.filter(([text]) => String(text).includes(marker))).toHaveLength(0);
  });
});
