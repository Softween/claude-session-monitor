import { describe, expect, it } from "vitest";
import {
  buildAddCommand,
  buildSeedBlob,
  decidePassiveSource,
  decodeSecurityOutput,
  parseCliVaultOutput,
  shouldSeed,
} from "../src/cliVault";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const tok = (rt: string, exp: number) => ({ accessToken: "at-" + rt, refreshToken: rt, expiresAt: exp });

describe("decidePassiveSource", () => {
  it("cli present, own missing -> use-cli", () => expect(decidePassiveSource(undefined, tok("c", 5))).toBe("use-cli"));
  it("cli newer or equal -> use-cli", () => {
    expect(decidePassiveSource(tok("o", 5), tok("c", 9))).toBe("use-cli");
    expect(decidePassiveSource(tok("o", 9), tok("c", 9))).toBe("use-cli");
  });
  it("cli missing -> use-own-and-seed", () => expect(decidePassiveSource(tok("o", 5), null)).toBe("use-own-and-seed"));
  it("own newer, different refresh token -> use-own-and-seed", () =>
    expect(decidePassiveSource(tok("o", 9), tok("c", 5))).toBe("use-own-and-seed"));
  it("own newer, same refresh token -> use-own", () => expect(decidePassiveSource(tok("x", 9), tok("x", 5))).toBe("use-own"));
  it("both missing -> use-own", () => expect(decidePassiveSource(undefined, null)).toBe("use-own"));
});

describe("security output decoding", () => {
  const json = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1 }, email: "x@y.z" });
  it("passes JSON text through", () => expect(decodeSecurityOutput(json + "\n")).toBe(json));
  it("decodes hex output", () => {
    const hex = Buffer.from(json, "utf8").toString("hex");
    expect(decodeSecurityOutput(hex + "\n")).toBe(json);
    expect(parseCliVaultOutput(hex)?.claudeAiOauth?.refreshToken).toBe("r");
  });
  it("returns null on garbage", () => {
    expect(parseCliVaultOutput("not json")).toBeNull();
    expect(parseCliVaultOutput("[1]")).toBeNull();
  });
});

describe("buildAddCommand", () => {
  const blob = { claudeAiOauth: tok("SECRET-REFRESH", 1) };
  const line = buildAddCommand(UUID, blob);
  it("quotes service and account, one line, hex payload only", () => {
    expect(line).toMatch(new RegExp(`^add-generic-password -U -a "${UUID}" -s "claude-switch" -X [0-9a-f]+\\n$`));
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(line).not.toContain("SECRET-REFRESH");
    expect(Buffer.from(line.trim().split(" -X ")[1], "hex").toString("utf8")).toBe(JSON.stringify(blob));
  });
  it("rejects non-uuid accounts", () => {
    expect(() => buildAddCommand('x" -w', blob)).toThrow();
    expect(() => buildAddCommand("ABC", blob)).toThrow();
  });
});

describe("seeding", () => {
  it("seeds once per distinct refresh token", () => {
    expect(shouldSeed(undefined, "r1")).toBe(true);
    expect(shouldSeed("r1", "r1")).toBe(false);
    expect(shouldSeed("r1", "r2")).toBe(true);
    expect(shouldSeed(undefined, undefined)).toBe(false);
  });
  it("seed blob carries identity, email and savedAt in seconds", () => {
    const b = buildSeedBlob(tok("r", 1), { emailAddress: "a@b.c" }, 5_000);
    expect(b).toMatchObject({ email: "a@b.c", savedAt: 5, oauthAccount: { emailAddress: "a@b.c" } });
  });
});
