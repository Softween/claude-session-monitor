import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  REMOTE_PANEL_MAX_AGE_SEC,
  SWITCH_LOCK_STALE_MS,
  acquireSwitchLock,
  autoRotateOn,
  remoteSwitch,
  type LockDeps,
  type RemoteSwitchDeps,
  type SwitchTarget,
} from "../src/accountSwitch";
import type { SwitchPanel } from "../src/switchPanel";

const NOW = 1_800_000_000_000;
const acct = (id: string, email: string, weekly: number, active = false): SwitchTarget => ({
  id,
  email,
  active,
  stale: false,
  gauges: [{ key: "weekly", pct: weekly, resetMs: null }],
});
const ACCOUNTS = [acct("ua", "a@x.com", 95, true), acct("ub", "b@x.com", 20), acct("uc", "c@x.com", 60)];
const panel = (ageSec: number, emails = ["a@x.com", "b@x.com", "c@x.com"]): SwitchPanel => ({
  v: 1,
  ts: NOW / 1000 - ageSec,
  accounts: emails.map((email) => ({ email })),
});

/** The runner is mocked: startUse records the email and answers like the panel's Use path. */
function deps(over: Partial<RemoteSwitchDeps> = {}): RemoteSwitchDeps & { used: string[]; direct: string[] } {
  const used: string[] = [];
  const direct: string[] = [];
  return {
    used,
    direct,
    accounts: () => ACCOUNTS,
    switchInstalled: () => true,
    readPanel: () => panel(30),
    nowMs: () => NOW,
    busy: () => false,
    startUse: (email) => {
      used.push(email);
      return null;
    },
    switchDirect: async (id) => {
      direct.push(id);
      return true;
    },
    ...over,
  };
}

describe("remoteSwitch with claude-switch installed", () => {
  it("starts claude-switch use and answers at once; the extension's own switch never runs", async () => {
    const d = deps();
    expect(await remoteSwitch("b@x.com", d)).toEqual({
      ok: true,
      message: "started: claude-switch use b@x.com; the account list shows the result when it finishes",
    });
    expect(d.used).toEqual(["b@x.com"]);
    expect(d.direct).toEqual([]);
  });

  it("'best' and an account id go the same way, with the email as claude-switch lists it", async () => {
    const best = deps();
    expect((await remoteSwitch("best", best)).ok).toBe(true);
    expect(best.used).toEqual(["b@x.com"]); // most headroom

    const byId = deps({ readPanel: () => panel(30, ["a@x.com", "C@X.com"]) });
    expect((await remoteSwitch("UC", byId)).ok).toBe(true);
    expect(byId.used).toEqual(["C@X.com"]);
  });

  it("refuses with a reason when panel.json is missing, older than 5 minutes or does not list the target", async () => {
    const cases: Array<[SwitchPanel | null, string]> = [
      [null, "claude-switch is installed but its panel.json is missing or unreadable; not switching"],
      [panel(REMOTE_PANEL_MAX_AGE_SEC + 1), `claude-switch's panel.json is ${REMOTE_PANEL_MAX_AGE_SEC + 1} s old (over 5 min); not switching`],
      [panel(30, ["a@x.com", "c@x.com"]), "claude-switch does not list b@x.com; not switching"],
    ];
    for (const [p, message] of cases) {
      const d = deps({ readPanel: () => p });
      expect(await remoteSwitch("b@x.com", d)).toEqual({ ok: false, message });
      expect(d.used).toEqual([]);
      expect(d.direct).toEqual([]);
    }
    expect(REMOTE_PANEL_MAX_AGE_SEC).toBe(300);
    const edge = deps({ readPanel: () => panel(REMOTE_PANEL_MAX_AGE_SEC) });
    expect((await remoteSwitch("b@x.com", edge)).ok).toBe(true);
  });

  it("passes on why claude-switch use did not start", async () => {
    const d = deps({ startUse: () => "already switching to c@x.com" });
    expect(await remoteSwitch("b@x.com", d)).toEqual({ ok: false, message: "already switching to c@x.com" });
  });
});

