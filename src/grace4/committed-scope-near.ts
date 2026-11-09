import { readdirSync } from "node:fs";
import path from "node:path";

import { defaultCaseSensitivity, type ObservedWriteScope } from "./scope";

const MANIFEST_NAMES = new Set(["package.json", "CMakeLists.txt", "pyproject.toml", "Cargo.toml", "go.mod", "idf_component.yml"]);
const MANIFEST_EXTENSIONS = [".csproj", ".fsproj"];

/** Compares project-relative paths with the platform case rule that observedWriteScopeContains uses. */
export class PathRule {
  readonly caseSensitive = defaultCaseSensitivity();

  key(value: string): string {
    return this.caseSensitive ? value : value.toLocaleLowerCase();
  }

  equal(left: string, right: string): boolean {
    return this.key(left) === this.key(right);
  }

  /** True when value is directory itself or lies below it. An empty directory is the project root. */
  within(value: string, directory: string): boolean {
    if (directory === "") {
      return true;
    }
    const folded = this.key(value);
    const base = this.key(directory);
    return folded === base || folded.startsWith(`${base}/`);
  }
}

/** Parent directory of a project-relative path; "" for a file at the project root. */
export function parentDirectory(file: string): string {
  const index = file.lastIndexOf("/");
  return index < 0 ? "" : file.slice(0, index);
}

/** The literal segments of a Glob before its first wildcard segment, joined; "" when the first segment is a wildcard. */
export function globLiteralPrefix(glob: string): string {
  const literal: string[] = [];
  for (const segment of glob.split("/")) {
    if (/[*?]/.test(segment)) {
      break;
    }
    literal.push(segment);
  }
  return literal.join("/");
}

/**
 * Resolves package roots on the filesystem: the nearest ancestor directory below the project root that holds a
 * manifest. The project root itself never counts. Directory listings and answers are cached for one run.
 */
export class PackageRoots {
  private readonly manifests = new Map<string, boolean>();
  private readonly roots = new Map<string, string | null>();

  constructor(private readonly projectRoot: string) {}

  /** Package root of a project-relative directory, the directory itself included; null when there is none. */
  rootOf(directory: string): string | null {
    const cached = this.roots.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    let found: string | null = null;
    for (let current = directory; current !== ""; current = parentDirectory(current)) {
      if (this.hasManifest(current)) {
        found = current;
        break;
      }
    }
    this.roots.set(directory, found);
    return found;
  }

  private hasManifest(directory: string): boolean {
    const cached = this.manifests.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    let names: string[] = [];
    try {
      names = readdirSync(path.join(this.projectRoot, ...directory.split("/")));
    } catch {
      names = [];
    }
    const found = names.some((name) => MANIFEST_NAMES.has(name) || MANIFEST_EXTENSIONS.some((extension) => name.endsWith(extension)));
    this.manifests.set(directory, found);
    return found;
  }
}

/** Labels widened files near or far from an approved scope by the directory rule and the package rule. */
export class NearFar {
  private readonly fileDirectories: string[];
  private readonly globPrefixes: string[];
  private readonly packages = new Set<string>();

  constructor(
    approvedScope: ObservedWriteScope,
    private readonly roots: PackageRoots,
    private readonly rule: PathRule,
  ) {
    this.fileDirectories = approvedScope.files.map(parentDirectory);
    this.globPrefixes = approvedScope.globs.map(globLiteralPrefix).filter((prefix) => prefix !== "");
    for (const directory of [...this.fileDirectories, ...this.globPrefixes]) {
      const packageRoot = roots.rootOf(directory);
      if (packageRoot !== null) {
        this.packages.add(rule.key(packageRoot));
      }
    }
  }

  isNear(file: string): boolean {
    const directory = parentDirectory(file);
    if (this.fileDirectories.some((approved) => this.rule.equal(approved, directory))) {
      return true;
    }
    if (this.globPrefixes.some((prefix) => this.rule.within(directory, prefix))) {
      return true;
    }
    const packageRoot = this.roots.rootOf(directory);
    return packageRoot !== null && this.packages.has(this.rule.key(packageRoot));
  }
}
