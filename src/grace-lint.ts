#!/usr/bin/env bun

import { defineCommand, type CommandDef, runMain } from "citty";

import { CommandResumeRefusal } from "./grace4/command-runner";
import { formatLintExplanation, getLintIssueGuide } from "./lint/catalog";
import { formatTextReport, isValidTextFormat, lintGraceProject } from "./lint/core";
import type { LintAssertionMode, LintOptions, LintProfile, LintResult } from "./lint/types";
import { GraceCommandError, runGraceCommand } from "./query/errors";

export type {
  GraceLintConfig,
  LanguageAdapter,
  LanguageAnalysis,
  LintIssue,
  LintAssertionMode,
  LintOptions,
  LintProfile,
  LintResult,
  LintSeverity,
  MapMode,
  ModuleRole,
} from "./lint/types";

export { formatTextReport, lintGraceProject } from "./lint/core";

function writeResult(format: string, result: LintResult) {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatTextReport(result)}\n`);
}

function resolveProfile(value: unknown): LintProfile {
  const profile = String(value ?? "standard");
  if (profile !== "standard") {
    throw new GraceCommandError("invalid-arguments", `Unsupported profile \`${profile}\`. Use \`standard\`.`);
  }

  return "standard";
}

function resolveFailOn(value: unknown) {
  const failOn = String(value ?? "errors");
  if (failOn !== "errors" && failOn !== "warnings" && failOn !== "never") {
    throw new GraceCommandError("invalid-arguments", `Unsupported fail-on policy \`${failOn}\`. Use \`errors\`, \`warnings\`, or \`never\`.`);
  }

  return failOn;
}

function resolveAssertionMode(value: unknown): LintAssertionMode {
  const mode = String(value ?? "current");
  if (mode !== "current" && mode !== "baseline" && mode !== "target" && mode !== "final") {
    throw new GraceCommandError("invalid-arguments", `Unsupported assertion mode \`${mode}\`. Use \`current\`, \`baseline\`, \`target\`, or \`final\`.`);
  }
  return mode;
}

function shouldFail(result: LintResult, failOn: string) {
  if (failOn === "never") {
    return false;
  }

  if (failOn === "warnings") {
    return result.summary.issues > 0;
  }

  return result.summary.errors > 0;
}

export const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description: "Lint GRACE artifacts, XML tag conventions, semantic markup, and role-aware module maps.",
  },
  args: {
    path: {
      type: "string",
      alias: "p",
      description: "Project root to lint",
      default: ".",
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format: text or json",
      default: "text",
    },
    profile: {
      type: "string",
      description: "Lint profile (currently only \`standard\` is supported)",
      default: "standard",
    },
    explain: {
      type: "string",
      description: "Explain one lint issue code instead of linting a project",
    },
    remediate: {
      type: "boolean",
      description: "Include explanation and remediation hints in text output",
      default: false,
    },
    failOn: {
      type: "string",
      description: "Exit policy: errors, warnings, or never",
      default: "errors",
    },
    change: {
      type: "string",
      description: "Active C-* bundle selected for baseline or target assertion evaluation",
    },
    assertions: {
      type: "string",
      description: "Assertion mode: current (pre-write active baselines), baseline, target, or final",
      default: "current",
    },
    runCommands: {
      type: "boolean",
      description: "Execute MustPassCommand assertions for the selected change",
      default: false,
    },
    commandTimeout: {
      type: "string",
      description: "Per-command timeout in seconds for --run-commands (default 600, 0 disables)",
      default: "600",
    },
    onlyFailed: {
      type: "string",
      description: "Re-run only the commands a previous run did not pass: a run directory name, an absolute run path, or `last`",
    },
    continueOnFailure: {
      type: "boolean",
      description: "Run every declared command in --run-commands instead of skipping the rest after a failure",
      default: false,
    },
    verbose: {
      type: "boolean",
      description: "Stream full command output in --run-commands (forces live mode)",
      default: false,
    },
    quiet: {
      type: "boolean",
      description: "Suppress streamed command output in --run-commands (forces compact mode)",
      default: false,
    },
    parallelPreflight: {
      type: "boolean",
      description: "Treat active-plan scope overlap as a parallel-execution blocker",
      default: false,
    },
  },
  async run(context) {
    const errorFormat = context.args.format === "json" ? "json" : "text";
    await runGraceCommand(errorFormat, async () => {
      const format = String(context.args.format ?? "text");
      const profile = resolveProfile(context.args.profile);
      const failOn = resolveFailOn(context.args.failOn);
      const assertionMode = resolveAssertionMode(context.args.assertions);
      if (!isValidTextFormat(format)) {
        throw new GraceCommandError("invalid-arguments", `Unsupported format \`${format}\`. Use \`text\` or \`json\`.`);
      }

      if (context.args.explain) {
        const code = String(context.args.explain);
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0.0", tool: "grace-lint", guide: getLintIssueGuide(code) }, null, 2)}\n`);
          return;
        }

        process.stdout.write(`${formatLintExplanation(code)}\n`);
        return;
      }

      const verbose = Boolean(context.args.verbose);
      const quiet = Boolean(context.args.quiet);
      const timeoutMs = parseCommandTimeoutMs(context.args.commandTimeout);
      const resume = resolveCommandResumeOptions({
        runCommands: Boolean(context.args.runCommands),
        onlyFailed: context.args.onlyFailed,
        continueOnFailure: Boolean(context.args.continueOnFailure),
      });
      const verbosity = resolveCommandVerbosity({
        format,
        verbose,
        quiet,
        interactive: Boolean(process.stdout.isTTY && process.stderr.isTTY),
      });

      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      try {
        const result = await lintGraceProject(String(context.args.path ?? "."), {
          profile,
          assertionMode,
          changeId: context.args.change ? String(context.args.change) : undefined,
          runCommands: Boolean(context.args.runCommands),
          parallelPreflight: Boolean(context.args.parallelPreflight),
          commandTimeoutMs: timeoutMs,
          commandVerbosity: verbosity,
          commandOnlyFailed: resume.onlyFailed,
          commandContinueOnFailure: resume.continueOnFailure,
          commandSignal: controller.signal,
        }).catch((error) => {
          // The runner refuses a resume it cannot prove safe; the CLI is where that becomes a
          // rendered invalid-arguments failure instead of the generic lint fallback message.
          if (error instanceof CommandResumeRefusal) {
            throw new GraceCommandError("invalid-arguments", error.message);
          }
          throw error;
        });

        if (format === "json") {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatTextReport(result, { remediate: Boolean(context.args.remediate) })}\n`);
        }
        if (controller.signal.aborted) {
          process.exitCode = 130;
        } else {
          process.exitCode = shouldFail(result, failOn) ? 1 : 0;
        }
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    }, "Unable to complete GRACE lint. Check the project path and run again.");
  },
});

/** Parses --command-timeout seconds into ms; rejects negative and non-integer values. */
export function parseCommandTimeoutMs(value: unknown): number {
  const raw = String(value ?? "600");
  if (!/^\d+$/.test(raw)) {
    throw new GraceCommandError("invalid-arguments", `Unsupported --command-timeout \`${raw}\`. Use a non-negative integer number of seconds.`);
  }
  return Number(raw) * 1000;
}

