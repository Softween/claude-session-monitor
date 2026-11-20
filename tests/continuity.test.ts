import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ContinuityServer,
  continuityDir,
  focusBySlot,
  gateOf,
  heartbeat,
  pickTab,
  readText,
  restoreAfter,
  servable,
  servedFrom,
  storageDir,
  storageKey,
  windowKey,
  withServed,
  writeTextAtomic,
  type Gate,
  type ServerDeps,
  type Served,
  type TabRef,
} from "../src/continuity";
import type { LiveSession } from "../src/wakeTabs";

const NOW = Date.UTC(2026, 10, 18, 11, 25, 0); // a whole second
const NOW_S = NOW / 1000;
const STORAGE = "/Users/u/Library/Application Support/Code/User/workspaceStorage/4f9d0c7b1e2a3d5c6b7a8f9e0d1c2b3a";
const SID = "0b563428-5f1e-4c7a-9d2b-3e4f5a6b7c8d";
const SID2 = "1c674539-6a2f-4d8b-8e3c-4f5a6b7c8d9e";
const request = (id: string, sid = SID, title = "Fix the build", over: Record<string, unknown> = {}) => ({
  id,
  sid,
  storage: STORAGE,
  title,
  action: "open",
  ts: NOW_S - 10,
  expires: NOW_S + 900,
  ...over,
});
const file = (...requests: unknown[]) => ({ v: 1, ts: NOW_S - 10, requests });
const done = (sid: string, result: Served["result"], ts = NOW_S): Served => ({ sid, result, detail: "", ts });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("addressing", () => {
  it("storage is the workspace-storage directory; the heartbeat key is the first 16 hex of its sha256", () => {
    expect(storageDir(`${STORAGE}/softween.claude-code-session-monitor`)).toBe(STORAGE);
    expect(storageDir(undefined)).toBeUndefined();
    expect(storageKey(STORAGE)).toBe("c7464c24ed54e168"); // python3: hashlib.sha256(path.encode()).hexdigest()[:16]
    expect(storageKey(`${STORAGE}-2`)).not.toBe("c7464c24ed54e168");
    expect(windowKey(STORAGE, 4242)).toBe("c7464c24ed54e168"); // the key of the debug log and the health file too
    expect(windowKey(undefined, 4242)).toBe("empty-4242");
    expect(continuityDir("/home/u")).toBe("/home/u/.claude/state/continuity");
  });
});

describe("requests", () => {
  it("serves only the requests addressed to this window's storage directory, in the daemon's order", () => {
    const raw = file(request("r1"), request("r2", SID2, "Other", { storage: `${STORAGE}-2` }), request("r3", SID2, "Other"));
    expect(servable(raw, STORAGE, NOW, new Map())).toEqual([
      { id: "r1", sid: SID, title: "Fix the build" },
      { id: "r3", sid: SID2, title: "Other" },
    ]);
  });

  it("ignores expired requests (epoch seconds)", () => {
    const raw = file(request("past", SID, "t", { expires: NOW_S - 1 }), request("now", SID, "t", { expires: NOW_S }), request("next", SID, "t", { expires: NOW_S + 1 }));
    expect(servable(raw, STORAGE, NOW, new Map()).map((r) => r.id)).toEqual(["next"]);
  });

  it("ignores a sid that is not a UUID, another action, no title or id, an unknown version and a malformed file", () => {
    const bad = file(
      request("upper", SID.toUpperCase()),
      request("short", "0b563428"),
      request("path", `../${SID}`),
      request("close", SID, "t", { action: "close" }),
      request("untitled", SID, ""),
      request("noid", SID, "t", { id: "" }),
      request("noexpiry", SID, "t", { expires: "soon" }),
      null,
      "text",
    );
    expect(servable(bad, STORAGE, NOW, new Map())).toEqual([]);
    expect(servable({ ...file(request("r1")), v: 2 }, STORAGE, NOW, new Map())).toEqual([]);
    for (const raw of [undefined, null, "text", [], { v: 1 }, { v: 1, requests: {} }]) expect(servable(raw, STORAGE, NOW, new Map())).toEqual([]);
  });

  it("ignores an id already answered; one with no-process stays for its second try", () => {
    const served = new Map<string, Served>([
      ["a", done(SID, "opened")],
      ["b", done(SID, "no-tab")],
      ["c", done(SID, "failed")],
      ["d", done(SID, "no-process")],
    ]);
    const raw = file(...["a", "b", "c", "d", "e"].map((id) => request(id)));
    expect(servable(raw, STORAGE, NOW, served).map((r) => r.id)).toEqual(["d", "e"]);
  });
});

