import { copyFileSync, createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";

import {
  commandLogFileName,
  createRunDir,
  projectSlug,
  pruneRuns,
  readRunMeta,
  resolveLogRoot,
  resolveRunDirRef,
  writeRunMeta,
  type RunMeta,
  type RunMetaCommand,
} from "./run-log-store";

/** One declared command identified by its owning assertion slot. */
export type DeclaredCommand = {
  /** Lookup key stamped at extraction: `${planFile}::${section}::${assertionIndex}`. */
  assertionKey: string;
  /** Display id for meta.json, e.g. `plan.xml#3`. */
  assertionId: string;
  /** Full command string executed verbatim via $SHELL -lc. */
  command: string;
};

export type CommandRunnerOptions = {
  /** Project root: cwd for children and basis for the cache slug. */
  root: string;
  changeId?: string;
  assertionMode: string;
  /** Per-command timeout in ms; 0 disables. */
  timeoutMs: number;
  verbosity: "compact" | "live";
  /** Progress sink; default writes `[grace] ${line}` to process.stderr. */
  progress?: (line: string) => void;
  /** Overrides resolveLogRoot() for tests. */
  logRoot?: string;
  /** Injectable clock for deterministic run directory names. */
  now?: () => Date;
  /**
   * Run reference whose non-passing commands are the only ones executed: a run directory
   * name, an absolute run directory path, or `last`. Commands that passed there are carried
   * over instead of re-executed. Refused unless the referenced run matches this invocation.
   */
  onlyFailed?: string;
  /** Runs every declared command even after one fails, instead of skipping the remainder. */
  continueOnFailure?: boolean;
};

export type CommandRunResult = {
  index: number;
  assertionKey: string;
  assertionId: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  skipped: boolean;
  logFile: string | null;
  /** Last <=15 lines and <=4KB of combined stdout+stderr; null on success or no output. */
  outputTail: string | null;
  /** Run reference this passing result was carried over from; absent when the command ran here. */
  resumedFrom?: string;
};

export type CommandRunSummary = {
  status: "passed" | "failed" | "timeout" | "interrupted";
  runDir: string | null;
  commands: CommandRunResult[];
};

/** Grace period between SIGTERM and SIGKILL when a process group must die. */
export const TERM_GRACE_MS = 5000;

/**
 * Refusal raised when `--only-failed` cannot prove the referenced run describes this exact
 * invocation. Carried to the CLI boundary, which renders it as an invalid-arguments failure.
 */
export class CommandResumeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandResumeRefusal";
  }
}

/**
 * Identity of the current invocation checked against a recorded run before resuming.
 * Tree identity (head, branch, dirty) is deliberately absent: meta.json does not record it
 * yet, so the guard below falls back to a byte-identical declared command set. When those
 * fields land in RunMeta they become extra members here and extra checks in one place.
 */
export type ResumeIdentity = {
  projectRoot: string;
  changeId: string | null;
  assertionMode: string;
  commands: string[];
};

/** Which declared commands a resume must execute, and the recorded entries for the rest. */
export type ResumePlan = {
  /** Parallel to the declared commands: true when the command must run again. */
  rerun: boolean[];
  /** The referenced run's recorded commands, index-aligned with the declared list. */
  prior: RunMetaCommand[];
};

/** A recorded command passed only when it ran to completion with exit code zero. */
function metaCommandPassed(command: RunMetaCommand): boolean {
  return !command.skipped && !command.timedOut && command.exitCode === 0;
}

/**
 * Decides whether the referenced run may be resumed, and which commands that implies.
 * Every mismatch is a refusal rather than a silent full run, because resuming against a
 * different project, change, mode, or command set would report stale evidence as fresh.
 */
