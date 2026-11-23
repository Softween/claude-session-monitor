import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The length of every fs.readSync call, so a test can tell how many bytes a parse read.
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

import { parseTranscriptTail, type TxInfo } from "../src/core";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-tail-"));
  file = path.join(dir, "s.jsonl");
  reads.length = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Math.floor(Date.parse("2026-06-17T12:00:00.000Z") / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e) + "\n").join("");
const user = (text: string, ts: number) => ({ type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text }] }, timestamp: iso(ts) });
const done = (text: string, ts: number, model = "claude-opus-4-8") => ({
  type: "assistant",
  effort: "high",
  message: { model, content: [{ type: "text", text }], stop_reason: "end_turn" },
  timestamp: iso(ts),
});
const toolUse = (id: string, name: string, ts: number) => ({
  type: "assistant",
  message: { model: "claude-opus-4-8", content: [{ type: "tool_use", id, name, input: {} }], stop_reason: "tool_use" },
  timestamp: iso(ts),
});
const toolResult = (id: string, ts: number) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, timestamp: iso(ts) });
const limitHit = (ts: number) => ({
  type: "assistant",
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 1:50pm (Europe/Istanbul)" }] },
  timestamp: iso(ts),
});
const bytesRead = () => reads.reduce((sum, n) => sum + n, 0);

/** Parses `file` on from `prev`, checks the result against a parse from scratch, and returns it. */
function step(prev: TxInfo | undefined): TxInfo {
  const next = parseTranscriptTail(file, prev);
  expect(next).toEqual(parseTranscriptTail(file));
  return next;
}

