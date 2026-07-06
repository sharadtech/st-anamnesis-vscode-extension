import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import { addEdge, ensureFileNode, lineNumber, makeNode, nodeId } from './utils';

const PROJECT_NAME_RE = /\b(st-ck-[a-z0-9-]+|st-anamnesis-[a-z0-9-]+|st-apache-web-server|st-nginx-server|AI-PROXY-APP|AI-GRAPHIFY)\b/gi;
const ROUTE_RE = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/[a-zA-Z0-9_./:*-]+)/g;
const KG_EDGE_RE = /^([^\s]+)\s*->\s*([^\s:]+)\s*:\s*(\w+)/gm;

function projectModuleId(project: string, name: string): string {
  return `${project}#module:${name}`;
}

function projectConceptId(project: string, name: string): string {
  return `${project}#concept:${name}`;
}

function ensureNamedNode(
  id: string,
  label: string,
  kind: GraphNode['kind'],
  file: string,
  line: number,
  nodes: Map<string, GraphNode>,
  confidence: GraphNode['confidence'] = 'INJECTED',
  extra: Record<string, unknown> = {}
): void {
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      label,
      kind,
      sourceFile: file,
      sourceLocation: { file, line, column: 1 },
      confidence,
      ...extra,
    });
  }
}

function extractMarkdown(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const docProjectMatch = file.match(/(?:^|\/)([A-Za-z0-9._-]+)\/ARCHITECTURE\.md$/i);
  const docProject = docProjectMatch?.[1];

  if (docProject) {
    const projectId = projectModuleId(docProject, 'root');
    ensureNamedNode(projectId, docProject, 'module', file, 1, nodes, 'INJECTED', { project: docProject });
    addEdge(file, fileId, projectId, 'documents', edges, edgeIndex, 'INJECTED');
  }

  const titleMatch = source.match(/^#\s+(.+?)\s+Architecture/m);
  if (titleMatch) {
    const titleProject = titleMatch[1].trim().split(/\s+/)[0];
    const titleId = projectModuleId(titleProject, 'architecture');
    ensureNamedNode(
      titleId,
      `${titleProject} Architecture`,
      'module',
      file,
      1,
      nodes,
      'INJECTED',
      { project: titleProject }
    );
    addEdge(file, fileId, titleId, 'documents', edges, edgeIndex, 'INJECTED');
  }

  const tableProjects =
    source.match(/\|\s*\*\*([A-Za-z0-9._-]+)\*\*\s*\|/g) ||
    source.match(/\|\s*([A-Za-z0-9._-]+)\s*\|\s*[^|]+\|\s*\[/g) ||
    [];
  for (const row of tableProjects) {
    const name = row.match(/\*\*([^*]+)\*\*/)?.[1] || row.match(/\|\s*([A-Za-z0-9._-]+)\s*\|/)?.[1];
    if (!name || name === 'Project' || name === 'Module') continue;
    const modId = projectModuleId(name, 'project');
    if (!nodes.has(modId)) {
      const line = lineNumber(source, source.indexOf(name));
      ensureNamedNode(modId, name, 'module', file, line, nodes, 'INJECTED', { project: name });
    }
    addEdge(file, fileId, modId, 'documents', edges, edgeIndex, 'INJECTED');
  }

  const links = source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
  for (const link of links) {
    const label = link[1];
    const href = link[2];
    const line = lineNumber(source, link.index ?? 0);
    if (/ARCHITECTURE\.md|modules\//.test(href)) {
      const linkedProject = href.match(/([A-Za-z0-9._-]+)\/ARCHITECTURE\.md/)?.[1] || label;
      const targetId = projectModuleId(linkedProject, 'project');
      if (!nodes.has(targetId)) {
        ensureNamedNode(targetId, linkedProject, 'module', file, line, nodes, 'INFERRED', { project: linkedProject });
      }
      const fromId = docProject ? projectModuleId(docProject, 'project') : fileId;
      addEdge(file, fromId, targetId, 'references', edges, edgeIndex, 'INFERRED');
    }
  }

  const projectsInText = source.matchAll(PROJECT_NAME_RE);
  for (const match of projectsInText) {
    const project = match[0];
    const line = lineNumber(source, match.index ?? 0);
    const modId = projectModuleId(project, 'mention');
    if (!nodes.has(modId)) {
      ensureNamedNode(modId, project, 'module', file, line, nodes, 'INFERRED', { project });
    }
    addEdge(file, fileId, modId, 'references', edges, edgeIndex, 'INFERRED');
  }

  const routes = source.matchAll(ROUTE_RE);
  for (const route of routes) {
    const method = route[1];
    const path = route[2];
    const line = lineNumber(source, route.index ?? 0);
    const owner = docProject || 'st-ck-server';
    const conceptName = `${method} ${path}`;
    const conceptId = projectConceptId(owner, conceptName);
    if (!nodes.has(conceptId)) {
      ensureNamedNode(conceptId, conceptName, 'concept', file, line, nodes, 'INJECTED', {
        method,
        path,
        owner,
      });
    }
    const fromId = docProject ? projectModuleId(docProject, 'project') : fileId;
    addEdge(file, fromId, conceptId, 'defines', edges, edgeIndex, 'INJECTED');
  }

  const mermaidNodes = source.matchAll(/^\s*([A-Za-z0-9_]+)\[([^\]]+)\]/gm);
  for (const mn of mermaidNodes) {
    const nodeKey = mn[1];
    const label = mn[2];
    const line = lineNumber(source, mn.index ?? 0);
    const conceptId = nodeId(file, 'concept', `mermaid:${nodeKey}`);
    nodes.set(
      conceptId,
      makeNode(file, 'concept', `mermaid:${nodeKey}`, label, line, { mermaidId: nodeKey }, 'INFERRED')
    );
    addEdge(file, fileId, conceptId, 'documents', edges, edgeIndex, 'INFERRED');

    const linked = label.match(PROJECT_NAME_RE)?.[0];
    if (linked) {
      const targetId = projectModuleId(linked, 'project');
      if (!nodes.has(targetId)) {
        ensureNamedNode(targetId, linked, 'module', file, line, nodes, 'INFERRED', { project: linked });
      }
      addEdge(file, conceptId, targetId, 'references', edges, edgeIndex, 'INFERRED');
    }
  }

  const mermaidEdges = source.matchAll(/^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)/gm);
  for (const me of mermaidEdges) {
    const from = nodeId(file, 'concept', `mermaid:${me[1]}`);
    const to = nodeId(file, 'concept', `mermaid:${me[2]}`);
    if (nodes.has(from) && nodes.has(to)) {
      addEdge(file, from, to, 'uses', edges, edgeIndex, 'INFERRED');
    }
  }

  const kgEdges = source.matchAll(KG_EDGE_RE);
  for (const ke of kgEdges) {
    const sourceId = ke[1].trim();
    const targetId = ke[2].trim();
    const relation = ke[3].trim() as GraphEdge['relation'];
    const line = lineNumber(source, ke.index ?? 0);
    const validRelations: GraphEdge['relation'][] = [
      'uses',
      'references',
      'calls',
      'contains',
      'defines',
      'depends_on',
      'proxies_to',
    ];
    const rel = validRelations.includes(relation) ? relation : 'uses';

    if (!nodes.has(sourceId)) {
      ensureNamedNode(sourceId, sourceId, 'concept', file, line, nodes, 'INJECTED');
    }
    if (!nodes.has(targetId)) {
      ensureNamedNode(targetId, targetId, 'concept', file, line, nodes, 'INJECTED');
    }
    addEdge(file, sourceId, targetId, rel, edges, edgeIndex, 'INJECTED');
  }

  const crossUses = source.matchAll(
    /([A-Za-z0-9._-]+#(?:module|concept):[^\s]+)\s*->\s*([A-Za-z0-9._-]+#(?:module|concept):[^\s]+)\s*:\s*(\w+)/g
  );
  for (const cu of crossUses) {
    const sourceId = cu[1];
    const targetId = cu[2];
    const relation = cu[3] as GraphEdge['relation'];
    const line = lineNumber(source, cu.index ?? 0);
    if (!nodes.has(sourceId)) {
      nodes.set(sourceId, makeNode(file, 'concept', sourceId, sourceId, line, {}, 'INJECTED'));
    }
    if (!nodes.has(targetId)) {
      nodes.set(targetId, makeNode(file, 'concept', targetId, targetId, line, {}, 'INJECTED'));
    }
    addEdge(file, sourceId, targetId, relation === 'uses' ? 'uses' : 'references', edges, edgeIndex, 'INJECTED');
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export const markdownArchExtractor: Extractor = {
  id: 'markdown-arch',
  name: 'Markdown Architecture Documentation',
  extensions: ['md'],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractMarkdown(source, ctx.sourceFile);
  },
};
