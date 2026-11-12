import { describe, expect, it } from "vitest";
import {
  GH_MAX_PER_MIN,
  GIT_TTL_MS,
  GitInfo,
  PR_TTL_MS,
  parseGitStatus,
  parsePr,
  rollupChecks,
  type CwdRunner,
} from "../src/gitInfo";

const status = (branch: string, entries: string[] = []) =>
  [`# branch.oid 0123abcd`, `# branch.head ${branch}`, "# branch.upstream origin/x", "# branch.ab +0 -0", ...entries, ""].join("\n");

const pr = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 42,
    state: "OPEN",
    url: "https://github.com/o/r/pull/42",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...over,
  });

describe("parseGitStatus", () => {
  it("reads the branch and counts every changed, untracked or conflicted path", () => {
    const out = status("feat/x", ["1 .M N... 100644 100644 100644 a b src/a.ts", "2 R. N... 1 2 3 a b R100 n.ts\to.ts", "u UU N... 1 2 3 4 a b c f.ts", "? new.md"]);
    expect(parseGitStatus(out)).toEqual({ branch: "feat/x", dirty: 4 });
    expect(parseGitStatus(status("main"))).toEqual({ branch: "main", dirty: 0 });
    expect(parseGitStatus(status("(detached)"))).toEqual({ branch: "(detached)", dirty: 0 });
    expect(parseGitStatus("")).toBeNull();
    expect(parseGitStatus("fatal: not a git repository")).toBeNull();
  });
});

describe("rollupChecks / parsePr", () => {
  const run = (status: string, conclusion: string | null = null) => ({ __typename: "CheckRun", status, conclusion });
  const ctx = (state: string) => ({ __typename: "StatusContext", state });

  it("fails on any failed check, is pending while one runs, passes otherwise, null without checks", () => {
    expect(rollupChecks([run("COMPLETED", "SUCCESS"), run("COMPLETED", "FAILURE")])).toBe("fail");
    expect(rollupChecks([run("IN_PROGRESS"), ctx("ERROR")])).toBe("fail");
    expect(rollupChecks([run("COMPLETED", "CANCELLED")])).toBe("fail");
    expect(rollupChecks([run("COMPLETED", "SUCCESS"), run("QUEUED")])).toBe("pending");
    expect(rollupChecks([ctx("PENDING"), run("COMPLETED", "SUCCESS")])).toBe("pending");
    expect(rollupChecks([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED"), ctx("SUCCESS"), run("COMPLETED", "NEUTRAL")])).toBe("pass");
    expect(rollupChecks([])).toBeNull();
    expect(rollupChecks(null)).toBeNull();
  });

  it("maps gh's JSON and refuses anything else", () => {
    expect(parsePr(pr())).toEqual({ number: 42, state: "open", url: "https://github.com/o/r/pull/42", checks: "pass" });
    expect(parsePr(pr({ state: "MERGED", statusCheckRollup: [] }))).toMatchObject({ state: "merged", checks: null });
    expect(parsePr(pr({ state: "CLOSED" }))?.state).toBe("closed");
    expect(parsePr(pr({ state: "DRAFT" }))).toBeNull();
    expect(parsePr(pr({ number: "42" }))).toBeNull();
    expect(parsePr("no pull requests found for branch")).toBeNull();
  });
});

describe("GitInfo", () => {
  function fixture(answers: Record<string, string | null>) {
    const calls: string[] = [];
    const clock = { now: 1_000_000 };
    const run: CwdRunner = async (cmd, args, cwd) => {
      const key = `${cmd} ${cwd}${cmd === "gh" ? " " + args[2] : ""}`;
      calls.push(key);
      return key in answers ? answers[key] : null;
    };
    return { calls, clock, info: new GitInfo(run, () => clock.now) };
  }

  it("answers from the cache, refreshes git after 30 s and asks gh only for a non-default branch", async () => {
    const { calls, clock, info } = fixture({
      "git /w/main": status("main", ["? a"]),
      "git /w/feat": status("feat/x", ["? a", "? b"]),
      "gh /w/feat feat/x": pr(),
    });
    expect(info.get("/w/main")).toBeNull(); // nothing cached yet: queued
    expect(info.get("/w/feat")).toBeNull();
    expect(info.get(null)).toBeNull();
    await info.idle();
    expect(info.get("/w/main")).toEqual({ branch: "main", dirty: 1, pr: null });
    expect(info.get("/w/feat")).toEqual({ branch: "feat/x", dirty: 2, pr: null }); // PR lookup queued now
    await info.idle();
    const withPr = { branch: "feat/x", dirty: 2, pr: { number: 42, state: "open", url: "https://github.com/o/r/pull/42", checks: "pass" } };
    expect(info.get("/w/feat")).toEqual(withPr);
    expect(calls).toEqual(["git /w/main", "git /w/feat", "gh /w/feat feat/x"]);

    clock.now += GIT_TTL_MS - 1;
    info.get("/w/feat");
    await info.idle();
    expect(calls).toHaveLength(3); // still fresh
    clock.now += 1;
    expect(info.get("/w/feat")).toEqual(withPr); // stale value while git runs again
    await info.idle();
    expect(calls.slice(3)).toEqual(["git /w/feat"]);
    clock.now += PR_TTL_MS;
    info.get("/w/feat");
    await info.idle();
    info.get("/w/feat");
    await info.idle();
    expect(calls.filter((c) => c.startsWith("gh"))).toHaveLength(2);
  });

  it("caches null when git or gh fails: no repo, no gh or no PR", async () => {
    const { info } = fixture({ "git /w/feat": status("feat/y"), "gh /w/feat feat/y": null });
    info.get("/tmp/no-repo");
    info.get("/w/feat");
    await info.idle();
    expect(info.get("/tmp/no-repo")).toBeNull();
    expect(info.get("/w/feat")).toEqual({ branch: "feat/y", dirty: 0, pr: null });
    await info.idle();
    expect(info.get("/w/feat")).toEqual({ branch: "feat/y", dirty: 0, pr: null });
  });

  it("makes at most 10 gh calls a minute across all folders", async () => {
    const answers: Record<string, string | null> = {};
    const cwds = Array.from({ length: 14 }, (_, i) => `/w/r${i}`);
    for (const c of cwds) answers[`git ${c}`] = status(`feat/${c.slice(3)}`);
    const { calls, clock, info } = fixture(answers);
    for (const c of cwds) info.get(c);
    await info.idle();
    for (const c of cwds) info.get(c);
    await info.idle();
    const gh = () => calls.filter((c) => c.startsWith("gh")).length;
    expect(gh()).toBe(GH_MAX_PER_MIN);
    for (const c of cwds) info.get(c); // over the budget: nothing new within the minute
    await info.idle();
    expect(gh()).toBe(GH_MAX_PER_MIN);
    clock.now += 60_000;
    for (const c of cwds) info.get(c);
    await info.idle();
    expect(gh()).toBe(14); // the 4 still unknown; the 10 cached ones are fresh for 3 min
  });
});
