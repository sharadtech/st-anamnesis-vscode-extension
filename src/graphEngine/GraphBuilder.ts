import Graph from 'graphology';
import type { ExtractionResult, GraphNode, GraphEdge, SerializedGraph } from './types';

export interface BuildGraphOptions {
  companyId: string;
  extraction: ExtractionResult;
}

export function buildGraph(options: BuildGraphOptions): Graph {
  const { companyId, extraction } = options;

  const graph = new Graph({
    type: 'directed',
    multi: true,
    allowSelfLoops: false,
  });

  for (const node of extraction.nodes) {
    if (!graph.hasNode(node.id)) {
      graph.addNode(node.id, {
        label: node.label,
        kind: node.kind,
        sourceFile: node.sourceFile,
        sourceLocation: node.sourceLocation,
        confidence: node.confidence,
      });
    }
  }

  const seenEdges = new Set<string>();
  for (const edge of extraction.edges) {
    if (edge.source === edge.target) continue;
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    const signature = `${edge.source}->${edge.target}:${edge.relation}`;
    if (seenEdges.has(signature)) continue;
    seenEdges.add(signature);
    if (!graph.hasEdge(edge.id)) {
      graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
        relation: edge.relation,
        confidence: edge.confidence,
        sourceFile: edge.sourceFile,
      });
    }
  }

  graph.setAttribute('companyId', companyId);
  return graph;
}

export function graphToSerialized(graph: Graph, companyId: string): SerializedGraph {
  const nodes: GraphNode[] = [];
  graph.forEachNode((id, attrs) => {
    nodes.push({
      id,
      label: attrs.label as string,
      kind: attrs.kind as GraphNode['kind'],
      sourceFile: attrs.sourceFile as string,
      sourceLocation: attrs.sourceLocation as GraphNode['sourceLocation'] | undefined,
      confidence: attrs.confidence as GraphNode['confidence'],
      community: attrs.community as number | undefined,
    });
  });

  const edges: GraphEdge[] = [];
  graph.forEachEdge((id, attrs, source, target) => {
    edges.push({
      id,
      source,
      target,
      relation: attrs.relation as GraphEdge['relation'],
      confidence: attrs.confidence as GraphEdge['confidence'],
      sourceFile: attrs.sourceFile as string,
    });
  });

  return {
    version: 1,
    companyId,
    builtAt: new Date().toISOString(),
    nodes,
    edges,
  };
}
