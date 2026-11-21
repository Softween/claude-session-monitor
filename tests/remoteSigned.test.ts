import { createPrivateKey, sign } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_COMMAND_TYPES } from "../src/remote";
import type { FleetCommand } from "../src/remoteBridge";
import type { PairedDevice } from "../src/remoteDevices";
import {
  AHEAD,
  CONFIRM_KEY,
  KEY_NOT_READ,
  NONCE_RETAIN_MS,
  NONCE_SEEN,
  NOT_READABLE,
  NOT_VERIFIED,
  NO_KEY,
  OTHER_DEVICE,
  OTHER_HOST,
  SIGNED_WINDOW_MS,
  TOO_OLD,
  UNSIGNED,
  checkSigned,
  keyFingerprint,
  nonceStore,
  publicKeyBytes,
  verifySigned,
  type SignedDeps,
} from "../src/remoteSigned";
import { SEEN_RETAIN_MS, type SeenIds } from "../src/seenIds";

// The protocol's test vector: the RFC 8032 test 1 key, one signed command and its signature.
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const KEY = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const SIGNED =
  '{"v":1,"nonce":"3f0b6c2e-8a41-4d7e-9c55-0f1e2d3c4b5a","deviceId":"dev-test-1","host":"Mac-test","type":"resume","args":{"sessionId":"0b5f3a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"},"ts":1763726400000}';
const SIG = "DQWUhIYa/WoGEwUIxdX0wrLl3GtZoqfIBaIKJepUE8GWKqKZAzVVLp8Ms0mkkcjJ5F1oYh31gHS8JJUDW6AgBg==";
const NONCE = "3f0b6c2e-8a41-4d7e-9c55-0f1e2d3c4b5a";
const DEVICE = "dev-test-1";
const HOST = "Mac-test";
const SESSION = "0b5f3a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const TS = 1763726400000;
// The RFC 8032 test 2 key: a valid key that did not sign anything here.
const OTHER_KEY = "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=";
const MIN = 60_000;

const phoneKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED, "hex")]),
  format: "der",
  type: "pkcs8",
});
const signText = (text: string): string => sign(null, Buffer.from(text, "utf8"), phoneKey).toString("base64");

/** A protocol v1 text as the phone builds it; `over` replaces fields, and a field set to undefined is left out. */
const envelope = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, nonce: "nonce-1", deviceId: DEVICE, host: HOST, type: "resume", args: { sessionId: SESSION }, ts: TS, ...over });

/** The relay's command carrying `signed` and the test key's signature of it. */
const relayCmd = (signed: string, over: Record<string, unknown> = {}): FleetCommand =>
  ({ id: "hub-1", type: "resume", sessionId: SESSION, createdAt: TS, deviceId: DEVICE, signed, sig: signText(signed), ...over }) as FleetCommand;

const refused = (refusal: string) => ({ ok: false, refusal });

/** The check's dependencies: this Mac's clock at `now`, its host, a pinned key for every device unless `pinned` says otherwise. */
function deps(o: { now?: number; host?: string; allowed?: readonly string[]; pinned?: unknown; listed?: () => Promise<PairedDevice | undefined> } = {}) {
  const taken = new Set<string>();
  const pinAsks: PairedDevice[] = [];
  const lookups: string[] = [];
  const d: SignedDeps = {
    host: o.host ?? HOST,
    allowed: o.allowed ?? ["resume", "kill"],
    now: () => o.now ?? TS,
    nonces: { claim: (id) => !taken.has(id) && !!taken.add(id) },
    devices: {
      pinnedKey: () => ("pinned" in o ? o.pinned : KEY),
      askToPin: (device) => void pinAsks.push(device),
    },
    listed: async (id) => {
      lookups.push(id);
      return o.listed ? o.listed() : undefined;
    },
  };
  return { d, taken, pinAsks, lookups };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A nonce folder inside a fresh temp dir (the folder itself does not exist yet). */
function nonceDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csm-nonces-"));
  dirs.push(root);
  return path.join(root, "remote", "nonces");
}

