import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>(async () => undefined));
vi.mock("vscode", () => ({ window: { showWarningMessage: warn } }));

import {
  DENIED,
  NOT_CONFIRMED,
  PENDING,
  UNREADABLE,
  DeviceGate,
  askOnThisMac,
  deviceName,
  nodeDeviceFs,
  pairedDevices,
  type DeviceDecision,
  type PairedDevice,
} from "../src/remoteDevices";

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const DAY = 86_400_000;
const IPHONE = "11111111-1111-4111-8111-111111111111";
const IPAD = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";

let base: string;
let file: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "csm-devices-"));
  file = path.join(base, "session-monitor", "remote-devices.json");
  warn.mockReset();
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

/** The relay's GET /fleet/tokens data, as the bridge's request resolves it. */
const tokens = (...list: Array<{ id: string; name: string; createdAt: number | null }>) => ({
  tokens: list.map((t) => ({ ...t, lastUsedAt: null, current: false })),
});

const allowed = (name: string, pairedAt: number | null = T0 - DAY) => ({ state: "allowed", name, pairedAt, decidedAt: T0 - 1000 });
const denied = (name: string) => ({ ...allowed(name), state: "denied" });

function writeStore(devices: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices, ...extra }));
}

const readStore = () => JSON.parse(fs.readFileSync(file, "utf8"));

/** Lets the background lookup and prompt run when nothing holds them open. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A gate over `file`; each prompt takes the next of `answers` (a pending promise holds the modal open). */
function gate(o: { relay?: () => Promise<unknown>; answers?: Array<DeviceDecision | Promise<DeviceDecision>> } = {}) {
  const prompts: PairedDevice[] = [];
  const logs: string[] = [];
  const answers = [...(o.answers ?? [])];
  let lookups = 0;
  const g = new DeviceGate({
    file,
    fs: nodeDeviceFs,
    now: () => T0,
    prompt: async (d) => {
      prompts.push(d);
      return answers.shift();
    },
    log: (m) => logs.push(m),
  });
  const lookup = async () => {
    lookups++;
    return (o.relay ?? (async () => tokens()))();
  };
  return { g, lookup, prompts, logs, lookups: () => lookups };
}

