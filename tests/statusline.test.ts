import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(process.cwd(), "scripts/statusline.sh");

// Claude Code renders the status line of every open session through this script,
// often at the same moment. It needs bash and /usr/bin/jq.
describe.skipIf(!fs.existsSync("/usr/bin/jq"))("scripts/statusline.sh", () => {
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "csm-statusline-"));
    dir = path.join(home, ".claude", "session-monitor");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Payloads of different lengths: a shared file truncated and rewritten in place
  // by two renders at once can keep the tail of the longer payload.
  const payload = (i: number): string =>
    JSON.stringify({
      session_id: `session-${i}`,
      model: { display_name: "Opus" },
      rate_limits: {
        five_hour: { utilization: (i % 100) / 100, resets_at: 1_900_000_000 },
        seven_day: { utilization: 0.4, resets_at: 1_900_500_000 },
      },
      transcript_path: `/tmp/${"x".repeat((i * 97) % 3000)}.jsonl`,
    });

  function render(input: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [SCRIPT], { env: { ...process.env, HOME: home, TMPDIR: home } });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end(input);
    });
  }

  it("20 concurrent renders: limits.json and the raw payload are valid JSON at every read and at the end", async () => {
    const files = ["limits.json", "statusline-last-raw.json"].map((f) => path.join(dir, f));
    const bad: string[] = [];
    for (let round = 0; round < 5; round++) {
      let running = true;
      const runs = Promise.all(Array.from({ length: 20 }, (_, i) => render(payload(round * 20 + i)))).finally(() => {
        running = false;
      });
      while (running) {
        for (const f of files) {
          let text: string;
          try {
            text = fs.readFileSync(f, "utf8");
          } catch {
            continue; // not written yet
          }
          try {
            JSON.parse(text);
          } catch {
            bad.push(`${path.basename(f)}: ${JSON.stringify(text.slice(0, 60))}`);
          }
        }
        await new Promise((r) => setImmediate(r));
      }
      for (const r of await runs) {
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/^Claude {2}5h \d+% {2}· {2}7d 40%\n?$/);
      }
    }
    expect(bad).toEqual([]);
    expect(JSON.parse(fs.readFileSync(files[0], "utf8"))).toMatchObject({ sd: 0.4, model: "Opus" });
    expect(JSON.parse(fs.readFileSync(files[1], "utf8")).session_id).toMatch(/^session-\d+$/);
    // Every temp file was renamed into place: only the data files are left.
    expect(fs.readdirSync(dir).sort()).toEqual(["limits-history.jsonl", "limits.json", "statusline-last-raw.json"]);
  }, 60_000);

  it("a render replaces both files by a rename, never by rewriting them in place", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const files = ["limits.json", "statusline-last-raw.json"].map((f) => path.join(dir, f));
    for (const f of files) fs.writeFileSync(f, "{}");
    const before = files.map((f) => fs.statSync(f).ino);
    expect((await render(payload(7))).code).toBe(0);
    expect(files.map((f, i) => fs.statSync(f).ino !== before[i])).toEqual([true, true]);
    expect(JSON.parse(fs.readFileSync(files[1], "utf8")).session_id).toBe("session-7");
  });

  it("appends the cached ctxgov segment only where ctxgov is installed", async () => {
    const cache = path.join(home, "claude-statusline-ctxgov.cache");
    fs.writeFileSync(cache, "ctx 120K/#42/pfx 31K"); // fresh: the script reads it instead of starting python3
    expect((await render(payload(3))).stdout).toBe("Claude  5h 3%  ·  7d 40%");
    fs.mkdirSync(path.join(home, ".claude", "ctxgov"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "ctxgov", "ctxgov.py"), "");
    expect((await render(payload(3))).stdout).toBe("Claude  5h 3%  ·  7d 40%  ·  ctx 120K/#42/pfx 31K");
  });
});