export function validateResumeEligibility(
  current: ResumeIdentity,
  prior: RunMeta | null,
  ref: string,
): ResumePlan {
  if (!prior) {
    throw new CommandResumeRefusal(
      `\`--only-failed ${ref}\` refused: the referenced run has no readable meta.json.`,
    );
  }
  if (path.resolve(prior.projectRoot) !== path.resolve(current.projectRoot)) {
    throw new CommandResumeRefusal(
      `\`--only-failed ${ref}\` refused: that run belongs to project \`${prior.projectRoot}\`, not \`${current.projectRoot}\`.`,
    );
  }
  if ((prior.changeId ?? null) !== current.changeId) {
    throw new CommandResumeRefusal(
      `\`--only-failed ${ref}\` refused: that run recorded change \`${prior.changeId ?? "none"}\`, this invocation selects \`${current.changeId ?? "none"}\`.`,
    );
  }
  if (prior.assertionMode !== current.assertionMode) {
    throw new CommandResumeRefusal(
      `\`--only-failed ${ref}\` refused: that run used assertion mode \`${prior.assertionMode}\`, this invocation uses \`${current.assertionMode}\`.`,
    );
  }
  // Without recorded tree identity the only honest evidence that the gate is the same gate is
  // that it declares the same commands in the same order, byte for byte.
  if (prior.commands.length !== current.commands.length) {
    throw new CommandResumeRefusal(
      `\`--only-failed ${ref}\` refused: that run declared ${prior.commands.length} command(s), this invocation declares ${current.commands.length}.`,
    );
  }
  for (let i = 0; i < current.commands.length; i++) {
    if (prior.commands[i].command !== current.commands[i]) {
      throw new CommandResumeRefusal(
        `\`--only-failed ${ref}\` refused: command ${i + 1} differs (recorded \`${prior.commands[i].command}\`, declared \`${current.commands[i]}\`).`,
      );
    }
  }
  return {
    rerun: prior.commands.map((command) => !metaCommandPassed(command)),
    prior: prior.commands,
  };
}

/** One spawned shell command with piped stdout/stderr and ignored stdin. */
type ShellProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

/**
 * Executes declared commands sequentially, fail-fast, writing plan/progress/result lines to the
 * progress sink, full combined output to per-command log files, and a final meta.json. POSIX
 * children run under `setsid $SHELL -lc <command>` so each command leads its own process group;
 * timeout and abort kill the whole group (SIGTERM, then SIGKILL after the grace period).
 * Windows children run under cmd.exe with taskkill /T /F for tree kills.
 *
 * Two opt-in modifiers change only what is attempted: `onlyFailed` re-runs just the commands a
 * referenced run did not pass (refusing when that run does not describe this invocation) and
 * `continueOnFailure` keeps going after a failure instead of skipping the remainder. With
 * neither set the behaviour is exactly the fail-fast run described above.
 */
