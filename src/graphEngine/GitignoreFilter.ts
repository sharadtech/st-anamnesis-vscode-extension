import fs from 'fs/promises';
import path from 'path';
import ignore, { type Ignore } from 'ignore';

/**
 * Applies the project root .gitignore while walking a repo for graph extraction.
 */
export class GitignoreFilter {
  private readonly ig: Ignore;
  private readonly hasRules: boolean;

  private constructor(ig: Ignore, hasRules: boolean) {
    this.ig = ig;
    this.hasRules = hasRules;
  }

  static async create(repoRoot: string): Promise<GitignoreFilter> {
    const ig = ignore();
    let hasRules = false;
    try {
      const content = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf-8');
      ig.add(content);
      hasRules = content.trim().length > 0;
    } catch {
      // No root .gitignore — fall back to built-in skip dirs / excludeGlobs only.
    }
    return new GitignoreFilter(ig, hasRules);
  }

  /** True when the path should be skipped (file or directory). */
  isIgnored(relativePath: string): boolean {
    if (!this.hasRules) {
      return false;
    }
    const normalized = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized || normalized === '.') {
      return false;
    }
    return this.ig.ignores(normalized);
  }

  /** True when a directory should not be descended into. */
  isIgnoredDirectory(relativeDir: string): boolean {
    const normalized = relativeDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized) {
      return false;
    }
    return this.isIgnored(normalized) || this.isIgnored(`${normalized}/`);
  }
}
