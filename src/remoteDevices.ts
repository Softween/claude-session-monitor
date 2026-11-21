/**
 * remoteDevices.ts - the paired devices whose remote commands run on this Mac.
 * The relay puts on each command the id of the device token that queued it
 * (`deviceId`); the bridge runs the command only when that device is `allowed`
 * in ~/.claude/session-monitor/remote-devices.json (0600 in a 0700 folder,
 * written through a temp file and a rename). Every window shares the file, so
 * each check reads it again. A device that is not in the file is looked up in
 * the relay's paired devices (GET /fleet/tokens) and, when listed, the window
 * that got the command shows a notification naming it, one per device at a
 * time; only its Review… button opens the modal: Deny (the default button),
 * Allow, or closed (nothing decided). The command is answered at once; after
 * Allow the phone sends it again. Without the file (the first run, or after it
 * was removed) the devices the relay paired before DEVICE_MIGRATION_CUTOFF are
 * allowed, once.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { MONITOR_DIR } from "./core";

export const NOT_CONFIRMED = "device not confirmed on this Mac";
export const DENIED = "device denied on this Mac";
export const PENDING = "device check pending";
export const UNREADABLE = "device list unreadable on this Mac";
export const DEVICE_NAME_MAX = 60;
/** The first run allows only devices the relay paired before this moment (its own createdAt); later ones are asked about. */
export const DEVICE_MIGRATION_CUTOFF = Date.parse("2026-11-21T12:00:00Z");
const CUTOFF_TEXT = new Date(DEVICE_MIGRATION_CUTOFF).toISOString();
const DEVICE_ID_MAX = 128;
const REVIEW = "Review…";

export type DeviceState = "allowed" | "denied";
/** The owner's answer to the modal; undefined: closed without one. */
export type DeviceDecision = "allow" | "deny" | undefined;

/** One device in the file; fields a later version adds are kept on every rewrite. */
export interface DeviceEntry {
  state: DeviceState;
  name: string;
  pairedAt: number | null; // epoch ms
  decidedAt: number; // epoch ms
  [field: string]: unknown;
}

export interface DeviceStore {
  version: 1;
  devices: Record<string, DeviceEntry>;
  [field: string]: unknown;
}

/** A device the relay lists as paired: its token id, cleaned name and pairing time (epoch ms). */
export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number | null;
}

/** The relay's GET /fleet/tokens, resolved to the envelope's data. */
export type PairedLookup = () => Promise<unknown>;

export interface DeviceFs {
  /** The file's text; undefined when it does not exist (any other error throws). */
  read(file: string): string | undefined;
  /** Writes the whole text through a temp file in the same folder; with `onlyNew`, false (nothing written) when the file exists. */
  write(file: string, text: string, onlyNew: boolean): boolean;
}

export interface DeviceGateDeps {
  file: string;
  fs: DeviceFs;
  now(): number; // epoch ms
  /** Asks the owner about the device; `sameName` holds the ids of the allowed devices that have its name. */
  prompt(device: PairedDevice, sameName: string[]): Promise<DeviceDecision>;
  log(msg: string): void;
}

/** What the bridge asks before a command runs: a DeviceGate, or a stand-in in tests. */
export interface DeviceCheck {
  /** The first run: allows the devices the relay paired before DEVICE_MIGRATION_CUTOFF while the file does not exist yet. */
  migrate(lookup: PairedLookup): Promise<void>;
  /** null when the device may run commands, else the answer the relay gets. */
  refusal(deviceId: unknown, lookup: PairedLookup): Promise<string | null>;
}

type Loaded = { kind: "missing" } | { kind: "unreadable"; why: string } | { kind: "ok"; store: DeviceStore };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= DEVICE_ID_MAX;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (id: string): string => id.slice(0, 8);
const entryOf = (store: DeviceStore, id: string): DeviceEntry | undefined => (Object.hasOwn(store.devices, id) ? store.devices[id] : undefined);
const serialize = (store: DeviceStore): string => JSON.stringify(store, null, 2) + "\n";

// Control, format (zero-width, bidirectional), private-use, unassigned and lone surrogate code points, and the line and paragraph separators.
const HIDDEN_RE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/** A relay-sent device name as this Mac shows it: no hidden characters or double quotes, single spaces, at most 60 characters. */
export function deviceName(raw: unknown): string {
  const chars = [...(typeof raw === "string" ? raw : "").replace(HIDDEN_RE, "").replace(/"/g, "").replace(/\s+/g, " ").trim()];
  if (!chars.length) return "unnamed device";
  return chars.length > DEVICE_NAME_MAX ? chars.slice(0, DEVICE_NAME_MAX - 1).join("").trimEnd() + "…" : chars.join("");
}

/** The devices of the relay's GET /fleet/tokens answer; throws when it carries no list. */
export function pairedDevices(data: unknown): PairedDevice[] {
  const tokens = isRecord(data) ? data.tokens : undefined;
  if (!Array.isArray(tokens)) throw new Error("the relay's answer lists no devices");
  return tokens
    .filter((t): t is Record<string, unknown> & { id: string } => isRecord(t) && validId(t.id))
    .map((t) => ({
      id: t.id,
      name: deviceName(t.name),
      pairedAt: typeof t.createdAt === "number" && Number.isFinite(t.createdAt) ? t.createdAt : null,
    }));
}

function parseStore(text: string): DeviceStore | null {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) && v.version === 1 && isRecord(v.devices) ? (v as DeviceStore) : null;
  } catch {
    return null;
  }
}

