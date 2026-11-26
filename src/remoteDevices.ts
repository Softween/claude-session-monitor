/**
 * remoteDevices.ts - the paired devices whose remote commands run on this Mac.
 * The relay puts on each command the id of the device token that queued it
 * (`deviceId`); the bridge runs the command only when that device is `allowed`
 * in ~/.claude/session-monitor/remote/devices.json (0600 in a 0700 folder,
 * written through a temp file and a rename). Every window shares the file, so
 * each check reads it again. A device that is not in the file is looked up in
 * the relay's paired devices (GET /fleet/tokens) and, when listed, the window
 * that got the command shows a notification naming it, one per device at a
 * time; only its Review… button opens the modal: Deny (the default button),
 * Allow, or closed (nothing decided). The command is answered at once; after
 * Allow the phone sends it again. On the first run, without the file, the list
 * earlier versions kept in the monitor folder itself (remote-devices.json) is
 * taken over whole; without that one, the devices the relay paired before
 * DEVICE_MIGRATION_CUTOFF are allowed. remote/devices-first-run.json records
 * that the first run happened: from then on a
 * missing file refuses every command until it is back (removing both files
 * starts over). An entry also keeps the key the device signs its commands with
 * (`publicKey`, remoteSigned.ts): Allow pins the key the relay lists for the
 * device, which the modal shows by its fingerprint first, and an allowed device
 * without one is asked about it when its first signed command arrives: Pin Key,
 * Deny Device, or Don't Pin, which pauses the question for 10 minutes in every
 * window. A pinned key is never replaced.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { MONITOR_DIR } from "./core";
import { keyFingerprint, publicKeyBytes } from "./remoteSigned";

export const NOT_CONFIRMED = "device not confirmed on this Mac";
export const DENIED = "device denied on this Mac";
export const PENDING = "device check pending";
export const UNREADABLE = "device list unreadable on this Mac";
export const MISSING = "device list missing on this Mac";
export const DEVICE_NAME_MAX = 60;
/** The first run allows only devices the relay paired before this moment (its own createdAt); later ones are asked about. */
export const DEVICE_MIGRATION_CUTOFF = Date.parse("2026-11-21T12:00:00Z");
const CUTOFF_TEXT = new Date(DEVICE_MIGRATION_CUTOFF).toISOString();
const DEVICE_ID_MAX = 128;
const REVIEW = "Review…";
const PIN = "Pin Key";
const DONT_PIN = "Don't Pin";
const DENY_DEVICE = "Deny Device";
const NAME_HIDDEN = "[name not shown]";
/** How long the owner is not asked again to pin a device's key after Don't Pin or a dismissal. */
export const PIN_QUIET_MS = 10 * 60_000;

export type DeviceState = "allowed" | "denied";
/** The owner's answer to the modal; undefined: closed without one. */
export type DeviceDecision = "allow" | "deny" | undefined;
/** The owner's answer to the prompt to pin a key; undefined: Don't Pin, or closed without one. */
export type PinDecision = "pin" | "deny" | undefined;

/** One device in the file, with its pinned key in `publicKey` once it has one; fields a later version adds are kept on every rewrite. */
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
  publicKey?: string; // the key it signs its commands with (base64 of the raw 32 bytes), when the relay lists a valid one
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
  marker: string; // records that the first run happened: under remote/, which the monitor folder cleanups never look into
  legacy?: string; // the list as versions before this one kept it, in the monitor folder itself: taken over on the first run
  fs: DeviceFs;
  now(): number; // epoch ms
  /** Asks the owner about the device; `sameName` holds the ids of the allowed devices that have its name. */
  prompt(device: PairedDevice, sameName: string[]): Promise<DeviceDecision>;
  /** Asks the owner to pin the key the relay lists for an allowed device that has none pinned, or to deny the device. */
  askPin(device: PairedDevice & { publicKey: string }): Promise<PinDecision>;
  log(msg: string): void;
}