describe("gate", () => {
  it("shows while the window is unfocused or input idles 20 s; user-active only when focused and not idle (unreadable: focus alone)", () => {
    const table: Array<[boolean, number | undefined, number | undefined, Gate]> = [
      [false, 0, 1, "ok"],
      [false, undefined, 1, "ok"],
      [true, 20_000, 1, "ok"],
      [true, 19_999, 1, "user-active"],
      [true, undefined, 1, "user-active"],
      [true, 0, 4, "user-active"],
      [false, 0, 4, "memory"],
      [true, 60_000, 4, "memory"],
      [false, 0, 2, "ok"],
      [false, 0, undefined, "ok"],
    ];
    for (const [focused, idle, pressure, gate] of table) {
      expect([focused, idle, pressure, gateOf(focused, idle, pressure)]).toEqual([focused, idle, pressure, gate]);
    }
  });
});

describe("tab to show", () => {
  const tab = (group: string, id: string, label: string, active = false, claude = true): TabRef<string, string> => ({ group, tab: id, label, claude, active });

  it("none: no Claude Code tab carries the title (another tab with that label or a longer label does not count)", () => {
    expect(pickTab([tab("g0", "t0", "Fix the build", false, false), tab("g0", "t1", "Fix the build!")], "Fix the build", 1)).toEqual({ kind: "none", detail: "" });
  });

  it("untitled (the default label Claude Code): only when exactly one Claude Code tab carries it, else none (untitled)", () => {
    const one = [tab("g0", "t0", "Claude Code"), tab("g0", "t1", "Fix the build")];
    expect(pickTab(one, "Claude Code", 1)).toEqual({ kind: "reveal", ref: one[0], ambiguous: false });
    expect(pickTab([tab("g0", "t0", "Claude Code"), tab("g1", "t1", "Claude Code")], "Claude Code", 1)).toEqual({ kind: "none", detail: "untitled" });
    expect(pickTab([tab("g0", "t0", "Fix the build")], "Claude Code", 1)).toEqual({ kind: "none", detail: "untitled" });
  });

  it("one: that tab", () => {
    const tabs = [tab("g0", "t0", "Other", true), tab("g0", "t1", "Fix the build")];
    expect(pickTab(tabs, "Fix the build", 1)).toEqual({ kind: "reveal", ref: tabs[1], ambiguous: false });
  });

  it("several: one per try in tab order, active ones skipped, ambiguous", () => {
    const tabs = [tab("g0", "t0", "Fix the build", true), tab("g0", "t1", "Fix the build"), tab("g1", "t2", "Fix the build")];
    expect(pickTab(tabs, "Fix the build", 1)).toEqual({ kind: "reveal", ref: tabs[1], ambiguous: true });
    expect(pickTab(tabs, "Fix the build", 2)).toEqual({ kind: "reveal", ref: tabs[2], ambiguous: true });
  });

  it("already the active tab of its group: active", () => {
    expect(pickTab([tab("g0", "t0", "Fix the build", true)], "Fix the build", 1)).toEqual({ kind: "active", ambiguous: false });
    expect(pickTab([tab("g0", "t0", "Fix the build", true), tab("g1", "t1", "Fix the build", true)], "Fix the build", 2)).toEqual({
      kind: "active",
      ambiguous: true,
    });
  });
});

