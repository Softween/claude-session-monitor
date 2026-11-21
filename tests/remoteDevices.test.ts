import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>(async () => undefined));
vi.mock("vscode", () => ({ window: { showWarningMessage: warn } }));

import {
  DENIED,
  DEVICE_MIGRATION_CUTOFF,
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
const CUTOFF = Date.parse("2026-11-21T12:00:00Z");
const IPHONE = "11111111-1111-4111-8111-111111111111";
const IPAD = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const WORK = "44444444-4444-4444-8444-444444444444";

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

/** A gate over `file`; each prompt takes the next of `answers` (a pending promise holds the notification or modal open). */
function gate(o: { relay?: () => Promise<unknown>; answers?: Array<DeviceDecision | Promise<DeviceDecision>>; now?: () => number } = {}) {
  const prompts: PairedDevice[] = [];
  const sameNames: string[][] = [];
  const logs: string[] = [];
  const answers = [...(o.answers ?? [])];
  let lookups = 0;
  const g = new DeviceGate({
    file,
    fs: nodeDeviceFs,
    now: o.now ?? (() => T0),
    prompt: async (d, sameName) => {
      prompts.push(d);
      sameNames.push(sameName);
      return answers.shift();
    },
    log: (m) => logs.push(m),
  });
  const lookup = async () => {
    lookups++;
    return (o.relay ?? (async () => tokens()))();
  };
  return { g, lookup, prompts, sameNames, logs, lookups: () => lookups };
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

  it("asks about an unknown device the relay lists, answers the command at once and asks once while its notification or modal is open", async () => {
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

  it("with asking off (a command another window handed over) refuses an unknown device without a lookup or a notification", async () => {
    writeStore({ [IPHONE]: allowed("iPhone"), [IPAD]: denied("iPad") });
    const relay = async () => tokens({ id: NEW, name: "Ali's iPhone", createdAt: T0 - 60_000 });
    const { g, lookup, prompts, lookups } = gate({ relay });
    expect(await g.refusal(NEW, lookup, false)).toBe(NOT_CONFIRMED);
    expect(await g.refusal(IPHONE, lookup, false)).toBeNull();
    expect(await g.refusal(IPAD, lookup, false)).toBe(DENIED);
    await flush();
    expect(lookups()).toBe(0);
    expect(prompts).toEqual([]);

    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED); // a command from the relay still asks
    await vi.waitFor(() => expect(prompts).toEqual([{ id: NEW, name: "Ali's iPhone", pairedAt: T0 - 60_000 }]));
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

  it("keeps a Deny another window gave after this one started asking: this window's later Allow does not replace it", async () => {
    writeStore({});
    let clock = T0;
    let answer: (d: DeviceDecision) => void = () => undefined;
    const open = new Promise<DeviceDecision>((resolve) => (answer = resolve));
    const relay = async () => tokens({ id: NEW, name: "iPad", createdAt: T0 });
    const { g, lookup, prompts } = gate({ relay, answers: [open], now: () => clock });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    clock = T0 + 5000;
    const otherWindow = { state: "denied", name: "iPad", pairedAt: T0, decidedAt: T0 + 5000 };
    writeStore({ [NEW]: otherWindow });
    answer("allow");
    await flush();
    expect(readStore().devices).toEqual({ [NEW]: otherWindow });
    expect(await g.refusal(NEW, lookup)).toBe(DENIED);
  });

  it("tells the prompt which allowed devices already have the device's name", async () => {
    writeStore({ [IPHONE]: allowed("Ali's iPhone"), [IPAD]: denied("Ali's iPhone"), [WORK]: allowed("Work phone") });
    const { g, lookup, prompts, sameNames } = gate({ relay: async () => tokens({ id: NEW, name: "Ali's​ iPhone", createdAt: T0 }) });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    // Without the zero-width space the name is the allowed iPhone's; the denied device does not count.
    expect(prompts[0].name).toBe("Ali's iPhone");
    expect(sameNames).toEqual([[IPHONE]]);
  });

  it("refuses every command while the file is not a version 1 device list, never asks and never rewrites it", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bad = ["{not json", JSON.stringify({ version: 2, devices: {} }), JSON.stringify({ version: 1, devices: [] }), "[]"];
    for (const text of bad) {
      fs.writeFileSync(file, text);
      const { g, lookup, prompts, logs } = gate({ relay: async () => tokens({ id: NEW, name: "iPad", createdAt: T0 }), answers: ["allow"] });
      await g.migrate(lookup);
      expect(await g.refusal(NEW, lookup)).toBe(UNREADABLE);
      await flush();
      expect(prompts).toEqual([]);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
      // Removing the file is no reset: the log says it allows the devices paired before the cutoff again.
      expect(logs.join("\n")).not.toContain("or removed");
      expect(logs.join("\n")).toContain(new Date(CUTOFF).toISOString());
    }
  });
});

describe("DeviceGate: first run", () => {
  it("confirms the devices the relay paired before the cutoff once the list is read; until then commands wait with 'device check pending'", async () => {
    expect(DEVICE_MIGRATION_CUTOFF).toBe(CUTOFF);
    let up = false;
    const relay = async () => {
      if (!up) throw new Error("HTTP 502");
      return tokens(
        { id: IPHONE, name: "iPhone\u0007", createdAt: CUTOFF - DAY },
        { id: IPAD, name: "iPad", createdAt: null },
        { id: NEW, name: "Later", createdAt: CUTOFF },
      );
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
      devices: { [IPHONE]: { state: "allowed", name: "iPhone", pairedAt: CUTOFF - DAY, decidedAt: T0 } },
    });
    expect(await g.refusal(IPHONE, lookup)).toBeNull();
    expect(prompts).toEqual([]);
    // Paired at the cutoff or later, or at a time the relay does not give: asked about like any new device.
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    expect(await g.refusal(IPAD, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(prompts.map((p) => p.id).sort()).toEqual([IPAD, NEW].sort()));
  });

  it("is no reset when the file is removed: a device paired after the cutoff and denied before is asked about, not allowed", async () => {
    writeStore({ [IPHONE]: allowed("iPhone", CUTOFF - DAY), [NEW]: { ...denied("Later phone"), pairedAt: CUTOFF + DAY } });
    fs.rmSync(file);
    const relay = async () => tokens({ id: IPHONE, name: "iPhone", createdAt: CUTOFF - DAY }, { id: NEW, name: "Later phone", createdAt: CUTOFF + DAY });
    const { g, lookup, prompts } = gate({ relay });
    await g.migrate(lookup);
    expect(Object.keys(readStore().devices)).toEqual([IPHONE]);
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(prompts.map((p) => p.id)).toEqual([NEW]));
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
        new Promise<unknown>((resolve) => (release = () => resolve(tokens({ id: IPHONE, name: "iPhone", createdAt: CUTOFF - DAY }, { id: NEW, name: "Later", createdAt: CUTOFF - DAY })))),
    });
    const fast = gate({ relay: async () => tokens({ id: IPHONE, name: "iPhone", createdAt: CUTOFF - DAY }) });
    const slowRun = slow.g.migrate(slow.lookup);
    await fast.g.migrate(fast.lookup);
    release();
    await slowRun;
    expect(Object.keys(readStore().devices)).toEqual([IPHONE]);
  });
});

