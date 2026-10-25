import { describe, expect, it } from "vitest";
import {
  activeName,
  alreadyActive,
  markActive,
  newerUsage,
  panelActive,
  pickActive,
  snapshotAccount,
  usageForActive,
  useOutcome,
  useStartMs,
  USE_STUCK_MS,
  useStuck,
  type ActiveCandidate,
} from "../src/activeAccount";
import type { AccountsFile } from "../src/core";
import type { SwitchPanel } from "../src/switchPanel";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 1_800_000_000_000;

const own = (id: string, email: string, atMs: number): ActiveCandidate => ({ id, email, atMs, source: "claude.json" });
const panel = (over: Partial<SwitchPanel> = {}): SwitchPanel => ({ v: 1, ts: NOW / 1000 - 5, active: { uuid: B, email: "b@x.com" }, ...over });

describe("panelActive", () => {
  it("reads the active login of a fresh panel, stamped with its ts", () => {
    expect(panelActive(panel(), NOW)).toEqual({ id: B, email: "b@x.com", atMs: NOW - 5000, source: "panel.json" });
  });
  it("ignores a stale or missing panel and an active entry without a valid uuid or email", () => {
    expect(panelActive(null, NOW)).toBeUndefined();
    expect(panelActive(panel({ ts: NOW / 1000 - 601 }), NOW)).toBeUndefined();
    expect(panelActive(panel({ active: { uuid: "not-a-uuid", email: "b@x.com" } }), NOW)).toBeUndefined();
    expect(panelActive(panel({ active: { uuid: B } }), NOW)).toBeUndefined();
    expect(panelActive(panel({ active: undefined }), NOW)).toBeUndefined();
  });
});

describe("pickActive", () => {
  it("the fresher observation wins, a tie keeps ~/.claude.json", () => {
    const file = own(A, "a@x.com", NOW - 10_000);
    const p = { ...own(B, "b@x.com", NOW - 5_000), source: "panel.json" as const };
    expect(pickActive(file, p)).toBe(p);
    expect(pickActive({ ...file, atMs: NOW }, p)).toEqual({ ...file, atMs: NOW });
    expect(pickActive({ ...file, atMs: p.atMs }, p)?.source).toBe("claude.json");
  });
  it("uses whichever source exists", () => {
    const file = own(A, "a@x.com", NOW);
    expect(pickActive(file, undefined)).toBe(file);
    expect(pickActive(undefined, file)).toBe(file);
    expect(pickActive(undefined, undefined)).toBeUndefined();
  });
});

describe("markActive", () => {
  const reg: AccountsFile = {
    v: 1,
    activeId: A,
    accounts: [
      { id: A, email: "a@x.com", lastSeenTs: 100, tier: "max" },
      { id: B, email: "b@x.com", lastSeenTs: 50, tokenExpiresAt: 9, needsLogin: true, needsLoginFp: "fp" },
    ],
  };
  it("moves activeId to a known account, newest first, keeping token metadata and needsLogin", () => {
    const out = markActive(reg, { id: B, email: "b@x.com" }, 200);
    expect(out.activeId).toBe(B);
    expect(out.accounts.map((a) => a.id)).toEqual([B, A]);
    expect(out.accounts[0]).toEqual({ id: B, email: "b@x.com", lastSeenTs: 200, tokenExpiresAt: 9, needsLogin: true, needsLoginFp: "fp" });
    expect(reg.activeId).toBe(A); // input untouched
    expect(reg.accounts[1].lastSeenTs).toBe(50);
  });
  it("adds an unknown account with identity only", () => {
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const out = markActive(reg, { id: C, email: "c@x.com" }, 300);
    expect(out.activeId).toBe(C);
    expect(out.accounts[0]).toEqual({ id: C, email: "c@x.com", lastSeenTs: 300 });
    expect(out.accounts).toHaveLength(3);
  });
});

describe("alreadyActive", () => {
  it("is true only when the registry already names the account as the active login", () => {
    const reg: AccountsFile = { v: 1, activeId: B, accounts: [{ id: B, email: "b@x.com", lastSeenTs: 1 }] };
    expect(alreadyActive(reg, B)).toBe(true);
    expect(alreadyActive(reg, A)).toBe(false);
    expect(alreadyActive({ ...reg, accounts: [] }, B)).toBe(false); // activeId without its entry: rewrite
    expect(alreadyActive({ v: 1, accounts: [] }, B)).toBe(false);
  });
});