export async function runDeclaredCommands(
  declared: DeclaredCommand[],
  options: CommandRunnerOptions,
  signal?: AbortSignal,
): Promise<CommandRunSummary> {
  // Resume eligibility is settled before anything is created, so a refusal leaves no empty
  // run directory behind and `last` never resolves to the directory being created now. It is
  // also settled before the empty early return, so resuming a gate that no longer declares any
  // command refuses on the command-count mismatch instead of passing without touching the run.
  const requestedRef = options.onlyFailed ? options.onlyFailed : null;
  // Provenance is always the resolved run directory, never the spelling on the command line:
  // `last` names a different run tomorrow, so recording it would be evidence nobody can follow.
  let resumeRef: string | null = null;
  let resume: ResumePlan | null = null;
  if (requestedRef) {
    const logRoot = options.logRoot ?? resolveLogRoot();
    const slug = projectSlug(options.root);
    const priorDir = resolveRunDirRef(logRoot, slug, requestedRef);
    if (!priorDir) {
      throw new CommandResumeRefusal(
        `\`--only-failed ${requestedRef}\` refused: no run directory found under ${path.join(logRoot, slug, "runs")}.`,
      );
    }
    resume = validateResumeEligibility(
      {
        projectRoot: options.root,
        changeId: options.changeId ?? null,
        assertionMode: options.assertionMode,
        commands: declared.map((entry) => entry.command),
      },
      readRunMeta(priorDir),
      requestedRef,
    );
    resumeRef = priorDir;
  }

  if (declared.length === 0) {
    return { status: "passed", runDir: null, commands: [] };
  }

  const emit = options.progress ?? defaultProgress;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const total = declared.length;

  let runDir: string | null = null;
  try {
    runDir = createRunDir(options.logRoot ?? resolveLogRoot(), projectSlug(options.root), startedAt, options.changeId);
  } catch (error) {
    emit(`warning: unable to create command log directory: ${errorMessage(error)}`);
  }

  const assertionCount = new Set(declared.map((entry) => entry.assertionKey)).size;
  const timeoutLabel = options.timeoutMs > 0 ? `${Math.round(options.timeoutMs / 1000)}s` : "none";
  emit(
    `run-commands: ${options.changeId ? `change ${options.changeId} ` : ""}(${options.assertionMode}), ` +
      `${assertionCount} assertion${assertionCount === 1 ? "" : "s"}, ` +
      `${total} command${total === 1 ? "" : "s"}, timeout ${timeoutLabel}`,
  );
  for (let i = 0; i < total; i++) {
    emit(`  [${i + 1}/${total}] ${declared[i].command}`);
  }
  if (resume) {
    const rerunCount = resume.rerun.filter(Boolean).length;
    emit(
      `resume: ${rerunCount} of ${total} command${rerunCount === 1 ? "" : "s"} re-run from ${resumeRef}, ` +
        `${total - rerunCount} carried over`,
    );
  }

  let currentGroup: ((signal: NodeJS.Signals) => void) | null = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    currentGroup?.("SIGTERM");
    setTimeout(() => currentGroup?.("SIGKILL"), TERM_GRACE_MS);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const results: CommandRunResult[] = [];
  let status: CommandRunSummary["status"] = "passed";
  let failedIndex = 0;
  const failedIndexes: number[] = [];

  try {
    for (let i = 0; i < total; i++) {
      const entry = declared[i];
      if (aborted) {
        results.push(skippedResult(entry, i + 1));
        continue;
      }
      if (resume && !resume.rerun[i]) {
        emit(`↷ [${i + 1}/${total}] ${entry.command} (passed in ${resumeRef})`);
        results.push(carriedResult(entry, i + 1, resume.prior[i], resumeRef as string, runDir));
        continue;
      }
      if (status !== "passed" && !options.continueOnFailure) {
        results.push(skippedResult(entry, i + 1));
        continue;
      }
      const outcome = await runOne(entry, i + 1, total, options, runDir, emit, (kill) => {
        currentGroup = kill;
      }, () => aborted);
      currentGroup = null;
      results.push(outcome.result);
      if (aborted) {
        status = "interrupted";
        failedIndex = i + 1;
      } else if (outcome.result.timedOut || outcome.result.exitCode !== 0) {
        // The summary keeps naming the first non-pass, so --continue-on-failure only widens
        // what is attempted, never what the run reports as the reason it is red.
        if (status === "passed") {
          status = outcome.result.timedOut ? "timeout" : "failed";
          failedIndex = i + 1;
        }
        failedIndexes.push(i + 1);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  const finishedAt = clock();
  const totalMs = finishedAt.getTime() - startedAt.getTime();
  const passed = results.filter((result) => !result.skipped && !result.timedOut && result.exitCode === 0).length;
  const collected = Boolean(options.continueOnFailure) && failedIndexes.length > 0 && status !== "interrupted";
  emit(
    collected
      // Nothing stopped when every command was attempted, so the fail-fast wording would lie.
      ? `complete: ${passed}/${total} commands passed; failed: ${failedIndexes.join(", ")} (total ${formatDuration(totalMs)})`
      : summaryLine(status, failedIndex, total, passed, totalMs),
  );

  if (runDir) {
    const meta: RunMeta = {
      schemaVersion: "1.0.0",
      tool: "grace-lint",
      changeId: options.changeId ?? null,
      assertionMode: options.assertionMode,
      projectRoot: path.resolve(options.root),
      slug: projectSlug(options.root),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status,
      ...(resumeRef ? { resumedFrom: resumeRef } : {}),
      commands: results.map(toMetaCommand),
    };
    writeRunMeta(runDir, meta);
    pruneRuns(path.dirname(runDir));
    emit(`logs: ${runDir}`);
  }

  return { status, runDir, commands: results };
}

/** Human duration: 48s, 6m 12s, 1h 02m 05s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(seconds)}s`;
  }
  return `${seconds}s`;
}

/** Returns the last `maxLines` lines of text trimmed to at most `maxBytes` from the end. */
export function outputTailOf(text: string, maxLines = 15, maxBytes = 4096): string | null {
  if (!text) {
    return null;
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }
  let tail = lines.slice(-maxLines).join("\n");
  const bytes = Buffer.byteLength(tail, "utf8");
  if (bytes > maxBytes) {
    tail = Buffer.from(tail, "utf8").subarray(bytes - maxBytes).toString("utf8");
    const firstNewline = tail.indexOf("\n");
    if (firstNewline > 0) {
      tail = tail.slice(firstNewline + 1);
    }
  }
  return tail.length > 0 ? tail : null;
}

/**
 * Windows tree-kill argv for one pid: ["taskkill", "/PID", pid, "/T", "/F"].
 * Returns null on POSIX, where process-group signals are used instead.
 * Pure and exported so the Windows branch stays unit-testable off-platform.
 */
export function treeKillArgv(pid: number, platform: NodeJS.Platform = process.platform): string[] | null {
  if (platform === "win32") {
    return ["taskkill", "/PID", String(pid), "/T", "/F"];
  }
  return null;
}

type SingleOutcome = {
  result: CommandRunResult;
};

async function runOne(
  entry: DeclaredCommand,
  index: number,
  total: number,
  options: CommandRunnerOptions,
  runDir: string | null,
  emit: (line: string) => void,
  registerKill: (kill: (signal: NodeJS.Signals) => void) => void,
  isAborted: () => boolean,
): Promise<SingleOutcome> {
  const label = `[${index}/${total}]`;
  emit(`▶ ${label} ${entry.command}`);
  const startedAt = Date.now();

  let logStream: WriteStream | null = null;
  let logFile: string | null = null;
  if (runDir) {
    logFile = path.join(runDir, commandLogFileName(index, entry.command));
    try {
      logStream = createWriteStream(logFile);
    } catch {
      logStream = null;
      logFile = null;
    }
  }

  let proc: ShellProcess;
  try {
    proc = spawnShellCommand(entry.command, options.root);
  } catch (error) {
    logStream?.end();
    emit(`✖ ${label} ${entry.command} (failed to start: ${errorMessage(error)})`);
    return {
      result: {
        index,
        assertionKey: entry.assertionKey,
        assertionId: entry.assertionId,
        command: entry.command,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        skipped: false,
        logFile,
        outputTail: null,
      },
    };
  }
  const prefix = `${label}`;
  const chunks: Uint8Array[] = [];
  const live = options.verbosity === "live";
  const kill = (signal: NodeJS.Signals) => killProcessTree(proc, signal);
  registerKill(kill);

  const exitPromise = raceExitWithTimeout(proc, options.timeoutMs, kill);
  const pumps = [
    pumpStream(proc.stdout, chunks, logStream, live, prefix, emit),
    pumpStream(proc.stderr, chunks, logStream, live, prefix, emit),
  ];
  const exit = await exitPromise;
  await Promise.allSettled(pumps);
  logStream?.end();

  const durationMs = Date.now() - startedAt;
  const combined = Buffer.concat(chunks).toString("utf8");
  const interrupted = isAborted() && !exit.timedOut;
  const commandFailed = exit.timedOut || interrupted || exit.exitCode !== 0;
  const outputTail = commandFailed ? outputTailOf(combined) : null;

  if (exit.timedOut) {
    emit(`✖ ${label} ${entry.command} (timed out after ${formatDuration(durationMs)})`);
  } else if (interrupted) {
    emit(`✖ ${label} ${entry.command} (interrupted)`);
  } else if (exit.exitCode !== 0) {
    emit(`✖ ${label} ${entry.command} (${formatDuration(durationMs)}, exit ${exit.exitCode})`);
  } else {
    emit(`✔ ${label} ${entry.command} (${formatDuration(durationMs)})`);
  }
  if (outputTail) {
    for (const line of outputTail.split("\n")) {
      emit(`  ${line}`);
    }
    if (logFile) {
      emit(`  full log: ${logFile}`);
    }
  }

  return {
    result: {
      index,
      assertionKey: entry.assertionKey,
      assertionId: entry.assertionId,
      command: entry.command,
      exitCode: interrupted || exit.timedOut ? null : exit.exitCode,
      durationMs,
      timedOut: exit.timedOut,
      skipped: false,
      logFile,
      outputTail,
    },
  };
}

type ExitOutcome = {
  exitCode: number | null;
  timedOut: boolean;
};

function raceExitWithTimeout(
  proc: ShellProcess,
  timeoutMs: number,
  kill: (signal: NodeJS.Signals) => void,
): Promise<ExitOutcome> {
  return new Promise<ExitOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let termTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (termTimer) {
        clearTimeout(termTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ exitCode, timedOut });
    };

    proc.exited
      .then((code) => finish(typeof code === "number" ? code : null))
      .catch(() => finish(null));

    if (timeoutMs > 0) {
      termTimer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), TERM_GRACE_MS);
      }, timeoutMs);
    }
  });
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | null,
  chunks: Uint8Array[],
  logStream: WriteStream | null,
  live: boolean,
  prefix: string,
  emit: (line: string) => void,
): Promise<void> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      chunks.push(Buffer.from(value));
      logStream?.write(value);
      if (live) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          // A Windows child ends every line with CRLF; forwarding the CR verbatim corrupts the
          // rendered line. outputTailOf already normalizes, so live output matches it here.
          const text = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (text.trim().length > 0) {
            emit(`${prefix} ${text}`);
          }
        }
      }
    }
    if (live && buffer.trim().length > 0) {
      emit(`${prefix} ${buffer}`);
    }
  } catch {
    // A dead child stream must never fail the run; captured chunks up to here stay.
  }
}