describe("remoteSwitch without claude-switch", () => {
  it("runs the extension's own switch and reports its end", async () => {
    const d = deps({ switchInstalled: () => false, readPanel: () => null });
    expect(await remoteSwitch("b@x.com", d)).toEqual({ ok: true, message: "switched to b@x.com" });
    expect(d.direct).toEqual(["ub"]);
    expect(d.used).toEqual([]);

    const failed = deps({ switchInstalled: () => false, switchDirect: async () => false });
    expect(await remoteSwitch("b@x.com", failed)).toEqual({ ok: false, message: "switch to b@x.com did not complete" });
  });
});

describe("remoteSwitch on either path", () => {
  it("refuses while a switch runs, names unknown accounts and needs nothing for the active one", async () => {
    expect(await remoteSwitch("b@x.com", deps({ busy: () => true }))).toEqual({ ok: false, message: "an account switch is already running" });
    expect(await remoteSwitch("z@x.com", deps())).toEqual({ ok: false, message: "unknown account z@x.com" });
    expect(await remoteSwitch("best", deps({ accounts: () => [acct("ua", "a@x.com", 95, true)] }))).toEqual({
      ok: true,
      message: "already on a@x.com",
    });
    expect(await remoteSwitch("best", deps({ accounts: () => [] }))).toEqual({ ok: false, message: "no other account with usage data" });
  });
});

describe("autoRotateOn", () => {
  it("keeps the extension's auto-rotate off while claude-switch is installed, because claude-switch rotates", () => {
    expect(autoRotateOn(true, true)).toBe(false);
    expect(autoRotateOn(true, false)).toBe(true);
    expect(autoRotateOn(false, false)).toBe(false);
  });
});

describe("acquireSwitchLock", () => {
  let dir: string;
  let file: string;
  const live = new Set<number>([111, 222]);
  const at = (pid: number, nowMs = NOW): LockDeps => ({ pid, nowMs: () => nowMs, alive: (p) => live.has(p) });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-lock-"));
    file = path.join(dir, "account-switch.lock");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is exclusive across holders, private, and free again once released", () => {
    const release = acquireSwitchLock(file, at(111));
    expect(release).toBeTypeOf("function");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^111 1800000000000 \S+$/);
    expect(acquireSwitchLock(file, at(222))).toBeNull();
    release!();
    expect(fs.existsSync(file)).toBe(false);
    const again = acquireSwitchLock(file, at(222));
    expect(again).toBeTypeOf("function");
    again!();
  });

  it("takes over a lock whose holder died or that is older than 5 minutes", () => {
    fs.writeFileSync(file, `333 ${NOW} dead`); // pid 333 is not alive
    const fromDead = acquireSwitchLock(file, at(111));
    expect(fromDead).toBeTypeOf("function");
    fromDead!();

    fs.writeFileSync(file, `222 ${NOW - SWITCH_LOCK_STALE_MS - 1} old`);
    const fromOld = acquireSwitchLock(file, at(111));
    expect(fromOld).toBeTypeOf("function");
    expect(fs.readFileSync(file, "utf8")).toMatch(/^111 /);
    fromOld!();
    expect(SWITCH_LOCK_STALE_MS).toBe(300_000);
  });

  it("a release never removes a lock that another holder took over", () => {
    const release = acquireSwitchLock(file, at(111));
    fs.writeFileSync(file, `222 ${NOW} other`);
    release!();
    expect(fs.readFileSync(file, "utf8")).toBe(`222 ${NOW} other`);
  });

  it("creates the lock's folder when it is missing", () => {
    const nested = path.join(dir, "missing", "account-switch.lock");
    const release = acquireSwitchLock(nested, at(111));
    expect(release).toBeTypeOf("function");
    release!();
  });
});
