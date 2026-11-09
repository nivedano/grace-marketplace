/**
 * Scenario evidence: which `SC-*` scenarios are referenced from scanned files, plus the three
 * `verification.scenario-*` lint codes. A missing id or missing evidence is never a lint issue;
 * it appears only in the status report.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { inspectEntryScenarios, type ScenarioRecord, type VerificationProjection } from "./projections";
import { entryOfScenarioId, findScenarioTokens, scenarioIdMatchesEntry } from "./scenario-ids";
import type { Grace4Issue } from "./types";
import { readGraceXmlArtifact } from "./xml";

export type { ScenarioRecord } from "./projections";

/** Evidence state of one scenario. */
export type ScenarioEvidenceState = "executable" | "manualOnly" | "unproven" | "legacy";

/** Project-wide scenario evidence totals and the per-entry breakdown. */
export type ScenarioEvidenceReport = {
  totals: { scenarios: number; executable: number; manualOnly: number; unproven: number; legacy: number };
  entries: { id: string; scenarios: (ScenarioRecord & { state: ScenarioEvidenceState })[] }[];
};

/**
 * Scans `files` plus every entry's `<TestFiles>` (minus any path with a segment starting with `.`)
 * for `SC-*` tokens, classifies every scenario, and returns the duplicate-id, invalid-id and
 * dangling-reference issues.
 */
export function collectScenarioEvidence(
  root: string,
  verification: VerificationProjection,
  files: string[],
): { report: ScenarioEvidenceReport; issues: Grace4Issue[] } {
  const issues: Grace4Issue[] = [];
  const references = scanReferences(verification, scanTargets(root, verification, files), issues);
  const entries = [...verification.entries.values()].sort((left, right) => left.id.localeCompare(right.id));

  const report: ScenarioEvidenceReport = {
    totals: { scenarios: 0, executable: 0, manualOnly: 0, unproven: 0, legacy: 0 },
    entries: entries.map((entry) => ({
      id: entry.id,
      scenarios: entry.scenarioRecords.map((record) => ({ ...record, state: stateOf(record, references) })),
    })),
  };
  for (const scenario of report.entries.flatMap((entry) => entry.scenarios)) {
    report.totals.scenarios += 1;
    report.totals[scenario.state] += 1;
  }

  issues.push(...duplicateIdIssues(verification), ...invalidIdIssues(verification));
  return { report, issues };
}

function stateOf(record: ScenarioRecord, references: ReadonlySet<string>): ScenarioEvidenceState {
  if (!record.id) return "legacy";
  if (references.has(record.id)) return "executable";
  return record.manualEvidence ? "manualOnly" : "unproven";
}

/** Code files plus `<TestFiles>`, deduplicated, without dot-segment paths. */
function scanTargets(root: string, verification: VerificationProjection, files: string[]): string[] {
  const testFiles = [...verification.entries.values()].flatMap((entry) => entry.testFiles);
  const targets = new Set<string>();
  for (const file of [...files, ...testFiles]) {
    const absolute = path.resolve(root, file);
    if (!hasDotSegment(path.relative(root, absolute))) {
      targets.add(absolute);
    }
  }
  return [...targets];
}

function hasDotSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => segment.startsWith("."));
}

/**
 * Collects every token found in `files`. A token whose entry part names an existing entry
 * that has no scenario with that id is a dangling reference; any other unknown token is ignored.
 */
function scanReferences(verification: VerificationProjection, files: string[], issues: Grace4Issue[]): Set<string> {
  const references = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Every token starts with "SC-", so a file without it has nothing to split or scan.
    if (!text.includes("SC-")) continue;
    const reported = new Set<string>();
    text.split("\n").forEach((line, index) => {
      for (const token of findScenarioTokens(line)) {
        references.add(token);
        const entryId = entryOfScenarioId(token);
        const entry = verification.entries.get(entryId);
        if (!entry || entry.scenarioRecords.some((record) => record.id === token) || reported.has(token)) {
          continue;
        }
        reported.add(token);
        issues.push({
          severity: "error",
          code: "verification.scenario-dangling-reference",
          file,
          line: index + 1,
          message: `${token} names ${entryId}, which has no scenario with that id.`,
        });
      }
    });
  }
  return references;
}

function duplicateIdIssues(verification: VerificationProjection): Grace4Issue[] {
  const firstOwner = new Map<string, string>();
  const issues: Grace4Issue[] = [];
  for (const entry of verification.entries.values()) {
    for (const record of entry.scenarioRecords) {
      if (!record.id) continue;
      const owner = firstOwner.get(record.id);
      if (owner === undefined) {
        firstOwner.set(record.id, entry.id);
        continue;
      }
      issues.push({
        severity: "error",
        code: "verification.scenario-duplicate-id",
        file: entry.file,
        message: `${record.id} appears on more than one scenario (${owner === entry.id ? entry.id : `${owner} and ${entry.id}`}).`,
      });
    }
  }
  return issues;
}

/** Re-reads each routed verification document to see every SC-* element a `<Scenario>` carries. */
function invalidIdIssues(verification: VerificationProjection): Grace4Issue[] {
  const issues: Grace4Issue[] = [];
  const seen = new Set<string>();
  for (const [owner, file] of verification.documents) {
    const wrapper = readGraceXmlArtifact(file).root?.children.find((child) => child.tag === owner);
    for (const node of wrapper?.children ?? []) {
      const entry = verification.entries.get(node.tag);
      if (!entry || entry.owner !== owner || seen.has(entry.id)) continue;
      seen.add(entry.id);
      for (const { record, idElements } of inspectEntryScenarios(node)) {
        const invalid = (message: string) => issues.push({ severity: "error", code: "verification.scenario-invalid-id", file, message });
        idElements.forEach((element, index) => {
          if (index > 0) {
            invalid(`A <Scenario> in ${entry.id} has a second id element <${element.tag}>; a scenario carries exactly one id.`);
          } else if (!element.wellFormed) {
            invalid(`A <Scenario> in ${entry.id} has a malformed id element <${element.tag}>; expected one empty, attribute-free SC-<entry>-NNN tag.`);
          }
        });
        if (record.id && !scenarioIdMatchesEntry(record.id, entry.id)) {
          invalid(`${record.id} sits in ${entry.id}, but its entry part names ${entryOfScenarioId(record.id)}.`);
        }
      }
    }
  }
  return issues;
}