function spawnShellCommand(command: string, cwd: string): ShellProcess {
  const base = shellArgv(command);
  const stdout = "pipe" as const;
  const stderr = "pipe" as const;
  const stdin = "ignore" as const;
  if (process.platform !== "win32" && Bun.which("setsid")) {
    return Bun.spawn({ cmd: ["setsid", ...base], cwd, stdin, stdout, stderr });
  }
  return Bun.spawn({ cmd: base, cwd, stdin, stdout, stderr });
}

function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  const shell = process.env.SHELL || "sh";
  return [shell, "-lc", command];
}

function killProcessTree(proc: ShellProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (typeof pid !== "number") {
    return;
  }
  const winArgv = treeKillArgv(pid);
  if (winArgv) {
    try {
      Bun.spawnSync({ cmd: winArgv, stdout: "ignore", stderr: "ignore" });
    } catch {
      // Best effort; the child is about to be reaped anyway.
    }
    return;
  }
  // -pid targets the whole process group (POSIX child leads one via setsid);
  // the direct pid is a belt-and-suspenders fallback for non-group spawns.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // The group or process may already be gone.
    }
  }
}

function skippedResult(entry: DeclaredCommand, index: number): CommandRunResult {
  return {
    index,
    assertionKey: entry.assertionKey,
    assertionId: entry.assertionId,
    command: entry.command,
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    skipped: true,
    logFile: null,
    outputTail: null,
  };
}

