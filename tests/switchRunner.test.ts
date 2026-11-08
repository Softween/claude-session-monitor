import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OUTPUT_CAP, SwitchRunner, busyText, exitText, lastLine, runDetached, spawnFailureText, type Clock, type Spawner } from "../src/switchRunner";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "csm-switch-test-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A fake claude-switch that prints after `ms` and exits 0; Node's default signal handling stays, so a SIGTERM ends it. */
function slowCli(ms: number): string {
  const file = path.join(TMP, `claude-switch-${ms}`);
  const body = `setTimeout(() => { process.stdout.write("active: b@x.com (Max)\\n"); process.stderr.write("warning: capture failed: x\\n"); }, ${ms});`;
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}
interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** A spawner whose children end only when the test emits their 'close'. */
function fakeSpawner(): { spawner: Spawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: Spawner = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
    calls.push({ command, args, options, child });
    return child as unknown as ChildProcess;
  };
  return { spawner, calls };
}

/** A clock whose timers fire only when the test advances it. */
function manualClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
  };
}

/** The stdout and stderr file descriptors the runner handed to the child. */
const outputFds = (call: SpawnCall): [number, number] => {
  const stdio = call.options.stdio as unknown[];
  return [stdio[1] as number, stdio[2] as number];
};

describe("SwitchRunner with a real slow claude-switch", () => {
  it("never kills a CLI that outlives the UI timeout: it runs to its end and its exit code and output arrive", async () => {
    const onTimeout = vi.fn();
    const runner = new SwitchRunner(slowCli(1_000));
    const t0 = Date.now();
    const launch = runner.start(["use", "b@x.com"], { timeoutMs: 150, onTimeout });
    if (!launch.started) throw new Error("did not start");
    const res = await launch.done;
    expect(res).toEqual({ code: 0, signal: null, stdout: "active: b@x.com (Max)\n", stderr: "warning: capture failed: x\n" });
    expect(onTimeout).toHaveBeenCalledTimes(1); // the UI stopped waiting at 150 ms, the process did not
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(runner.running()).toBeNull();
  });
});

