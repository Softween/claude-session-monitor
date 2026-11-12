import { describe, expect, it } from "vitest";
import {
  autoResumeOn,
  limitedToResume,
  readOverrides,
  rowAutoResume,
  settledOverrides,
  sweepQueue,
  withOverride,
} from "../src/autoResume";
import { defaultCapabilities, type SessionView } from "../src/providers/types";

const NOW = 1_800_000_000_000;

const row = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  key: `claude:${id}`,
  provider: "claude",
  sessionId: id,
  title: id,
  bucket: "working",
  sub: "working",
  detail: "",
  tooltip: "",
  capabilities: defaultCapabilities("claude"),
  lastActivityMs: NOW,
  stale: false,
  matchLabels: [],
  ...over,
});
const limited = (id: string, over: Partial<SessionView> = {}) => row(id, { bucket: "limited", sub: "session limit", resetText: "9pm", ...over });

describe("auto-resume overrides", () => {
  it("reads only well-formed entries younger than 7 days", () => {
    const raw = {
      a: { enabled: true, setAt: NOW - 1000 },
      b: { enabled: false, setAt: NOW - 8 * 24 * 3600_000 },
      c: { enabled: "yes", setAt: NOW },
      d: null,
      e: { enabled: false, setAt: NOW + 3600_000 },
    };
    expect(readOverrides(raw, NOW)).toEqual({ a: { enabled: true, setAt: NOW - 1000 } });
    expect(readOverrides(undefined, NOW)).toEqual({});
    expect(readOverrides([1, 2], NOW)).toEqual({});
  });

  it("sets one session and keeps the newest 500", () => {
    let o = {};
    for (let i = 0; i < 505; i++) o = withOverride(o, `s${i}`, i % 2 === 0, NOW + i);
    expect(Object.keys(o)).toHaveLength(500);
    expect((o as Record<string, unknown>).s0).toBeUndefined();
    expect(withOverride(o, "s504", false, NOW + 999).s504).toEqual({ enabled: false, setAt: NOW + 999 });
  });

  it("drops a choice once its session is listed as not limited, keeps unlisted and limited ones", () => {
    const o = { lim: { enabled: true, setAt: NOW }, back: { enabled: false, setAt: NOW }, gone: { enabled: true, setAt: NOW } };
    expect(settledOverrides(o, [limited("lim"), row("back")])).toEqual({ lim: o.lim, gone: o.gone });
    expect(settledOverrides(o, [limited("lim"), limited("back")])).toBeNull();
    expect(settledOverrides(o, [row("lim", { provider: "codex", key: "codex:lim" })])).toBeNull();
  });
});

describe("who the auto-resume sweep is for", () => {
  const views = [
    limited("on"),
    limited("off"),
    limited("plain"),
    row("working"),
    row("done", { bucket: "attention", sub: "your turn" }),
    row("ended", { bucket: "ended", sub: "ended" }),
    row("codex", { provider: "codex", key: "codex:codex", bucket: "limited", sub: "session limit" }),
    limited("nobulk", { capabilities: defaultCapabilities("claude", { bulkInput: false }) }),
  ];
  const o = { on: { enabled: true, setAt: NOW }, off: { enabled: false, setAt: NOW } };
  const ids = (vs: SessionView[]) => vs.map((v) => v.sessionId);

  it("with the setting on: everything open except the limited sessions switched off", () => {
    expect(ids(sweepQueue(views, o, true))).toEqual(["on", "plain", "working", "done"]);
    expect(ids(limitedToResume(views, o, true))).toEqual(["on", "plain", "nobulk"]);
  });

  it("with the setting off: only the limited sessions switched on", () => {
    expect(ids(sweepQueue(views, o, false))).toEqual(["on"]);
    expect(ids(limitedToResume(views, o, false))).toEqual(["on"]);
    expect(autoResumeOn(limited("plain"), o, false)).toBe(false);
  });

  it("puts {enabled, at} on limited Claude rows only, at = the scheduled sweep while on", () => {
    expect(rowAutoResume(limited("on"), o, false, NOW + 90_500)).toEqual({ enabled: true, at: Math.floor((NOW + 90_500) / 1000) });
    expect(rowAutoResume(limited("off"), o, true, NOW + 90_500)).toEqual({ enabled: false, at: null });
    expect(rowAutoResume(limited("plain"), o, true, 0)).toEqual({ enabled: true, at: null });
    expect(rowAutoResume(row("working"), o, true, NOW)).toBeNull();
    expect(rowAutoResume(views[6], o, true, NOW)).toBeNull();
  });
});
