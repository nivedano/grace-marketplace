import { describe, expect, it } from "bun:test";

import { entryOfScenarioId, findScenarioTokens, scenarioIdMatchesEntry } from "./scenario-ids";

describe("scenario ids", () => {
  it("matches at sentence end, in strings and in spaced comments", () => {
    expect(findScenarioTokens("Covers SC-FW-MAIN-002.")).toEqual(["SC-FW-MAIN-002"]);
    expect(findScenarioTokens(`it("SC-FW-MAIN-002 boots", () => {})`)).toEqual(["SC-FW-MAIN-002"]);
    expect(findScenarioTokens("// SC-FW-MAIN-002")).toEqual(["SC-FW-MAIN-002"]);
    expect(findScenarioTokens("# SC-FW-MAIN-002: boot\n# (SC-FW-MAIN-003)")).toEqual(["SC-FW-MAIN-002", "SC-FW-MAIN-003"]);
    expect(findScenarioTokens("SC-FW-MAIN-002, SC-FW-MAIN-003")).toEqual(["SC-FW-MAIN-002", "SC-FW-MAIN-003"]);
  });

  it("rejects -0021, _x, .cs, -boot and <!--SC-…-->", () => {
    expect(findScenarioTokens("SC-FW-MAIN-0021")).toEqual([]);
    expect(findScenarioTokens("SC-FW-MAIN-002_x")).toEqual([]);
    expect(findScenarioTokens("SC-FW-MAIN-002.cs")).toEqual([]);
    expect(findScenarioTokens("SC-FW-MAIN-002-boot")).toEqual([]);
    expect(findScenarioTokens("<!--SC-FW-MAIN-002-->")).toEqual([]);
    expect(findScenarioTokens("xSC-FW-MAIN-002")).toEqual([]);
    expect(findScenarioTokens("a.SC-FW-MAIN-002")).toEqual([]);
  });

  it("parses SC-X-001-002 as entry V-M-X-001", () => {
    expect(findScenarioTokens("SC-X-001-002")).toEqual(["SC-X-001-002"]);
    expect(entryOfScenarioId("SC-X-001-002")).toBe("V-M-X-001");
    expect(scenarioIdMatchesEntry("SC-X-001-002", "V-M-X-001")).toBe(true);
    expect(scenarioIdMatchesEntry("SC-X-001-002", "V-M-X")).toBe(false);
  });

  it("derives the entry without moduleIdForVerification semantics", () => {
    expect(entryOfScenarioId("SC-FW-MAIN-002")).toBe("V-M-FW-MAIN");
    expect(scenarioIdMatchesEntry("SC-FW-MAIN-002", "V-M-FW-MAIN")).toBe(true);
  });

  it("matches ids after a BOM and across CRLF", () => {
    expect(findScenarioTokens("\uFEFFSC-FW-MAIN-002 boots\r\nSC-FW-MAIN-003\r\n")).toEqual(["SC-FW-MAIN-002", "SC-FW-MAIN-003"]);
  });

  it("returns a fresh result on repeated calls (global regex state)", () => {
    expect(findScenarioTokens("SC-A-001")).toEqual(["SC-A-001"]);
    expect(findScenarioTokens("SC-A-001")).toEqual(["SC-A-001"]);
  });
});
