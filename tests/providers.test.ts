import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectSessions, readHookStatuses } from "../src/core";
import {
  assessCodexHooks,
  codexHooksConfigured,
  mapCodexThreads,
  parseCodexUsage,
  readCodexHookStatuses,
  type CodexRefreshOptions,
  type CodexThread,
} from "../src/providers/codex";
import {
  countProviders,
  filterProvider,
  mergeProviderSessions,
} from "../src/providers/registry";
import {
  sessionKey,
  type SessionHookStatus,
} from "../src/providers/types";

const NOW = Math.floor(Date.parse("2026-07-28T12:00:00.000Z") / 1000);

function options(overrides: Partial<CodexRefreshOptions> = {}): CodexRefreshOptions {
  return {
    now: NOW,
    maxAgeSec: 6 * 3600,
    hideEndedOlderThanSec: 30 * 60,
    showEnded: true,
    ...overrides,
  };
}

function thread(
  id: string,
  status: CodexThread["status"],
  overrides: Partial<CodexThread> = {},
): CodexThread {
  return {
    id,
    preview: `Preview ${id}`,
    createdAt: NOW - 30,
    updatedAt: NOW - 10,
    status,
    cwd: "/workspace/current",
    source: "cli",
    ...overrides,
  };
}

function hook(
  id: string,
  state: string,
  overrides: Partial<SessionHookStatus> = {},
): SessionHookStatus {
  return {
    session_id: id,
    provider: "codex",
    state,
    ts: NOW - 5,
    ...overrides,
  };
}

