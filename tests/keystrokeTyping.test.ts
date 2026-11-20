import { describe, expect, it } from "vitest";
import {
  CHUNK_CHARS,
  PROMPT_INPUT,
  chunkText,
  isPromptInput,
  nothingTyped,
  typeIntoPrompt,
  type FocusRead,
  type FocusedElement,
  type KeystrokeDeps,
  type TypeTarget,
} from "../src/keystrokeTyping";

const VS = "com.microsoft.VSCode";
const PROMPT: FocusedElement = { app: VS, role: "AXTextArea", description: "Message input" };
const TERMINAL: FocusedElement = { app: VS, role: "AXTextArea", description: "Terminal 1, zsh" };
const EDITOR: FocusedElement = { app: VS, role: "AXTextArea", description: "Editor content" };
const OTHER_APP: FocusedElement = { app: "com.apple.Terminal", role: "", description: "" };

/** Fake osascript runs: `focus(n)` answers the n-th focus read (1-based); every call is logged in order. */
function fake(focus: (n: number) => FocusedElement | FocusRead): { deps: KeystrokeDeps; calls: string[] } {
  const calls: string[] = [];
  let reads = 0;
  const deps: KeystrokeDeps = {
    readFocus: async () => {
      reads++;
      calls.push("focus");
      const f = focus(reads);
      return "ok" in f ? f : { ok: true, focus: f };
    },
    keystroke: async (text) => {
      calls.push(`type ${text}`);
      return { ok: true };
    },
    pressReturn: async () => {
      calls.push("return");
      return { ok: true };
    },
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
    },
  };
  return { deps, calls };
}

const target = (over: Partial<TypeTarget> = {}): TypeTarget => ({
  submitDelayMs: 150,
  alive: () => true,
  windowFocused: () => true,
  tabActive: () => true,
  ...over,
});

