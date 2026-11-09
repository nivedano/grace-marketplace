import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs git in a fixture repository and returns its trimmed stdout; throws with stderr on failure. */
export function fixtureGit(root: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString("utf8")}`);
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

/** Creates an empty git repository in a temporary directory with identity configured, signing off and hooks disabled. */
export function createRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grace-git-fixture-"));
  fixtureGit(root, ["init", "--quiet"]);
  fixtureGit(root, ["config", "user.email", "grace@example.test"]);
  fixtureGit(root, ["config", "user.name", "GRACE Test"]);
  fixtureGit(root, ["config", "commit.gpgsign", "false"]);
  fixtureGit(root, ["config", "core.hooksPath", "disabled-hooks"]);
  fixtureGit(root, ["config", "core.autocrlf", "false"]);
  return root;
}

/** Writes (string) or deletes (null) project-relative files, commits everything, and returns the new commit hash. */
export function commit(root: string, files: Record<string, string | null>, message: string): string {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, ...relativePath.split("/"));
    if (contents === null) {
      rmSync(filePath, { force: true });
    } else {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, contents);
    }
  }
  fixtureGit(root, ["add", "--all"]);
  fixtureGit(root, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}

/**
 * Returns GraceChangePlan XML. Scope entries containing a glob metacharacter become Glob, others File; an empty
 * scope becomes None. extra replaces the TargetAssertions body, the ImplementationPlan body or the DurableScope body.
 */
export function plan(
  changeId: string,
  status: string,
  scope: string[],
  extra: { tasks?: string; target?: string; durable?: string } = {},
): string {
  const observed = scope.length === 0
    ? "<None />"
    : scope.map((entry) => (/[*?[]/.test(entry) ? `<Glob>${entry}</Glob>` : `<File>${entry}</File>`)).join("\n      ");
  const target = extra.target ?? "<MustVerify><Module>M-EXAMPLE</Module></MustVerify>";
  const tasks = extra.tasks
    ?? "<T-001><Title>Apply fixture change</Title><DependsOn></DependsOn><AcceptanceCriteria><Criterion>The fixture remains valid.</Criterion></AcceptanceCriteria><Verification><Command>bun test</Command></Verification></T-001>";
  const durable = extra.durable ?? "<GraphAnchors><M-EXAMPLE /></GraphAnchors>";
  return `<GraceChangePlan graceVersion="4.0" status="${status}">
  <${changeId}>
    <IntentSummary>Apply the fixture change.</IntentSummary>
    <BaselineAssertions><MustExist><Value>M-EXAMPLE</Value></MustExist></BaselineAssertions>
    <TargetAssertions>${target}</TargetAssertions>
    <DurableScope>${durable}</DurableScope>
    <ObservedWriteScope>
      ${observed}
    </ObservedWriteScope>
    <ImplementationPlan>${tasks}</ImplementationPlan>
  </${changeId}>
</GraceChangePlan>
`;
}

/** Returns minimal GraceChangeSpec XML with the given root status. */
export function spec(changeId: string, status: string): string {
  return `<GraceChangeSpec graceVersion="4.0" status="${status}"><${changeId}><Summary>Fixture change.</Summary></${changeId}></GraceChangeSpec>
`;
}