/** Resolved `--only-failed` / `--continue-on-failure` selection for one lint invocation. */
export type CommandResumeOptions = {
  onlyFailed?: string;
  continueOnFailure: boolean;
};

/**
 * Validates the gate-resume flags: both are meaningless without `--run-commands`, and an empty
 * `--only-failed` value cannot name a run. Resolution of the reference itself belongs to the
 * runner, which is the only layer that knows the declared command set it must match.
 */
export function resolveCommandResumeOptions(input: {
  runCommands: boolean;
  onlyFailed?: unknown;
  continueOnFailure: boolean;
}): CommandResumeOptions {
  const onlyFailed = input.onlyFailed === undefined || input.onlyFailed === null ? undefined : String(input.onlyFailed).trim();
  if (onlyFailed !== undefined && onlyFailed.length === 0) {
    throw new GraceCommandError("invalid-arguments", "`--only-failed` needs a run directory name, an absolute run path, or `last`.");
  }
  if (onlyFailed !== undefined && !input.runCommands) {
    throw new GraceCommandError("invalid-arguments", "`--only-failed` requires `--run-commands`.");
  }
  if (input.continueOnFailure && !input.runCommands) {
    throw new GraceCommandError("invalid-arguments", "`--continue-on-failure` requires `--run-commands`.");
  }
  return { onlyFailed, continueOnFailure: input.continueOnFailure };
}

/** Input for resolving the --run-commands output verbosity. */
export type CommandVerbosityInput = {
  format: string;
  verbose: boolean;
  quiet: boolean;
  /** True when both stdout and stderr are interactive TTYs. */
  interactive: boolean;
};

/**
 * Resolves run-commands verbosity: json output is always compact; --verbose forces live;
 * --quiet forces compact; otherwise live only for interactive terminals. Rejects the
 * mutually exclusive --verbose/--quiet combination.
 */
export function resolveCommandVerbosity(input: CommandVerbosityInput): "compact" | "live" {
  if (input.verbose && input.quiet) {
    throw new GraceCommandError("invalid-arguments", "`--verbose` and `--quiet` are mutually exclusive.");
  }
  if (input.format === "json" || input.quiet) {
    return "compact";
  }
  if (input.verbose || input.interactive) {
    return "live";
  }
  return "compact";
}

if (import.meta.main) {
  await runMain(lintCommand as CommandDef);
}
