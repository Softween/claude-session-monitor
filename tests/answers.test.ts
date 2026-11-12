import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FREE_TEXT_MAX, SHOWN_QUESTION_MAX, checkAnswers, liveMarkers, parseMarker, readMarker, sameText, submitAnswer, type WaitingMarker } from "../src/answers";

const NOW = 1_800_000_000;
const alive = (pid?: number) => pid === 4242;

const marker = (over: Partial<WaitingMarker> = {}): WaitingMarker => ({
  sessionId: "s1",
  toolUseId: "toolu_1",
  pid: 4242,
  nonce: "n0nce",
  started: NOW - 10,
  deadline: NOW + 590,
  questions: [
    { question: "Which fruit?", header: "Fruit", multiSelect: false, options: ["Apple", "Banana"] },
    { question: "Toppings?", header: "", multiSelect: true, options: ["Nuts", "Honey", "Jam, homemade"] },
  ],
  ...over,
});

describe("answers: markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-answers-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(body));

  it("parses only well-formed markers that name their own session", () => {
    expect(parseMarker({ v: 1, ...marker() }, "s1")).toEqual(marker());
    expect(parseMarker(marker(), "other")).toBeNull();
    expect(parseMarker({ ...marker(), nonce: "" }, "s1")).toBeNull();
    expect(parseMarker({ ...marker(), questions: [] }, "s1")).toBeNull();
    expect(parseMarker({ ...marker(), questions: [{ question: "Q?" }] }, "s1")).toBeNull();
    expect(parseMarker({ ...marker(), toolUseId: null }, "s1")?.toolUseId).toBeNull();
    put("s1.waiting.json", marker());
    expect(readMarker("s1", dir)).toEqual(marker());
    expect(readMarker("../s1", dir)).toBeNull();
  });

  it("lists live markers only: hook running, deadline more than 2 s away", () => {
    put("s1.waiting.json", marker());
    put("dead.waiting.json", marker({ sessionId: "dead", pid: 7 }));
    put("late.waiting.json", marker({ sessionId: "late", deadline: NOW + 2 }));
    put("s1.answer.json", { nonce: "n0nce" });
    put("off", "");
    expect([...liveMarkers(NOW, { dir, alive }).keys()]).toEqual(["s1"]);
    expect(liveMarkers(NOW, { dir: path.join(dir, "missing"), alive }).size).toBe(0);
  });
});

describe("answers: checkAnswers", () => {
  const m = marker();
  it("takes option labels, multi-select labels joined with commas, or a short free text", () => {
    expect(checkAnswers(m, { "Which fruit?": " Banana ", "Toppings?": "Honey,Nuts" })).toEqual({
      ok: true,
      answers: { "Which fruit?": "Banana", "Toppings?": "Honey, Nuts" },
    });
    expect(checkAnswers(m, { "Which fruit?": "Kiwi please", "Toppings?": "Jam, homemade" })).toEqual({
      ok: true,
      answers: { "Which fruit?": "Kiwi please", "Toppings?": "Jam, homemade" },
    });
    expect(checkAnswers(m, { "Which fruit?": "é".repeat(FREE_TEXT_MAX), "Toppings?": "Nuts" }).ok).toBe(true);
  });

  it("maps the tailer's redacted and capped texts back to the questions and labels as asked", () => {
    const long = "Q".repeat(480) + " about ayse@example.com and more";
    const mm = marker({
      questions: [
        { question: "Send the report to ayse@example.com?", header: "Report", multiSelect: false, options: ["Yes, to ayse@example.com", "No"] },
        { question: long, header: "Long", multiSelect: true, options: ["Commit 0123456789abcdef0123456789abcdef01234567", "Skip"] },
      ],
    });
    const shownLong = "Q".repeat(480) + " about [email] and";
    expect([...shownLong].length).toBeLessThan(SHOWN_QUESTION_MAX);
    const cut = long.slice(0, SHOWN_QUESTION_MAX);
    expect(checkAnswers(mm, { "Send the report to [email]?": "Yes, to [email]", [cut]: "Commit [redacted], Skip" })).toEqual({
      ok: true,
      answers: {
        "Send the report to ayse@example.com?": "Yes, to ayse@example.com",
        [long]: "Commit 0123456789abcdef0123456789abcdef01234567, Skip",
      },
    });
    expect(sameText(shownLong, long, SHOWN_QUESTION_MAX)).toBe(false); // not cut, so it must match to the end
    expect(sameText("Send the report to [email]?", "Send the report to x?", SHOWN_QUESTION_MAX)).toBe(true);
    const twin = marker({
      questions: [
        { question: "Mail a@x.io?", header: "A", multiSelect: false, options: ["Yes"] },
        { question: "Mail b@y.io?", header: "B", multiSelect: false, options: ["Yes"] },
      ],
    });
    expect(checkAnswers(twin, { "Mail [email]?": "Yes" })).toMatchObject({ ok: false, reason: expect.stringMatching(/eşleşmiyor/) });
    expect(checkAnswers(m, { "Which fruit?": "Apple", "Toppings?": "Nuts", "Which fruit? ": "x" })).toMatchObject({ ok: false });
  });

  it("refuses in Turkish: missing, extra, empty, too long or control characters", () => {
    const reason = (answers: unknown) => {
      const r = checkAnswers(m, answers);
      return r.ok ? "" : r.reason;
    };
    expect(reason(null)).toBe("Cevaplar eksik");
    expect(reason(["Apple"])).toBe("Cevaplar eksik");
    expect(reason({ "Which fruit?": "Apple" })).toBe('"Toppings?" sorusu cevaplanmadı');
    expect(reason({ "Which fruit?": "Apple", "Toppings?": "Nuts", "Old question?": "x" })).toMatch(/eşleşmiyor/);
    expect(reason({ "Which fruit?": "  ", "Toppings?": "Nuts" })).toBe('"Fruit" için cevap boş');
    expect(reason({ "Which fruit?": 3, "Toppings?": "Nuts" })).toBe('"Fruit" için cevap boş');
    expect(reason({ "Which fruit?": "x".repeat(FREE_TEXT_MAX + 1), "Toppings?": "Nuts" })).toMatch(/en fazla 500 karakter/);
    expect(reason({ "Which fruit?": "two\nlines", "Toppings?": "Nuts" })).toMatch(/kontrol karakteri/);
  });
});

