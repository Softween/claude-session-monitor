/**
 * tabFocus.ts — show an editor tab by its index and focus an editor group by its
 * on-screen slot: the panel click, the typing sweep, remote typing, the wake
 * restore, continuity and the restart guard all bring tabs forward through here.
 *
 * A tab is never reached by stepping through the tabs before it: showing a
 * Claude Code tab that a window reload restored starts its `claude --resume`
 * process. tabGroups.all lists groups in creation order while the
 * focus…EditorGroup commands count them as laid out on screen, so a group is
 * focused by its viewColumn and confirmed (focusBySlot).
 *
 * No `vscode` import: extension.ts injects the command runner and the active group.
 */
import { focusBySlot } from "./continuity";

/** focus…EditorGroup commands by screen slot (viewColumn - 1); VS Code has eight. */
export const FOCUS_GROUP_COMMANDS: readonly string[] = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

/** Shows the active group's tab at the index it gets as argument (its keybinding variants stop at the ninth tab). */
export const OPEN_AT_INDEX_COMMAND = "workbench.action.openEditorAtIndex";

export interface TabFocusDeps<G> {
  run(command: string, ...args: unknown[]): PromiseLike<unknown>;
  activeGroup(): G;
}

/** Focus `group` by its on-screen slot; throws unless it became the active group. */
export function focusGroupBySlot<G extends { viewColumn: number }>(group: G, deps: TabFocusDeps<G>): Promise<void> {
  return focusBySlot(group, FOCUS_GROUP_COMMANDS, (command) => deps.run(command), () => deps.activeGroup());
}

/**
 * Make tab `index` of `group` its active tab and focus the group; no other tab is
 * shown. Throws, before showing anything, when the group has no such tab or
 * cannot be focused.
 */
export async function revealTabByIndex<G extends { viewColumn: number; tabs: readonly unknown[] }>(
  group: G,
  index: number,
  deps: TabFocusDeps<G>,
): Promise<void> {
  if (!(Number.isInteger(index) && index >= 0 && index < group.tabs.length)) {
    throw new Error(`editor group ${group.viewColumn} has no tab ${index}`);
  }
  await focusGroupBySlot(group, deps);
  await deps.run(OPEN_AT_INDEX_COMMAND, index);
}