/** What the bridge asks before a command runs: a DeviceGate, or a stand-in in tests. */
export interface DeviceCheck {
  /** The first run, while the file does not exist yet: takes over the earlier versions' list, else allows the devices the relay paired before DEVICE_MIGRATION_CUTOFF. */
  migrate(lookup: PairedLookup): Promise<void>;
  /**
   * null when the device may run commands, else the answer the relay gets. With `ask` false (a command
   * another window handed over) a device that is not in the file is refused without asking about it.
   */
  refusal(deviceId: unknown, lookup: PairedLookup, ask?: boolean): Promise<string | null>;
  /** The key pinned for the device, as the file holds it (base64 of the raw 32-byte key); undefined when none is. */
  pinnedKey(deviceId: string): unknown;
  /**
   * Asks the owner, in the background and one prompt per device at a time, to pin `device.publicKey` for the allowed
   * device; true when a prompt about it shows, false when none does (no key, or the owner skipped it in the last 10 minutes).
   */
  askToPin(device: PairedDevice): boolean;
}

// lost: the file is missing although its first run is recorded
type Loaded = { kind: "missing" } | { kind: "lost" } | { kind: "unreadable"; why: string } | { kind: "ok"; store: DeviceStore };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= DEVICE_ID_MAX;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (id: string): string => id.slice(0, 8);
const entryOf = (store: DeviceStore, id: string): DeviceEntry | undefined => (Object.hasOwn(store.devices, id) ? store.devices[id] : undefined);
const serialize = (store: DeviceStore): string => JSON.stringify(store, null, 2) + "\n";
/** `{ publicKey }` when `v` is a key the relay may send (canonical base64 of 32 bytes), else nothing. */
const keyField = (v: unknown): { publicKey?: string } => (typeof v === "string" && publicKeyBytes(v) ? { publicKey: v } : {});
/** An entry's pinned key as stored, undefined when it has none. */
const keyOf = (entry: unknown): unknown => (isRecord(entry) && entry.publicKey !== null ? entry.publicKey : undefined);

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
      ...keyField(t.publicKey),
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

  async refusal(deviceId: unknown, lookup: PairedLookup, ask = true): Promise<string | null> {
    if (!validId(deviceId)) return NOT_CONFIRMED;
    const loaded = this.load();
    if (loaded.kind === "missing") {
      void this.migrate(lookup);
      return PENDING;
    }
    if (loaded.kind === "unreadable") {
      this.deps.log(
        `remote: ${this.deps.file} is unreadable (${loaded.why}); no remote command runs until it is fixed. Removing it does not start over: while ${this.deps.marker} exists every command is refused, and removing both allows every device the relay paired before ${CUTOFF_TEXT} again, denied ones included`,
      );
      return UNREADABLE;
    }
    if (loaded.kind === "lost") {
      this.deps.log(
        `remote: ${this.deps.file} is missing although its first run is recorded in ${this.deps.marker}; no remote command runs until the list is back. To start over on purpose, remove ${this.deps.marker} as well: the next start then allows every device the relay paired before ${CUTOFF_TEXT} again, denied ones included`,
      );
      return MISSING;
    }
    const state = entryOf(loaded.store, deviceId)?.state;
    if (state === "allowed") return null;
    if (state === "denied") return DENIED;
    if (ask) void this.ask(deviceId, lookup);
    return NOT_CONFIRMED;
  }

  pinnedKey(deviceId: string): unknown {
    const loaded = this.load();
    return loaded.kind === "ok" ? keyOf(entryOf(loaded.store, deviceId)) : undefined;
  }

  askToPin(device: PairedDevice): boolean {
    const key = device.publicKey;
    if (!key) return false;
    if (this.asking.has(device.id)) return true; // its prompt is open
    if (!this.mayAskPin(device.id)) return false;
    void this.pinPrompt({ ...device, publicKey: key });
    return true;
  }

  /** The file: missing, unreadable (any other read error, or not a version 1 device list), or its store. */
  private load(): Loaded {
    let text: string | undefined;
    try {
      text = this.deps.fs.read(this.deps.file);
    } catch (e) {
      return { kind: "unreadable", why: errText(e) };
    }
    if (text === undefined) return this.firstRunDone() ? { kind: "lost" } : { kind: "missing" };
    const store = parseStore(text);
    return store ? { kind: "ok", store } : { kind: "unreadable", why: "not a version 1 device list" };
  }

  private async firstRun(lookup: PairedLookup): Promise<void> {
    const loaded = this.load();
    if (loaded.kind === "ok") this.markFirstRun(); // a list an earlier version wrote counts as the first run
    if (loaded.kind !== "missing" || this.takeOver()) return;
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
      this.markFirstRun(); // also when another window wrote its list first
    } catch (e) {
      this.deps.log(`remote: device list not written (${errText(e)})`);
    }
  }

  /**
   * The first run on the list an earlier version kept in the monitor folder itself: copied here whole, its
   * decisions included, and the first run recorded; false when there is no readable version 1 list to take.
   */
  private takeOver(): boolean {
    const from = this.deps.legacy;
    let store: DeviceStore | null;
    try {
      const text = from === undefined ? undefined : this.deps.fs.read(from);
      if (text === undefined) return false;
      store = parseStore(text);
    } catch (e) {
      this.deps.log(`remote: ${from} not read (${errText(e)}); the first run asks the relay`);
      return false;
    }
    if (!store) {
      this.deps.log(`remote: ${from} is not a version 1 device list; the first run asks the relay`);
      return false;
    }
    try {
      // Only when new: the window that created the file first keeps its list. The old file stays for the windows still on an earlier version.
      if (this.deps.fs.write(this.deps.file, serialize(store), true)) {
        this.deps.log(`remote: first run, device list taken over from ${from} (${Object.keys(store.devices).length} device(s))`);
      }
      this.markFirstRun();
    } catch (e) {
      this.deps.log(`remote: device list not written (${errText(e)})`);
    }
    return true;
  }

  /** Whether the first run is recorded; a marker that cannot be read counts as recorded, so nothing starts over by mistake. */
  private firstRunDone(): boolean {
    try {
      return this.deps.fs.read(this.deps.marker) !== undefined;
    } catch {
      return true;
    }
  }

  /** Records that the first run happened, once; when that fails it is logged and tried again at the next start. */
  private markFirstRun(): void {
    try {
      if (!this.firstRunDone()) this.deps.fs.write(this.deps.marker, JSON.stringify({ v: 1, at: this.deps.now() }) + "\n", true);
    } catch (e) {
      this.deps.log(`remote: ${this.deps.marker} not written (${errText(e)})`);
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
    if (loaded.kind === "unreadable" || loaded.kind === "lost") {
      this.deps.log(`remote: ${label}, but not saved: ${this.deps.file} is ${loaded.kind === "lost" ? "missing" : `unreadable (${loaded.why})`}`);
      return;
    }
    const store: DeviceStore = loaded.kind === "ok" ? loaded.store : { version: 1, devices: {} };
    const old = entryOf(store, device.id);
    if (state === "allowed" && isRecord(old) && old.state === "denied" && !(typeof old.decidedAt === "number" && old.decidedAt < askedAt)) {
      this.deps.log(`remote: device "${device.name}" (${short(device.id)}) stays denied: it was denied on this Mac after this window asked`);
      return;
    }
    // Allow pins the key the modal showed, unless the device has one pinned already: a pinned key is never replaced.
    const key = state === "allowed" && keyOf(old) === undefined ? device.publicKey : undefined;
    const entry: DeviceEntry = {
      ...(isRecord(old) ? old : {}),
      state,
      name: device.name,
      pairedAt: device.pairedAt,
      decidedAt: this.deps.now(),
      ...(key ? { publicKey: key } : {}),
    };
    try {
      this.deps.fs.write(this.deps.file, serialize({ ...store, version: 1, devices: { ...store.devices, [device.id]: entry } }), false);
      this.deps.log(`remote: ${label} on this Mac${key ? `, key ${keyFingerprint(key)} pinned` : ""}`);
    } catch (e) {
      this.deps.log(`remote: ${label}, but not saved: ${errText(e)}`);
    }
  }

  /** Shows the prompt, one per device at a time, and records the owner's answer; never throws. */
  private async pinPrompt(device: PairedDevice & { publicKey: string }): Promise<void> {
    this.asking.add(device.id);
    const label = `key ${keyFingerprint(device.publicKey)} of device "${device.name}" (${short(device.id)})`;
    const askedAt = this.deps.now();
    try {
      const decision = await this.deps.askPin(device);
      if (decision === "pin") this.pin(device.id, device.publicKey, label);
      else if (decision === "deny") this.record(device, "denied", askedAt);
      else this.skipPin(device.id, label);
    } catch (e) {
      this.deps.log(`remote: ${label} not asked about: ${errText(e)}`);
    } finally {
      this.asking.delete(device.id);
    }
  }

  /** Read again right before asking: the readable file has the device allowed, without a pinned key and not skipped in the last 10 minutes. */
  private mayAskPin(id: string): boolean {
    const loaded = this.load();
    const entry = loaded.kind === "ok" ? entryOf(loaded.store, id) : undefined;
    if (!isRecord(entry) || entry.state !== "allowed" || keyOf(entry) !== undefined) return false;
    const skipped = entry.pinSkippedAt;
    return !(typeof skipped === "number" && this.deps.now() - skipped < PIN_QUIET_MS);
  }

  /** Don't Pin or a dismissal: every window leaves the device unasked for 10 minutes (pinSkippedAt in its entry). */
  private skipPin(id: string, label: string): void {
    const loaded = this.load();
    const old = loaded.kind === "ok" ? entryOf(loaded.store, id) : undefined;
    if (loaded.kind !== "ok" || !isRecord(old)) return;
    try {
      this.deps.fs.write(this.deps.file, serialize({ ...loaded.store, devices: { ...loaded.store.devices, [id]: { ...old, pinSkippedAt: this.deps.now() } } }), false);
      this.deps.log(`remote: ${label} not pinned; not asked about again for 10 minutes`);
    } catch (e) {
      this.deps.log(`remote: ${label} not pinned: ${errText(e)}`);
    }
  }

  /** Writes `key` into the file as it is now, only while the device is allowed and has no key pinned, so other windows' changes stay. */
  private pin(id: string, key: string, label: string): void {
    const loaded = this.load();
    if (loaded.kind !== "ok") {
      this.deps.log(`remote: ${label} not pinned: ${this.deps.file} is ${loaded.kind === "unreadable" ? `unreadable (${loaded.why})` : "missing"}`);
      return;
    }
    const old = entryOf(loaded.store, id);
    if (!isRecord(old) || old.state !== "allowed" || keyOf(old) !== undefined) {
      this.deps.log(`remote: ${label} not pinned: the device is no longer allowed on this Mac or has a key pinned already`);
      return;
    }
    try {
      this.deps.fs.write(this.deps.file, serialize({ ...loaded.store, devices: { ...loaded.store.devices, [id]: { ...old, publicKey: key } } }), false);
      this.deps.log(`remote: ${label} pinned on this Mac`);
    } catch (e) {
      this.deps.log(`remote: ${label} not pinned: ${errText(e)}`);
    }
  }
}