describe("incremental transcript tails", () => {
  it("reads only the bytes appended since the last parse", () => {
    fs.writeFileSync(file, jsonl(user("first question", NOW - 60), done("first answer ".repeat(40), NOW - 50), user("second question", NOW - 40)));
    const first = parseTranscriptTail(file);
    reads.length = 0;
    const added = jsonl(done("second answer", NOW - 30));
    fs.appendFileSync(file, added);
    const next = parseTranscriptTail(file, first);
    expect(bytesRead()).toBeGreaterThan(0);
    expect(bytesRead()).toBeLessThanOrEqual(Buffer.byteLength(added) + 64); // the new line and a short check of the bytes before it
    expect(next).toEqual(parseTranscriptTail(file));
    expect(next.convKind).toBe("end_turn");
  });

  it("gives the same result as a parse from scratch after each append", () => {
    fs.writeFileSync(file, jsonl({ type: "ai-title", aiTitle: "Parser refactor" }, user("refactor the parser", NOW - 300)));
    let tx = step(undefined);
    const appends = [
      jsonl(toolUse("t1", "Bash", NOW - 290)),
      jsonl(toolResult("t1", NOW - 280), done("Refactored.\n⏳ Kapatma: deploy bekleniyor", NOW - 270)),
      jsonl({ type: "last-prompt", lastPrompt: "refactor the parser" }, toolUse("q1", "AskUserQuestion", NOW - 200)),
      jsonl({ type: "attachment", attachment: { type: "hook_success" }, timestamp: iso(NOW - 190) }),
      jsonl(toolResult("q1", NOW - 180)),
      jsonl(limitHit(NOW - 100)),
      jsonl(user("same second as the limit", NOW - 100)),
      jsonl({ type: "ai-title", aiTitle: "Parser refactor, part 2" }, done("All set.", NOW - 50, "claude-sonnet-5")),
    ];
    const seen = { askPending: false, limit: false, closing: false };
    for (const chunk of appends) {
      fs.appendFileSync(file, chunk);
      tx = step(tx);
      if (tx.askPending) seen.askPending = true;
      if (tx.limit) seen.limit = true;
      if (tx.closing) seen.closing = true;
    }
    expect(seen).toEqual({ askPending: true, limit: true, closing: true }); // the steps went through each of these states
    expect([tx.title, tx.model, tx.convKind, tx.askPending]).toEqual(["Parser refactor, part 2", "claude-sonnet-5", "end_turn", undefined]);
  });

  it("carries a partial last line over and parses it once it is complete", () => {
    fs.writeFileSync(file, jsonl(user("question", NOW - 60), done("answer", NOW - 50)));
    let tx = step(undefined);
    const next = jsonl(user("a follow-up question", NOW - 40));
    fs.appendFileSync(file, next.slice(0, 30)); // written halfway
    tx = step(tx);
    expect(tx.convKind).toBe("end_turn");
    fs.appendFileSync(file, next.slice(30));
    tx = step(tx);
    expect(tx.convKind).toBe("user_text");
    const last = JSON.stringify(done("follow-up answer", NOW - 30));
    fs.appendFileSync(file, last); // complete, its newline not written yet
    tx = step(tx);
    expect(tx.convKind).toBe("end_turn");
    fs.appendFileSync(file, "\n" + jsonl(user("third question", NOW - 20)));
    tx = step(tx);
    expect(tx.convKind).toBe("user_text");
  });

  it("parses a line whose multi-byte character was split between two appends", () => {
    fs.writeFileSync(file, jsonl(user("question", NOW - 60)));
    let tx = step(undefined);
    const titled = Buffer.from(jsonl({ type: "ai-title", aiTitle: "Kapanış çalışması öğleden önce" }), "utf8");
    const cut = titled.indexOf(Buffer.from("ş", "utf8")) + 1; // inside the two bytes of "ş"
    fs.appendFileSync(file, titled.subarray(0, cut));
    tx = step(tx);
    expect(tx.title).toBeUndefined();
    fs.appendFileSync(file, titled.subarray(cut));
    tx = step(tx);
    expect(tx.title).toBe("Kapanış çalışması öğleden önce");
  });

  it("reads the tail again when the file shrank", () => {
    fs.writeFileSync(file, jsonl(user("a long first question ".repeat(20), NOW - 60), done("answer", NOW - 50), toolUse("t1", "Bash", NOW - 40)));
    const first = parseTranscriptTail(file);
    const shorter = jsonl(user("a new question", NOW - 30));
    fs.writeFileSync(file, shorter);
    reads.length = 0;
    const tx = step(first);
    expect(reads[0]).toBe(Buffer.byteLength(shorter)); // the whole (short) file, read from its start
    expect(tx.convKind).toBe("user_text");
  });

  it("reads the tail again when the file was replaced or rewritten in place", () => {
    fs.writeFileSync(file, jsonl({ type: "ai-title", aiTitle: "Old title" }, user("old question", NOW - 60), done("old answer", NOW - 50)));
    let tx = parseTranscriptTail(file);
    const tmp = path.join(dir, "s.jsonl.tmp");
    fs.writeFileSync(tmp, jsonl({ type: "ai-title", aiTitle: "New title" }, user("new question, longer than before", NOW - 40), done("new answer", NOW - 30), user("more", NOW - 20)));
    fs.renameSync(tmp, file); // another file under the same name
    tx = step(tx);
    expect(tx.title).toBe("New title");
    fs.writeFileSync(file, jsonl({ type: "ai-title", aiTitle: "Rewritten title" }, user("rewritten question, longer than the one before it", NOW - 15), done("rewritten answer", NOW - 10), done("and more", NOW - 5)));
    tx = step(tx); // same file, every byte rewritten and longer
    expect(tx.title).toBe("Rewritten title");
  });

  it("reads the tail again when more than a tail window was appended", () => {
    fs.writeFileSync(file, jsonl({ type: "ai-title", aiTitle: "Long session" }, user("question", NOW - 600)));
    const first = parseTranscriptTail(file);
    const filler = jsonl(toolResult("t0", NOW - 500)).replace('"ok"', JSON.stringify("x".repeat(2000)));
    fs.appendFileSync(file, filler.repeat(300) + jsonl(done("finally done", NOW - 5))); // about 600 KB
    reads.length = 0;
    const tx = step(first);
    expect(Math.max(...reads)).toBe(512 * 1024); // one tail window, not the 600 KB appended
    expect([tx.title, tx.convKind]).toEqual(["Long session", "end_turn"]);
  });
});