describe("typeIntoPrompt", () => {
  it("types in chunks of at most 200 characters and reads the focus before every chunk and before Return", async () => {
    const text = "a".repeat(200) + "b".repeat(200) + "c".repeat(50);
    const { deps, calls } = fake(() => PROMPT);
    expect(await typeIntoPrompt(text, target(), deps)).toEqual({ ok: true });
    expect(calls).toEqual([
      "focus",
      `type ${"a".repeat(200)}`,
      "focus",
      `type ${"b".repeat(200)}`,
      "focus",
      `type ${"c".repeat(50)}`,
      "sleep 150",
      "focus",
      "return",
    ]);
  });

  it("a click into the integrated terminal mid-typing aborts: the rest of the text and Return never go out", async () => {
    const { deps, calls } = fake((n) => (n < 3 ? PROMPT : TERMINAL));
    const r = await typeIntoPrompt("x".repeat(450), target(), deps);
    expect(r).toMatchObject({ ok: false, reason: "interrupted" });
    expect(calls).toEqual(["focus", `type ${"x".repeat(200)}`, "focus", `type ${"x".repeat(200)}`, "focus"]);
    const detail = r.ok ? "" : r.detail;
    expect(detail).toContain("Terminal 1, zsh");
    expect(detail).toContain("400 of 450 characters");
  });

  it("an editor or another app taking the focus aborts the same way", async () => {
    for (const other of [EDITOR, OTHER_APP]) {
      const { deps, calls } = fake((n) => (n < 2 ? PROMPT : other));
      expect(await typeIntoPrompt("y".repeat(300), target(), deps)).toMatchObject({ ok: false, reason: "interrupted" });
      expect(calls).toEqual(["focus", `type ${"y".repeat(200)}`, "focus"]);
    }
  });

  it("a focus change right before Return leaves the typed text unsent and reports a failure", async () => {
    const { deps, calls } = fake((n) => (n < 2 ? PROMPT : TERMINAL));
    expect(await typeIntoPrompt("resume", target(), deps)).toMatchObject({ ok: false, reason: "interrupted" });
    expect(calls).toEqual(["focus", "type resume", "sleep 150", "focus"]);
  });

  it("types nothing when the prompt input lacks the focus at the start", async () => {
    const cases: Array<[FocusedElement, string]> = [
      [TERMINAL, "not-prompt"],
      [EDITOR, "not-prompt"],
      [OTHER_APP, "not-frontmost"],
    ];
    for (const [focus, reason] of cases) {
      const { deps, calls } = fake(() => focus);
      expect(await typeIntoPrompt("hello", target(), deps)).toMatchObject({ ok: false, reason });
      expect(calls).toEqual(["focus"]);
    }
  });

  it("re-checks the window focus and the session's tab before every chunk", async () => {
    let tabChecks = 0;
    const first = fake(() => PROMPT);
    const r = await typeIntoPrompt("z".repeat(250), target({ tabActive: () => ++tabChecks < 2 }), first.deps);
    expect(r).toMatchObject({ ok: false, reason: "interrupted" });
    expect(first.calls).toEqual(["focus", `type ${"z".repeat(200)}`, "focus"]);

    const second = fake(() => PROMPT);
    expect(await typeIntoPrompt("hi", target({ windowFocused: () => false }), second.deps)).toMatchObject({
      ok: false,
      reason: "not-frontmost",
    });
    expect(second.calls).toEqual(["focus"]);
  });

  it("a stop before the first chunk types nothing", async () => {
    const { deps, calls } = fake(() => PROMPT);
    expect(await typeIntoPrompt("hi", target({ alive: () => false }), deps)).toMatchObject({ ok: false, reason: "aborted" });
    expect(calls).toEqual([]);
  });

  it("a focus read macOS refuses is an accessibility failure with nothing typed", async () => {
    const { deps, calls } = fake(() => ({
      ok: false,
      err: "System Events got an error: osascript is not allowed assistive access. (-25211)",
    }));
    expect(await typeIntoPrompt("hi", target(), deps)).toMatchObject({ ok: false, reason: "accessibility" });
    expect(calls).toEqual(["focus"]);
  });

  it("a failed keystroke is final, and a keystroke run that finds another app in front stops before Return", async () => {
    const failing = fake(() => PROMPT);
    failing.deps.keystroke = async () => ({ ok: false, err: "execution error" });
    expect(await typeIntoPrompt("hi", target(), failing.deps)).toMatchObject({ ok: false, reason: "keystroke" });

    const late = fake(() => PROMPT);
    let runs = 0;
    late.deps.keystroke = async (text) => {
      late.calls.push(`type ${text}`);
      return ++runs < 2 ? { ok: true } : { ok: false, notFrontmost: true, err: "frontmost app is not VS Code" };
    };
    expect(await typeIntoPrompt("q".repeat(260), target(), late.deps)).toMatchObject({ ok: false, reason: "interrupted" });
    expect(late.calls).not.toContain("return");
  });
});

describe("chunkText", () => {
  it("never splits a character outside the BMP across two chunks", () => {
    const text = "😀".repeat(250);
    const parts = chunkText(text);
    expect(parts.map((p) => Array.from(p).length)).toEqual([200, 50]);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
  });

  it("cuts at CHUNK_CHARS (200) characters", () => {
    expect(CHUNK_CHARS).toBe(200);
    expect(chunkText("")).toEqual([]);
    expect(chunkText("k".repeat(401)).map((p) => p.length)).toEqual([200, 200, 1]);
  });
});

describe("the Claude Code prompt input", () => {
  it("is identified by its accessibility role and description", () => {
    expect(PROMPT_INPUT).toEqual({ role: "AXTextArea", description: "Message input" });
    expect(isPromptInput(PROMPT)).toBe(true);
    expect(isPromptInput(TERMINAL)).toBe(false);
    expect(isPromptInput(EDITOR)).toBe(false);
    expect(isPromptInput({ ...PROMPT, role: "AXGroup" })).toBe(false);
  });
});

describe("nothingTyped", () => {
  it("lets the remote path try its next delivery only when nothing was typed", () => {
    for (const reason of ["aborted", "not-frontmost", "tab-mismatch", "not-prompt", "accessibility"] as const) {
      expect(nothingTyped(reason)).toBe(true);
    }
    expect(nothingTyped("interrupted")).toBe(false);
    expect(nothingTyped("keystroke")).toBe(false);
  });
});
