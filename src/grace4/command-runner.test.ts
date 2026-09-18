import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommandResumeRefusal,
  formatDuration,
  outputTailOf,
  runDeclaredCommands,
  treeKillArgv,
  type CommandRunnerOptions,
  type DeclaredCommand,
} from "./command-runner";
import { projectSlug } from "./run-log-store";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // Temp dirs are best-effort cleanup.
    }
  }
});

function fixture(overrides: Partial<CommandRunnerOptions> = {}) {
  const logRoot = mkdtempSync(path.join(tmpdir(), "grace-runner-"));
  cleanups.push(() => rmSync(logRoot, { recursive: true, force: true }));
  const lines: string[] = [];
  const options: CommandRunnerOptions = {
    root: process.cwd(),
    changeId: "C-TEST",
    assertionMode: "target",
    timeoutMs: 10_000,
    verbosity: "compact",
    progress: (line) => lines.push(line),
    logRoot,
    ...overrides,
  };
  return { logRoot, lines, options };
}

function declared(commands: string[], assertionKey = "plan.xml::TargetAssertions::0"): DeclaredCommand[] {
  return commands.map((command, index) => ({
    assertionKey,
    assertionId: `plan.xml#${index + 1}`,
    command,
  }));
}

function join(lines: string[]): string {
  return lines.join("\n");
}

// Declared commands are spawned through `cmd.exe /d /s /c` on Windows and `$SHELL -lc` elsewhere,
// so a fixture command has to be written for whichever shell will read it. `printf` does not exist
// on Windows, and `echo a & echo b` there emits a trailing space before the separator, which would
// break the exact-match assertions below — hence `&` with no surrounding space.
const onWindows = process.platform === "win32";

/** Prints one token and exits 0. */
function printCommand(token: string): string {
  return onWindows ? `echo ${token}` : `printf ${token}`;
}

/** Prints two separate lines and exits 0. */
const twoLineCommand = onWindows
  ? "echo hello-live&echo second-line"
  : "printf 'hello-live\\nsecond-line\\n'";

/** Writes to stdout and stderr, then exits 3. */
const failingCommand = onWindows
  ? "echo boom-stdout&echo boom-stderr 1>&2&exit 3"
  : "printf boom-stdout; printf boom-stderr 1>&2; exit 3";

/**
 * Prints `quiet-success` while the command text itself never spells that token, so an assertion
 * that the token is absent from progress output tests forwarding rather than the echoed command.
 * POSIX splits it with adjacent quoting; `cmd.exe` uses a no-op caret escape.
 */
const quietSuccessCommand = onWindows ? "echo quiet^-success" : "printf 'quiet''-success'";

describe("runDeclaredCommands output contract", () => {
  test("plan block precedes result lines; compact emits start and result per command only", async () => {
    const { lines, options } = fixture();
    const okCommand = printCommand("ok");
    const fineCommand = printCommand("fine");
    const summary = await runDeclaredCommands(declared([okCommand, fineCommand]), options);
    expect(summary.status).toBe("passed");

    const headerIndex = lines.findIndex((line) => line.startsWith("run-commands:"));
    expect(headerIndex).toBe(0);
    expect(lines[0]).toContain("change C-TEST (target)");
    expect(lines[0]).toContain("1 assertion, 2 commands, timeout 10s");
    expect(lines[1]).toBe(`  [1/2] ${okCommand}`);
    expect(lines[2]).toBe(`  [2/2] ${fineCommand}`);
    expect(lines[3]).toBe(`▶ [1/2] ${okCommand}`);
    expect(lines[4]).toStartWith(`✔ [1/2] ${okCommand}`);
    expect(lines[4]).toMatch(/ \(\d+ms\)$/);
    expect(lines[5]).toBe(`▶ [2/2] ${fineCommand}`);
    expect(lines[6]).toStartWith(`✔ [2/2] ${fineCommand}`);
    expect(lines[6]).toMatch(/ \(\d+ms\)$/);
    expect(lines.some((line) => line.includes("ok") && !line.startsWith("✔") && !line.includes("[1/2]"))).toBe(false);
    expect(join(lines)).toContain("complete: 2/2 commands passed");
  });

  test("live mode forwards child output with [k/M] prefixes", async () => {
    const { lines, options } = fixture({ verbosity: "live" });
    await runDeclaredCommands(declared([twoLineCommand]), options);
    expect(lines).toContain("[1/1] hello-live");
    expect(lines).toContain("[1/1] second-line");
  });

  test("failure prints tail and full log path; success prints no tail", async () => {
    const { logRoot, lines, options } = fixture();
    const summary = await runDeclaredCommands(declared([failingCommand]), options);
    expect(summary.status).toBe("failed");
    const text = join(lines);
    expect(text).toContain("exit 3");
    expect(text).toContain("boom-stdout");
    expect(text).toContain("boom-stderr");
    expect(text).toMatch(/full log: .+\.log/);
    expect(text).toContain("stopped: command 1 of 1 failed");

    const passing = fixture();
    await runDeclaredCommands(declared([quietSuccessCommand]), passing.options);
    expect(join(passing.lines)).not.toContain("quiet-success");
  });

  test("commands after the first failure are skipped and never started", async () => {
    const { lines, options } = fixture();
    const summary = await runDeclaredCommands(declared(["exit 7", "echo second", "echo third"]), options);
    expect(summary.status).toBe("failed");
    expect(summary.commands[1]?.skipped).toBe(true);
    expect(summary.commands[2]?.skipped).toBe(true);
    expect(summary.commands[1]?.durationMs).toBe(0);
    expect(join(lines)).not.toContain("▶ [2/3]");
    expect(join(lines)).not.toContain("▶ [3/3]");
    expect(join(lines)).not.toContain("✔ [2/3]");
    expect(join(lines)).not.toContain("✖ [2/3]");
  });
});