describe("answers: submitAnswer", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-submit-"));
    fs.writeFileSync(path.join(dir, "s1.waiting.json"), JSON.stringify(marker()));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ok = { "Which fruit?": "Apple", "Toppings?": "Nuts" };
  const submit = (cmd: Record<string, unknown>, askPending = true, nowSec = NOW) =>
    submitAnswer({ sessionId: "s1", answers: ok, ...cmd }, { nowSec, askPending, dir, alive });

  it("writes the answer for the hook (0600, the marker's nonce) once", () => {
    expect(submit({ toolUseId: "toolu_1" })).toEqual({ ok: true, message: "Cevap iletildi" });
    const file = path.join(dir, "s1.answer.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ v: 1, nonce: "n0nce", toolUseId: "toolu_1", answers: ok, writtenAt: NOW });
    expect(submit({})).toEqual({ ok: false, message: "Bu soruya zaten cevap iletildi" });
    expect(fs.readdirSync(dir).sort()).toEqual(["s1.answer.json", "s1.waiting.json"]);
  });

  it("refuses when the question is gone, answered at the desk, late or for another card", () => {
    expect(submit({ sessionId: "../x" })).toEqual({ ok: false, message: "Geçersiz oturum kimliği" });
    expect(submit({ sessionId: "s2" }, false)).toEqual({ ok: false, message: "Mac'te cevaplandı" });
    expect(submit({ sessionId: "s2" }, true)).toEqual({ ok: false, message: "Süre doldu; soruyu Mac'te cevapla" });
    expect(submit({}, true, NOW + 589)).toEqual({ ok: false, message: "Süre doldu; soruyu Mac'te cevapla" });
    expect(submit({}, false)).toEqual({ ok: false, message: "Mac'te cevaplandı" });
    expect(submit({ toolUseId: "toolu_old" })).toEqual({ ok: false, message: "Mac'te cevaplandı" });
    expect(submit({ answers: { "Which fruit?": "Apple" } })).toEqual({ ok: false, message: '"Toppings?" sorusu cevaplanmadı' });
    fs.writeFileSync(path.join(dir, "s1.waiting.json"), JSON.stringify(marker({ pid: 7 })));
    expect(submit({})).toEqual({ ok: false, message: "Süre doldu; soruyu Mac'te cevapla" });
    expect(fs.existsSync(path.join(dir, "s1.answer.json"))).toBe(false);
  });
});