describe("the protocol's test vector", () => {
  it("verifies against the test key, whose fingerprint is 21fe 31df a154 a261, and the key's seed signs it to the same signature", () => {
    expect(verifySigned(SIGNED, SIG, KEY)).toBe(true);
    expect(keyFingerprint(KEY)).toBe("21fe 31df a154 a261");
    expect(signText(SIGNED)).toBe(SIG);
    expect(relayCmd(SIGNED).sig).toBe(SIG);
  });

  it("does not verify a changed text, another text's signature or another key", () => {
    expect(verifySigned(SIGNED.replace('"resume"', '"kill"'), SIG, KEY)).toBe(false);
    expect(verifySigned(SIGNED + " ", SIG, KEY)).toBe(false);
    const flipped = Buffer.from(SIG, "base64");
    flipped[10] ^= 1;
    expect(verifySigned(SIGNED, flipped.toString("base64"), KEY)).toBe(false);
    expect(verifySigned(SIGNED, signText(envelope()), KEY)).toBe(false);
    expect(verifySigned(SIGNED, SIG, OTHER_KEY)).toBe(false);
    const near = Buffer.from(KEY, "base64");
    near[31] ^= 1;
    expect(verifySigned(SIGNED, SIG, near.toString("base64"))).toBe(false);
  });

  it("takes a key only as canonical base64 of 32 bytes and a signature only as canonical base64 of 64", () => {
    expect(publicKeyBytes(KEY)?.toString("hex")).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const keys = [undefined, null, 42, "", KEY.slice(0, -1), ` ${KEY}`, KEY.replace("/", "_"), Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")];
    for (const bad of keys) {
      expect(publicKeyBytes(bad)).toBeUndefined();
      expect(verifySigned(SIGNED, SIG, bad)).toBe(false);
    }
    const sigs = [undefined, 7, SIG.slice(0, -2), `${SIG}\n`, SIG.replace("/", "_"), Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64")];
    for (const bad of sigs) expect(verifySigned(SIGNED, bad, KEY)).toBe(false);
  });
});

describe("checkSigned: a device with a pinned key", () => {
  it("runs the command from its signed type and arguments, with the relay's id, device and time and none of the relay's other fields", async () => {
    const { d, taken } = deps();
    const hub = relayCmd(SIGNED, { type: "kill", sessionId: "relay-session", text: "relay text", cwd: "/elsewhere" });
    expect(await checkSigned(hub, d)).toEqual({ ok: true, cmd: { id: "hub-1", type: "resume", sessionId: SESSION, deviceId: DEVICE, createdAt: TS } });
    expect([...taken]).toEqual([NONCE]);
  });

  it("refuses a command without its signed text or signature before anything else, a device without a pinned key included", async () => {
    const { d, taken, lookups, pinAsks } = deps({ pinned: undefined, listed: async () => ({ id: DEVICE, name: "iPhone", pairedAt: 1, publicKey: KEY }) });
    for (const over of [{ signed: undefined, sig: undefined }, { sig: undefined }, { signed: undefined }, { signed: null, sig: null }, { sig: 42 }]) {
      expect(await checkSigned(relayCmd(SIGNED, over), d)).toEqual(refused(UNSIGNED));
    }
    expect([taken.size, lookups, pinAsks]).toEqual([0, [], []]);
  });

  it("refuses a signature that does not verify against the key pinned for the device, and records no nonce", async () => {
    const { d, taken } = deps();
    expect(await checkSigned({ ...relayCmd(SIGNED), signed: SIGNED.replace(SESSION, "11111111-1111-4111-8111-111111111111") }, d)).toEqual(refused(NOT_VERIFIED));
    expect(await checkSigned({ ...relayCmd(SIGNED), sig: signText(envelope({ type: "kill" })) }, d)).toEqual(refused(NOT_VERIFIED));
    expect(await checkSigned(relayCmd(SIGNED), deps({ pinned: OTHER_KEY }).d)).toEqual(refused(NOT_VERIFIED));
    expect(taken.size).toBe(0);
  });

  it("verifies against the stored key as it is: a stored value that is no key verifies nothing and is not looked up or replaced", async () => {
    for (const pinned of ["pk-iphone", 42, { key: KEY }]) {
      const { d, lookups, pinAsks } = deps({ pinned, listed: async () => ({ id: DEVICE, name: "iPhone", pairedAt: 1, publicKey: KEY }) });
      expect(await checkSigned(relayCmd(SIGNED), d)).toEqual(refused(NOT_VERIFIED));
      expect([lookups, pinAsks]).toEqual([[], []]);
    }
  });

  it("refuses a text that is not a version 1 command, or whose arguments have the wrong types", async () => {
    const texts = [
      "not json",
      "[]",
      "null",
      envelope({ v: 2 }),
      envelope({ v: "1" }),
      envelope({ nonce: "" }),
      envelope({ nonce: 7 }),
      envelope({ deviceId: undefined }),
      envelope({ host: undefined }),
      envelope({ type: undefined }),
      envelope({ ts: "1763726400000" }),
      envelope({ ts: undefined }),
      envelope({ args: undefined }),
      envelope({ args: [] }),
      envelope({ args: { sessionId: 5 } }),
      envelope({ args: { text: ["a"] } }),
      envelope({ args: { enabled: "true" } }),
    ];
    for (const text of texts) expect(await checkSigned(relayCmd(text), deps().d)).toEqual(refused(NOT_READABLE));
  });

  it("refuses a command signed by another device than the relay names, or for another host", async () => {
    // The relay names dev-test-2 (whose pinned key is the test key too); the signed text names dev-test-1.
    expect(await checkSigned(relayCmd(SIGNED, { deviceId: "dev-test-2" }), deps().d)).toEqual(refused(OTHER_DEVICE));
    expect(await checkSigned(relayCmd(SIGNED), deps({ host: "Mac-other" }).d)).toEqual(refused(OTHER_HOST));
    expect(await checkSigned(relayCmd(SIGNED), deps({ host: "mac-test" }).d)).toEqual(refused(OTHER_HOST));
  });

  it("accepts a command signed up to 5 minutes before or after this Mac's clock, not a millisecond more", async () => {
    expect(SIGNED_WINDOW_MS).toBe(5 * MIN);
    const at = (now: number) => checkSigned(relayCmd(SIGNED), deps({ now }).d); // a fresh nonce store each time
    expect((await at(TS + 5 * MIN)).ok).toBe(true);
    expect(await at(TS + 5 * MIN + 1)).toEqual(refused(TOO_OLD));
    expect((await at(TS - 5 * MIN)).ok).toBe(true);
    expect(await at(TS - 5 * MIN - 1)).toEqual(refused(AHEAD));
  });

  it("runs each nonce once: the same signed command under another relay id is refused", async () => {
    const { d } = deps();
    expect((await checkSigned(relayCmd(SIGNED), d)).ok).toBe(true);
    expect(await checkSigned(relayCmd(SIGNED, { id: "hub-2" }), d)).toEqual(refused(NONCE_SEEN));
  });

  it("keeps a nonce for as long as its command is valid: 11 minutes in a folder every window shares, longer than twice the window", async () => {
    expect(NONCE_RETAIN_MS).toBe(11 * MIN);
    expect(NONCE_RETAIN_MS).toBeGreaterThan(2 * SIGNED_WINDOW_MS);
    expect(NONCE_RETAIN_MS).toBeGreaterThan(SEEN_RETAIN_MS);
    const dir = nonceDir();
    const clock = { now: TS - 5 * MIN }; // this Mac's clock runs 5 minutes behind the phone's
    const check = (store: SeenIds) => checkSigned(relayCmd(SIGNED), { ...deps().d, now: () => clock.now, nonces: store });
    const windowA = nonceStore(dir, () => clock.now);
    const windowB = nonceStore(dir, () => clock.now);
    expect((await check(windowA)).ok).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    // 10 minutes later the command is still within its window: its nonce is still recorded.
    clock.now = TS + 5 * MIN;
    expect(await check(windowB)).toEqual(refused(NONCE_SEEN));
    clock.now = TS + 5 * MIN + 1;
    expect(await check(windowB)).toEqual(refused(TOO_OLD));
    // Once the 11 minutes are up the record goes: by then no command with that nonce is valid any more.
    clock.now = TS - 5 * MIN + NONCE_RETAIN_MS;
    windowB.prune();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a signed type that is unknown or not in remote.allowedCommands, after recording its nonce", async () => {
    const { d, taken } = deps({ allowed: ["kill"] });
    expect(await checkSigned(relayCmd(SIGNED), d)).toEqual(refused("resume is not allowed on this Mac"));
    expect(taken.has(NONCE)).toBe(true);
    const reboot = envelope({ type: "reboot", nonce: "n-reboot" });
    expect(await checkSigned(relayCmd(reboot), deps({ allowed: [...REMOTE_COMMAND_TYPES, "reboot"] }).d)).toEqual(refused("reboot is not allowed on this Mac"));
  });

  it("takes only the arguments a command uses, by their FleetCommand names; other names and the relay's values are left out", async () => {
    const text = `{"v":1,"nonce":"n-send","deviceId":"${DEVICE}","host":"${HOST}","type":"send","args":{"__proto__":{"type":"kill"},"sessionId":"${SESSION}","text":"run the tests","extra":"x"},"ts":${TS}}`;
    const send = await checkSigned(relayCmd(text, { text: "relay text", account: "a@b.c", answers: [1] }), deps({ allowed: ["send"] }).d);
    expect(send).toEqual({ ok: true, cmd: { id: "hub-1", type: "send", sessionId: SESSION, text: "run the tests", deviceId: DEVICE, createdAt: TS } });
    expect(send.ok && Object.getPrototypeOf(send.cmd)).toBe(Object.prototype);

    const answers = { "Which one?": "A" };
    const answer = envelope({ type: "answer", nonce: "n-answer", args: { sessionId: SESSION, toolUseId: "toolu_1", answers } });
    expect(await checkSigned(relayCmd(answer), deps({ allowed: ["answer"] }).d)).toEqual({
      ok: true,
      cmd: { id: "hub-1", type: "answer", sessionId: SESSION, toolUseId: "toolu_1", answers, deviceId: DEVICE, createdAt: TS },
    });
    const auto = envelope({ type: "autoResume", nonce: "n-auto", args: { sessionId: SESSION, enabled: false } });
    expect(await checkSigned(relayCmd(auto), deps({ allowed: ["autoResume"] }).d)).toEqual({
      ok: true,
      cmd: { id: "hub-1", type: "autoResume", sessionId: SESSION, enabled: false, deviceId: DEVICE, createdAt: TS },
    });
    const all = envelope({ type: "resumeAll", nonce: "n-all", args: {} });
    expect(await checkSigned(relayCmd(all, { sessionId: "relay-session" }), deps({ allowed: ["resumeAll"] }).d)).toEqual({
      ok: true,
      cmd: { id: "hub-1", type: "resumeAll", deviceId: DEVICE, createdAt: TS },
    });
  });
});

describe("checkSigned: an allowed device without a pinned key", () => {
  const listedWith = (publicKey?: string) => async (): Promise<PairedDevice> => ({ id: DEVICE, name: "iPhone", pairedAt: 1, ...(publicKey ? { publicKey } : {}) });

  it("verifies the command against the key the relay lists for the device, then asks to pin that key; the command itself is refused", async () => {
    const { d, taken, lookups, pinAsks } = deps({ pinned: undefined, listed: listedWith(KEY) });
    expect(await checkSigned(relayCmd(SIGNED), d)).toEqual(refused(CONFIRM_KEY));
    expect(lookups).toEqual([DEVICE]);
    expect(pinAsks).toEqual([{ id: DEVICE, name: "iPhone", pairedAt: 1, publicKey: KEY }]);
    // Its nonce is taken: the refused command never runs later, not even once the key is pinned.
    expect(taken.has(NONCE)).toBe(true);
    expect(await checkSigned(relayCmd(SIGNED, { id: "hub-2" }), d)).toEqual(refused(NONCE_SEEN));
    expect(pinAsks).toHaveLength(1);
  });

  it("asks nothing when the relay lists no key or another one, or cannot be read", async () => {
    const cases: Array<[() => Promise<PairedDevice | undefined>, string]> = [
      [async () => undefined, NO_KEY],
      [listedWith(), NO_KEY],
      [listedWith(OTHER_KEY), NOT_VERIFIED],
      [
        async () => {
          throw new Error("HTTP 503");
        },
        KEY_NOT_READ,
      ],
    ];
    for (const [listed, refusal] of cases) {
      const { d, taken, pinAsks } = deps({ pinned: undefined, listed });
      expect(await checkSigned(relayCmd(SIGNED), d)).toEqual(refused(refusal));
      expect([taken.size, pinAsks]).toEqual([0, []]);
    }
  });

  it("asks nothing for a command that verifies but fails a later check", async () => {
    const listed = listedWith(KEY);
    const host = deps({ pinned: undefined, listed, host: "Mac-other" });
    expect(await checkSigned(relayCmd(SIGNED), host.d)).toEqual(refused(OTHER_HOST));
    const late = deps({ pinned: undefined, listed, now: TS + 6 * MIN });
    expect(await checkSigned(relayCmd(SIGNED), late.d)).toEqual(refused(TOO_OLD));
    const device = deps({ pinned: undefined, listed });
    expect(await checkSigned(relayCmd(SIGNED, { deviceId: "dev-test-2" }), device.d)).toEqual(refused(OTHER_DEVICE));
    const again = deps({ pinned: undefined, listed });
    again.taken.add(NONCE);
    expect(await checkSigned(relayCmd(SIGNED), again.d)).toEqual(refused(NONCE_SEEN));
    expect([host.pinAsks, late.pinAsks, device.pinAsks, again.pinAsks]).toEqual([[], [], [], []]);
  });
});
