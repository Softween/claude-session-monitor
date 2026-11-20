import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSwitchLock } from "../src/accountSwitch";
import { MAX_ERRORS, mergeErrors, readIfThere, saveErrors, type SaveDeps } from "../src/errorRegistry";
import type { ErrorRecord } from "../src/safeStage";

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const STACK = "TypeError: bad state\n    at observe (src/continuity.ts:120:11)\n    at refresh (src/extension.ts:3301:5)";

function rec(key: string, count: number, firstMs: number, lastMs = firstMs, stack = STACK): ErrorRecord {
  return { key, stage: key.slice(0, key.indexOf(":")), count, stack, firstMs, lastMs };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fileDeps(): SaveDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-errors-"));
  dirs.push(dir);
  return {
    file: path.join(dir, "health", "errors.json"),
    shared: () => true,
    lock: (f) => acquireSwitchLock(f),
    read: (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined),
    write: (f, text) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.tmp`, text);
      fs.renameSync(`${f}.tmp`, f);
    },
  };
}

describe("mergeErrors", () => {
  it("adds counts across windows, keeps the first stack, the first time, the version and window that saw it first", () => {
    const one = mergeErrors(undefined, [rec("continuity: TypeError: bad state", 3, T0, T0 + 1000)], "2.40.0", "aaaaaaaaaaaaaaaa");
    const two = mergeErrors(
      JSON.parse(JSON.stringify(one)),
      [rec("continuity: TypeError: bad state", 2, T0 + 5000, T0 + 9000, "TypeError: bad state\n    at elsewhere (x.ts:1:1)")],
      "2.41.0",
      "bbbbbbbbbbbbbbbb",
    );
    expect(two).toEqual({
      v: 1,
      errors: {
        "continuity: TypeError: bad state": {
          stage: "continuity",
          count: 5,
          first: "2026-11-20T12:00:00.000Z",
          last: "2026-11-20T12:00:09.000Z",
          stack: STACK,
          ver: "2.40.0",
          win: "aaaaaaaaaaaaaaaa",
        },
      },
    });
  });

  it("never shortens a stack, however long", () => {
    const stack = `Error: deep\n${"    at frame (src/x.ts:1:1)\n".repeat(5_000)}`;
    const out = mergeErrors(undefined, [rec("sessions: Error: deep", 1, T0, T0, stack)], "2.40.0", "w");
    expect(JSON.parse(JSON.stringify(out)).errors["sessions: Error: deep"].stack).toBe(stack);
  });

  it(`keeps at most ${MAX_ERRORS} distinct errors, dropping the ones seen longest ago`, () => {
    const records = Array.from({ length: MAX_ERRORS + 2 }, (_, i) => rec(`limits: Error: e${i}`, 1, T0 + i * 1000));
    const out = mergeErrors(undefined, records, "2.40.0", "w");
    const keys = Object.keys(out.errors);
    expect(keys).toHaveLength(MAX_ERRORS);
    expect(keys).not.toContain("limits: Error: e0");
    expect(keys).not.toContain("limits: Error: e1");
    expect(keys).toContain("limits: Error: e2");
    expect(keys).toContain(`limits: Error: e${MAX_ERRORS + 1}`);
  });

  it("refuses a file of another version or shape and skips malformed entries", () => {
    expect(() => mergeErrors({ v: 2, errors: { k: {} } }, [], "2.40.0", "w")).toThrow(/left as it is/);
    expect(() => mergeErrors(null, [], "2.40.0", "w")).toThrow(/left as it is/);
    const kept = { stage: "x", count: 1, first: "a", last: "b", stack: "s", ver: "1", win: "w" };
    expect(mergeErrors({ v: 1, errors: { good: kept, bad: { stage: 1 } } }, [], "2.40.0", "w")).toEqual({ v: 1, errors: { good: kept } });
  });
});

describe("saveErrors", () => {
  it("adds the records to the file under its lock", () => {
    const deps = fileDeps();
    expect(saveErrors([rec("wake: Error: x", 2, T0)], "2.40.0", "w1", deps)).toBe(true);
    expect(saveErrors([rec("wake: Error: x", 1, T0 + 60_000)], "2.40.0", "w2", deps)).toBe(true);
    const out = JSON.parse(fs.readFileSync(deps.file, "utf8"));
    expect(out.errors["wake: Error: x"]).toMatchObject({ count: 3, win: "w1", last: "2026-11-20T12:01:00.000Z" });
    expect(fs.existsSync(`${deps.file}.lock`)).toBe(false);
  });

  it("returns false while another live window holds the lock, and saves once it is free", () => {
    const deps = fileDeps();
    fs.mkdirSync(path.dirname(deps.file), { recursive: true });
    fs.writeFileSync(`${deps.file}.lock`, `${process.pid} ${Date.now()} other-window`);
    expect(saveErrors([rec("wake: Error: x", 2, T0)], "2.40.0", "w1", deps)).toBe(false);
    expect(fs.existsSync(deps.file)).toBe(false);
    fs.unlinkSync(`${deps.file}.lock`);
    expect(saveErrors([rec("wake: Error: x", 2, T0)], "2.40.0", "w1", deps)).toBe(true);
    expect(JSON.parse(fs.readFileSync(deps.file, "utf8")).errors["wake: Error: x"].count).toBe(2);
  });

  it("observer mode writes nothing and leaves the records unsaved", () => {
    const deps = { ...fileDeps(), shared: () => false };
    expect(saveErrors([rec("wake: Error: x", 2, T0)], "2.40.0", "w1", deps)).toBe(false);
    expect(fs.existsSync(path.dirname(deps.file))).toBe(false);
  });

  it("does nothing without records", () => {
    const deps = fileDeps();
    expect(saveErrors([], "2.40.0", "w1", deps)).toBe(true);
    expect(fs.existsSync(deps.file)).toBe(false);
  });

  it("leaves a file it cannot read as it is: only a missing file starts an empty registry", () => {
    const deps = fileDeps();
    expect(saveErrors([rec("wake: Error: x", 2, T0)], "2.40.0", "w1", deps)).toBe(true);
    const before = fs.readFileSync(deps.file, "utf8");
    const emfile = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    const unreadable: SaveDeps = {
      ...deps,
      read: () => {
        throw emfile;
      },
    };
    expect(() => saveErrors([rec("limits: Error: y", 1, T0)], "2.40.0", "w2", unreadable)).toThrow(emfile);
    expect(fs.readFileSync(deps.file, "utf8")).toBe(before);
    expect(fs.existsSync(`${deps.file}.lock`)).toBe(false);
  });

  it("leaves a file of another version or shape as it is, a newer window's included", () => {
    const deps = fileDeps();
    fs.mkdirSync(path.dirname(deps.file), { recursive: true });
    for (const text of [`${JSON.stringify({ v: 2, errors: { "wake: Error: x": { count: 7 } } })}\n`, "not json", "null"]) {
      fs.writeFileSync(deps.file, text);
      expect(() => saveErrors([rec("wake: Error: x", 1, T0)], "2.40.0", "w1", deps)).toThrow();
      expect(fs.readFileSync(deps.file, "utf8")).toBe(text);
      expect(fs.existsSync(`${deps.file}.lock`)).toBe(false);
    }
  });
});

describe("readIfThere", () => {
  it("gives a file's text, undefined only when there is no file, and throws any other error", () => {
    const deps = fileDeps();
    expect(readIfThere(deps.file)).toBeUndefined(); // neither the file nor its folder exists
    fs.mkdirSync(deps.file, { recursive: true }); // a folder where the file belongs
    expect(() => readIfThere(deps.file)).toThrow(/EISDIR/);
    const file = path.join(deps.file, "x.json");
    fs.writeFileSync(file, "{}");
    expect(readIfThere(file)).toBe("{}");
  });
});