/**
 * Result for a command the referenced run already passed: the recorded exit code and duration
 * are kept verbatim, and the earlier log is copied into this run directory so retention pruning
 * of the referenced run can never take the evidence with it.
 */
function carriedResult(
  entry: DeclaredCommand,
  index: number,
  prior: RunMetaCommand,
  ref: string,
  runDir: string | null,
): CommandRunResult {
  return {
    index,
    assertionKey: entry.assertionKey,
    assertionId: entry.assertionId,
    command: entry.command,
    exitCode: prior.exitCode,
    durationMs: prior.durationMs,
    timedOut: false,
    skipped: false,
    logFile: carryLogFile(prior.logFile, index, entry.command, runDir),
    outputTail: null,
    resumedFrom: ref,
  };
}

/** Copies one earlier command log into the new run directory; falls back to the recorded path. */
function carryLogFile(priorLog: string | null, index: number, command: string, runDir: string | null): string | null {
  if (!priorLog || !runDir) {
    return priorLog;
  }
  const target = path.join(runDir, commandLogFileName(index, command));
  try {
    copyFileSync(priorLog, target);
    return target;
  } catch {
    return priorLog;
  }
}

function toMetaCommand(result: CommandRunResult): RunMetaCommand {
  return {
    index: result.index,
    assertionId: result.assertionId,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    skipped: result.skipped,
    logFile: result.logFile,
    ...(result.resumedFrom ? { resumedFrom: result.resumedFrom } : {}),
  };
}

function summaryLine(
  status: CommandRunSummary["status"],
  failedIndex: number,
  total: number,
  passed: number,
  totalMs: number,
): string {
  const totalLabel = `total ${formatDuration(totalMs)}`;
  if (status === "passed") {
    return `complete: ${passed}/${total} commands passed (${totalLabel})`;
  }
  if (status === "interrupted") {
    return `interrupted: command ${failedIndex} of ${total} aborted (${passed} passed, ${totalLabel})`;
  }
  if (status === "timeout") {
    return `stopped: command ${failedIndex} of ${total} timed out (${passed} passed, ${totalLabel})`;
  }
  return `stopped: command ${failedIndex} of ${total} failed (${passed} passed, ${totalLabel})`;
}

function defaultProgress(line: string): void {
  process.stderr.write(`[grace] ${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
