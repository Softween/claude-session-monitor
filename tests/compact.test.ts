import { describe, expect, it } from "vitest";
import { gaugeColumn } from "../src/compact";

describe("gaugeColumn", () => {
  it("maps session keys", () => {
    expect(gaugeColumn("session")).toBe("session");
    expect(gaugeColumn("5h")).toBe("session");
  });
  it("maps weekly keys", () => {
    expect(gaugeColumn("weekly")).toBe("weekly");
    expect(gaugeColumn("7d")).toBe("weekly");
  });
  it("maps any fable key to the fable column", () => {
    expect(gaugeColumn("weekly-fable")).toBe("fable");
    expect(gaugeColumn("weekly_Fable_x")).toBe("fable");
  });
  it("leaves other model-scoped weeklies out of the grid", () => {
    expect(gaugeColumn("weekly-opus")).toBeNull();
    expect(gaugeColumn("")).toBeNull();
  });
});
