import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOCUS_COMMAND, focusCommandBlocker, typingLine, waitForActive, type FocusScene } from "../src/promptFocus";

const SAFE: FocusScene = { targetActive: true, claudePanel: true, textEditor: false, otherClaudePanels: 0 };

describe("Claude Code's focus command", () => {
  it("may run only while the target Claude panel is the active editor, no text editor is active and no other Claude panel is visible", () => {
    expect(focusCommandBlocker(SAFE)).toBeUndefined();
    expect(focusCommandBlocker({ ...SAFE, targetActive: false })).toBe("the target Claude panel is not the active editor");
    expect(focusCommandBlocker({ ...SAFE, claudePanel: false })).toBe("the target Claude panel is not the active editor");
    expect(focusCommandBlocker({ ...SAFE, textEditor: true })).toBe("a text editor is active"); // its selection would become an @-mention
    expect(focusCommandBlocker({ ...SAFE, otherClaudePanels: 1 })).toBe("another Claude panel is visible"); // the command reveals each
  });
});

describe("waiting for the shown tab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes on as soon as the tab is the active tab of the active group, and gives up after 1 s", async () => {
    await expect(waitForActive(() => true)).resolves.toBe(true);
    let active = false;
    setTimeout(() => (active = true), 300);
    const soon = waitForActive(() => active);
    await vi.advanceTimersByTimeAsync(350);
    await expect(soon).resolves.toBe(true);
    const never = waitForActive(() => false);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void never.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(never).resolves.toBe(false);
  });
});

describe("the typing log line", () => {
  it("names the path each attempt took", () => {
    expect(typingLine("resume claude:a", { ok: true })).toBe("typing resume claude:a: prompt already focused");
    expect(typingLine("resume claude:a", { ok: true, refocused: true })).toBe(`typing resume claude:a: prompt focused after ${FOCUS_COMMAND}`);
    expect(typingLine("remote claude:a", { ok: false, reason: "not-prompt", detail: "the keyboard focus is on AXGroup" })).toBe(
      "typing remote claude:a: skipped (not-prompt: the keyboard focus is on AXGroup)",
    );
    expect(typingLine("remote claude:a", { ok: false, reason: "not-prompt", detail: "x", refocused: true })).toBe(
      `typing remote claude:a: skipped after ${FOCUS_COMMAND} (not-prompt: x)`,
    );
    expect(typingLine("resume claude:a", { ok: false, reason: "interrupted", detail: "y" })).toBe("typing resume claude:a: stopped (interrupted: y)");
  });
});
