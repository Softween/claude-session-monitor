import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Every synchronous fs read by name, so a test can tell which reads did not go through fs.promises.
const syncCalls = vi.hoisted(() => [] as string[]);
vi.mock("fs", async (orig) => {
  const real = await orig<typeof import("fs")>();
  const counted: Record<string, unknown> = {};
  for (const name of ["readFileSync", "readdirSync", "statSync", "existsSync", "openSync", "fstatSync", "readSync"] as const) {
    counted[name] = (...args: unknown[]) => {
      syncCalls.push(name);
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ...real, ...counted };
});

import { collectSessions, readEffortSettings, readHookStatuses } from "../src/core";
import { SessionCollector } from "../src/sessionCollector";

// What a transcript parse reads synchronously (parseTranscriptTail): the new bytes of one changed transcript.
const TRANSCRIPT_READS = ["openSync", "fstatSync", "readSync"];
const NOW = Math.floor(Date.now() / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const user = (text: string, ts: number) => ({ type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text }] }, timestamp: iso(ts) });
const done = (text: string, ts: number) => ({ type: "assistant", message: { model: "claude-opus-4-8", content: [{ type: "text", text }], stop_reason: "end_turn" }, timestamp: iso(ts) });

let root: string;
let mon: string;
let settings: string;
let tx: (sid: string) => string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "csm-collect-"));
  mon = path.join(root, "session-monitor");
  settings = path.join(root, "settings.json");
  const proj = path.join(root, "projects", "-repo");
  fs.mkdirSync(mon, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  tx = (sid) => path.join(proj, `${sid}.jsonl`);
  for (const sid of ["s1", "s2", "s3"]) {
    fs.writeFileSync(tx(sid), [user(`work on ${sid}`, NOW - 60), done("Done.", NOW - 50)].map((l) => JSON.stringify(l) + "\n").join(""));
  }
  const hook = (sid: string, state: string, ts: number) =>
    fs.writeFileSync(path.join(mon, `${sid}.json`), JSON.stringify({ session_id: sid, provider: "claude", state, ts, cwd: "/repo", transcript_path: tx(sid), pid: process.pid }));
  hook("s1", "working", NOW - 40);
  hook("s2", "idle", NOW - 40);
  hook("s4", "idle", NOW - 3600); // its transcript never appeared: a phantom
  fs.writeFileSync(path.join(mon, "accounts.json"), JSON.stringify({ v: 1, accounts: [] }));
  fs.writeFileSync(path.join(mon, "token-buckets.json"), JSON.stringify({ v: 1 }));
  fs.writeFileSync(settings, JSON.stringify({ effortLevel: "high" }));
  syncCalls.length = 0;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const opts = () => ({ now: NOW, extraTranscripts: [{ sessionId: "s3", path: tx("s3"), mtimeMs: Date.now() }], maxAgeSec: 3600, pidAlive: () => true });
const fromScratch = async () => collectSessions({ ...opts(), hookStatuses: await readHookStatuses(mon), effortSettings: readEffortSettings(settings) });
const notTranscriptReads = () => syncCalls.filter((c) => !TRANSCRIPT_READS.includes(c));
const opened = () => syncCalls.filter((c) => c === "openSync").length;

describe("SessionCollector", () => {
  it("lists what collectSessions lists; only the transcript parses read synchronously, and an unchanged refresh reads nothing synchronously", async () => {
    const collector = new SessionCollector({ monitorDir: mon, settings });
    const views = await collector.collect(opts());
    expect(views.map((v) => v.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
    expect(notTranscriptReads()).toEqual([]);
    expect(opened()).toBe(3);
    expect(views).toEqual(await fromScratch());

    syncCalls.length = 0;
    expect(await collector.collect(opts())).toEqual(views);
    expect(syncCalls).toEqual([]);
  });

  it("parses only the transcript that changed and reads a changed hook record through fs.promises", async () => {
    const collector = new SessionCollector({ monitorDir: mon, settings });
    await collector.collect(opts());
    fs.appendFileSync(tx("s3"), JSON.stringify(user("one more", NOW - 5)) + "\n");
    fs.writeFileSync(path.join(mon, "s2.json"), JSON.stringify({ session_id: "s2", provider: "claude", state: "waiting", event: "Notification", ts: NOW - 4, cwd: "/repo", transcript_path: tx("s2"), pid: process.pid }));
    syncCalls.length = 0;
    const views = await collector.collect(opts());
    expect(notTranscriptReads()).toEqual([]);
    expect(opened()).toBe(1);
    expect(views).toEqual(await fromScratch());
  });

  it("parses every transcript again after forget()", async () => {
    const collector = new SessionCollector({ monitorDir: mon, settings });
    await collector.collect(opts());
    collector.forget();
    syncCalls.length = 0;
    await collector.collect(opts());
    expect(opened()).toBe(3);
  });
});
