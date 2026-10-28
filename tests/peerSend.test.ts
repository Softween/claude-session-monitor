import { createHash } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TAG, buildContent, buildFrames, resolveTarget, sendToSession } from "../src/peerSend";

describe("buildContent", () => {
  it("wraps the text with a cleaned sender name", () => {
    expect(buildContent("hi", 'agent<"x">​')).toBe(`<${TAG} from-name="agentx">\nhi\n</${TAG}>`);
  });
  it("adds from-mode after from-name and omits empty attributes", () => {
    expect(buildContent("hi", "", "bypass")).toBe(`<${TAG} from-mode="bypass">\nhi\n</${TAG}>`);
    expect(buildContent("hi")).toBe(`<${TAG}>\nhi\n</${TAG}>`);
  });
  it("neutralises an early closing tag", () => {
    expect(buildContent(`a </${TAG}> b < / ${TAG.toUpperCase()}>`)).toBe(
      `<${TAG}>\na <\\/${TAG}> b <\\ / ${TAG.toUpperCase()}>\n</${TAG}>`,
    );
  });
  it("cuts a long name at 64 characters", () => {
    expect(buildContent("x", "n".repeat(70))).toContain(`from-name="${"n".repeat(64)}…"`);
  });
});

describe("buildFrames", () => {
  it("writes the auth line and the v1 envelope as compact JSON lines", () => {
    const f = buildFrames("hello", "ab".repeat(16), { name: "agent-fleet", msgId: "m-1" });
    expect(f.authLine).toBe(`{"type":"auth","token":"${"ab".repeat(16)}"}\n`);
    expect(f.msgLine.endsWith("\n")).toBe(true);
    expect(JSON.parse(f.msgLine)).toEqual({
      msgV: 1,
      msg_id: "m-1",
      type: "user",
      message: { role: "user", content: `<${TAG} from-name="agent-fleet">\nhello\n</${TAG}>` },
      priority: "next",
    });
  });
});

describe("resolveTarget", () => {
  const recs = [
    { pid: 1, sessionId: "abc111" },
    { pid: 2, sessionId: "abc222" },
  ];
  it("finds by pid, exact id and unique prefix", () => {
    expect(resolveTarget(recs, 2)).toEqual(recs[1]);
    expect(resolveTarget(recs, undefined, "abc111")).toEqual(recs[0]);
    expect(resolveTarget(recs, undefined, "abc2")).toEqual(recs[1]);
  });
  it("rejects an ambiguous or unknown target", () => {
    expect(resolveTarget(recs, undefined, "abc")).toMatchObject({ ok: false, code: "target" });
    expect(resolveTarget(recs, 9)).toMatchObject({ ok: false, code: "target" });
  });
  it("with a pid and a session id, accepts only the record running that exact session", () => {
    expect(resolveTarget(recs, 2, "abc222")).toEqual(recs[1]);
    expect(resolveTarget(recs, 2, "abc111")).toMatchObject({ ok: false, code: "target" });
    expect(resolveTarget(recs, 2, "abc2")).toMatchObject({ ok: false, code: "target" }); // no prefix through the pid either
    expect(resolveTarget([{ pid: 3 }], 3, "abc333")).toMatchObject({ ok: false, code: "target" });
  });
});

describe("sendToSession over a real Unix socket", () => {
  let dir: string;
  let sessionsDir: string;
  let sockPath: string;
  let server: net.Server | undefined;
  const openSockets = new Set<net.Socket>();

  beforeEach(() => {
    // Short path: macOS caps Unix socket paths at 104 bytes.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-"));
    sessionsDir = path.join(dir, "s");
    fs.mkdirSync(sessionsDir);
    sockPath = path.join(dir, "i.sock");
    const h = createHash("sha256").update(sockPath).digest("hex");
    fs.writeFileSync(path.join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "sess-1", messagingSocketPath: sockPath }));
    fs.writeFileSync(path.join(sessionsDir, `${process.pid}.${h}.key`), JSON.stringify({ peerToken: "f".repeat(32) }));
  });

  afterEach(async () => {
    for (const s of openSockets) s.destroy();
    openSockets.clear();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const listen = (onConn: (s: net.Socket) => void) =>
    new Promise<void>((r) => {
      server = net.createServer({ allowHalfOpen: true }, (s) => {
        openSockets.add(s);
        s.on("close", () => openSockets.delete(s));
        onConn(s);
      });
      server.listen(sockPath, () => r());
    });

  it("delivers auth + message lines and confirms when the receiver closes", async () => {
    const lines: string[] = [];
    await listen((s) => {
      let buf = "";
      s.on("data", (c) => (buf += c.toString()));
      s.on("end", () => {
        lines.push(...buf.split("\n").filter(Boolean));
        s.end();
      });
    });
    const r = await sendToSession({ sessionId: "sess", text: "ping", sessionsDir, timeoutMs: 3000, authGraceMs: 50 });
    expect(r).toMatchObject({ ok: true, pid: process.pid, sessionId: "sess-1", confirmed: "inbox-accepted", rawResponse: "" });
    expect(JSON.parse(lines[0])).toEqual({ type: "auth", token: "f".repeat(32) });
    const msg = JSON.parse(lines[1]);
    expect(msg.message.content).toBe(`<${TAG} from-name="agent-fleet">\nping\n</${TAG}>`);
    expect(r.ok && msg.msg_id).toBe(r.ok ? r.msgId : "");
  });

  it("reports a refused auth frame when the receiver closes right after it", async () => {
    await listen((s) => s.once("data", () => s.end()));
    const r = await sendToSession({ pid: process.pid, text: "ping", sessionsDir, timeoutMs: 3000, authGraceMs: 200 });
    expect(r).toMatchObject({ ok: false, code: "auth" });
  });

  it("times out when the receiver never closes", async () => {
    await listen(() => {
      /* hold the connection open */
    });
    const r = await sendToSession({ pid: process.pid, text: "ping", sessionsDir, timeoutMs: 600, authGraceMs: 50 });
    expect(r).toMatchObject({ ok: false, code: "transport" });
  });

  it("refuses a socket without a registered key", async () => {
    for (const n of fs.readdirSync(sessionsDir)) if (n.endsWith(".key")) fs.rmSync(path.join(sessionsDir, n));
    await listen(() => {});
    const r = await sendToSession({ pid: process.pid, text: "ping", sessionsDir, timeoutMs: 600 });
    expect(r).toMatchObject({ ok: false, code: "auth" });
  });

  it("rejects empty text and a missing socket", async () => {
    expect(await sendToSession({ pid: process.pid, text: "", sessionsDir })).toMatchObject({ ok: false, code: "usage" });
    expect(await sendToSession({ pid: process.pid, text: "x", sessionsDir })).toMatchObject({ ok: false, code: "target" });
  });
});