describe("mapCodexThreads", () => {
  it("maps app-server states without hooks and treats notLoaded as unavailable", () => {
    const views = mapCodexThreads(
      [
        thread("working", { type: "active" }),
        thread("approval", { type: "active", activeFlags: ["waitingOnApproval"] }),
        thread("input", { type: "active", activeFlags: ["waitingOnUserInput"] }),
        thread("idle", { type: "idle" }),
        thread("error", { type: "systemError" }),
        thread("unavailable", { type: "notLoaded" }),
      ],
      new Map(),
      options(),
    );
    const byId = new Map(views.map((view) => [view.sessionId, view]));

    expect(byId.get("working")).toMatchObject({
      key: "codex:working",
      provider: "codex",
      bucket: "working",
      sub: "working",
      stale: false,
    });
    expect(byId.get("approval")).toMatchObject({
      bucket: "attention",
      sub: "waiting for you",
    });
    expect(byId.get("input")).toMatchObject({
      bucket: "attention",
      sub: "waiting for you",
    });
    expect(byId.get("idle")).toMatchObject({ bucket: "attention", sub: "your turn" });
    expect(byId.get("error")).toMatchObject({ bucket: "attention", sub: "Codex error" });
    expect(byId.get("unavailable")).toMatchObject({
      bucket: "unknown",
      sub: "live state unavailable",
    });
  });

  it("uses hook working/waiting/idle/ended state for a non-active app-server thread", () => {
    const threads = ["working", "waiting", "idle", "ended"].map((id) =>
      thread(id, { type: "notLoaded" }),
    );
    const hooks = new Map<string, SessionHookStatus>([
      ["working", hook("working", "working")],
      ["waiting", hook("waiting", "waiting")],
      ["idle", hook("idle", "idle")],
      ["ended", hook("ended", "ended")],
    ]);
    const byId = new Map(
      mapCodexThreads(threads, hooks, options()).map((view) => [view.sessionId, view]),
    );

    expect(byId.get("working")).toMatchObject({ bucket: "working", sub: "working" });
    expect(byId.get("waiting")).toMatchObject({
      bucket: "attention",
      sub: "waiting for you",
    });
    expect(byId.get("idle")).toMatchObject({ bucket: "attention", sub: "your turn" });
    expect(byId.get("ended")).toMatchObject({ bucket: "ended", sub: "ended" });
  });

  it("prefers a newer exact hook over a lagging active app-server state", () => {
    const threads = [
      thread("stopped", { type: "active" }, { updatedAt: NOW - 10 }),
      thread(
        "ended",
        { type: "active", activeFlags: ["waitingOnApproval"] },
        { updatedAt: NOW - 10 },
      ),
      thread("resumed", { type: "active" }, { updatedAt: NOW - 1 }),
    ];
    const hooks = new Map<string, SessionHookStatus>([
      ["stopped", hook("stopped", "idle", { ts: NOW - 5 })],
      ["ended", hook("ended", "ended", { ts: NOW - 5 })],
      ["resumed", hook("resumed", "ended", { ts: NOW - 5 })],
    ]);
    const byId = new Map(
      mapCodexThreads(threads, hooks, options()).map((view) => [view.sessionId, view]),
    );

    expect(byId.get("stopped")).toMatchObject({ bucket: "attention", sub: "your turn" });
    expect(byId.get("ended")).toMatchObject({ bucket: "ended", sub: "ended" });
    expect(byId.get("resumed")).toMatchObject({ bucket: "working", sub: "working" });
  });

  it("lets a newer concrete app-server state supersede an older hook", () => {
    const hooks = new Map<string, SessionHookStatus>([
      ["now-idle", hook("now-idle", "working", { ts: NOW - 5 })],
    ]);

    const [view] = mapCodexThreads(
      [thread("now-idle", { type: "idle" }, { updatedAt: NOW - 1 })],
      hooks,
      options(),
    );

    expect(view).toMatchObject({ bucket: "attention", sub: "your turn" });
  });

  it("synthesizes hook-only sessions and preserves live waiting state", () => {
    const hooks = new Map<string, SessionHookStatus>([
      [
        "hook-working",
        hook("hook-working", "working", {
          prompt: "Continue the provider migration",
          transcript_path: "/home/test/.codex/sessions/working.jsonl",
          cwd: "/workspace/current",
          model: "gpt-5.6-sol",
          pid: 4321,
        }),
      ],
      [
        "hook-waiting",
        hook("hook-waiting", "waiting", {
          message: "permission: Bash",
          cwd: "/workspace/current",
        }),
      ],
    ]);
    const byId = new Map(
      mapCodexThreads([], hooks, options()).map((view) => [view.sessionId, view]),
    );

    expect(byId.get("hook-working")).toMatchObject({
      key: "codex:hook-working",
      provider: "codex",
      title: "Continue the provider migration",
      bucket: "working",
      model: "gpt-5.6-sol",
      transcriptPath: "/home/test/.codex/sessions/working.jsonl",
      pid: 4321,
      capabilities: {
        focus: true,
        transcript: true,
        resume: true,
        kill: false,
        bulkInput: false,
      },
    });
    expect(byId.get("hook-waiting")).toMatchObject({
      bucket: "attention",
      sub: "waiting for you",
      notifMessage: "permission: Bash",
    });
  });

  it("applies the workspace filter after letting hook cwd override thread cwd", () => {
    const threads = [
      thread("current", { type: "active" }, { cwd: "/workspace/current" }),
      thread("other", { type: "active" }, { cwd: "/workspace/other" }),
      thread("hook-moved", { type: "active" }, { cwd: "/workspace/other" }),
    ];
    const hooks = new Map<string, SessionHookStatus>([
      ["hook-moved", hook("hook-moved", "working", { cwd: "/workspace/current" })],
    ]);

    const views = mapCodexThreads(
      threads,
      hooks,
      options({ workspaceCwd: "/workspace/current" }),
    );
    expect(views.map((view) => view.sessionId).sort()).toEqual(["current", "hook-moved"]);
    expect(views.find((view) => view.sessionId === "hook-moved")?.cwd).toBe(
      "/workspace/current",
    );
  });

  it("honors ended visibility, ended retention, and overall recency windows", () => {
    const recentEnded = thread("recent-ended", { type: "notLoaded" });
    const oldEnded = thread("old-ended", { type: "notLoaded" }, { updatedAt: NOW - 1900 });
    const tooOldWorking = thread(
      "old-working",
      { type: "active" },
      { updatedAt: NOW - 7200 },
    );
    const endedHooks = new Map<string, SessionHookStatus>([
      ["recent-ended", hook("recent-ended", "ended", { ts: NOW - 10 })],
      ["old-ended", hook("old-ended", "ended", { ts: NOW - 1900 })],
    ]);

    expect(
      mapCodexThreads([recentEnded], endedHooks, options({ showEnded: false })),
    ).toEqual([]);
    expect(
      mapCodexThreads(
        [recentEnded, oldEnded, tooOldWorking],
        endedHooks,
        options({ maxAgeSec: 3600, hideEndedOlderThanSec: 1800 }),
      ).map((view) => view.sessionId),
    ).toEqual(["recent-ended"]);
  });
});

