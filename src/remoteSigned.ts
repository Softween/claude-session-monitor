/**
 * remoteSigned.ts - the paired device's signature on a remote command. The
 * phone app signs every command with an Ed25519 key that stays on the phone:
 * `signed` is one JSON text with `v: 1`, a nonce, the device id, the target
 * host, the command type, its arguments (named as FleetCommand names them) and
 * the time in ms; `sig` is the signature of that text's UTF-8 bytes, in base64.
 * The relay carries both unchanged. A command runs only when `signed` verifies
 * against the key pinned for its device on this Mac (remoteDevices.ts), names
 * that device and this Mac's host, was signed within 5 minutes of this Mac's
 * clock, carries a nonce no window took before (seenIds.ts, kept 11 minutes)
 * and has a type the settings allow; it then runs as built from the signed type
 * and arguments alone. An allowed device without a pinned key gets a prompt to
 * pin the key the relay lists for it, once a command of it verifies against
 * that key. No vscode import.
 */
import { createHash, createPublicKey, verify } from "crypto";
import * as path from "path";
import { MONITOR_DIR } from "./core";
import { REMOTE_COMMAND_TYPES } from "./remote";
import type { FleetCommand } from "./remoteBridge";
import type { DeviceCheck, PairedDevice } from "./remoteDevices";
import { SeenIds, nodeSeenFs } from "./seenIds";

/** How far the signed time may be from this Mac's clock, either way. */
export const SIGNED_WINDOW_MS = 5 * 60_000;
/** How long a nonce is kept: longer than twice the window, so it outlives every moment its command is valid. */
export const NONCE_RETAIN_MS = 11 * 60_000;

export const UNSIGNED = "command not signed";
export const NOT_VERIFIED = "signature does not match the device's key";
export const NOT_READABLE = "signed command not readable";
export const OTHER_DEVICE = "signed by another device";
export const OTHER_HOST = "signed for another host";
export const TOO_OLD = "signed more than 5 minutes ago";
export const AHEAD = "signed more than 5 minutes ahead of this Mac's clock";
export const NONCE_SEEN = "signed command already received";
export const NO_KEY = "the relay lists no key for the device";
export const KEY_NOT_READ = "the device's key could not be read from the relay; send the command again";
export const KEY_NOT_PINNED = "the device's key is not pinned on this Mac";
export const CONFIRM_KEY = "the device's key is not pinned on this Mac: confirm it on the Mac, then send the command again";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex"); // the DER header of an Ed25519 public key (RFC 8410)
const STRING_ARGS = ["sessionId", "text", "account", "cwd", "toolUseId"] as const;

export interface SignedDeps {
  host: string; // this Mac's remote host: the name the bridge polls the relay with
  allowed: readonly string[]; // remote.allowedCommands
  now(): number; // epoch ms
  nonces: Pick<SeenIds, "claim">; // the nonces taken so far, shared by every window
  devices: Pick<DeviceCheck, "pinnedKey" | "askToPin">;
  /** The device as the relay lists it now (GET /fleet/tokens), with its key; undefined when it is not listed. Throws when the list is not read. */
  listed(deviceId: string): Promise<PairedDevice | undefined>;
}

/** The command to run, built from the signed fields, or why the command must not run. */
export type SignedCheck = { ok: true; cmd: FleetCommand } | { ok: false; refusal: string };

type Signed = { ok: true; nonce: string; type: string; args: Partial<FleetCommand> } | { ok: false; refusal: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (refusal: string): { ok: false; refusal: string } => ({ ok: false, refusal });

/** `text` as exactly `length` bytes of canonical base64, else undefined. */
function base64Bytes(text: unknown, length: number): Buffer | undefined {
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.from(text, "base64");
  return bytes.length === length && bytes.toString("base64") === text ? bytes : undefined;
}

/** The raw bytes of a public key sent as base64: 32 bytes in canonical base64, else undefined. */
export function publicKeyBytes(key: unknown): Buffer | undefined {
  return base64Bytes(key, 32);
}

/** A key's fingerprint as the phone and this Mac show it: the first 8 bytes of the raw key's SHA-256, lowercase hex in groups of 4. */
export function keyFingerprint(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 16);
  return hex.replace(/(.{4})(?=.)/g, "$1 ");
}

/** Whether `sig` (base64 of 64 bytes) is the Ed25519 signature of `signed`'s UTF-8 bytes under `key` (base64 of the raw 32-byte key). */
export function verifySigned(signed: string, sig: unknown, key: unknown): boolean {
  const raw = publicKeyBytes(key);
  const signature = base64Bytes(sig, 64);
  const bytes = Buffer.from(signed, "utf8");
  // A lone surrogate becomes the bytes of U+FFFD: only a text that its bytes spell out exactly is the text that was signed.
  if (!raw || !signature || bytes.toString("utf8") !== signed) return false;
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
    return verify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}