/** How the prompts name a device: its pairing time and the first 8 characters of its id, then the relay-sent name. */
function aboutDevice(device: PairedDevice): string {
  const when = device.pairedAt === null ? "at an unknown time" : `on ${new Date(device.pairedAt).toLocaleString()}`;
  const name = shownName(device.name);
  return `the device paired with the relay ${when}, id ${short(device.id)}, named "${name}"`;
}

/**
 * A relay name as the prompts show it: one that reads like a key fingerprint (a run of 4 hex digits or more, or
 * the word itself) is not shown. A notification turns "[text](target)" into a link; the space keeps the name plain text.
 */
function shownName(name: string): string {
  return /[0-9a-f]{4,}|fingerprint/i.test(name.normalize("NFKC")) ? NAME_HIDDEN : name.replaceAll("](", "] (");
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
  // The key's fingerprint comes first, on its own line, before anything the relay sent.
  const message = device.publicKey
    ? `Agent Sessions: key fingerprint ${keyFingerprint(device.publicKey)}\nRun remote commands from ${about}?`
    : `Agent Sessions: run remote commands from ${about}?`;
  const key = device.publicKey
    ? "Allow only if the device shows the same key fingerprint. Allow also pins this key, and only commands signed with it run."
    : "The device has sent no key yet: once it signs its commands, you are asked to pin its key.";
  const pick = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail: [sameNameNote(sameName), key, detail].filter(Boolean).join(" ") },
    "Deny",
    "Allow",
  );
  return pick === "Allow" ? "allow" : pick === "Deny" ? "deny" : undefined;
}