describe("parseCodexUsage", () => {
  it("parses rate windows and sums only the current seven calendar days despite gaps", () => {
    const rateLimits = {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 37.5,
            windowDurationMins: 300,
            resetsAt: NOW + 1800,
          },
          secondary: {
            usedPercent: 101,
            windowDurationMins: 10_080,
            resetsAt: NOW + 86_400,
          },
        },
      },
    };
    const dailyUsageBuckets = [
      { startDate: "2026-07-28T00:00:00.000Z", tokens: 300 },
      { startDate: "2026-07-24T00:00:00.000Z", tokens: 200 },
      { startDate: "2026-07-22T00:00:00.000Z", tokens: 100 },
      { startDate: "2026-07-21T23:59:59.000Z", tokens: 10_000 },
      { startDate: "2026-07-28T13:00:00.000Z", tokens: 20_000 },
      { startDate: "2026-07-29T00:00:00.000Z", tokens: 30_000 },
      { startDate: "not-a-date", tokens: 40_000 },
    ];
    const usage = parseCodexUsage(
      rateLimits,
      {
        summary: { lifetimeTokens: "123456" },
        dailyUsageBuckets,
      },
      NOW,
    );

    expect(usage).toMatchObject({
      provider: "codex",
      label: "Codex",
      ts: NOW,
      lifetimeTokens: 123_456,
      sevenDayTokens: 600,
    });
    expect(usage?.gauges).toEqual([
      {
        key: "codex-primary-300",
        label: "Session (5h)",
        pct: 37.5,
        resetMs: (NOW + 1800) * 1000,
      },
      {
        key: "codex-secondary-10080",
        label: "Weekly (7d)",
        pct: 100,
        resetMs: (NOW + 86_400) * 1000,
      },
    ]);
  });

  it("supports the legacy single rateLimits object and returns null for empty input", () => {
    const usage = parseCodexUsage(
      {
        rateLimits: {
          limitId: "review",
          limitName: "Code review",
          primary: { usedPercent: "12", windowDurationMins: 60 },
        },
      },
      null,
      NOW,
    );
    expect(usage?.gauges).toEqual([
      {
        key: "review-primary-60",
        label: "Code review (1h)",
        pct: 12,
        resetMs: null,
      },
    ]);
    expect(parseCodexUsage(null, null, NOW)).toBeNull();
  });
});