describe("DeviceGate: which devices run commands", () => {
  it("runs a command only from a device allowed in the file: none, an unknown and a denied one are refused", async () => {
    writeStore({ [IPHONE]: allowed("iPhone"), [IPAD]: denied("iPad") });
    const { g, lookup, prompts, lookups } = gate();
    expect(await g.refusal(IPHONE, lookup)).toBeNull();
    expect(await g.refusal(IPAD, lookup)).toBe(DENIED);
    for (const id of [undefined, null, "", 42, { id: IPHONE }]) expect(await g.refusal(id, lookup)).toBe(NOT_CONFIRMED);
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    // Only the unknown device is looked up; the relay does not list it, so nothing asks.
    expect(lookups()).toBe(1);
    expect(prompts).toEqual([]);
    expect(await g.refusal("constructor", lookup)).toBe(NOT_CONFIRMED);
  });

  it("asks about an unknown device the relay lists, answers the command at once and asks once while the modal is open", async () => {
    writeStore({});
    let answer: (d: DeviceDecision) => void = () => undefined;
    const open = new Promise<DeviceDecision>((resolve) => (answer = resolve));
    const relay = async () => tokens({ id: NEW, name: "Ali's iPhone", createdAt: T0 - 60_000 });
    const { g, lookup, prompts, lookups } = gate({ relay, answers: [open] });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(prompts).toEqual([{ id: NEW, name: "Ali's iPhone", pairedAt: T0 - 60_000 }]));
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect(prompts).toHaveLength(1);
    expect(lookups()).toBe(1);
    answer("allow");
    await vi.waitFor(() => expect(readStore().devices[NEW]).toEqual({ state: "allowed", name: "Ali's iPhone", pairedAt: T0 - 60_000, decidedAt: T0 }));
    expect(await g.refusal(NEW, lookup)).toBeNull();
    expect(prompts).toHaveLength(1);
  });

  it("Deny keeps refusing without asking again; a closed modal decides nothing and the next command asks again", async () => {
    writeStore({});
    const relay = async () => tokens({ id: NEW, name: "iPad", createdAt: T0 });
    const { g, lookup, prompts } = gate({ relay, answers: [undefined, "deny"] });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect(prompts).toHaveLength(1);
    expect(readStore().devices).toEqual({});
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect(prompts).toHaveLength(2);
    expect(readStore().devices[NEW]).toEqual({ state: "denied", name: "iPad", pairedAt: T0, decidedAt: T0 });
    expect(await g.refusal(NEW, lookup)).toBe(DENIED);
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it("never asks about a device the relay does not list (revoked or never paired) or when the lookup fails", async () => {
    writeStore({});
    const unlisted = gate({ relay: async () => tokens({ id: IPAD, name: "iPad", createdAt: T0 }), answers: ["allow"] });
    expect(await unlisted.g.refusal(NEW, unlisted.lookup)).toBe(NOT_CONFIRMED);
    const failing = gate({
      relay: async () => {
        throw new Error("HTTP 503");
      },
      answers: ["allow"],
    });
    expect(await failing.g.refusal(NEW, failing.lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect([unlisted.prompts, failing.prompts]).toEqual([[], []]);
    expect(readStore()).toEqual({ version: 1, devices: {} });
  });

  it("reads the file again before it asks: a device another window decided meanwhile is not asked about", async () => {
    writeStore({});
    let list: () => void = () => undefined;
    const relay = () => new Promise<unknown>((resolve) => (list = () => resolve(tokens({ id: NEW, name: "iPad", createdAt: T0 }))));
    const { g, lookup, prompts } = gate({ relay, answers: ["deny"] });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    writeStore({ [NEW]: allowed("iPad") });
    list();
    await flush();
    expect(prompts).toEqual([]);
    expect(await g.refusal(NEW, lookup)).toBeNull();
  });

  it("reads the file again before it writes: the decision joins other windows' entries and keeps fields it does not know", async () => {
    writeStore({ [IPHONE]: { ...allowed("iPhone"), publicKey: "pk-iphone" } }, { note: "kept" });
    let answer: (d: DeviceDecision) => void = () => undefined;
    const open = new Promise<DeviceDecision>((resolve) => (answer = resolve));
    const { g, lookup, prompts } = gate({ relay: async () => tokens({ id: NEW, name: "iPad", createdAt: T0 }), answers: [open] });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    writeStore({ [IPHONE]: { ...allowed("iPhone"), publicKey: "pk-iphone" }, [IPAD]: denied("Old iPad") }, { note: "kept" });
    answer("allow");
    await vi.waitFor(() => expect(readStore().devices[NEW]?.state).toBe("allowed"));
    expect(readStore()).toEqual({
      version: 1,
      note: "kept",
      devices: {
        [IPHONE]: { ...allowed("iPhone"), publicKey: "pk-iphone" },
        [IPAD]: denied("Old iPad"),
        [NEW]: { state: "allowed", name: "iPad", pairedAt: T0, decidedAt: T0 },
      },
    });
  });

  it("refuses every command while the file is not a version 1 device list, never asks and never rewrites it", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bad = ["{not json", JSON.stringify({ version: 2, devices: {} }), JSON.stringify({ version: 1, devices: [] }), "[]"];
    for (const text of bad) {
      fs.writeFileSync(file, text);
      const { g, lookup, prompts } = gate({ relay: async () => tokens({ id: NEW, name: "iPad", createdAt: T0 }), answers: ["allow"] });
      await g.migrate(lookup);
      expect(await g.refusal(NEW, lookup)).toBe(UNREADABLE);
      await flush();
      expect(prompts).toEqual([]);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    }
  });
});

describe("DeviceGate: first run", () => {
  it("confirms the relay's paired devices once the list is read; until then commands wait with 'device check pending'", async () => {
    let up = false;
    const relay = async () => {
      if (!up) throw new Error("HTTP 502");
      return tokens({ id: IPHONE, name: "iPhone", createdAt: T0 - 5000 }, { id: IPAD, name: "iPad\u0007", createdAt: null });
    };
    const { g, lookup, prompts } = gate({ relay });
    await g.migrate(lookup);
    expect(fs.existsSync(file)).toBe(false);
    expect(await g.refusal(IPHONE, lookup)).toBe(PENDING);
    await flush();
    expect(fs.existsSync(file)).toBe(false);
    up = true;
    expect(await g.refusal(IPHONE, lookup)).toBe(PENDING);
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
    expect(readStore()).toEqual({
      version: 1,
      devices: {
        [IPHONE]: { state: "allowed", name: "iPhone", pairedAt: T0 - 5000, decidedAt: T0 },
        [IPAD]: { state: "allowed", name: "iPad", pairedAt: null, decidedAt: T0 },
      },
    });
    expect(await g.refusal(IPHONE, lookup)).toBeNull();
    expect(prompts).toEqual([]);
  });

  it("never runs again once the file exists: a device paired later is asked about, not confirmed", async () => {
    writeStore({ [IPHONE]: allowed("iPhone") });
    const relay = async () => tokens({ id: IPHONE, name: "iPhone", createdAt: T0 - DAY }, { id: NEW, name: "Later", createdAt: T0 });
    const { g, lookup, prompts } = gate({ relay, answers: [undefined] });
    await g.migrate(lookup);
    expect(readStore().devices).toEqual({ [IPHONE]: allowed("iPhone") });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect(prompts.map((p) => p.id)).toEqual([NEW]);
    expect(readStore().devices).toEqual({ [IPHONE]: allowed("iPhone") });
  });

  it("writes only the first window's list when two windows read the relay at the same time", async () => {
    let release: () => void = () => undefined;
    const slow = gate({
      relay: () =>
        new Promise<unknown>((resolve) => (release = () => resolve(tokens({ id: IPHONE, name: "iPhone", createdAt: T0 }, { id: NEW, name: "Later", createdAt: T0 })))),
    });
    const fast = gate({ relay: async () => tokens({ id: IPHONE, name: "iPhone", createdAt: T0 }) });
    const slowRun = slow.g.migrate(slow.lookup);
    await fast.g.migrate(fast.lookup);
    release();
    await slowRun;
    expect(Object.keys(readStore().devices)).toEqual([IPHONE]);
  });
});

describe("the modal", () => {
  it("names the device and its pairing time, offers Allow and Deny, and maps the answer", async () => {
    warn.mockResolvedValueOnce("Allow").mockResolvedValueOnce("Deny").mockResolvedValueOnce(undefined);
    const device: PairedDevice = { id: NEW, name: "Ali's iPad", pairedAt: T0 };
    expect(await askOnThisMac(device)).toBe("allow");
    expect(await askOnThisMac(device)).toBe("deny");
    expect(await askOnThisMac({ ...device, pairedAt: null })).toBeUndefined();
    const [message, options, ...buttons] = warn.mock.calls[0] as [string, { modal?: boolean; detail?: string }, ...string[]];
    expect(message).toContain('"Ali\'s iPad"');
    expect(message).toContain(new Date(T0).toLocaleString());
    expect(options.modal).toBe(true);
    expect(options.detail).toMatch(/Deny/);
    expect(buttons).toEqual(["Allow", "Deny"]);
    expect(warn.mock.calls[2][0]).toContain("an unknown time");
  });
});

describe("device names and the relay's list", () => {
  it("strips control characters and cuts names to 60 characters, never inside a character", () => {
    expect(deviceName("Ali's\u0000 iPhone\n‮")).toBe("Ali's iPhone");
    expect(deviceName("  \u0007 ")).toBe("unnamed device");
    expect(deviceName(42)).toBe("unnamed device");
    const long = deviceName("x".repeat(100));
    expect([...long]).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
    expect(deviceName("😀".repeat(70))).toBe("😀".repeat(59) + "…");
    expect(deviceName("y".repeat(60))).toBe("y".repeat(60));
  });

  it("reads id, cleaned name and pairing time of each listed device and skips rows without an id", () => {
    const listed = pairedDevices({
      tokens: [
        { id: NEW, name: "a\u0001b", createdAt: 5, lastUsedAt: null, current: false },
        { id: "", name: "x" },
        { name: "no id" },
        "junk",
        { id: IPAD, name: "iPad", createdAt: "yesterday" },
      ],
    });
    expect(listed).toEqual([
      { id: NEW, name: "ab", pairedAt: 5 },
      { id: IPAD, name: "iPad", pairedAt: null },
    ]);
    for (const data of [undefined, {}, { tokens: "none" }]) expect(() => pairedDevices(data)).toThrow();
  });
});

describe("nodeDeviceFs", () => {
  it("writes the file 0600 in a 0700 folder through a temp file and leaves none behind", () => {
    const dir = path.dirname(file);
    expect(nodeDeviceFs.read(file)).toBeUndefined();
    expect(nodeDeviceFs.write(file, "one", false)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(dir, 0o755);
    expect(nodeDeviceFs.write(file, "two", false)).toBe(true);
    expect(nodeDeviceFs.read(file)).toBe("two");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Only when new: the file exists, so nothing changes.
    expect(nodeDeviceFs.write(file, "three", true)).toBe(false);
    expect(nodeDeviceFs.read(file)).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["remote-devices.json"]);
    const other = path.join(base, "fresh", "remote-devices.json");
    expect(nodeDeviceFs.write(other, "new", true)).toBe(true);
    expect(nodeDeviceFs.read(other)).toBe("new");
    expect(fs.readdirSync(path.dirname(other))).toEqual(["remote-devices.json"]);
  });
});