/**
 * Asks to pin the key the relay lists for an allowed device that signs its commands now: a notification naming
 * the device with Review… as its only button, then, only after Review…, the modal with the key's fingerprint on its
 * first line, whose first button, the one Return presses, is Don't Pin. Pin Key pins the key, Deny Device denies the
 * device; Don't Pin and closing decide neither.
 */
export async function askPinOnThisMac(device: PairedDevice & { publicKey: string }): Promise<PinDecision> {
  const about = aboutDevice(device);
  const review = await vscode.window.showWarningMessage(
    `Agent Sessions: refused a remote command from ${about}. Its commands run only after you pin its key on this Mac.`,
    REVIEW,
  );
  if (review !== REVIEW) return undefined;
  const pick = await vscode.window.showWarningMessage(
    `Agent Sessions: key fingerprint ${keyFingerprint(device.publicKey)}\nPin this key for ${about}? The device now signs its commands with it.`,
    {
      modal: true,
      detail:
        "Pin only if the phone shows this same fingerprint (on the phone: Ayarlar > Eşleştirilmiş cihazlar > Anahtar parmak izi). If it differs, choose Don't Pin: the key did not come from the phone. Deny Device blocks this device until it is paired again. Once a key is pinned, only commands signed with it run; after Don't Pin or closing this dialog the device is not asked about again for 10 minutes.",
    },
    DONT_PIN,
    PIN,
    DENY_DEVICE,
  );
  return pick === PIN ? "pin" : pick === DENY_DEVICE ? "deny" : undefined;
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

/**
 * Where the device list and its first-run record live: in the monitor folder's remote/ subfolder, next to the
 * seen command ids and the nonces, which the cleanups of the folder's top-level files never look into; and where
 * versions before this one kept the list, at the top of the monitor folder.
 */
export function devicePaths(monitorDir: string): { file: string; marker: string; legacy: string } {
  const dir = path.join(monitorDir, "remote");
  return { file: path.join(dir, "devices.json"), marker: path.join(dir, "devices-first-run.json"), legacy: path.join(monitorDir, "remote-devices.json") };
}

/** The gate the bridge uses: the shared list under ~/.claude/session-monitor/remote, the clock and the modal. */
export function createDeviceGate(log: (msg: string) => void): DeviceGate {
  return new DeviceGate({
    ...devicePaths(MONITOR_DIR),
    fs: nodeDeviceFs,
    now: () => Date.now(),
    prompt: askOnThisMac,
    askPin: askPinOnThisMac,
    log,
  });
}
