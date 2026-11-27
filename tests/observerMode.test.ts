import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { OBSERVER_FEATURES, observerMode } from "../src/observerMode";

function make(development: boolean, enableFeatures: unknown) {
  const notes: string[] = [];
  return { mode: observerMode({ development, enableFeatures, notify: (text) => notes.push(text) }), notes };
}

describe("observer mode", () => {
  it("allows every feature and action outside an Extension Development Host, whatever dev.enableFeatures says", () => {
    for (const setting of [[], ["wake"], "nonsense", undefined]) {
      const { mode, notes } = make(false, setting);
      expect(mode.on).toBe(false);
      for (const id of OBSERVER_FEATURES) {
        expect(mode.featureAllowed(id)).toBe(true);
        expect(mode.actionAllowed(id)).toBe(true);
      }
      expect(notes).toEqual([]);
      expect(mode.offCommands()).toEqual([]);
    }
  });

  it("keeps every feature off in Development mode by default", () => {
    const { mode } = make(true, []);
    expect(mode.on).toBe(true);
    for (const id of OBSERVER_FEATURES) expect(mode.featureAllowed(id)).toBe(false);
  });

  it("dev.enableFeatures turns back on just the features it lists; unknown ids, other values and a non-list change nothing", () => {
    const { mode } = make(true, ["wake", "restartGuard", "nope", 3, null, "Wake"]);
    expect(OBSERVER_FEATURES.filter((id) => mode.featureAllowed(id))).toEqual(["wake", "restartGuard"]);
    for (const setting of ["wake", { wake: true }, null, undefined]) {
      const other = make(true, setting).mode;
      expect(OBSERVER_FEATURES.filter((id) => other.featureAllowed(id))).toEqual([]);
    }
  });

  it("refuses a user action with a notice naming the feature and the setting, and allows a listed one silently", () => {
    const { mode, notes } = make(true, ["accountWrites"]);
    expect(mode.actionAllowed("accountWrites")).toBe(true);
    expect(notes).toEqual([]);
    expect(mode.actionAllowed("remoteBridge")).toBe(false);
    expect(notes).toEqual([mode.notice("remoteBridge")]);
    expect(notes[0]).toContain("remoteBridge is off in this Extension Development Host (observer mode)");
    expect(notes[0]).toContain("claudeSessionMonitor.dev.enableFeatures");
  });

  it("lists the commands of the features that are off, so they answer instead of being missing", () => {
    expect(make(true, []).mode.offCommands()).toEqual([
      { command: "claudeSessionMonitor.setRemoteToken", feature: "remoteBridge" },
      { command: "claudeSessionMonitor.remoteStatus", feature: "remoteBridge" },
      { command: "claudeSessionMonitor.openRestartGuard", feature: "restartGuard" },
    ]);
    expect(make(true, ["remoteBridge"]).mode.offCommands()).toEqual([{ command: "claudeSessionMonitor.openRestartGuard", feature: "restartGuard" }]);
  });

  it("names what is off and what dev.enableFeatures turned on in its activation line", () => {
    expect(make(true, ["wake", "continuity"]).mode.summary()).toBe(
      "observer mode (Extension Development Host): off remoteBridge, rotation, autoResume, restartGuard, dailyReload, usagePolls, accountWrites, sharedFiles; on through dev.enableFeatures wake, continuity",
    );
    expect(make(true, []).mode.summary()).toMatch(/; on through dev\.enableFeatures none$/);
  });

  it("package.json offers exactly these ids for claudeSessionMonitor.dev.enableFeatures and lists each in its description", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    const setting = pkg.contributes.configuration.properties["claudeSessionMonitor.dev.enableFeatures"];
    expect(setting.default).toEqual([]);
    expect(setting.items.enum).toEqual([...OBSERVER_FEATURES]);
    for (const id of OBSERVER_FEATURES) expect(setting.markdownDescription).toContain(`\`${id}\``);
    expect(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain("claudeSessionMonitor.dev.enableFeatures");
  });
});
