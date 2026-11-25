import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { READY_TIMEOUT_MS } from "../src/remoteNewSession";
import { startNewTab, type NewTabDeps } from "../src/remoteNewTab";

const OLD = "00000000-0000-4000-8000-000000000000";
const ID = "11111111-2222-4333-8444-555555555555";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-newtab-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const transcript = () => path.join(dir, "transcript.jsonl");
const writeRecord = (id = ID) =>
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ session_id: id, event: "SessionStart", transcript_path: transcript() }));

interface SetupOptions {
  /** the window's sessions after the tab opened */
  after?: string[];
  psFails?: boolean;
  /** what each Enter press returns; called with the press number (1-based) */
  onPress?: (n: number) => string | undefined;
}

function setup(o: SetupOptions = {}) {
  let clock = 0;
  let opened = false;
  const prompts: Array<string | undefined> = [];
  let presses = 0;
  const deps: NewTabDeps = {
    allowed: () => ["/r/REPOS", "/r/REPOS/personal/app"],
    ownSessions: async () => (o.psFails ? undefined : opened ? (o.after ?? [OLD, ID]) : [OLD]),
    open: async (prompt) => {
      opened = true;
      prompts.push(prompt);
      writeRecord();
    },
    pressEnter: async () => {
      presses++;
      return o.onPress?.(presses);
    },
    monitorDir: dir,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, prompts, presses: () => presses };
}

describe("startNewTab", () => {
  it("refuses a folder outside the list or a rejected first message, with nothing opened", async () => {
    const { deps, prompts } = setup();
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/etc" }, deps)).toEqual({ ok: false, message: "folder not allowed on this Mac" });
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "/clear" }, deps)).toEqual({
      ok: false,
      message: "first message: rejected input",
    });
    expect(prompts).toEqual([]);
  });

  it("refuses when this window's sessions cannot be listed", async () => {
    const { deps, prompts } = setup({ psFails: true });
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS" }, deps)).toEqual({
      ok: false,
      message: "could not list this window's Claude sessions (ps failed); new session refused",
    });
    expect(prompts).toEqual([]);
  });

  it("opens a tab with the message in its input and names the new session, pressing Enter until the transcript shows it", async () => {
    const { deps, prompts, presses } = setup({
      onPress: (n) => {
        if (n === 2) fs.appendFileSync(transcript(), '{"type":"user"}\n');
        return undefined;
      },
    });
    const out = await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "anastasia hesabını da bağla" }, deps);
    expect(out).toEqual({ ok: true, message: `new session ${ID} started in REPOS in a Claude Code tab; first message delivered` });
    expect(prompts).toEqual(["anastasia hesabını da bağla"]);
    expect(presses()).toBe(2);
    // the hub reads the session id from this prefix (softween-hub worker/lib/fleetWatch.ts)
    expect(out.message).toMatch(/^new session [0-9a-f-]{36} started /);
  });

  it("presses nothing without a first message", async () => {
    const { deps, prompts, presses } = setup();
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS" }, deps)).toEqual({
      ok: true,
      message: `new session ${ID} started in REPOS in a Claude Code tab`,
    });
    expect(prompts).toEqual([undefined]);
    expect(presses()).toBe(0);
  });

  it("says the message waits in the tab's input when Enter cannot be pressed", async () => {
    const { deps } = setup({ onPress: () => "VS Code not frontmost (Mac locked or another app in front)" });
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "merhaba" }, deps)).toEqual({
      ok: true,
      message: `new session ${ID} started in REPOS in a Claude Code tab; first message is in the tab's input, not sent: VS Code not frontmost (Mac locked or another app in front)`,
    });
  });

  it("fails when no new session appears, or several do", async () => {
    const none = setup({ after: [OLD] });
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS", text: "merhaba" }, none.deps)).toEqual({
      ok: false,
      message: `new tab in REPOS opened but its session was not found: no session start within ${READY_TIMEOUT_MS / 1000} s`,
    });
    expect(none.presses()).toBe(0);
    const two = setup({ after: [OLD, ID, "22222222-2222-4333-8444-555555555555"] });
    expect(await startNewTab({ id: "c", type: "newSession", cwd: "/r/REPOS" }, two.deps)).toEqual({
      ok: false,
      message: "new tab in REPOS opened but its session was not found: 2 new sessions appeared at once",
    });
  });
});
