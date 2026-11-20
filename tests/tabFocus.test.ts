import { describe, expect, it, vi } from "vitest";

import { FOCUS_GROUP_COMMANDS, OPEN_AT_INDEX_COMMAND, focusGroupBySlot, revealTabByIndex } from "../src/tabFocus";

interface FakeGroup {
  viewColumn: number;
  tabs: string[];
  active: number; // index of the group's active tab
}

const labels = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
const group = (viewColumn: number, tabs: string[]): FakeGroup => ({ viewColumn, tabs, active: 0 });

/**
 * Editor groups listed in creation order (tabGroups.all), with VS Code's command
 * semantics: a focus…EditorGroup command picks the group at its screen slot,
 * openEditorAtIndex shows a tab of the active group (the index as argument, or
 * 1-9 in the command name), nextEditorInGroup the tab after the active one.
 * Every tab that becomes active is recorded as shown.
 */
function editor(groups: FakeGroup[]) {
  let activeGroup = groups[0];
  const shown: string[] = [];
  const show = (i: number): void => {
    const tab = activeGroup.tabs[i];
    if (tab === undefined) return;
    activeGroup.active = i;
    shown.push(tab);
  };
  const run = vi.fn(async (command: string, ...args: unknown[]) => {
    const slot = FOCUS_GROUP_COMMANDS.indexOf(command);
    const named = /^workbench\.action\.openEditorAtIndex(\d)$/.exec(command);
    if (slot >= 0) activeGroup = groups.find((g) => g.viewColumn === slot + 1) ?? activeGroup;
    else if (command === OPEN_AT_INDEX_COMMAND) show(args[0] as number);
    else if (named) show(Number(named[1]) - 1);
    else if (command === "workbench.action.nextEditorInGroup") show(activeGroup.active + 1);
  });
  return { run, shown, deps: { run, activeGroup: () => activeGroup } };
}

describe("revealTabByIndex", () => {
  it("shows tab 15 with one command: no step through the tabs before it, no other tab shown", async () => {
    const only = group(1, labels("tab", 20));
    const e = editor([only]);
    await revealTabByIndex(only, 15, e.deps);
    expect(e.run.mock.calls).toEqual([["workbench.action.focusFirstEditorGroup"], [OPEN_AT_INDEX_COMMAND, 15]]);
    expect(e.run.mock.calls.flat()).not.toContain("workbench.action.nextEditorInGroup");
    expect(e.shown).toEqual(["tab 15"]);
  });

  it("focuses the group at its on-screen slot: a group created after the group to its right", async () => {
    const left = group(1, labels("left", 2));
    const right = group(3, labels("right", 2));
    const middle = group(2, labels("middle", 12)); // split off last, placed between the two
    const e = editor([left, right, middle]); // tabGroups.all order: creation
    await revealTabByIndex(middle, 11, e.deps);
    expect(e.run.mock.calls).toEqual([["workbench.action.focusSecondEditorGroup"], [OPEN_AT_INDEX_COMMAND, 11]]);
    expect(e.deps.activeGroup()).toBe(middle);
    expect(e.shown).toEqual(["middle 11"]);
    expect(right.active).toBe(0);
  });

  it("shows nothing when the group cannot be focused, did not become active or has no such tab", async () => {
    const first = group(1, labels("first", 3));
    const ninth = group(9, labels("ninth", 3)); // past the eight focus commands
    const e = editor([first, ninth]);
    await expect(revealTabByIndex(ninth, 1, e.deps)).rejects.toThrow("editor group 9 cannot be focused");
    await expect(revealTabByIndex(first, 3, e.deps)).rejects.toThrow("editor group 1 has no tab 3");
    expect(e.run).not.toHaveBeenCalled();

    const second = group(2, labels("second", 3));
    const stuck = { run: vi.fn(async () => undefined), activeGroup: () => first };
    await expect(revealTabByIndex(second, 0, stuck)).rejects.toThrow("editor group 2 did not become active");
    expect(stuck.run.mock.calls).toEqual([["workbench.action.focusSecondEditorGroup"]]);
    expect(e.shown).toEqual([]);
  });
});

describe("focusGroupBySlot", () => {
  it("runs the focus command of the group's screen slot and confirms it", async () => {
    const left = group(1, labels("left", 1));
    const right = group(2, labels("right", 1));
    const e = editor([right, left]);
    await focusGroupBySlot(left, e.deps);
    expect(e.run.mock.calls).toEqual([["workbench.action.focusFirstEditorGroup"]]);
    expect(e.deps.activeGroup()).toBe(left);
    expect(e.shown).toEqual([]);
  });
});