describe("codexHooksConfigured", () => {
  let tmp: string;
  const required = [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PermissionRequest",
    "SessionEnd",
  ];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-codex-configured-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(commandFor: (event: string) => string, events = required): string {
    const file = path.join(tmp, "hooks.json");
    const hooks = Object.fromEntries(
      events.map((event) => [
        event,
        [{ hooks: [{ type: "command", command: commandFor(event) }] }],
      ]),
    );
    fs.writeFileSync(file, JSON.stringify({ hooks }));
    return file;
  }

  it("requires all five Codex lifecycle events", () => {
    const file = writeConfig(
      (event) => `/usr/bin/python3 /tmp/.claude/session-monitor/hook.py ${event}`,
    );
    expect(codexHooksConfigured(file)).toBe(true);

    const missingPermission = writeConfig(
      (event) => `/usr/bin/python3 /tmp/.claude/session-monitor/hook.py ${event}`,
      required.filter((event) => event !== "PermissionRequest"),
    );
    expect(codexHooksConfigured(missingPermission)).toBe(false);
  });

  it("recognizes shell-quoted hook paths containing spaces", () => {
    const file = writeConfig(
      (event) =>
        `/usr/bin/python3 '/tmp/home with spaces/.claude/session-monitor/hook.py' ${event}`,
    );
    expect(codexHooksConfigured(file)).toBe(true);
  });

  it("rejects malformed config and unrelated commands", () => {
    const malformed = path.join(tmp, "malformed.json");
    fs.writeFileSync(malformed, "{");
    expect(codexHooksConfigured(malformed)).toBe(false);
    expect(
      codexHooksConfigured(writeConfig((event) => `/usr/bin/other-hook ${event}`)),
    ).toBe(false);
  });
});

describe("assessCodexHooks", () => {
  const required = [
    "sessionStart",
    "userPromptSubmit",
    "stop",
    "permissionRequest",
    "sessionEnd",
  ];
  const command = (event: string) =>
    `/usr/bin/python3 '/tmp/home with spaces/.claude/session-monitor/hook.py' ${event}`;

  function response(
    change: (
      hooks: Array<{
        eventName: string;
        command: string;
        enabled: boolean;
        trustStatus: string;
      }>,
    ) => void = () => {},
  ): unknown {
    const hooks = required.map((event, index) => ({
      eventName: event,
      command: command(event),
      enabled: true,
      trustStatus: index % 2 === 0 ? "trusted" : "managed",
    }));
    change(hooks);
    return { data: [{ hooks }] };
  }

  it("is ready when all five matching hooks are enabled and trusted or managed", () => {
    expect(assessCodexHooks(response())).toEqual({
      ready: true,
      missing: [],
      needsReview: [],
    });
  });

  it.each(["untrusted", "modified"])(
    "marks an enabled PermissionRequest hook with %s trust as needsReview",
    (trustStatus) => {
      const assessment = assessCodexHooks(
        response((hooks) => {
          hooks.find((hook) => hook.eventName === "permissionRequest")!.trustStatus =
            trustStatus;
        }),
      );
      expect(assessment).toEqual({
        ready: false,
        missing: [],
        needsReview: ["permissionRequest"],
      });
    },
  );

  it.each([
    {
      label: "disabled",
      mutate: (hooks: any[]) => {
        hooks.find((hook) => hook.eventName === "permissionRequest").enabled = false;
      },
    },
    {
      label: "missing",
      mutate: (hooks: any[]) => {
        hooks.splice(
          hooks.findIndex((hook) => hook.eventName === "permissionRequest"),
          1,
        );
      },
    },
    {
      label: "unrelated command",
      mutate: (hooks: any[]) => {
        hooks.find((hook) => hook.eventName === "permissionRequest").command =
          "/usr/bin/python3 /tmp/other-hook.py PermissionRequest";
      },
    },
  ])("reports a $label PermissionRequest hook as missing", ({ mutate }) => {
    expect(assessCodexHooks(response(mutate))).toEqual({
      ready: false,
      missing: ["permissionRequest"],
      needsReview: [],
    });
  });
});

