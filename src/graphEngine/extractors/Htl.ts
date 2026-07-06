import path from 'path';
import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import { addEdge, ensureFileNode, lineNumber, makeNode, nodeId } from './utils';

/** Fully-qualified Java class: com.example.models.Foo */
const JAVA_CLASS_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.[A-Z][a-zA-Z0-9_]*$/;

function isJavaClassReference(value: string): boolean {
  if (value.endsWith('.html') || value.endsWith('.htm')) return false;
  return JAVA_CLASS_RE.test(value);
}

/** Infer AEM component path from ui.apps file location, e.g. adobexp/components/content/teaser */
function inferAemComponentPath(relativeFile: string): string | undefined {
  const m = relativeFile.match(/\/apps\/([^/]+\/components(?:\/[^/]+){1,2})\//i);
  return m ? m[1] : undefined;
}

/** Resolve an HTL include path relative to the current template file or AEM /apps root. */
function resolveHtlPath(currentFile: string, includePath: string): string {
  const normalized = includePath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return normalized.slice(1);

  // AEM apps-relative path (e.g. adobexp/components/commons/v1/templates.html)
  if (/^[^./]+\/.+/.test(normalized)) {
    const appsRoot = currentFile.match(/^(.*\/apps\/)/i);
    if (appsRoot) {
      return path.posix.normalize(path.posix.join(appsRoot[1], normalized));
    }
  }

  const dir = path.posix.dirname(currentFile);
  return path.posix.normalize(path.posix.join(dir, normalized));
}

function ensureIncludeNode(
  file: string,
  includePath: string,
  line: number,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  edgeIndex: { value: number },
  sourceId: string
): string {
  const resolved = resolveHtlPath(file, includePath);
  const includeId = nodeId(file, 'htl_include', resolved);
  if (!nodes.has(includeId)) {
    nodes.set(
      includeId,
      makeNode(file, 'htl_include', resolved, includePath, line, { resolvedPath: resolved })
    );
  }
  addEdge(file, sourceId, includeId, 'includes', edges, edgeIndex);
  return includeId;
}

function extractHtl(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const componentPath = inferAemComponentPath(file);
  let graphRootId = fileId;
  if (componentPath) {
    const componentId = nodeId(file, 'htl_component', componentPath);
    nodes.set(
      componentId,
      makeNode(file, 'htl_component', componentPath, componentPath, 1, { componentPath })
    );
    addEdge(file, fileId, componentId, 'contains', edges, edgeIndex);
    graphRootId = componentId;
  }

  // varName -> resolved HTL path (for data-sly-call resolution)
  const htlUseBindings = new Map<string, string>();

  const useRegex = /data-sly-use\.(\w+)\s*=\s*["']([^"']+)["']/g;
  let useMatch: RegExpExecArray | null;
  while ((useMatch = useRegex.exec(source)) !== null) {
    const varName = useMatch[1];
    const target = useMatch[2].trim();
    const line = lineNumber(source, useMatch.index);

    if (isJavaClassReference(target)) {
      const modelId = nodeId(file, 'htl_use_model', target);
      const shortName = target.split('.').pop() || target;
      if (!nodes.has(modelId)) {
        nodes.set(
          modelId,
          makeNode(file, 'htl_use_model', target, shortName, line, {
            javaClass: target,
            varName,
          })
        );
      }
      addEdge(file, graphRootId, modelId, 'uses_model', edges, edgeIndex);
    } else {
      const resolved = resolveHtlPath(file, target);
      htlUseBindings.set(varName, resolved);
      ensureIncludeNode(file, target, line, nodes, edges, edgeIndex, graphRootId);
    }
  }

  const includeRegex = /data-sly-include\s*=\s*["']([^"']+)["']/g;
  let includeMatch: RegExpExecArray | null;
  while ((includeMatch = includeRegex.exec(source)) !== null) {
    const target = includeMatch[1].trim();
    const line = lineNumber(source, includeMatch.index);
    ensureIncludeNode(file, target, line, nodes, edges, edgeIndex, graphRootId);
  }

  const templateRegex = /data-sly-template\.(\w+)\s*=\s*["']/g;
  let templateMatch: RegExpExecArray | null;
  while ((templateMatch = templateRegex.exec(source)) !== null) {
    const templateName = templateMatch[1];
    const line = lineNumber(source, templateMatch.index);
    const templateId = nodeId(file, 'htl_template', templateName);
    nodes.set(
      templateId,
      makeNode(file, 'htl_template', templateName, templateName, line, { templateName })
    );
    addEdge(file, graphRootId, templateId, 'defines', edges, edgeIndex);
  }

  const callRegex = /data-sly-call\s*=\s*["']\$\{(\w+)\.(\w+)[^"']*["']/g;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = callRegex.exec(source)) !== null) {
    const varName = callMatch[1];
    const templateName = callMatch[2];
    const line = lineNumber(source, callMatch.index);
    const callLabel = `${varName}.${templateName}`;
    const callId = nodeId(file, 'htl_template', `call:${callLabel}`);
    if (!nodes.has(callId)) {
      nodes.set(
        callId,
        makeNode(file, 'htl_template', `call:${callLabel}`, callLabel, line, {
          varName,
          templateName,
        })
      );
    }
    addEdge(file, graphRootId, callId, 'calls', edges, edgeIndex);

    const boundPath = htlUseBindings.get(varName);
    if (boundPath) {
      const targetTemplateId = nodeId(boundPath, 'htl_template', templateName);
      if (!nodes.has(targetTemplateId)) {
        nodes.set(
          targetTemplateId,
          makeNode(boundPath, 'htl_template', templateName, templateName, line, { templateName }, 'INFERRED')
        );
      }
      addEdge(file, callId, targetTemplateId, 'references', edges, edgeIndex, 'INFERRED');
    }
  }

  const resourceRegex = /data-sly-resource\s*=\s*["']\$\{([^"']+)\}["']/g;
  let resourceMatch: RegExpExecArray | null;
  while ((resourceMatch = resourceRegex.exec(source)) !== null) {
    const expr = resourceMatch[1].trim();
    const line = lineNumber(source, resourceMatch.index);
    const resourceId = nodeId(file, 'concept', `resource:${expr.slice(0, 60)}`);
    nodes.set(
      resourceId,
      makeNode(file, 'concept', `resource:${expr.slice(0, 60)}`, `resource ${expr.slice(0, 80)}`, line, {
        expression: expr,
      })
    );
    addEdge(file, graphRootId, resourceId, 'references', edges, edgeIndex);
  }

  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(source)) !== null) {
    const tagName = tagMatch[1];
    const line = lineNumber(source, tagMatch.index);
    const tagId = nodeId(file, 'tag', `${tagName}:${line}`);
    if (nodes.has(tagId)) continue;
    nodes.set(tagId, makeNode(file, 'tag', `${tagName}:${line}`, `<${tagName}>`, line));
    addEdge(file, fileId, tagId, 'contains', edges, edgeIndex);
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export const htlExtractor: Extractor = {
  id: 'htl',
  name: 'HTL (Sightly)',
  extensions: [],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractHtl(source, ctx.sourceFile);
  },
};

/** Detect Adobe HTL / Sightly templates (AEM component scripts or data-sly directives). */
export function isHtlFile(relativePath: string, source: string): boolean {
  const ext = relativePath.split('.').pop()?.toLowerCase();
  if (ext !== 'html' && ext !== 'htm') return false;
  if (/\bdata-sly-/i.test(source)) return true;
  if (/\/apps\/[^/]+\/components\//i.test(relativePath)) return true;
  if (/\/jcr_root\/apps\//i.test(relativePath)) return true;
  return false;
}