describe("snapshotAccount", () => {
  const after = NOW / 1000 + 1;
  it("trusts the acct tag", () => {
    expect(snapshotAccount({ ts: 1, acct: A }, B, NOW, undefined)).toBe(A);
  });
  it("attributes an untagged snapshot to the active login only when its own snapshot holds the same fetch, made after the last change", () => {
    expect(snapshotAccount({ ts: after }, B, NOW, { ts: after })).toBe(B);
    expect(snapshotAccount({ ts: 5 }, B, 0, { ts: 5 })).toBe(B); // nothing changed since activation
    expect(snapshotAccount({ ts: NOW / 1000 - 1 }, B, NOW, { ts: NOW / 1000 - 1 })).toBeNull(); // fetched before the switch
  });
  it("leaves an untagged snapshot unknown without that proof", () => {
    expect(snapshotAccount({ ts: after }, B, NOW, { ts: after - 90 })).toBeNull(); // the previous login's fetch
    expect(snapshotAccount({ ts: after }, B, NOW, undefined)).toBeNull();
    expect(snapshotAccount({ ts: 5 }, B, 0, undefined)).toBeNull(); // boot: the registry alone is no proof
    expect(snapshotAccount({ ts: after }, null, NOW, { ts: after })).toBeNull();
  });
});

describe("newerUsage", () => {
  it("keeps the later fetch, the first one on a tie, and whichever exists", () => {
    const old = { ts: 10 };
    const fresh = { ts: 20 };
    expect(newerUsage(old, fresh)).toBe(fresh);
    expect(newerUsage(fresh, old)).toBe(fresh);
    const tie = { ts: 10 };
    expect(newerUsage(old, tie)).toBe(old);
    expect(newerUsage(null, old)).toBe(old);
    expect(newerUsage(old, null)).toBe(old);
    expect(newerUsage(null, null)).toBeNull();
  });
});

describe("usageForActive", () => {
  const bUsage = { ts: 100, pct: 12 };
  const per = new Map([[B, { usage: bUsage }]]);
  it("shows the live poll only for the account it was fetched for", () => {
    const live = { ts: 200, pct: 50 };
    expect(usageForActive(A, { usage: live, acct: A }, per)).toBe(live);
    expect(usageForActive(B, { usage: live, acct: A }, per)).toBe(bUsage);
    expect(usageForActive("unknown", { usage: live, acct: A }, per)).toBeNull();
    expect(usageForActive(null, { usage: live, acct: null }, per)).toBe(live);
  });
  it("prefers a newer per-account fetch over an older live poll of the same account (newest wins)", () => {
    const stale = { ts: 50, pct: 100 }; // live poll before the switch away, A exhausted
    const reset = { ts: 90, pct: 4 }; // background poll after A's reset
    const perA = new Map([[A, { usage: reset }]]);
    expect(usageForActive(A, { usage: stale, acct: A }, perA)).toBe(reset);
    const newer = { ts: 95, pct: 6 };
    expect(usageForActive(A, { usage: newer, acct: A }, perA)).toBe(newer);
    expect(usageForActive(A, { usage: null, acct: A }, perA)).toBe(reset);
  });
});

describe("activeName", () => {
  it("matches the card header name, with the domain when local parts collide", () => {
    expect(activeName("ana@example.com", ["ben@example.com", "ana@example.com"])).toBe("ana");
    expect(activeName("sam@globex.com", ["sam@acme.com", "sam@globex.com"])).toBe("sam@globex");
    expect(activeName("new@x.com", ["a@x.com"])).toBe("new");
  });
});

describe("useStartMs", () => {
  it("starts at the click when it is plausible, else at receipt", () => {
    expect(useStartMs(NOW - 40, NOW)).toBe(NOW - 40);
    expect(useStartMs(NOW + 5, NOW)).toBe(NOW);
    expect(useStartMs(NOW - 61_000, NOW)).toBe(NOW);
    expect(useStartMs("x", NOW)).toBe(NOW);
    expect(useStartMs(undefined, NOW)).toBe(NOW);
  });
});

describe("useStuck", () => {
  it("gives a use up only after 90 s, past the CLI's 60 s timeout", () => {
    expect(USE_STUCK_MS).toBe(90_000);
    expect(useStuck(NOW, NOW + 60_000)).toBe(false);
    expect(useStuck(NOW, NOW + 90_000)).toBe(false);
    expect(useStuck(NOW, NOW + 90_001)).toBe(true);
  });
});

describe("useOutcome", () => {
  it("success reports the last stdout line", () => {
    expect(useOutcome(null, "warming up\nactive: b@x.com (Max)\n", "warning: capture failed: x\n")).toEqual({ ok: true, text: "active: b@x.com (Max)" });
    expect(useOutcome(null, "", "")).toEqual({ ok: true, text: "done" });
  });
  it("failure reports the CLI's error line, stderr first, capped at 200 characters", () => {
    expect(useOutcome({ message: "Command failed: claude-switch use b@x.com" }, "", "claude-switch: vault for b@x.com has no oauthAccount; log in once with that account\n")).toEqual({
      ok: false,
      text: "claude-switch: vault for b@x.com has no oauthAccount; log in once with that account",
    });
    expect(useOutcome({ message: "Command failed: x\nspawn claude-switch ENOENT" }, "", "").text).toBe("spawn claude-switch ENOENT");
    expect(useOutcome({ message: "x" }, "", "e".repeat(300)).text).toHaveLength(200);
    expect(useOutcome({ message: "x", killed: true }, "", "")).toEqual({ ok: false, text: "claude-switch use timed out" });
  });
});
