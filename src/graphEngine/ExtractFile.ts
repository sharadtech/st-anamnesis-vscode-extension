import fs from 'fs/promises';
import path from 'path';
import { globalExtractorRegistry, type Extractor, type ExtractorContext, type ExtractionResult } from './Extractor';
import type { GitignoreFilter } from './GitignoreFilter';
import { isApacheConfig } from './extractors/ApacheConf';
import { isLikelyShellScript } from './extractors/Bash';
import { isJenkinsPipelineFile } from './extractors/Jenkins';
import { isMavenPomFile } from './extractors/Maven';
import { isHtlFile } from './extractors/Htl';
import { isAemContentXmlFile } from './extractors/AemContentXml';
import { isNginxConfig } from './extractors/NginxConf';

export interface ExtractFileOptions {
  repoRoot: string;
  filePath: string;
  filesToExclude?: string[];
  gitignoreFilter?: GitignoreFilter;
}

export interface ExtractRepoOptions {
  filesToExclude?: string[];
  gitignoreFilter?: GitignoreFilter;
  onProgress?: (info: { processed: number; current: string }) => void;
}

/** Hard cap so a stray log/binary cannot freeze the extension host. */
export const MAX_EXTRACT_FILE_BYTES = 1_500_000;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.vscode',
  '.cursor',
  '.idea',
  'logs',
  'coverage',
  '.next',
  'target',
  'tmp',
  'temp',
  '.cache',
  '.turbo',
]);

const EXTRACTABLE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'html',
  'htm',
  'md',
  'sh',
  'bash',
  'conf',
  'any',
  'groovy',
  'jenkinsfile',
]);

function isExcluded(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/\/$/, '');
    return (
      relativePath === normalized ||
      relativePath.startsWith(`${normalized}/`) ||
      relativePath.includes(`/${normalized}/`)
    );
  });
}

function isBinaryFile(source: string): boolean {
  const sample = source.slice(0, 1024);
  return sample.includes('\0');
}

function basenameLower(relativePath: string): string {
  return path.basename(relativePath).toLowerCase();
}

/**
 * Cheap path-only check: skip files no extractor can use so we never read
 * multi-GB logs, lockfiles, images, etc.
 */
function isPathExtractable(relativePath: string, ext: string): boolean {
  if (isJenkinsPipelineFile(relativePath)) {
    return true;
  }
  const base = basenameLower(relativePath);
  if (base === 'pom.xml' || base.endsWith('.pom.xml') || base.endsWith('.pom')) {
    return true;
  }
  if (relativePath.endsWith('.content.xml')) {
    return true;
  }
  if (EXTRACTABLE_EXTENSIONS.has(ext)) {
    return true;
  }
  // Extensionless files may be shell scripts (shebang checked after a tiny peek).
  if (!ext) {
    return true;
  }
  return false;
}

function resolveExtractor(relativePath: string, source: string, ext: string): Extractor | undefined {
  if (isMavenPomFile(relativePath, source)) {
    return globalExtractorRegistry.getById('maven');
  }

  if (isJenkinsPipelineFile(relativePath)) {
    return globalExtractorRegistry.getById('jenkins');
  }

  if (ext === 'sh' || ext === 'bash' || !ext || isLikelyShellScript(relativePath, source)) {
    if (isLikelyShellScript(relativePath, source)) {
      return globalExtractorRegistry.getById('bash');
    }
  }

  if (ext === 'conf' || ext === 'any') {
    const apache = isApacheConfig(relativePath, source);
    const nginx = isNginxConfig(relativePath, source);
    if (apache && !nginx) {
      return globalExtractorRegistry.getById('apache-conf');
    }
    if (nginx && !apache) {
      return globalExtractorRegistry.getById('nginx-conf');
    }
    if (apache && nginx) {
      // Prefer path hints when both match generic proxy config.
      if (/nginx|upstreams|snippets/i.test(relativePath)) {
        return globalExtractorRegistry.getById('nginx-conf');
      }
      if (/apache|sites-available|sites-enabled|conf-dispatcher/i.test(relativePath)) {
        return globalExtractorRegistry.getById('apache-conf');
      }
    }
  }

  if ((ext === 'html' || ext === 'htm') && isHtlFile(relativePath, source)) {
    return globalExtractorRegistry.getById('htl');
  }

  if (relativePath.endsWith('.content.xml') && isAemContentXmlFile(relativePath, source)) {
    return globalExtractorRegistry.getById('aem-content-xml');
  }

  return globalExtractorRegistry.getForExtension(ext);
}

function shouldSkipPath(
  relativePath: string,
  filesToExclude: string[],
  gitignoreFilter?: GitignoreFilter
): boolean {
  if (isExcluded(relativePath, filesToExclude)) {
    return true;
  }
  return gitignoreFilter?.isIgnored(relativePath) ?? false;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function extractFile(options: ExtractFileOptions): Promise<ExtractionResult> {
  const { repoRoot, filePath, filesToExclude = [], gitignoreFilter } = options;
  const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');

  if (shouldSkipPath(relativePath, filesToExclude, gitignoreFilter)) {
    return { nodes: [], edges: [] };
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!isPathExtractable(relativePath, ext)) {
    return { nodes: [], edges: [] };
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EXTRACT_FILE_BYTES) {
      return { nodes: [], edges: [] };
    }
  } catch {
    return { nodes: [], edges: [] };
  }

  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { nodes: [], edges: [] };
  }

  if (isBinaryFile(source)) {
    return { nodes: [], edges: [] };
  }

  const extractor = resolveExtractor(relativePath, source, ext);
  if (!extractor) {
    return { nodes: [], edges: [] };
  }

  const ctx: ExtractorContext = {
    sourceFile: relativePath,
    repoRoot,
  };

  try {
    return await extractor.extract(source, ctx);
  } catch (err) {
    console.error(
      `Anamnesis: skipped ${relativePath}: ${err instanceof Error ? err.message : err}`
    );
    return { nodes: [], edges: [] };
  }
}

export async function extractRepo(
  repoRoot: string,
  options: ExtractRepoOptions | string[] = {}
): Promise<ExtractionResult> {
  const opts: ExtractRepoOptions = Array.isArray(options) ? { filesToExclude: options } : options;
  const filesToExclude = opts.filesToExclude ?? [];
  const gitignoreFilter = opts.gitignoreFilter;
  const results: ExtractionResult[] = [];
  let processed = 0;

  async function walk(dir: string, relDir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (shouldSkipPath(relPath, filesToExclude, gitignoreFilter)) continue;
        if (gitignoreFilter?.isIgnoredDirectory(relPath)) continue;
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (entry.name === '.gitignore') continue;
        if (shouldSkipPath(relPath, filesToExclude, gitignoreFilter)) continue;
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!isPathExtractable(relPath, ext)) continue;
        results.push(await extractFile({ repoRoot, filePath: fullPath, filesToExclude, gitignoreFilter }));
        processed += 1;
        opts.onProgress?.({ processed, current: relPath });
        if (processed % 8 === 0) {
          await yieldToEventLoop();
        }
      }
    }
  }

  await walk(repoRoot, '');

  const nodes: ExtractionResult['nodes'] = [];
  const edges: ExtractionResult['edges'] = [];
  for (const r of results) {
    nodes.push(...r.nodes);
    edges.push(...r.edges);
  }
  return { nodes, edges };
}