describe("focusing a tab group", () => {
  const COMMANDS = ["focusFirstEditorGroup", "focusSecondEditorGroup", "focusThirdEditorGroup"];
  /** Groups listed in creation order (tabGroups.all); like VS Code's, a focus command picks the group at its screen slot. */
  function editor(groups: Array<{ name: string; viewColumn: number }>) {
    let active = groups[0];
    const run = vi.fn(async (command: string) => {
      active = groups.find((g) => g.viewColumn === COMMANDS.indexOf(command) + 1) ?? active;
    });
    return { run, active: () => active };
  }

  it("uses the group's screen slot (viewColumn), not its place in creation order", async () => {
    const first = { name: "created first, now on the right", viewColumn: 2 };
    const split = { name: "split later, moved to the left", viewColumn: 1 };
    const e = editor([first, split]);
    await focusBySlot(first, COMMANDS, e.run, e.active);
    expect(e.run.mock.calls).toEqual([["focusSecondEditorGroup"]]);
    expect(e.active()).toBe(first);
  });

  it("throws when the group did not become active or has no focus command", async () => {
    const g = { viewColumn: 2 };
    await expect(focusBySlot(g, COMMANDS, async () => undefined, () => ({ viewColumn: 1 }))).rejects.toThrow("editor group 2 did not become active");
    await expect(focusBySlot({ viewColumn: 4 }, COMMANDS, async () => undefined, () => g)).rejects.toThrow("editor group 4 cannot be focused");
  });
});

describe("focus restore decision", () => {
  const memo = { activeGroup: "g1", group: "g0", groupTab: "t0", tab: "t5" };

  it("the shown tab is still its group's active tab in the active group: the former tab and group come back", () => {
    expect(restoreAfter(memo, "g0", "t5")).toEqual({ tab: "t0", group: "g1" });
  });

  it("the user changed the active tab or group, or the show never landed: nothing is touched", () => {
    expect(restoreAfter(memo, "g0", "t3")).toBeUndefined();
    expect(restoreAfter(memo, "g1", "t5")).toBeUndefined();
    expect(restoreAfter(memo, "g1", "t0")).toBeUndefined();
  });
});

describe("results", () => {
  it("keeps the newest 50; an answered id moves to the end", () => {
    let m = new Map<string, Served>();
    for (let i = 0; i < 51; i++) m = withServed(m, `r${i}`, done(SID, "opened", NOW_S + i));
    expect(m.size).toBe(50);
    expect([...m.keys()][0]).toBe("r1");
    m = withServed(m, "r1", done(SID, "failed", NOW_S + 60));
    expect(m.size).toBe(50);
    expect([...m.keys()].slice(-2)).toEqual(["r50", "r1"]);
  });

  it("come back from this window's last heartbeat: same storage, valid entries, oldest first", () => {
    const hb = heartbeat(STORAGE, "2.38.0", 1, NOW_S, "ok", new Map([["b", done(SID, "opened")], ["a", done(SID, "no-process", NOW_S - 5)]]));
    const raw = { ...hb, served: { ...hb.served, bad: { sid: SID, result: "maybe", detail: "", ts: 1 } } };
    expect([...servedFrom(raw, STORAGE).keys()]).toEqual(["a", "b"]);
    expect(servedFrom(raw, `${STORAGE}-2`).size).toBe(0);
    expect(servedFrom({ ...raw, v: 2 }, STORAGE).size).toBe(0);
    expect(servedFrom(undefined, STORAGE).size).toBe(0);
  });
});

