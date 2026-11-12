import { describe, it, expect } from "vitest";
import {
  NO_DUE_IDLE_SEC,
  OVERDUE_GRACE_SEC,
  backgroundByDue,
  fmtClock,
  isBackground,
  parseDueClock,
  pendingTiming,
  resolveDueSec,
  timingNote,
} from "../src/closingBuckets";
import { groupOf } from "../src/view";
import type { SessionView } from "../src/providers/types";

// Local wall-clock times (November 2026), so the cases hold in any time zone.
const at = (day: number, h: number, m: number, s = 0): number => new Date(2026, 10, day, h, m, s).getTime() / 1000;

const view = (over: Partial<SessionView> = {}): SessionView =>
  ({ key: "claude:s", bucket: "attention", sub: "your turn", ...over }) as SessionView;
const pending = (text: string, overdue = false, dueMs: number | null = at(12, 6, 15) * 1000): Partial<SessionView> => ({
  closing: { kind: "pending", text },
  closingTiming: { dueMs, overdue },
});

describe("parseDueClock", () => {
  it("reads bitiş / bitis / finish / due, with or without ~", () => {
    expect(parseDueClock("Kapatma: deploy-wait · bitiş ~06:15")).toEqual({ h: 6, m: 15 });
    expect(parseDueClock("Kapatma: CI · bitis 7:05")).toEqual({ h: 7, m: 5 });
    expect(parseDueClock("Kapatma: build, finish ~23:50")).toEqual({ h: 23, m: 50 });
    expect(parseDueClock("Kapatma: agent; due: 00:30")).toEqual({ h: 0, m: 30 });
    expect(parseDueClock("Kapatma: x · Bitiş ~ 12:30 (yedek uyandırma 12:31)")).toEqual({ h: 12, m: 30 });
  });

  it("takes the finish time, not another clock in the line", () => {
    expect(parseDueClock("Kapatma: ajanlar (ara kontrol 06:01) · bitiş ~06:15")).toEqual({ h: 6, m: 15 });
  });

  it("is undefined without the keyword or a valid clock", () => {
    expect(parseDueClock("Kapatma: CI bitince (~10 dk)")).toBeUndefined();
    expect(parseDueClock("Kapatma: deploy 06:15")).toBeUndefined();
    expect(parseDueClock("Kapatma: x · bitiş ~25:10")).toBeUndefined();
    expect(parseDueClock("Kapatma: overdue 06:15")).toBeUndefined();
  });
});

describe("resolveDueSec", () => {
  it("is the first such clock time at or after the final message", () => {
    expect(resolveDueSec(6, 15, at(12, 5, 9, 40))).toBe(at(12, 6, 15));
    expect(resolveDueSec(23, 50, at(12, 23, 50, 30))).toBe(at(12, 23, 50)); // the same minute still counts
  });

  it("wraps past midnight to the next day", () => {
    expect(resolveDueSec(0, 30, at(12, 23, 50))).toBe(at(13, 0, 30));
    expect(resolveDueSec(5, 0, at(12, 5, 9))).toBe(at(13, 5, 0));
  });
});

describe("pendingTiming", () => {
  const ended = at(12, 5, 10);
  const line = "Kapatma: CI ve deploy · bitiş ~06:15";

  it("stays on time until 5 min past the finish time", () => {
    expect(pendingTiming(line, ended, at(12, 5, 30))).toEqual({ dueMs: at(12, 6, 15) * 1000, overdue: false });
    expect(pendingTiming(line, ended, at(12, 6, 15) + OVERDUE_GRACE_SEC).overdue).toBe(false);
    expect(pendingTiming(line, ended, at(12, 6, 15) + OVERDUE_GRACE_SEC + 1).overdue).toBe(true);
  });

  it("without a finish time, turns overdue once idle 90 min", () => {
    const text = "Kapatma: CI bitince (~10 dk)";
    expect(pendingTiming(text, ended, ended + NO_DUE_IDLE_SEC - 1)).toEqual({ dueMs: null, overdue: false });
    expect(pendingTiming(text, ended, ended + NO_DUE_IDLE_SEC)).toEqual({ dueMs: null, overdue: true });
  });

  it("is not overdue before midnight when the finish time is after it", () => {
    expect(pendingTiming("Kapatma: x · bitiş ~00:30", at(12, 23, 50), at(12, 23, 59))).toEqual({
      dueMs: at(13, 0, 30) * 1000,
      overdue: false,
    });
  });
});

describe("bucket decision (groupOf)", () => {
  it("puts an on-time ⏳ row in background", () => {
    const v = view(pending("Kapatma: CI · bitiş ~06:15"));
    expect(isBackground(v)).toBe(true);
    expect(groupOf(v)).toBe("background");
  });

  it("keeps an overdue ⏳ row in Your turn, with or without a finish time", () => {
    expect(groupOf(view(pending("Kapatma: CI · bitiş ~06:15", true)))).toBe("done");
    expect(groupOf(view(pending("Kapatma: CI bitince", true, null)))).toBe("done");
  });

  it("keeps 🟡, ✅ and rows without a closing line in Your turn", () => {
    expect(groupOf(view({ closing: { kind: "blocked", text: "Senden bekliyor: onay" } }))).toBe("done");
    expect(groupOf(view({ closing: { kind: "done", text: "Bu sohbetteki işler tamamlandı" } }))).toBe("done");
    expect(groupOf(view())).toBe("done");
  });

  it("keeps a ⏳ line that also asks you something (🟡 inside) in Your turn", () => {
    expect(groupOf(view(pending("Kapatma: deploy · bitiş ~08:30 · 🟡 Senden bekliyor: yeniden giriş")))).toBe("done");
  });
});

describe("timingNote / fmtClock", () => {
  it("names the finish time, or warns once overdue", () => {
    const due = at(12, 6, 5) * 1000;
    expect(fmtClock(due)).toBe("06:05");
    expect(timingNote({ dueMs: due, overdue: false })).toBe("finish: ~06:05");
    expect(timingNote({ dueMs: due, overdue: true })).toBe("past its finish time (~06:05); may be stuck");
    expect(timingNote({ dueMs: null, overdue: true })).toBe("no finish time and idle 90+ min; may be stuck");
    expect(timingNote({ dueMs: null, overdue: false })).toBe("");
  });
});

describe("backgroundByDue", () => {
  it("lists background rows by finish time (none last) after the others, which keep their order", () => {
    const bg = (key: string, dueMs: number | null) => view({ key, ...pending("Kapatma: x", false, dueMs) });
    const yourTurn = (key: string) => view({ key });
    const out = backgroundByDue([bg("b-late", 3000), yourTurn("y1"), bg("b-none", null), bg("b-soon", 1000), yourTurn("y2")]);
    expect(out.map((v) => v.key)).toEqual(["y1", "y2", "b-soon", "b-late", "b-none"]);
  });
});
