import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  READY_TIMEOUT_MS,
  SETTLE_MS,
  readStartRecord,
  startNewSession,
  type NewSessionDeps,
  type TerminalSpec,
} from "../src/remoteNewSession";

const ID = "11111111-2222-4333-8444-555555555555";
const BIN = "/Users/u/.local/bin/claude";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-newsession-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeTerminal {
  spec: TerminalSpec;
  exitStatus: unknown;
  sent: Array<{ text: string; at: number }>;
  disposed: boolean;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

interface SetupOptions {
  bin?: string;
  noBin?: boolean;
  /** called on every fake sleep with the clock after it */
  onSleep?: (clock: number, term: FakeTerminal | undefined) => void;
  onSend?: (text: string) => void;
}

const transcript = () => path.join(dir, "transcript.jsonl");
const writeRecord = (over: Record<string, unknown> = {}) =>
  fs.writeFileSync(path.join(dir, `${ID}.json`), JSON.stringify({ session_id: ID, event: "SessionStart", transcript_path: transcript(), ...over }));

function setup(o: SetupOptions = {}) {
  let clock = 0;
  const opened: FakeTerminal[] = [];
  const registered: Array<[string, FakeTerminal]> = [];
  const deps: NewSessionDeps<FakeTerminal> = {
    allowed: () => ["/r/REPOS", "/r/REPOS/personal/app"],
    claudeBinary: async () => (o.noBin ? undefined : (o.bin ?? BIN)),
    open: (spec) => {
      const term: FakeTerminal = {
        spec,
        exitStatus: undefined,
        sent: [],
        disposed: false,
        sendText(text) {
          this.sent.push({ text, at: clock });
          o.onSend?.(text);
        },
        dispose() {
          this.disposed = true;
        },
      };
      opened.push(term);
      return term;
    },
    register: (id, term) => registered.push([id, term]),
    monitorDir: dir,
    sleep: async (ms) => {
      clock += ms;
      o.onSleep?.(clock, opened[0]);
    },
    now: () => clock,
    newId: () => ID,
  };
  return { deps, opened, registered };
}

describe("startNewSession", () => {
  it("refuses a folder outside the list or a rejected first message, with nothing opened", async () => {
    const { deps, opened } = setup();
    expect(await startNewSession({ id: "c", type: "newSession", cwd: "/etc" }, deps)).toEqual({
      ok: false,
      message: "folder not allowed on this Mac",
    });
    expect(await startNewSession({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "/clear" }, deps)).toEqual({
      ok: false,
      message: "first message: rejected input",
    });
    expect(opened).toEqual([]);
  });

  it("refuses without a claude executable", async () => {
    const { deps, opened } = setup({ noBin: true });
    expect(await startNewSession({ id: "c", type: "newSession", cwd: "/r/REPOS" }, deps)).toEqual({
      ok: false,
      message: "claude executable not found on this Mac; new session refused",
    });
    expect(opened).toEqual([]);
  });

  it("opens claude --session-id in the folder, registers it, and writes the first message only after the session started", async () => {
    const { deps, opened, registered } = setup({
      onSleep: (clock) => {
        if (clock === 3000) writeRecord();
      },
      onSend: () => fs.appendFileSync(transcript(), '{"type":"user"}\n'),
    });
    const out = await startNewSession(
      { id: "c", type: "newSession", cwd: "/r/REPOS/personal/app", text: "merhaba, bu bir test; hiçbir şey yapma" },
      deps,
    );
    expect(out).toEqual({ ok: true, message: `new session ${ID} started in app; first message delivered` });
    expect(opened).toHaveLength(1);
    expect(opened[0].spec).toEqual({ name: "Claude · app", cwd: "/r/REPOS/personal/app", shellPath: BIN, shellArgs: ["--session-id", ID] });
    expect(registered).toEqual([[ID, opened[0]]]);
    expect(opened[0].sent).toEqual([{ text: "merhaba, bu bir test; hiçbir şey yapma\r", at: 3000 + SETTLE_MS }]);
    expect(opened[0].disposed).toBe(false);
  });

  it("types nothing without a first message", async () => {
    const { deps, opened } = setup({ onSleep: () => writeRecord() });
    expect(await startNewSession({ id: "c", type: "newSession", cwd: "/r/REPOS" }, deps)).toEqual({
      ok: true,
      message: `new session ${ID} started in REPOS`,
    });
    expect(opened[0].sent).toEqual([]);
  });

  it("closes the terminal when the session does not start within 35 s, and types nothing", async () => {
    const { deps, opened } = setup();
    const out = await startNewSession({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "merhaba" }, deps);
    expect(out).toEqual({
      ok: false,
      message: `new session in REPOS did not start: no session start within ${READY_TIMEOUT_MS / 1000} s (a question may be waiting in the terminal); terminal closed`,
    });
    expect(opened[0].disposed).toBe(true);
    expect(opened[0].sent).toEqual([]);
  });

  it("stops when claude exits before it starts", async () => {
    const { deps, opened } = setup({
      onSleep: (clock, term) => {
        if (term && clock >= 1000) term.exitStatus = { code: 1 };
      },
    });
    const out = await startNewSession({ id: "c", type: "newSession", cwd: "/r/REPOS" }, deps);
    expect(out).toEqual({ ok: false, message: "new session in REPOS did not start: claude exited; terminal closed" });
    expect(opened[0].disposed).toBe(true);
  });

  it("says so when the first message has not reached the transcript after 15 s", async () => {
    const { deps, opened } = setup({ onSleep: () => writeRecord() });
    const out = await startNewSession({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "merhaba" }, deps);
    expect(out).toEqual({ ok: true, message: `new session ${ID} started in REPOS; first message written, not in the transcript yet` });
    expect(opened[0].sent.map((s) => s.text)).toEqual(["merhaba\r"]);
  });
});

describe("readStartRecord", () => {
  it("reads only this session's record and its transcript path", () => {
    const file = path.join(dir, `${ID}.json`);
    expect(readStartRecord(file, ID)).toBeNull(); // not written yet
    writeRecord();
    expect(readStartRecord(file, ID)).toEqual({ transcriptPath: transcript() });
    expect(readStartRecord(file, "other")).toBeNull();
    writeRecord({ transcript_path: 5 });
    expect(readStartRecord(file, ID)).toEqual({ transcriptPath: null });
    fs.writeFileSync(file, "{not json");
    expect(readStartRecord(file, ID)).toBeNull();
  });
});