describe.skipIf(process.platform === "win32")("runDeclaredCommands timeout and process groups", () => {
  test("timeout kills the command and marks the run as timeout", async () => {
    const { lines, options } = fixture({ timeoutMs: 600 });
    const startedAt = Date.now();
    const summary = await runDeclaredCommands(declared(["sleep 23.7"]), options);
    const wallMs = Date.now() - startedAt;
    expect(summary.status).toBe("timeout");
    expect(summary.commands[0]?.timedOut).toBe(true);
    expect(summary.commands[0]?.exitCode).toBeNull();
    expect(wallMs).toBeLessThan(15_000);
    expect(join(lines)).toContain("timed out after");
  });

  test("timeout kills the whole process group including background children", async () => {
    const { options } = fixture({ timeoutMs: 600 });
    await runDeclaredCommands(declared(["sleep 23.4 & sleep 23.4"]), options);
    await Bun.sleep(700);
    const probe = Bun.spawnSync({ cmd: ["pgrep", "-f", "sleep 23.4"], stdout: "pipe", stderr: "pipe" });
    const survivors = new TextDecoder().decode(probe.stdout).trim();
    expect(survivors).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("runDeclaredCommands abort handling", () => {
  test("abort kills the running group, skips the rest, and records interrupted", async () => {
    const { lines, options } = fixture();
    const controller = new AbortController();
    const running = runDeclaredCommands(declared(["sleep 22.9", "echo after-abort"], "plan.xml::TargetAssertions::0"), options, controller.signal);
    await Bun.sleep(400);
    controller.abort();
    const summary = await running;

    expect(summary.status).toBe("interrupted");
    expect(summary.commands[0]?.skipped).toBe(false);
    expect(summary.commands[1]?.skipped).toBe(true);
    expect(join(lines)).toContain("(interrupted)");
    expect(join(lines)).toContain("interrupted: command 1 of 2 aborted");

    const probe = Bun.spawnSync({ cmd: ["pgrep", "-f", "sleep 22.9"], stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(probe.stdout).trim()).toBe("");
  });
});

describe("runDeclaredCommands logs", () => {
  test("meta.json round-trips with per-command fields and existing log files", async () => {
    const { logRoot, options } = fixture();
    const summary = await runDeclaredCommands(declared([printCommand("meta-ok")]), options);
    expect(summary.runDir).not.toBeNull();
    const meta = JSON.parse(await Bun.file(path.join(summary.runDir!, "meta.json")).text());
    expect(meta.schemaVersion).toBe("1.0.0");
    expect(meta.status).toBe("passed");
    expect(meta.changeId).toBe("C-TEST");
    expect(meta.commands).toHaveLength(1);
    expect(meta.commands[0].exitCode).toBe(0);
    expect(meta.commands[0].logFile).toBeString();
    const logText = await Bun.file(meta.commands[0].logFile).text();
    expect(logText).toContain("meta-ok");
  });

  test("retention keeps ten runs including the current one", async () => {
    const { logRoot, options } = fixture();
    const projectRoot = path.join(tmpdir(), "grace-retention-proj");
    mkdirSync(projectRoot, { recursive: true });
    cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
    const runsParent = path.join(logRoot, projectSlug(projectRoot), "runs");
    for (let i = 1; i <= 11; i++) {
      mkdirSync(path.join(runsParent, `2026-08-${String(i).padStart(2, "0")}T00-00-00`), { recursive: true });
    }
    const summary = await runDeclaredCommands(declared([printCommand("keep")]), { ...options, root: projectRoot });
    const runDirs = readdirSync(runsParent).sort();
    expect(runDirs).toHaveLength(10);
    expect(runDirs[9]).toBe(path.basename(summary.runDir!));
  });

  test("unwritable log root degrades to a warning and null log files", async () => {
    const logRoot = mkdtempSync(path.join(tmpdir(), "grace-runner-blocked-"));
    const blocker = path.join(logRoot, "blocker");
    writeFileSync(blocker, "not a directory");
    cleanups.push(() => rmSync(logRoot, { recursive: true, force: true }));

    const lines: string[] = [];
    const options: CommandRunnerOptions = {
      root: process.cwd(),
      changeId: "C-TEST",
      assertionMode: "target",
      timeoutMs: 10_000,
      verbosity: "compact",
      progress: (line) => lines.push(line),
      logRoot: blocker,
    };
    const summary = await runDeclaredCommands(declared([printCommand("degrade-ok")]), options);
    expect(summary.status).toBe("passed");
    expect(summary.runDir).toBeNull();
    expect(summary.commands[0]?.logFile).toBeNull();
    expect(join(lines)).toContain("warning: unable to create command log directory");
    expect(join(lines)).toContain("✔ [1/1]");
  });
});

/**
 * A project root whose `check.js` exits 7 until `marker.txt` appears beside it. The command text
 * stays byte-identical between runs, which is exactly what the resume guard requires, while the
 * outcome still changes — the same shape as fixing the code a failing gate command tests.
 */
function resumeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "grace-resume-proj-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "check.js"),
    `import { existsSync } from "node:fs";\nprocess.exit(existsSync("marker.txt") ? 0 : 7);\n`,
  );
  return root;
}

describe("runDeclaredCommands --only-failed", () => {
  test("re-runs only the commands the referenced run did not pass", async () => {
    const root = resumeProject();
    const first = fixture({ root });
    const commands = declared([printCommand("first"), `${process.execPath} check.js`, printCommand("third")]);

    const failedRun = await runDeclaredCommands(commands, first.options);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.commands[1]?.exitCode).toBe(7);
    expect(failedRun.commands[2]?.skipped).toBe(true);
    const firstMeta = JSON.parse(await Bun.file(path.join(failedRun.runDir!, "meta.json")).text());
    expect("resumedFrom" in firstMeta).toBe(false);

    writeFileSync(path.join(root, "marker.txt"), "ready");
    // Referenced by directory name; provenance is recorded as the resolved absolute run.
    const ref = failedRun.runDir!;
    const second = fixture({ root, logRoot: first.logRoot });
    const resumed = await runDeclaredCommands(commands, { ...second.options, onlyFailed: path.basename(ref) });

    expect(resumed.status).toBe("passed");
    expect(resumed.runDir).not.toBe(failedRun.runDir);
    const text = join(second.lines);
    expect(text).toContain(`resume: 2 of 3 commands re-run from ${ref}, 1 carried over`);
    expect(text).not.toContain("▶ [1/3]");
    expect(text).toContain(`↷ [1/3] ${printCommand("first")} (passed in ${ref})`);
    expect(text).toContain("▶ [2/3]");
    expect(text).toContain("▶ [3/3]");

    const meta = JSON.parse(await Bun.file(path.join(resumed.runDir!, "meta.json")).text());
    expect(meta.resumedFrom).toBe(ref);
    expect(meta.status).toBe("passed");
    expect(meta.commands).toHaveLength(3);
    expect(meta.commands[0].resumedFrom).toBe(ref);
    expect(meta.commands[0].exitCode).toBe(0);
    expect("resumedFrom" in meta.commands[1]).toBe(false);
    // The carried log lives in the new run directory, so pruning the referenced run cannot
    // take the only copy of that evidence with it.
    expect(path.dirname(meta.commands[0].logFile)).toBe(resumed.runDir as string);
    expect(await Bun.file(meta.commands[0].logFile).text()).toContain("first");
  });

  test("`last` resolves the newest run and an all-passing run re-runs nothing", async () => {
    const { logRoot, options } = fixture();
    const commands = declared([printCommand("alpha"), printCommand("beta")]);
    const green = await runDeclaredCommands(commands, options);
    expect(green.status).toBe("passed");

    const second = fixture({ logRoot });
    const resumed = await runDeclaredCommands(commands, { ...second.options, onlyFailed: "last" });
    expect(resumed.status).toBe("passed");
    expect(resumed.runDir).not.toBe(green.runDir);
    const text = join(second.lines);
    // `last` names a different run tomorrow, so the recorded provenance is the resolved run.
    expect(text).toContain(`resume: 0 of 2 commands re-run from ${green.runDir}, 2 carried over`);
    expect(text).not.toContain("▶ ");
    expect(resumed.commands.every((command) => command.resumedFrom === green.runDir)).toBe(true);
  });

  test("refuses an unknown run, a foreign change or mode, and a changed command set", async () => {
    const { logRoot, options } = fixture();
    const commands = declared([printCommand("gate")]);
    const base = await runDeclaredCommands(commands, options);
    const ref = path.basename(base.runDir!);

    await expect(runDeclaredCommands(commands, { ...options, onlyFailed: "2020-01-01T00-00-00" }))
      .rejects.toThrow(/no run directory found/);
    await expect(runDeclaredCommands(commands, { ...options, onlyFailed: ref, changeId: "C-OTHER" }))
      .rejects.toThrow(/recorded change `C-TEST`/);
    await expect(runDeclaredCommands(commands, { ...options, onlyFailed: ref, assertionMode: "baseline" }))
      .rejects.toThrow(/assertion mode `target`/);
    await expect(runDeclaredCommands(declared([printCommand("gate"), printCommand("extra")]), { ...options, onlyFailed: ref }))
      .rejects.toThrow(/declared 1 command\(s\), this invocation declares 2/);
    await expect(runDeclaredCommands(declared([printCommand("other")]), { ...options, onlyFailed: ref }))
      .rejects.toThrow(/command 1 differs/);

    const orphan = path.join(logRoot, projectSlug(options.root), "runs", "2031-01-01T00-00-00");
    mkdirSync(orphan, { recursive: true });
    const refusal = runDeclaredCommands(commands, { ...options, onlyFailed: "2031-01-01T00-00-00" });
    await expect(refusal).rejects.toBeInstanceOf(CommandResumeRefusal);
    await expect(refusal).rejects.toThrow(/no readable meta.json/);
  });

  test("refuses a resume of a gate that no longer declares any command", async () => {
    const { options } = fixture();
    const base = await runDeclaredCommands(declared([printCommand("gate")]), options);
    await expect(runDeclaredCommands([], { ...options, onlyFailed: path.basename(base.runDir!) }))
      .rejects.toThrow(/declared 1 command\(s\), this invocation declares 0/);
    // Without a resume, an empty declared list stays the silent no-op it has always been.
    const empty = await runDeclaredCommands([], options);
    expect(empty).toEqual({ status: "passed", runDir: null, commands: [] });
  });

  test("a refusal creates no run directory", async () => {
    const { logRoot, options } = fixture();
    const commands = declared([printCommand("solo")]);
    await runDeclaredCommands(commands, options);
    const runsParent = path.join(logRoot, projectSlug(options.root), "runs");
    const before = readdirSync(runsParent);
    await expect(runDeclaredCommands(declared([printCommand("changed")]), { ...options, onlyFailed: path.basename(before[0]) }))
      .rejects.toThrow(/command 1 differs/);
    expect(readdirSync(runsParent)).toEqual(before);
  });
});

describe("runDeclaredCommands --continue-on-failure", () => {
  test("runs every command and names all failures in the summary", async () => {
    const { lines, options } = fixture();
    const summary = await runDeclaredCommands(
      declared(["exit 7", "exit 9", printCommand("last-one")]),
      { ...options, continueOnFailure: true },
    );
    expect(summary.status).toBe("failed");
    expect(summary.commands.some((command) => command.skipped)).toBe(false);
    expect(summary.commands[1]?.exitCode).toBe(9);
    expect(summary.commands[2]?.exitCode).toBe(0);
    const text = join(lines);
    expect(text).toContain("▶ [2/3]");
    expect(text).toContain("▶ [3/3]");
    expect(text).toContain("complete: 1/3 commands passed; failed: 1, 2 (total ");
  });
});

describe("formatDuration", () => {
  test("renders the agreed human formats", () => {
    expect(formatDuration(48000)).toBe("48s");
    expect(formatDuration(372000)).toBe("6m 12s");
    expect(formatDuration(3725000)).toBe("1h 02m 05s");
    expect(formatDuration(250)).toBe("250ms");
  });
});

describe("outputTailOf", () => {
  test("returns null for empty input", () => {
    expect(outputTailOf("")).toBeNull();
    expect(outputTailOf("   \n  \n")).toBeNull();
  });

  test("caps at 15 lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    const tail = outputTailOf(lines.join("\n"))!;
    expect(tail.split("\n")).toHaveLength(15);
    expect(tail.startsWith("line-15")).toBe(true);
  });

  test("byte-trims from the end when lines exceed 4096 bytes", () => {
    const longLines = Array.from({ length: 10 }, () => "x".repeat(1000));
    const tail = outputTailOf(longLines.join("\n"), 15, 4096)!;
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(4096);
    expect(tail.startsWith("x")).toBe(true);
  });
});

describe("treeKillArgv", () => {
  test("builds taskkill argv on win32 and null on posix", () => {
    expect(treeKillArgv(4242, "win32" as NodeJS.Platform)).toEqual(["taskkill", "/PID", "4242", "/T", "/F"]);
    expect(treeKillArgv(4242, "linux" as NodeJS.Platform)).toBeNull();
  });
});
