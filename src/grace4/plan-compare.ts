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
 * C-* wrapper. Attributes compare order-insensitively; children and text compare in order. Text is compared
 * exactly, because the parser does not trim, so whitespace-only changes count as differences.
 *
 * sections lists the differing direct children of the wrapper by tag name, "wrapper" when the wrapper itself
 * (tag, attributes, text, or the order of its children) differs, and "root" when the root differs.
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

  if (!sameAttributes(left.attributes, right.attributes) || left.tag !== right.tag || left.text !== right.text) {
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
    || leftWrapper.text !== rightWrapper.text
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
  if (sections.length === 0 && !sameTagSequence(leftChildren, rightChildren)) {
    add("wrapper");
  }

  return { equal: sections.length === 0, sections };
}

/** Returns true when every file and every glob of narrower appears in wider by exact normalized string equality. */
export function scopeIsSuperset(wider: ObservedWriteScope, narrower: ObservedWriteScope): boolean {
  const files = new Set(wider.files);
  const globs = new Set(wider.globs);
  return narrower.files.every((file) => files.has(file)) && narrower.globs.every((glob) => globs.has(glob));
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

function sameTagSequence(left: GraceXmlNode[], right: GraceXmlNode[]): boolean {
  return left.length === right.length && left.every((child, index) => child.tag === right[index]!.tag);
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
    && left.text === right.text
    && sameAttributes(left.attributes, right.attributes)
    && sameNodeList(left.children, right.children);
}
