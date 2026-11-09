/**
 * Scenario ids: `SC-<entry>-NNN`, where `<entry>` is the enclosing `V-M-*` id without the `V-M-` prefix.
 * The number is always the last segment; everything between `SC-` and it is the entry.
 */

/** Global matcher for scenario id tokens in free text. Callers must use `findScenarioTokens`, which resets state. */
export const SCENARIO_TOKEN: RegExp =
  /(?<![A-Za-z0-9_.-])SC-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}(?![A-Za-z0-9_-])(?!\.[A-Za-z0-9])/g;

/** Returns every scenario id token in `text`, in order of appearance. */
export function findScenarioTokens(text: string): string[] {
  SCENARIO_TOKEN.lastIndex = 0;
  const tokens = text.match(SCENARIO_TOKEN) ?? [];
  SCENARIO_TOKEN.lastIndex = 0;
  return tokens;
}

/** `SC-FW-MAIN-002` -> `V-M-FW-MAIN`. Deliberately not `moduleIdForVerification`, which strips only `V-`. */
export function entryOfScenarioId(id: string): string {
  return `V-M-${id.slice("SC-".length, id.length - "-NNN".length)}`;
}

/** True when the id's entry part names `entryId`. */
export function scenarioIdMatchesEntry(id: string, entryId: string): boolean {
  return entryOfScenarioId(id) === entryId;
}
