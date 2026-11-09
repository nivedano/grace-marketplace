import { describe, expect, it } from "bun:test";

import { comparePlansIgnoringObservedScope, scopeIsSuperset } from "./plan-compare";
import { parseGraceXmlArtifact, type GraceXmlNode } from "./xml";

function parse(xml: string): GraceXmlNode {
  const parsed = parseGraceXmlArtifact("plan.xml", xml);
  if (!parsed.root) {
    throw new Error(`fixture does not parse: ${xml}`);
  }
  return parsed.root;
}

function plan(body: { assertions?: string; implementation?: string; durable?: string; observed?: string; rootAttributes?: string } = {}): string {
  const attributes = body.rootAttributes ?? `graceVersion="4.0" status="approved"`;
  return `<GraceChangePlan ${attributes}><C-ONE>`
    + `<TargetAssertions>${body.assertions ?? "<A-1>one</A-1>"}</TargetAssertions>`
    + `<ImplementationPlan>${body.implementation ?? "<T-001>first</T-001>"}</ImplementationPlan>`
    + `<DurableScope>${body.durable ?? "<GraphAnchors><M-ONE /></GraphAnchors>"}</DurableScope>`
    + `<ObservedWriteScope>${body.observed ?? "<File>src/a.ts</File>"}</ObservedWriteScope>`
    + `</C-ONE></GraceChangePlan>`;
}

describe("comparePlansIgnoringObservedScope", () => {
  it("equal when only ObservedWriteScope differs", () => {
    const left = parse(plan());
    const right = parse(plan({ observed: "<File>src/a.ts</File><File>src/b.ts</File><Glob>docs/**</Glob>" }));
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: true, sections: [] });
  });

  it("ignores an ObservedWriteScope nested inside a task but not the wrapper's direct one", () => {
    const left = parse(plan({ implementation: "<T-001>first<ObservedWriteScope><File>x.ts</File></ObservedWriteScope></T-001>" }));
    const right = parse(plan({ implementation: "<T-001>first<ObservedWriteScope><File>y.ts</File></ObservedWriteScope></T-001>" }));
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: false, sections: ["ImplementationPlan"] });
  });

  it("reports TargetAssertions, ImplementationPlan and DurableScope differences by section name", () => {
    const left = parse(plan());
    expect(comparePlansIgnoringObservedScope(left, parse(plan({ assertions: "<A-1>changed</A-1>" })))).toEqual({
      equal: false,
      sections: ["TargetAssertions"],
    });
    expect(comparePlansIgnoringObservedScope(left, parse(plan({ implementation: "<T-001>first</T-001><T-002>second</T-002>" })))).toEqual({
      equal: false,
      sections: ["ImplementationPlan"],
    });
    expect(comparePlansIgnoringObservedScope(left, parse(plan({ durable: "<GraphAnchors><M-TWO /></GraphAnchors>" })))).toEqual({
      equal: false,
      sections: ["DurableScope"],
    });
    expect(comparePlansIgnoringObservedScope(left, parse(plan({
      assertions: "<A-1>changed</A-1>",
      durable: "<None />",
      observed: "<File>src/z.ts</File>",
    })))).toEqual({ equal: false, sections: ["TargetAssertions", "DurableScope"] });
  });

  it("reports root attribute differences as root", () => {
    const left = parse(plan());
    const right = parse(plan({ rootAttributes: `graceVersion="4.0" status="draft"` }));
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: false, sections: ["root"] });
  });

  it("reports a differing wrapper tag as wrapper", () => {
    const left = parse(plan());
    const right = parse(plan().replaceAll("C-ONE", "C-TWO"));
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: false, sections: ["wrapper"] });
  });

  it("ignores attribute order", () => {
    const left = parse(plan({ rootAttributes: `graceVersion="4.0" status="approved"`, assertions: `<A-1 id="x" kind="y">one</A-1>` }));
    const right = parse(plan({ rootAttributes: `status="approved" graceVersion="4.0"`, assertions: `<A-1 kind="y" id="x">one</A-1>` }));
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: true, sections: [] });
  });

  it("compares children in order", () => {
    const left = parse(plan({ implementation: "<T-001>a</T-001><T-002>b</T-002>" }));
    const right = parse(plan({ implementation: "<T-002>b</T-002><T-001>a</T-001>" }));
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: false, sections: ["ImplementationPlan"] });
  });

  // The parser runs with trimValues disabled, so whitespace-only text survives in
  // GraceXmlNode.text. The comparator compares text exactly, which makes a
  // reformatted plan unequal: a fail-safe inequality, not a silent pass.
  it("treats whitespace-only text differences as unequal because the parser does not trim", () => {
    const compact = parse(plan());
    const spaced = parse(plan().replaceAll("><", ">\n  <"));
    expect(comparePlansIgnoringObservedScope(compact, spaced).equal).toBe(false);
  });

  it("treats a plan with no wrapper like any other tree and reports root", () => {
    const left = parse(`<GraceChangePlan status="approved"><Other>a</Other></GraceChangePlan>`);
    const right = parse(`<GraceChangePlan status="approved"><Other>b</Other></GraceChangePlan>`);
    expect(comparePlansIgnoringObservedScope(left, right)).toEqual({ equal: false, sections: ["root"] });
    expect(comparePlansIgnoringObservedScope(left, left)).toEqual({ equal: true, sections: [] });
  });
});

describe("scopeIsSuperset", () => {
  it("true for added File, false for removed Glob", () => {
    const base = { files: ["src/a.ts"], globs: ["docs/**"] };
    expect(scopeIsSuperset({ files: ["src/a.ts", "src/b.ts"], globs: ["docs/**"] }, base)).toBe(true);
    expect(scopeIsSuperset({ files: ["src/a.ts"], globs: [] }, base)).toBe(false);
    expect(scopeIsSuperset(base, base)).toBe(true);
    expect(scopeIsSuperset(base, { files: [], globs: [] })).toBe(true);
  });

  it("uses exact string equality for globs, not containment", () => {
    expect(scopeIsSuperset({ files: [], globs: ["src/**"] }, { files: [], globs: ["src/a/**"] })).toBe(false);
  });
});
