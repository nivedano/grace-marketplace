import { ANCHOR_PATTERNS } from "./types";
import type { ObservedWriteScope } from "./scope";
import type { GraceXmlNode } from "./xml";

/** Result of comparing two plan versions apart from their observed write scope. */
export type PlanComparison = {
  equal: boolean;
  sections: string[];
};

const OBSERVED_WRITE_SCOPE_TAG = "ObservedWriteScope";

/**
 * Compares two parsed GraceChangePlan roots, ignoring the ObservedWriteScope that is a direct child of the
 * C-* wrapper. Attributes compare order-insensitively and exactly; children compare in order. Text is
 * trimmed and its internal whitespace runs collapse to one space before comparing, because the parser does not
 * trim and plan XML is not mixed content, so formatting whitespace carries no meaning.
 *
 * sections lists the differing direct children of the wrapper by tag name, "wrapper" when the wrapper itself
 * (tag, attributes, text, or the order of the children both versions share) differs, even alongside other
 * differing sections, and "root" when the root differs.
 */
export function comparePlansIgnoringObservedScope(left: GraceXmlNode, right: GraceXmlNode): PlanComparison {
  const sections: string[] = [];
  const add = (section: string): void => {
    if (!sections.includes(section)) {
      sections.push(section);
    }
  };

  const leftWrapper = findWrapper(left);
  const rightWrapper = findWrapper(right);

  if (!sameAttributes(left.attributes, right.attributes) || left.tag !== right.tag || !sameText(left.text, right.text)) {
    add("root");
  }

  if (!leftWrapper || !rightWrapper) {
    if (leftWrapper || rightWrapper || !sameNodeList(left.children, right.children)) {
      add("root");
    }
    return { equal: sections.length === 0, sections };
  }

  const leftOthers = left.children.filter((child) => child !== leftWrapper);
  const rightOthers = right.children.filter((child) => child !== rightWrapper);
  if (!sameNodeList(leftOthers, rightOthers)) {
    add("root");
  }

  if (
    leftWrapper.tag !== rightWrapper.tag
    || !sameAttributes(leftWrapper.attributes, rightWrapper.attributes)
    || !sameText(leftWrapper.text, rightWrapper.text)
  ) {
    add("wrapper");
  }

  const leftChildren = withoutObservedScope(leftWrapper);
  const rightChildren = withoutObservedScope(rightWrapper);
  for (const tag of orderedTags(leftChildren, rightChildren)) {
    if (!sameNodeList(leftChildren.filter((child) => child.tag === tag), rightChildren.filter((child) => child.tag === tag))) {
      add(tag);
    }
  }
  // A reorder of the children both versions share is always reported, so it cannot hide behind another difference.
  if (!sameCommonOrder(leftChildren, rightChildren)) {
    add("wrapper");
  }

  return { equal: sections.length === 0, sections };
}

/** Plan sections that an approved plan may amend in place; every other section is a gate. */
export const AMENDABLE_PLAN_SECTIONS: readonly string[] = ["ImplementationPlan", "IntentSummary"];

/** Gate sections that the assertion and scope readers find at any depth of a plan. */
const NESTABLE_GATE_SECTIONS: readonly string[] = ["BaselineAssertions", "TargetAssertions", "DurableScope", "ObservedWriteScope"];

/**
 * Returns true when a non-empty list of differing sections, compared between plan roots left and right, names only
 * amendable sections and no such section holds a gate section at any depth in either version. Any other section,
 * including "root", "wrapper", "unparseable" and unknown tags, makes the difference a mutation.
 */
export function isPlanAmendment(sections: readonly string[], left: GraceXmlNode, right: GraceXmlNode): boolean {
  if (sections.length === 0 || !sections.every((section) => AMENDABLE_PLAN_SECTIONS.includes(section))) {
    return false;
  }
  const sectionNodes = [findWrapper(left), findWrapper(right)]
    .flatMap((wrapper) => wrapper?.children ?? [])
    .filter((child) => sections.includes(child.tag));
  return !sectionNodes.some((node) => node.children.some(holdsGateSection));
}

function holdsGateSection(node: GraceXmlNode): boolean {
  return NESTABLE_GATE_SECTIONS.includes(node.tag) || node.children.some(holdsGateSection);
}

/** Returns true when every file and every glob of narrower appears in wider by exact normalized string equality. */
export function scopeIsSuperset(wider: ObservedWriteScope, narrower: ObservedWriteScope): boolean {
  const files = new Set(wider.files);
  const globs = new Set(wider.globs);
  return narrower.files.every((file) => files.has(file)) && narrower.globs.every((glob) => globs.has(glob));
}

function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findWrapper(root: GraceXmlNode): GraceXmlNode | undefined {
  return root.children.find((child) => ANCHOR_PATTERNS.change.test(child.tag));
}

function withoutObservedScope(wrapper: GraceXmlNode): GraceXmlNode[] {
  const direct = wrapper.children.find((child) => child.tag === OBSERVED_WRITE_SCOPE_TAG);
  return wrapper.children.filter((child) => child !== direct);
}

function orderedTags(left: GraceXmlNode[], right: GraceXmlNode[]): string[] {
  return [...new Set([...left, ...right].map((child) => child.tag))];
}

/** Compares the tag order of the children whose tags appear in both lists. */
function sameCommonOrder(left: GraceXmlNode[], right: GraceXmlNode[]): boolean {
  const leftTags = new Set(left.map((child) => child.tag));
  const rightTags = new Set(right.map((child) => child.tag));
  const leftCommon = left.filter((child) => rightTags.has(child.tag));
  const rightCommon = right.filter((child) => leftTags.has(child.tag));
  return leftCommon.length === rightCommon.length && leftCommon.every((child, index) => child.tag === rightCommon[index]!.tag);
}

function sameAttributes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function sameNodeList(left: GraceXmlNode[], right: GraceXmlNode[]): boolean {
  return left.length === right.length && left.every((node, index) => sameNode(node, right[index]!));
}

function sameNode(left: GraceXmlNode, right: GraceXmlNode): boolean {
  return left.tag === right.tag
    && sameText(left.text, right.text)
    && sameAttributes(left.attributes, right.attributes)
    && sameNodeList(left.children, right.children);
}

/**
 * Returns true when two parsed artifact roots are equal apart from the root `status` attribute. Attributes compare
 * order-insensitively; children compare in order; text is trimmed and whitespace runs collapse, so CRLF and LF
 * copies of the same artifact are equal. Only the root's `status` is ignored, never a nested one.
 */
export function sameTreeIgnoringRootStatus(left: GraceXmlNode, right: GraceXmlNode): boolean {
  const withoutStatus = (attributes: Record<string, string>): Record<string, string> => {
    const { status: _status, ...rest } = attributes;
    return rest;
  };
  return left.tag === right.tag
    && sameText(left.text, right.text)
    && sameAttributes(withoutStatus(left.attributes), withoutStatus(right.attributes))
    && sameNodeList(left.children, right.children);
}
