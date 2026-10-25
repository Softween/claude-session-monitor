import { describe, expect, it } from "vitest";
import {
  activeName,
  markActive,
  panelActive,
  pickActive,
  snapshotAccount,
  usageForActive,
  useOutcome,
  useStartMs,
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

describe("snapshotAccount", () => {
  it("trusts the acct tag, else attributes an untagged snapshot to the active login only when fetched after the last change", () => {
    expect(snapshotAccount({ ts: 1, acct: A }, B, NOW)).toBe(A);
    expect(snapshotAccount({ ts: NOW / 1000 + 1 }, B, NOW)).toBe(B);
    expect(snapshotAccount({ ts: NOW / 1000 - 1 }, B, NOW)).toBeNull();
    expect(snapshotAccount({ ts: 5 }, B, 0)).toBe(B); // nothing changed since activation
  });
});

describe("usageForActive", () => {
  const per = new Map([[B, { usage: "b-usage" }]]);
  it("shows the live poll only for the account it was fetched for", () => {
    expect(usageForActive(A, { usage: "live", acct: A }, per)).toBe("live");
    expect(usageForActive(B, { usage: "live-of-a", acct: A }, per)).toBe("b-usage");
    expect(usageForActive("unknown", { usage: "live", acct: A }, per)).toBeNull();
    expect(usageForActive(null, { usage: "live", acct: null }, per)).toBe("live");
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