describe("SwitchRunner", () => {
  it("never signals the child when the UI timeout fires, and its late exit still resolves", async () => {
    const { spawner, calls } = fakeSpawner();
    const clock = manualClock();
    const onTimeout = vi.fn();
    const runner = new SwitchRunner("/x/claude-switch", spawner, clock);
    const launch = runner.start(["use", "b@x.com"], { timeoutMs: 90_000, onTimeout });
    if (!launch.started) throw new Error("did not start");
    clock.advance(89_999);
    expect(onTimeout).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    clock.advance(10 * 60_000); // ten minutes on: still running, still untouched
    expect(runner.running()).toEqual({ args: ["use", "b@x.com"], startedMs: 1_000_000 });
    fs.writeSync(outputFds(calls[0])[0], "active: b@x.com (Max)\n");
    calls[0].child.emit("close", 0, null);
    await expect(launch.done).resolves.toEqual({ code: 0, signal: null, stdout: "active: b@x.com (Max)\n", stderr: "" });
    expect(calls[0].child.kill).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(runner.running()).toBeNull();
  });

  it("a run that ends first cancels its UI timeout", async () => {
    const { spawner, calls } = fakeSpawner();
    const clock = manualClock();
    const onTimeout = vi.fn();
    const launch = new SwitchRunner("/x/claude-switch", spawner, clock).start(["use", "b@x.com"], { timeoutMs: 90_000, onTimeout });
    if (!launch.started) throw new Error("did not start");
    calls[0].child.emit("close", 0, null);
    await launch.done;
    clock.advance(120_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("is single-flight across commands: while a run is in flight nothing else starts and the caller learns which run it is", async () => {
    const { spawner, calls } = fakeSpawner();
    const clock = manualClock();
    const runner = new SwitchRunner("/x/claude-switch", spawner, clock);
    const first = runner.start(["use", "b@x.com"]);
    if (!first.started) throw new Error("did not start");
    clock.advance(5_000);
    expect(runner.start(["use", "c@x.com"])).toEqual({ started: false, running: { args: ["use", "b@x.com"], startedMs: 1_000_000 } });
    expect(runner.start(["tick", "--fresh"]).started).toBe(false);
    expect(calls).toHaveLength(1);
    expect(busyText(runner.running()!, clock.now())).toBe("claude-switch use b@x.com is still running (started 5 s ago)");
    calls[0].child.emit("close", 1, null);
    await first.done;
    expect(runner.start(["tick", "--fresh"]).started).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([["use", "b@x.com"], ["tick", "--fresh"]]);
  });

  it("starts the CLI detached with stdin ignored and stdout/stderr in files instead of pipes, and never waits for it", () => {
    const { spawner, calls } = fakeSpawner();
    new SwitchRunner("/x/claude-switch", spawner).start(["tick", "--fresh"]);
    const { command, args, options, child } = calls[0];
    expect(command).toBe("/x/claude-switch");
    expect(args).toEqual(["tick", "--fresh"]);
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
    expect(options).not.toHaveProperty("timeout");
    expect(options).not.toHaveProperty("killSignal");
    expect(child.unref).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
  });

  it("keeps the tail of each stream, at most OUTPUT_CAP bytes, without the line the cut split", async () => {
    const { spawner, calls } = fakeSpawner();
    const done = runDetached("/x/claude-switch", ["use", "b@x.com"], spawner);
    const [out, err] = outputFds(calls[0]);
    fs.writeSync(out, "x".repeat(OUTPUT_CAP) + "\nactive: b@x.com (Max)\n");
    fs.writeSync(err, "warning: capture failed: x\n");
    calls[0].child.emit("close", 2, null);
    const res = await done;
    expect(res).toEqual({ code: 2, signal: null, stdout: "active: b@x.com (Max)\n", stderr: "warning: capture failed: x\n" });
  });

  it("resolves with the signal when something else ended the child", async () => {
    const { spawner, calls } = fakeSpawner();
    const done = runDetached("/x/claude-switch", ["use", "b@x.com"], spawner);
    calls[0].child.emit("close", null, "SIGKILL");
    const res = await done;
    expect(res).toEqual({ code: null, signal: "SIGKILL", stdout: "", stderr: "" });
    expect(exitText(res, "use")).toBe("claude-switch use ended by SIGKILL");
    expect(exitText({ ...res, code: 7, signal: null }, "tick --fresh")).toBe("claude-switch tick --fresh exited with code 7");
  });

  it("rejects when the CLI cannot start (ENOENT, EACCES, a synchronous spawn error), frees the slot and says why", async () => {
    const missing = path.join(TMP, "no-such-claude-switch");
    const runner = new SwitchRunner(missing);
    const launch = runner.start(["use", "b@x.com"]);
    if (!launch.started) throw new Error("did not start");
    const enoent = await launch.done.then(() => null, (e: NodeJS.ErrnoException) => e);
    expect(enoent?.code).toBe("ENOENT");
    expect(spawnFailureText(enoent, missing)).toBe(`could not start claude-switch: ${missing} or the interpreter on its #! line was not found (ENOENT)`);
    expect(runner.running()).toBeNull();

    const plain = path.join(TMP, "not-executable");
    fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
    const eacces = await runDetached(plain, ["use"]).then(() => null, (e: NodeJS.ErrnoException) => e);
    expect(eacces?.code).toBe("EACCES");
    expect(spawnFailureText(eacces, plain)).toBe(`could not start claude-switch: ${plain} is not executable (EACCES)`);

    const e2big: Spawner = () => {
      throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
    };
    const sync = await runDetached("/x/claude-switch", ["use"], e2big).then(() => null, (e: unknown) => e);
    expect(spawnFailureText(sync, "/x/claude-switch")).toBe("could not start claude-switch: spawn E2BIG");

    const installed = path.join(os.homedir(), ".claude", "bin", "claude-switch");
    expect(spawnFailureText(Object.assign(new Error("x"), { code: "ENOENT" }), installed)).toBe(
      "could not start claude-switch: ~/.claude/bin/claude-switch or the interpreter on its #! line was not found (ENOENT)",
    );
  });
});

describe("lastLine", () => {
  it("is the last non-empty line, without ANSI escapes, control or bidi characters, at most 200 characters", () => {
    expect(lastLine("warming up\n\x1b[31mclaude-switch: boom\x1b[0m\r\n\n")).toBe("claude-switch: boom");
    expect(lastLine("a‮b\u0007c")).toBe("a b c");
    expect(lastLine("e".repeat(300))).toHaveLength(200);
    expect(lastLine(" \n\t\n")).toBe("");
  });
});
