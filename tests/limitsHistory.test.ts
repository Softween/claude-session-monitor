import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The length of every fs.readSync call, so a test can tell whether a call read the file.
const reads = vi.hoisted(() => [] as number[]);
vi.mock("fs", async (orig) => {
  const real = await orig<typeof import("fs")>();
  return {
    ...real,
    readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      reads.push(length);
      return real.readSync(fd, buffer, offset, length, position);
    },
  };
});

import { readLimitsHistory } from "../src/core";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-history-"));
  file = path.join(dir, "limits-history.jsonl");
  reads.length = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const point = (i: number) => JSON.stringify({ ts: 1_800_000_000 + i * 60, fh: i, sd: i / 2, src: "ext" }) + "\n";

describe("readLimitsHistory", () => {
  it("parses the file again only when its mtime or size changed", () => {
    fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => point(i)).join(""));
    const first = readLimitsHistory(240, file);
    expect(first).toHaveLength(240);
    expect(reads.length).toBeGreaterThan(0);

    reads.length = 0;
    expect(readLimitsHistory(240, file)).toEqual(first);
    expect(readLimitsHistory(5, file).map((p) => p.fh)).toEqual([295, 296, 297, 298, 299]);
    expect(reads).toEqual([]); // unchanged: served from memory

    fs.appendFileSync(file, point(300));
    expect(readLimitsHistory(240, file).at(-1)?.fh).toBe(300);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("a caller that changes the list it got does not change the next one", () => {
    fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => point(i)).join(""));
    const first = readLimitsHistory(240, file);
    first.length = 0;
    expect(readLimitsHistory(240, file)).toHaveLength(10);
  });
});