/** The ids of the other devices allowed in the store under the device's name. */
const allowedSameName = (store: DeviceStore, device: PairedDevice): string[] =>
  Object.entries(store.devices)
    .filter(([id, e]) => id !== device.id && isRecord(e) && e.state === "allowed" && deviceName(e.name) === device.name)
    .map(([id]) => id);

export class DeviceGate implements DeviceCheck {
  private migrating: Promise<void> | undefined;
  private readonly asking = new Set<string>(); // devices this window is looking up or showing the notification or modal for

  constructor(private readonly deps: DeviceGateDeps) {}

  migrate(lookup: PairedLookup): Promise<void> {
    this.migrating ??= this.firstRun(lookup).finally(() => {
      this.migrating = undefined;
    });
    return this.migrating;
  }

  async refusal(deviceId: unknown, lookup: PairedLookup): Promise<string | null> {
    if (!validId(deviceId)) return NOT_CONFIRMED;
    const loaded = this.load();
    if (loaded.kind === "missing") {
      void this.migrate(lookup);
      return PENDING;
    }
    if (loaded.kind === "unreadable") {
      this.deps.log(
        `remote: ${this.deps.file} is unreadable (${loaded.why}); no remote command runs until it is fixed. Removing it is no reset: without the file every device the relay paired before ${CUTOFF_TEXT} is allowed again, denied ones included`,
      );
      return UNREADABLE;
    }
    const state = entryOf(loaded.store, deviceId)?.state;
    if (state === "allowed") return null;
    if (state === "denied") return DENIED;
    void this.ask(deviceId, lookup);
    return NOT_CONFIRMED;
  }

  /** The file: missing, unreadable (any other read error, or not a version 1 device list), or its store. */
  private load(): Loaded {
    let text: string | undefined;
    try {
      text = this.deps.fs.read(this.deps.file);
    } catch (e) {
      return { kind: "unreadable", why: errText(e) };
    }
    if (text === undefined) return { kind: "missing" };
    const store = parseStore(text);
    return store ? { kind: "ok", store } : { kind: "unreadable", why: "not a version 1 device list" };
  }

  private async firstRun(lookup: PairedLookup): Promise<void> {
    if (this.load().kind !== "missing") return;
    let paired: PairedDevice[];
    try {
      paired = pairedDevices(await lookup());
    } catch (e) {
      this.deps.log(`remote: paired devices not read (${errText(e)}); commands wait for that list`);
      return;
    }
    // The relay sets createdAt at pairing, so a later device cannot pass for an earlier one; one without a time is asked about.
    const early = paired.filter((d) => d.pairedAt !== null && d.pairedAt < DEVICE_MIGRATION_CUTOFF);
    const decidedAt = this.deps.now();
    const devices = Object.fromEntries(
      early.map((d): [string, DeviceEntry] => [d.id, { state: "allowed", name: d.name, pairedAt: d.pairedAt, decidedAt }]),
    );
    try {
      // Only when new: the window that created the file first keeps its list.
      if (this.deps.fs.write(this.deps.file, serialize({ version: 1, devices }), true)) {
        const later = paired.length - early.length;
        this.deps.log(
          `remote: first run, ${early.length} device(s) paired before ${CUTOFF_TEXT} confirmed on this Mac${early.length ? ": " + early.map((d) => d.name).join(", ") : ""}${later ? `; ${later} other(s) are asked about at their first command` : ""}`,
        );
      }
    } catch (e) {
      this.deps.log(`remote: device list not written (${errText(e)})`);
    }
  }

  /** Looks the device up and asks once when the relay lists it and no window decided meanwhile; never throws. */
  private async ask(id: string, lookup: PairedLookup): Promise<void> {
    if (this.asking.has(id)) return;
    this.asking.add(id);
    try {
      const device = pairedDevices(await lookup()).find((d) => d.id === id);
      if (!device) {
        this.deps.log(`remote: device ${short(id)} is not paired with the relay (revoked or never paired); not asked`);
        return;
      }
      const askedAt = this.deps.now(); // taken before the read below: a Deny that read does not see is newer
      const store = this.undecided(id);
      if (!store) return;
      const decision = await this.deps.prompt(device, allowedSameName(store, device));
      if (decision === undefined) {
        this.deps.log(`remote: device "${device.name}" (${short(id)}) not decided; its next command asks again`);
        return;
      }
      this.record(device, decision === "allow" ? "allowed" : "denied", askedAt);
    } catch (e) {
      this.deps.log(`remote: device ${short(id)} not asked about: ${errText(e)}`);
    } finally {
      this.asking.delete(id);
    }
  }