/** The signed arguments the bridge reads, by their FleetCommand names; undefined when one has the wrong type. Other names are left out. */
function argsOf(raw: unknown): Partial<FleetCommand> | undefined {
  if (!isRecord(raw)) return undefined;
  const args: Partial<FleetCommand> = {};
  for (const name of STRING_ARGS) {
    if (!Object.hasOwn(raw, name)) continue;
    const value = raw[name];
    if (typeof value !== "string" && value !== null) return undefined;
    args[name] = value;
  }
  if (Object.hasOwn(raw, "enabled")) {
    const enabled = raw.enabled;
    if (typeof enabled !== "boolean" && enabled !== null) return undefined;
    args.enabled = enabled;
  }
  if (Object.hasOwn(raw, "answers")) args.answers = raw.answers;
  return args;
}

/** The signed text, verified already, checked in the protocol's order: version 1, the relay's device, this host, the time window. */
function readSigned(signed: string, deviceId: string, deps: Pick<SignedDeps, "host" | "now">): Signed {
  let v: unknown;
  try {
    v = JSON.parse(signed);
  } catch {
    return refuse(NOT_READABLE);
  }
  if (!isRecord(v) || v.v !== 1) return refuse(NOT_READABLE);
  const { nonce, deviceId: signedBy, host, type, ts } = v;
  const args = argsOf(v.args);
  if (typeof nonce !== "string" || !nonce || typeof signedBy !== "string" || typeof host !== "string" || typeof type !== "string") return refuse(NOT_READABLE);
  if (typeof ts !== "number" || !Number.isFinite(ts) || !args) return refuse(NOT_READABLE);
  if (signedBy !== deviceId) return refuse(OTHER_DEVICE);
  if (host !== deps.host) return refuse(OTHER_HOST);
  const age = deps.now() - ts;
  if (age > SIGNED_WINDOW_MS) return refuse(TOO_OLD);
  if (age < -SIGNED_WINDOW_MS) return refuse(AHEAD);
  return { ok: true, nonce, type, args };
}

/**
 * The bridge's last check on a relay command whose device is allowed on this Mac
 * (remoteBridge.ts), before the command is claimed, run or handed over: the
 * command built from its signed type and arguments, with the relay's id, device
 * and time, or the refusal. The nonce is recorded once the signed text passed
 * every check before it, so the command can never run a second time, a refused
 * one included.
 */
export async function checkSigned(cmd: FleetCommand, deps: SignedDeps): Promise<SignedCheck> {
  const { signed, sig } = cmd;
  if (typeof signed !== "string" || typeof sig !== "string") return refuse(UNSIGNED);
  const deviceId = typeof cmd.deviceId === "string" ? cmd.deviceId : "";
  const pinned = deps.devices.pinnedKey(deviceId);
  if (pinned === undefined) return pinRequest(signed, sig, deviceId, deps);
  if (!verifySigned(signed, sig, pinned)) return refuse(NOT_VERIFIED);
  const s = readSigned(signed, deviceId, deps);
  if (!s.ok) return s;
  if (!deps.nonces.claim(s.nonce)) return refuse(NONCE_SEEN);
  if (!(REMOTE_COMMAND_TYPES as readonly string[]).includes(s.type) || !deps.allowed.includes(s.type)) {
    return refuse(`${s.type} is not allowed on this Mac`);
  }
  return { ok: true, cmd: { ...s.args, id: cmd.id, type: s.type, deviceId, createdAt: cmd.createdAt } };
}

/**
 * An allowed device without a pinned key: its command must verify against the
 * key the relay lists for it and pass the checks up to its nonce; only then is
 * the owner asked to pin that key, unless they were asked about the device in
 * the last 10 minutes. The command itself is refused either way.
 */
async function pinRequest(signed: string, sig: string, deviceId: string, deps: SignedDeps): Promise<SignedCheck> {
  let device: PairedDevice | undefined;
  try {
    device = await deps.listed(deviceId);
  } catch {
    return refuse(KEY_NOT_READ);
  }
  if (!device?.publicKey) return refuse(NO_KEY);
  if (!verifySigned(signed, sig, device.publicKey)) return refuse(NOT_VERIFIED);
  const s = readSigned(signed, deviceId, deps);
  if (!s.ok) return s;
  if (!deps.nonces.claim(s.nonce)) return refuse(NONCE_SEEN);
  return refuse(deps.devices.askToPin(device) ? CONFIRM_KEY : KEY_NOT_PINNED);
}

/** The nonces of the signed commands in `dir`, shared by every window that uses it, kept 11 minutes. */
export function nonceStore(dir: string, now: () => number): SeenIds {
  return new SeenIds({ dir, now, fs: nodeSeenFs, retainMs: NONCE_RETAIN_MS });
}

/** The bridge's nonce store: ~/.claude/session-monitor/remote/nonces, next to the seen command ids. */
export function nodeNonces(): SeenIds {
  return nonceStore(path.join(MONITOR_DIR, "remote", "nonces"), () => Date.now());
}