describe("ContinuityServer", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-continuity-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeRequests = (...reqs: unknown[]) => fs.writeFileSync(path.join(dir, "requests.json"), JSON.stringify(file(...reqs)));
  const beatFile = () => JSON.parse(fs.readFileSync(path.join(dir, "ext", `${storageKey(STORAGE)}.json`), "utf8"));

  /** A window whose reveal lands `landMs` after the call (0: before the call returns, as VS Code's); a shown Claude tab gets its process 100 ms later. */
  function fakeWindow(landMs = 300) {
    const groups = new Map<string, { tabs: Array<{ id: string; label: string; claude: boolean; sid?: string }>; active: string }>([
      [
        "g0",
        {
          tabs: [
            { id: "editor", label: "notes.md", claude: false },
            { id: "c1", label: "Fix the build", claude: true, sid: SID },
            { id: "c2", label: "Write the docs", claude: true, sid: SID2 },
          ],
          active: "editor",
        },
      ],
      ["g1", { tabs: [{ id: "term", label: "Terminal", claude: false }], active: "term" }],
    ]);
    const state = { activeGroup: "g1", live: [] as LiveSession[], spawn: true };
    const calls: string[] = [];
    const group = (g: string) => groups.get(g) as { tabs: Array<{ id: string; label: string; claude: boolean; sid?: string }>; active: string };
    const land = (fn: () => void): void => {
      if (landMs === 0) fn();
      else setTimeout(fn, landMs);
    };
    const reveal = async (g: string, t: string): Promise<void> => {
      calls.push(`reveal ${g}/${t}`);
      land(() => {
        group(g).active = t;
        state.activeGroup = g;
        const sid = group(g).tabs.find((x) => x.id === t)?.sid;
        if (sid && state.spawn) setTimeout(() => state.live.push({ sessionId: sid, pid: 4242, entrypoint: "claude-vscode" }), 100);
      });
    };
    const focusGroup = async (g: string): Promise<void> => {
      calls.push(`focus ${g}`);
      land(() => (state.activeGroup = g));
    };
    const tabs = (): Array<TabRef<string, string>> =>
      [...groups].flatMap(([g, x]) => x.tabs.map((t) => ({ group: g, tab: t.id, label: t.label, claude: t.claude, active: x.active === t.id })));
    return { group, state, calls, reveal, focusGroup, tabs, activeGroup: () => state.activeGroup, activeTabOf: (g: string) => groups.get(g)?.active };
  }

  /** A server over a fake window, activated `activatedAgoMs` ago (default: past the 60 s first-step delay). */
  function server(over: Partial<ServerDeps<string, string>> = {}, opts: { landMs?: number; activatedAgoMs?: number } = {}) {
    const win = fakeWindow(opts.landMs);
    const logs: string[] = [];
    const read = vi.fn(readText);
    const write = vi.fn(writeTextAtomic);
    const deps: ServerDeps<string, string> = {
      enabled: () => true,
      storage: STORAGE,
      version: "2.38.0",
      pid: 3203,
      dir,
      now: () => Date.now(),
      log: (m) => {
        logs.push(m);
      },
      read,
      write,
      liveSessions: () => win.state.live,
      windowFocused: () => false,
      idleMs: async () => 0,
      pressureLevel: async () => 1,
      othersBusy: () => false,
      tabs: win.tabs,
      activeGroup: win.activeGroup,
      activeTabOf: win.activeTabOf,
      reveal: win.reveal,
      focusGroup: win.focusGroup,
      ...over,
    };
    const t = Date.now();
    vi.setSystemTime(t - (opts.activatedAgoMs ?? 60_000));
    const srv = new ContinuityServer(deps);
    vi.setSystemTime(t);
    return { win, logs, read, write, srv };
  }

  /** Refresh cycles every `stepMs` for `ms`, as extension.ts calls observe(). */
  async function cycles(srv: ContinuityServer<string, string>, ms: number, stepMs = 10_000): Promise<void> {
    for (let t = 0; t < ms; t += stepMs) {
      srv.observe();
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }

  it("makes the session's existing tab active, waits for its process, then puts the group's tab and the active group back", async () => {
    const s = server();
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual(["reveal g0/c1"]);
    expect(s.win.activeTabOf("g0")).toBe("editor"); // the reveal has not landed yet
    await vi.advanceTimersByTimeAsync(500); // landed at 0.3 s, process at 0.4 s, seen at 0.5 s
    expect(s.win.calls).toEqual(["reveal g0/c1", "reveal g0/editor", "focus g1"]);
    await vi.advanceTimersByTimeAsync(300);
    expect([s.win.state.activeGroup, s.win.activeTabOf("g0")]).toEqual(["g1", "editor"]);
    expect(beatFile()).toEqual({
      v: 1,
      storage: STORAGE,
      version: "2.38.0",
      pid: 3203,
      ts: NOW_S,
      enabled: true,
      gate: "ok",
      served: { r1: { sid: SID, result: "opened", detail: "", ts: NOW_S } },
    });
    expect(s.logs).toContain("continuity: 0b563428 opened after 0.5s pid=4242, try 1/2, request r1");
  });

  it("leaves the tabs alone when the user changed the active tab during the wait", async () => {
    const s = server();
    s.win.state.spawn = false;
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(1_000);
    s.win.group("g0").active = "c2";
    await vi.advanceTimersByTimeAsync(19_000);
    expect(s.win.calls).toEqual(["reveal g0/c1"]);
    expect(beatFile().served.r1).toEqual({ sid: SID, result: "no-process", detail: "", ts: NOW_S + 20 });
  });

  it("a reveal that lands before the call returns: what was active before the show comes back (the memo is taken before it)", async () => {
    const s = server({}, { landMs: 0 });
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(500);
    expect(s.win.calls).toEqual(["reveal g0/c1", "reveal g0/editor", "focus g1"]);
    expect([s.win.state.activeGroup, s.win.activeTabOf("g0")]).toEqual(["g1", "editor"]);
    expect(beatFile().served.r1).toMatchObject({ result: "opened" });
  });

  it("the first step waits 60 s after activation; the heartbeat is written from the start", async () => {
    const s = server({}, { activatedAgoMs: 0 });
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(beatFile()).toMatchObject({ ts: NOW_S, gate: "ok", served: {} });
    await cycles(s.srv, 60_000);
    expect(s.win.calls).toEqual([]);
    expect(s.srv.pending()).toBe(true); // the limit-stopped wakes wait for it meanwhile
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual(["reveal g0/c1"]);
  });

  it("skips the restore while the user types in this window (focused, input idle under 2 s)", async () => {
    let focused = false;
    let idle: number | undefined = 60_000;
    const s = server({ windowFocused: () => focused, idleMs: async () => idle });
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(400);
    focused = true; // the user came back during the wait
    idle = 500;
    await vi.advanceTimersByTimeAsync(100);
    expect(s.win.calls).toEqual(["reveal g0/c1"]);
    expect(s.logs).toContain("continuity: tab restore skipped, the user is typing");
    expect(beatFile().served.r1).toMatchObject({ result: "opened" });
  });

  it("restores when the window is focused but input idle cannot be read", async () => {
    let focused = false;
    const s = server({ windowFocused: () => focused, idleMs: async () => undefined });
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(400);
    focused = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(s.win.calls).toEqual(["reveal g0/c1", "reveal g0/editor", "focus g1"]);
  });

  it("checks the focus again right before the show: focused with input not idle is user-active and uses no try", async () => {
    let focused = false;
    let pressureChecks = 0;
    const s = server({
      windowFocused: () => focused,
      idleMs: async () => 5_000,
      pressureLevel: async () => {
        if (++pressureChecks === 2) focused = true; // the user clicks into the window during the step's gate check
        return 1;
      },
    });
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual([]);
    expect(beatFile()).toMatchObject({ gate: "user-active", served: {} });
    focused = false;
    await cycles(s.srv, 20_000);
    expect(s.win.calls[0]).toBe("reveal g0/c1");
    expect(s.logs.filter((l) => l.startsWith("continuity: gate") || l.includes("request r1"))).toEqual([
      "continuity: gate ok",
      "continuity: gate user-active (was ok)",
      "continuity: gate ok (was user-active)",
      "continuity: 0b563428 opened after 0.5s pid=4242, try 1/2, request r1",
    ]);
  });

  it("an untitled request answers no-tab (untitled) when not exactly one tab carries the default label", async () => {
    const s = server();
    s.win.group("g0").tabs.push({ id: "u1", label: "Claude Code", claude: true, sid: SID }, { id: "u2", label: "Claude Code", claude: true, sid: SID2 });
    writeRequests(request("r1", SID, "Claude Code"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual([]);
    expect(beatFile().served.r1).toEqual({ sid: SID, result: "no-tab", detail: "untitled", ts: NOW_S });
    expect(s.logs).toContain("continuity: 0b563428 no-tab (untitled), request r1");
  });

  it("no Claude Code tab with the title: no-tab, nothing shown, final; the next request is served in the same step", async () => {
    const s = server();
    writeRequests(request("r1", SID, "Closed tab"), request("r2", SID2, "Write the docs"));
    await cycles(s.srv, 60_000);
    expect(s.win.calls.filter((c) => !c.endsWith("/editor") && !c.startsWith("focus"))).toEqual(["reveal g0/c2"]);
    expect(beatFile().served.r1).toEqual({ sid: SID, result: "no-tab", detail: "", ts: NOW_S });
    expect(s.logs.filter((l) => l.includes("request r1"))).toEqual(["continuity: 0b563428 no-tab, request r1"]);
  });

  it("a session whose process already runs is opened (already live) without showing anything", async () => {
    const s = server();
    s.win.state.live.push({ sessionId: SID, pid: 77, entrypoint: "claude-vscode" });
    writeRequests(request("r1"));
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual([]);
    expect(beatFile().served.r1).toEqual({ sid: SID, result: "opened", detail: "already live", ts: NOW_S });
    expect(s.logs).toContain("continuity: 0b563428 opened (already live) pid=77, request r1");
  });

  it("two tries per request: no-process, then failed; never a third", async () => {
    const s = server();
    s.win.state.spawn = false;
    writeRequests(request("r1"));
    await cycles(s.srv, 120_000);
    expect(s.win.calls.filter((c) => c === "reveal g0/c1")).toHaveLength(2);
    expect(beatFile().served.r1).toMatchObject({ result: "failed", detail: "no process" });
    expect(s.logs.filter((l) => l.includes("request r1"))).toEqual([
      "continuity: 0b563428 no-process after 20.0s, try 1/2, request r1",
      "continuity: 0b563428 failed (no process) after 20.0s, try 2/2, request r1",
    ]);
  });

  it("several tabs with the title: one per try in tab order, ambiguous title", async () => {
    const s = server();
    s.win.state.spawn = false;
    s.win.group("g1").tabs.push({ id: "c3", label: "Fix the build", claude: true, sid: SID });
    writeRequests(request("r1"));
    await cycles(s.srv, 120_000);
    expect(s.win.calls.filter((c) => c.endsWith("/c1") || c.endsWith("/c3"))).toEqual(["reveal g0/c1", "reveal g1/c3"]);
    expect(beatFile().served.r1).toMatchObject({ result: "failed", detail: "ambiguous title" });
  });

  it("the tab is already its group's active tab and the session has no process: no-process without showing anything", async () => {
    const s = server();
    s.win.group("g0").active = "c1";
    writeRequests(request("r1"));
    await cycles(s.srv, 20_000);
    expect(s.win.calls).toEqual([]);
    expect(s.logs.filter((l) => l.includes("request r1"))).toEqual([
      "continuity: 0b563428 no-process (tab already active), try 1/2, request r1",
      "continuity: 0b563428 failed (tab already active), try 2/2, request r1",
    ]);
  });

  it("an error while showing the tab fails the request at once", async () => {
    const s = server({
      reveal: async () => {
        throw new Error("editor group 9 cannot be focused");
      },
    });
    writeRequests(request("r1"));
    await cycles(s.srv, 40_000);
    expect(s.win.calls).toEqual([]); // nothing else changes: no restore
    expect([s.win.state.activeGroup, s.win.activeTabOf("g0")]).toEqual(["g1", "editor"]);
    expect(beatFile().served.r1).toMatchObject({ result: "failed", detail: "editor group 9 cannot be focused" });
    expect(s.logs.filter((l) => l.includes("request r1"))).toEqual([
      "continuity: 0b563428 failed (editor group 9 cannot be focused) after 0.0s, try 1/2, request r1",
    ]);
  });

  it("waits while this window is focused and input is not idle; the heartbeat names the gate, each change is logged once", async () => {
    let focused = true;
    const s = server({ windowFocused: () => focused, idleMs: async () => 5_000 });
    writeRequests(request("r1"));
    await cycles(s.srv, 40_000);
    expect(s.win.calls).toEqual([]);
    expect(beatFile().gate).toBe("user-active");
    focused = false;
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual(["reveal g0/c1"]);
    expect(s.logs.filter((l) => l.startsWith("continuity: gate"))).toEqual(["continuity: gate user-active", "continuity: gate ok (was user-active)"]);
  });

  it("waits under critical memory pressure", async () => {
    const s = server({ pressureLevel: async () => 4 });
    writeRequests(request("r1"));
    await cycles(s.srv, 40_000);
    expect(s.win.calls).toEqual([]);
    expect(beatFile().gate).toBe("memory");
  });

  it("waits while a limit-stopped tab wake runs and meanwhile asks the waker to let it go first", async () => {
    let wakeRuns = true;
    const s = server({ othersBusy: () => wakeRuns });
    writeRequests(request("r1"));
    await cycles(s.srv, 20_000);
    expect(s.win.calls).toEqual([]);
    expect(s.srv.pending()).toBe(true);
    wakeRuns = false;
    s.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.win.calls).toEqual(["reveal g0/c1"]);
  });

  it("writes a heartbeat every 15 s", async () => {
    const s = server();
    await cycles(s.srv, 46_500, 1_500);
    expect(s.write).toHaveBeenCalledTimes(4); // at 0, 15, 30 and 45 s
    expect(beatFile()).toEqual({ v: 1, storage: STORAGE, version: "2.38.0", pid: 3203, ts: NOW_S + 45, enabled: true, gate: "ok", served: {} });
  });

  it("a reloaded window brings back the results of its last heartbeat and does not serve them again", async () => {
    const first = server();
    first.win.state.live.push({ sessionId: SID, pid: 77 });
    writeRequests(request("r1"));
    first.srv.observe();
    await vi.advanceTimersByTimeAsync(0);
    first.srv.dispose();
    const second = server();
    second.srv.observe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.logs[0]).toBe(`continuity: channel on key=${storageKey(STORAGE)} pid=3203 served=1`);
    expect(second.win.calls).toEqual([]);
    expect(beatFile().served.r1).toMatchObject({ result: "opened", detail: "already live" });
  });

  it("setting off: nothing is read, written, shown or logged", async () => {
    const s = server({ enabled: () => false });
    writeRequests(request("r1"));
    await cycles(s.srv, 120_000);
    expect(s.srv.pending()).toBe(false);
    expect(s.read).not.toHaveBeenCalled();
    expect(s.write).not.toHaveBeenCalled();
    expect(s.win.calls).toEqual([]);
    expect(s.logs).toEqual([]);
    expect(fs.existsSync(path.join(dir, "ext"))).toBe(false);
  });

  it("no folder open (no storage directory): the channel is off in that window", async () => {
    const s = server({ storage: undefined });
    writeRequests(request("r1"));
    await cycles(s.srv, 30_000);
    expect(s.read).not.toHaveBeenCalled();
    expect(s.write).not.toHaveBeenCalled();
    expect(s.logs).toEqual(["continuity: channel off in this window (no folder open)"]);
  });

  it("writes atomically (0600, folders created, no temp file left) and reads a missing file as undefined", () => {
    const f = path.join(dir, "ext", "k.json");
    writeTextAtomic(f, "{}");
    writeTextAtomic(f, '{"a":1}');
    expect(readText(f)).toBe('{"a":1}');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(dir, "ext"))).toEqual(["k.json"]);
    expect(readText(path.join(dir, "missing.json"))).toBeUndefined();
  });
});