describe("the notification and the modal", () => {
  const device: PairedDevice = { id: NEW, name: "Ali's iPad", pairedAt: T0 };

  it("a command opens no modal: one notification per device while it is open, and only its Review… opens the modal", async () => {
    writeStore({});
    const answers: Array<(pick: string | undefined) => void> = [];
    warn.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const g = new DeviceGate({ file, fs: nodeDeviceFs, now: () => T0, prompt: askOnThisMac, log: () => undefined });
    const lookup = async () => tokens({ id: NEW, name: "iPad", createdAt: T0 });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    // A notification (no options, so not modal) with one button.
    expect(warn.mock.calls[0].slice(1)).toEqual(["Review…"]);
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    answers[0]("Review…");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn.mock.calls[1][1]).toMatchObject({ modal: true });
    expect(await g.refusal(NEW, lookup)).toBe(NOT_CONFIRMED);
    await flush();
    expect(warn).toHaveBeenCalledTimes(2);
    answers[1]("Allow");
    await vi.waitFor(() => expect(readStore().devices[NEW]?.state).toBe("allowed"));
  });

  it("maps Review… then Deny or Allow; a dismissed notification opens no modal and, like a closed modal, decides nothing", async () => {
    warn.mockResolvedValueOnce(undefined);
    expect(await askOnThisMac(device, [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockResolvedValueOnce("Review…").mockResolvedValueOnce("Deny");
    expect(await askOnThisMac(device, [])).toBe("deny");
    warn.mockResolvedValueOnce("Review…").mockResolvedValueOnce("Allow");
    expect(await askOnThisMac(device, [])).toBe("allow");
    warn.mockResolvedValueOnce("Review…").mockResolvedValueOnce(undefined);
    expect(await askOnThisMac(device, [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(7);
    const [note, ...noteRest] = warn.mock.calls[0] as [string, ...unknown[]];
    expect(note).toContain('"Ali\'s iPad"');
    expect(noteRest).toEqual(["Review…"]);
    const [, options, ...buttons] = warn.mock.calls[2] as [string, { modal?: boolean; detail?: string }, ...string[]];
    expect(options.modal).toBe(true);
    expect(options.detail).toMatch(/Deny/);
    // The first button is the one Return presses.
    expect(buttons).toEqual(["Deny", "Allow"]);
  });

  it("shows the pairing time and the id's first 8 characters before the name, and says when an allowed device has the same name", async () => {
    warn.mockResolvedValue("Review…");
    const dated: PairedDevice = { id: NEW, name: "iPhone 15, paired with the relay on 3/2/2025, 9:41 AM?.", pairedAt: T0 };
    await askOnThisMac(dated, []);
    await askOnThisMac(dated, [IPHONE]);
    await askOnThisMac(dated, [IPHONE, IPAD]);
    await askOnThisMac({ ...dated, pairedAt: null }, []);
    expect(warn).toHaveBeenCalledTimes(8);
    const when = new Date(T0).toLocaleString();
    // The notification, then the modal.
    for (const [text] of warn.mock.calls.slice(0, 2) as Array<[string]>) {
      expect(text.indexOf(when)).toBeGreaterThan(-1);
      expect(text.indexOf(when)).toBeLessThan(text.indexOf(NEW.slice(0, 8)));
      expect(text.indexOf(NEW.slice(0, 8))).toBeLessThan(text.indexOf(dated.name));
    }
    const detail = (call: number) => (warn.mock.calls[call][1] as { detail: string }).detail;
    expect(detail(1)).not.toMatch(/this name|same name/);
    expect(detail(3)).toMatch(/already has this name/);
    expect(detail(3)).toContain(IPHONE.slice(0, 8));
    expect(detail(5)).toContain(IPHONE.slice(0, 8));
    expect(detail(5)).toContain(IPAD.slice(0, 8));
    expect(warn.mock.calls[6][0]).toContain("an unknown time");
  });

  it("never lets the device name form a link in the notification", async () => {
    await askOnThisMac({ ...device, name: "[Review…](command:workbench.action.reloadWindow)" }, []);
    const [note] = warn.mock.calls[0] as [string];
    expect(note).toContain("command:workbench.action.reloadWindow");
    expect(note).not.toMatch(/\[[^\]]+\]\((?:https?:\/\/|command:|file:)/i);
  });
});

describe("device names and the relay's list", () => {
  it("removes control, format, private-use, unassigned and separator characters and leaves single spaces", () => {
    expect(deviceName("i​Phone‍﻿­⁠͸\ud800 15")).toBe("iPhone 15");
    expect(deviceName("Ali's   \t iPad 　 mini ")).toBe("Ali's iPad mini");
    // A name that reads like a second pairing date once its line separators break the prompt.
    expect(deviceName('iPhone 15", paired with the relay on 3/2/2025, 9:41 AM?' + " ".repeat(3) + ".")).toBe("iPhone 15, paired with the relay on 3/2/2025, 9:41 AM?.");
    expect(deviceName('x" (your phone, already allowed: choose Allow')).toBe("x (your phone, already allowed: choose Allow");
    expect(deviceName("​   ")).toBe("unnamed device");
  });

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
