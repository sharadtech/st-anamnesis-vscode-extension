import fs from 'fs/promises';
import path from 'path';
import ignore, { type Ignore } from 'ignore';

/**
 * Applies the project root .gitignore while walking a repo for graph extraction.
 */
export class GitignoreFilter {
  private readonly ig: Ignore;

  private constructor(ig: Ignore) {
    this.ig = ig;
  }

  static async create(repoRoot: string): Promise<GitignoreFilter> {
    const ig = ignore();
    try {
      const content = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf-8');
      ig.add(content);
    } catch {
      // No root .gitignore — fall back to built-in skip dirs / excludeGlobs only.
    }
    return new GitignoreFilter(ig);
  }

  /** True when the path should be skipped (file or directory). */
  isIgnored(relativePath: string): boolean {
    if (this.ig.length === 0) {
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