  /** Read again right before asking: the store while the file is readable and holds no decision for the device, else null. */
  private undecided(id: string): DeviceStore | null {
    const loaded = this.load();
    if (loaded.kind !== "ok") return null;
    const state = entryOf(loaded.store, id)?.state;
    return state === "allowed" || state === "denied" ? null : loaded.store;
  }

  /**
   * Writes one decision into the file as it is now, so other windows' entries and unknown fields stay.
   * An Allow never replaces a Deny given since `askedAt` (or one of unknown time): a newer Deny wins over a stale Allow.
   */
  private record(device: PairedDevice, state: DeviceState, askedAt: number): void {
    const label = `device "${device.name}" (${short(device.id)}) ${state}`;
    const loaded = this.load();
    if (loaded.kind === "unreadable") {
      this.deps.log(`remote: ${label}, but not saved: ${this.deps.file} is unreadable (${loaded.why})`);
      return;
    }
    const store: DeviceStore = loaded.kind === "ok" ? loaded.store : { version: 1, devices: {} };
    const old = entryOf(store, device.id);
    if (state === "allowed" && isRecord(old) && old.state === "denied" && !(typeof old.decidedAt === "number" && old.decidedAt < askedAt)) {
      this.deps.log(`remote: device "${device.name}" (${short(device.id)}) stays denied: it was denied on this Mac after this window asked`);
      return;
    }
    const entry: DeviceEntry = { ...(isRecord(old) ? old : {}), state, name: device.name, pairedAt: device.pairedAt, decidedAt: this.deps.now() };
    try {
      this.deps.fs.write(this.deps.file, serialize({ ...store, version: 1, devices: { ...store.devices, [device.id]: entry } }), false);
      this.deps.log(`remote: ${label} on this Mac`);
    } catch (e) {
      this.deps.log(`remote: ${label}, but not saved: ${errText(e)}`);
    }
  }
}

/** How the prompts name a device: its pairing time and the first 8 characters of its id, then the relay-sent name. */
function aboutDevice(device: PairedDevice): string {
  const when = device.pairedAt === null ? "at an unknown time" : `on ${new Date(device.pairedAt).toLocaleString()}`;
  // A notification turns "[text](target)" into a link; the space keeps the name plain text.
  const name = device.name.replaceAll("](", "] (");
  return `the device paired with the relay ${when}, id ${short(device.id)}, named "${name}"`;
}

/** The modal's sentence about allowed devices that already have the device's name; "" when none has. */
function sameNameNote(ids: readonly string[]): string {
  if (!ids.length) return "";
  const list = ids.map(short).join(", ");
  return ids.length === 1 ? `A device you allowed earlier (id ${list}) already has this name.` : `Devices you allowed earlier (ids ${list}) already have this name.`;
}

/**
 * A notification naming the device with Review… as its only button, then, only after Review…,
 * the modal whose first button, the one Return presses, is Deny. Dismissing either decides nothing (undefined).
 */
export async function askOnThisMac(device: PairedDevice, sameName: readonly string[]): Promise<DeviceDecision> {
  const about = aboutDevice(device);
  const review = await vscode.window.showWarningMessage(
    `Agent Sessions: refused a remote command from ${about}. Its commands run only after you allow it on this Mac.`,
    REVIEW,
  );
  if (review !== REVIEW) return undefined;
  const detail =
    "Commands from a newly paired device run on this Mac only after you allow it. Deny refuses its commands, Allow runs them from now on, and closing this dialog decides nothing. If you did not pair this device, choose Deny and revoke it on the relay.";
  const pick = await vscode.window.showWarningMessage(
    `Agent Sessions: run remote commands from ${about}?`,
    { modal: true, detail: [sameNameNote(sameName), detail].filter(Boolean).join(" ") },
    "Deny",
    "Allow",
  );
  return pick === "Allow" ? "allow" : pick === "Deny" ? "deny" : undefined;
}

/** Node's file system: the folder made or set 0700, the text written 0600 under a unique temp name, then renamed (or linked when only new). */
export const nodeDeviceFs: DeviceFs = {
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  write(file, text, onlyNew) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
      if (!onlyNew) {
        fs.renameSync(tmp, file);
        return true;
      }
      try {
        fs.linkSync(tmp, file); // refused while the file exists
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
};

/** The gate the bridge uses: the shared file under ~/.claude/session-monitor, the clock and the modal. */
export function createDeviceGate(log: (msg: string) => void): DeviceGate {
  return new DeviceGate({ file: path.join(MONITOR_DIR, "remote-devices.json"), fs: nodeDeviceFs, now: () => Date.now(), prompt: askOnThisMac, log });
}
