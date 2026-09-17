import { beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({
  commands: new Map<string, () => unknown>(),
  terminals: [] as Array<{ options: any; show: ReturnType<typeof vi.fn> }>,
  provider: undefined as any,
  messages: [] as any[],
  messageHandler: undefined as ((message: any) => void) | undefined,
  trusted: true,
}));

vi.mock("vscode", () => {
  class Disposable {
    static from(...items: any[]) {
      return { dispose: () => items.forEach((item) => item?.dispose?.()) };
    }
  }
  return {
    Disposable,
    ViewColumn: { Active: 1 },
    Uri: { file: (fsPath: string) => ({ fsPath }), parse: (value: string) => ({ value }) },
    window: {
      registerWebviewViewProvider: (_id: string, provider: any) => {
        rec.provider = provider;
        return { dispose() {} };
      },
      onDidCloseTerminal: () => ({ dispose() {} }),
      createTerminal: (options: any) => {
        const terminal = { options, show: vi.fn() };
        rec.terminals.push(terminal);
        return terminal;
      },
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn(),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ name: "repo", uri: { fsPath: "/workspace/repo" } }],
      getConfiguration: () => ({ get: (key: string, fallback: string) => key === "agentHub.claudeExecutable" ? "/bin/sh" : fallback }),
    },
    commands: {
      registerCommand: (id: string, callback: () => unknown) => {
        rec.commands.set(id, callback);
        return { dispose() {} };
      },
      executeCommand: vi.fn(),
    },
    env: { openExternal: vi.fn() },
  };
});

import * as vscode from "vscode";
import { registerAgentHub } from "../src/hub/runtime";

function context(): any {
  const state = new Map<string, unknown>();
  return {
    subscriptions: [],
    globalState: {
      get: (key: string, fallback?: unknown) => state.has(key) ? state.get(key) : fallback,
      update: (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
        return Promise.resolve();
      },
    },
  };
}

beforeEach(() => {
  rec.commands.clear();
  rec.terminals.length = 0;
  rec.messages.length = 0;
  rec.messageHandler = undefined;
  (vscode.workspace as any).isTrusted = true;
});

describe("Agent Hub terminal runtime", () => {
  it("uses a direct shell path and reuses one provider/workspace terminal", async () => {
    registerAgentHub(context());
    await rec.commands.get("agentHub.start")!();
    await rec.commands.get("agentHub.start")!();
    await rec.commands.get("agentHub.newSession")!();
    expect(rec.terminals).toHaveLength(2);
    expect(rec.terminals[0].options).toMatchObject({
      shellPath: "/bin/sh",
      cwd: "/workspace/repo",
      shellArgs: [],
      location: { viewColumn: 1 },
    });
    expect(rec.terminals[0].show).toHaveBeenCalledTimes(2);
    expect(rec.terminals[1].options.name).toContain("new");
  });

  it("does not create an agent terminal in an untrusted workspace", async () => {
    (vscode.workspace as any).isTrusted = false;
    registerAgentHub(context());
    await rec.commands.get("agentHub.start")!();
    expect(rec.terminals).toHaveLength(0);
  });

  it("waits for the webview ready handshake before focusing configuration on first open", async () => {
    registerAgentHub(context());
    await rec.commands.get("agentHub.configure")!();
    expect(rec.messages).toEqual([]);

    rec.provider.resolveWebviewView({
      webview: {
        options: {},
        html: "",
        postMessage: (message: any) => rec.messages.push(message),
        onDidReceiveMessage: (handler: (message: any) => void) => {
          rec.messageHandler = handler;
        },
      },
    });
    expect(rec.messages.map((message) => message.type)).toEqual(["state"]);

    rec.messageHandler?.({ type: "ready" });
    expect(rec.messages.slice(-2).map((message) => message.type)).toEqual(["state", "focusSettings"]);
  });
});
