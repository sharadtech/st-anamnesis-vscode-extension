import type { Confidence, GraphEdge, GraphNode, RelationType, SourceLocation } from '../types';

export function loc(file: string, line: number, column = 1): SourceLocation {
  return { file, line, column };
}

export function nodeId(file: string, kind: string, name: string): string {
  return `${file}#${kind}:${name}`;
}

export function makeNode(
  file: string,
  kind: GraphNode['kind'],
  name: string,
  label: string,
  line: number,
  extra: Record<string, unknown> = {},
  confidence: Confidence = 'EXTRACTED'
): GraphNode {
  return {
    id: nodeId(file, kind, name),
    label,
    kind,
    sourceFile: file,
    sourceLocation: loc(file, line),
    confidence,
    ...extra,
  };
}

export function makeEdge(
  file: string,
  source: string,
  target: string,
  relation: RelationType,
  index: number,
  confidence: Confidence = 'EXTRACTED',
  extra: Record<string, unknown> = {}
): GraphEdge {
  return {
    id: `${source}->${target}:${relation}:${index}`,
    source,
    target,
    relation,
    confidence,
    sourceFile: file,
    ...extra,
  };
}

export function ensureFileNode(
  file: string,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  edgeIndex: { value: number }
): string {
  if (!nodes.has(file)) {
    nodes.set(
      file,
      makeNode(file, 'file', file.split('/').pop() || file, file.split('/').pop() || file, 1)
    );
  }
  return file;
}

export function addEdge(
  file: string,
  source: string,
  target: string,
  relation: RelationType,
  edges: GraphEdge[],
  edgeIndex: { value: number },
  confidence: Confidence = 'EXTRACTED',
  extra: Record<string, unknown> = {}
): void {
  if (source === target) return;
  edges.push(makeEdge(file, source, target, relation, edgeIndex.value++, confidence, extra));
}

export function parseUrlTarget(raw: string): { scheme?: string; host?: string; port?: string; path?: string } {
  const cleaned = raw.replace(/["']/g, '').trim();
  const match = cleaned.match(/^(wss?|https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i);
  if (!match) {
    return { path: cleaned };
  }
  return {
    scheme: match[1]?.toLowerCase(),
    host: match[2],
    port: match[3],
    path: match[4] || '/',
  };
}

export function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