describe("readCodexHookStatuses", () => {
  let tmp: string;
  let codexDir: string;
  let legacyDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-provider-hooks-"));
    codexDir = path.join(tmp, "codex");
    legacyDir = path.join(tmp, "claude");
    fs.mkdirSync(codexDir);
    fs.mkdirSync(legacyDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(dir: string, name: string, value: unknown): void {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
  }

  it("accepts native/providerless Codex records and only Codex records from the legacy directory", () => {
    write(codexDir, "native", hook("native", "working", { ts: 10 }));
    write(codexDir, "providerless", {
      session_id: "providerless",
      state: "idle",
      ts: 11,
    });
    write(codexDir, "wrong-provider", {
      session_id: "wrong-provider",
      provider: "claude",
      state: "working",
      ts: 12,
    });
    write(legacyDir, "legacy-path", {
      session_id: "legacy-path",
      state: "working",
      ts: 13,
      transcript_path: "/home/test/.codex/sessions/rollout.jsonl",
    });
    write(legacyDir, "legacy-provider", {
      session_id: "legacy-provider",
      provider: "codex",
      state: "waiting",
      ts: 14,
    });
    write(legacyDir, "claude", {
      session_id: "claude",
      provider: "claude",
      state: "working",
      ts: 15,
      transcript_path: "/home/test/.claude/projects/session.jsonl",
    });
    fs.writeFileSync(path.join(legacyDir, "partial.json"), "{");

    const statuses = readCodexHookStatuses(codexDir, legacyDir);
    expect([...statuses.keys()].sort()).toEqual([
      "legacy-path",
      "legacy-provider",
      "native",
      "providerless",
    ]);
    expect([...statuses.values()].every((status) => status.provider === "codex")).toBe(
      true,
    );

    const claudeStatuses = readHookStatuses(legacyDir);
    expect([...claudeStatuses.keys()]).toEqual(["claude"]);
    expect(claudeStatuses.get("claude")?.provider).toBe("claude");
  });

  it("keeps the newest status when native and legacy records share an id", () => {
    write(codexDir, "shared-native", hook("shared", "working", { ts: 20 }));
    write(
      legacyDir,
      "shared-legacy",
      hook("shared", "waiting", {
        ts: 21,
        transcript_path: "/home/test/.codex/sessions/shared.jsonl",
      }),
    );

    expect(readCodexHookStatuses(codexDir, legacyDir).get("shared")).toMatchObject({
      provider: "codex",
      state: "waiting",
      ts: 21,
    });
  });
});

describe("provider registry", () => {
  it("keeps Claude and Codex sessions with the same raw id as separate composite keys", () => {
    const rawId = "same-session-id";
    const claude = collectSessions({
      now: NOW,
      hookStatuses: new Map([
        [
          rawId,
          {
            session_id: rawId,
            provider: "claude",
            state: "working",
            ts: NOW - 2,
          },
        ],
      ]),
      allowedEntrypoints: [],
      globalEffort: "high",
      showEnded: true,
      maxAgeSec: 3600,
    });
    const codex = mapCodexThreads(
      [thread(rawId, { type: "active" }, { updatedAt: NOW - 1 })],
      new Map(),
      options(),
    );
    const merged = mergeProviderSessions(claude, codex);

    expect(sessionKey("claude", rawId)).not.toBe(sessionKey("codex", rawId));
    expect(merged.map((view) => view.key).sort()).toEqual([
      `claude:${rawId}`,
      `codex:${rawId}`,
    ]);
    expect(countProviders(merged)).toEqual({ all: 2, claude: 1, codex: 1 });
    expect(filterProvider(merged, "claude").map((view) => view.key)).toEqual([
      `claude:${rawId}`,
    ]);
    expect(filterProvider(merged, "codex").map((view) => view.key)).toEqual([
      `codex:${rawId}`,
    ]);
    expect(filterProvider(merged, "all")).toHaveLength(2);
  });

  it("deduplicates only an identical composite key and keeps the newest view", () => {
    const older = mapCodexThreads(
      [thread("duplicate", { type: "idle" }, { updatedAt: NOW - 20 })],
      new Map(),
      options(),
    )[0];
    const newer = mapCodexThreads(
      [thread("duplicate", { type: "active" }, { updatedAt: NOW - 5 })],
      new Map(),
      options(),
    )[0];

    expect(mergeProviderSessions([older], [newer])).toEqual([newer]);
  });
});
