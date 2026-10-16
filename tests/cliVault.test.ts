import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildSeedBlob, decidePassiveSource, readCliVault, shouldSeed, vaultFilePath, writeCliVault } from "../src/cliVault";

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

describe("vault path", () => {
  it("builds <dir>/<uuid>.json", () => expect(vaultFilePath(UUID, "/v")).toBe(path.join("/v", `${UUID}.json`)));
  it("rejects non-uuid accounts", () => {
    expect(vaultFilePath("../../etc/passwd", "/v")).toBeNull();
    expect(vaultFilePath("ABC", "/v")).toBeNull();
    expect(vaultFilePath(UUID.toUpperCase(), "/v")).toBeNull();
  });
});

describe("file vault I/O", () => {
  let base: string;
  let dir: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "csm-vault-"));
    dir = path.join(base, "vault");
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("missing file or dir -> null", async () => {
    expect(await readCliVault(UUID, () => {}, dir)).toBeNull();
  });
  it("unparsable or non-object file -> null, never throws", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${UUID}.json`), "not json");
    expect(await readCliVault(UUID, () => {}, dir)).toBeNull();
    fs.writeFileSync(path.join(dir, `${UUID}.json`), "[1]");
    expect(await readCliVault(UUID, () => {}, dir)).toBeNull();
  });
  it("invalid uuid -> null / false without touching disk", async () => {
    expect(await readCliVault("../x", () => {}, dir)).toBeNull();
    expect(await writeCliVault("../x", {}, () => {}, dir)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });
  it("write creates 0700 dir and 0600 file, round-trips, leaves no temp files", async () => {
    const blob = { claudeAiOauth: tok("r", 1), email: "a@b.c", savedAt: 5 };
    expect(await writeCliVault(UUID, blob, () => {}, dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, `${UUID}.json`)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([`${UUID}.json`]);
    expect(await readCliVault(UUID, () => {}, dir)).toEqual(blob);
  });
  it("overwrite replaces content and keeps 0600", async () => {
    await writeCliVault(UUID, { claudeAiOauth: tok("r1", 1) }, () => {}, dir);
    await writeCliVault(UUID, { claudeAiOauth: tok("r2", 2) }, () => {}, dir);
    expect((await readCliVault(UUID, () => {}, dir))?.claudeAiOauth?.refreshToken).toBe("r2");
    expect(fs.statSync(path.join(dir, `${UUID}.json`)).mode & 0o777).toBe(0o600);
  });
  it("write failure returns false", async () => {
    fs.writeFileSync(dir, "a file where the dir should be");
    expect(await writeCliVault(UUID, {}, () => {}, dir)).toBe(false);
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
