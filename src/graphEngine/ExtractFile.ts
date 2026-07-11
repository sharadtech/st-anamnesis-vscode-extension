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
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.vscode']);

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

function resolveExtractor(relativePath: string, source: string, ext: string): Extractor | undefined {
  const base = path.basename(relativePath);

  if (isMavenPomFile(relativePath, source)) {
    return globalExtractorRegistry.getById('maven');
  }

  if (isJenkinsPipelineFile(relativePath)) {
    return globalExtractorRegistry.getById('jenkins');
  }

  if (isLikelyShellScript(relativePath, source)) {
    return globalExtractorRegistry.getById('bash');
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

export async function extractFile(options: ExtractFileOptions): Promise<ExtractionResult> {
  const { repoRoot, filePath, filesToExclude = [], gitignoreFilter } = options;
  const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');

  if (shouldSkipPath(relativePath, filesToExclude, gitignoreFilter)) {
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

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const extractor = resolveExtractor(relativePath, source, ext);
  if (!extractor) {
    return { nodes: [], edges: [] };
  }

  const ctx: ExtractorContext = {
    sourceFile: relativePath,
    repoRoot,
  };

  return extractor.extract(source, ctx);
}

export async function extractRepo(
  repoRoot: string,
  options: ExtractRepoOptions | string[] = {}
): Promise<ExtractionResult> {
  const opts: ExtractRepoOptions = Array.isArray(options) ? { filesToExclude: options } : options;
  const filesToExclude = opts.filesToExclude ?? [];
  const gitignoreFilter = opts.gitignoreFilter;
  const results: ExtractionResult[] = [];

  async function walk(dir: string, relDir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (shouldSkipPath(relPath, filesToExclude, gitignoreFilter)) continue;
        if (gitignoreFilter?.isIgnoredDirectory(relPath)) continue;
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (entry.name === '.gitignore') continue;
        if (shouldSkipPath(relPath, filesToExclude, gitignoreFilter)) continue;
        results.push(await extractFile({ repoRoot, filePath: fullPath, filesToExclude, gitignoreFilter }));
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
