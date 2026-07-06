import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

export interface ClusterResult {
  communities: number;
  assignments: Record<string, number>;
}

export function clusterGraph(graph: Graph): ClusterResult {
  const assignments = louvain(graph);

  const seen = new Set<number>();
  for (const node of graph.nodes()) {
    const community = assignments[node];
    if (community !== undefined) {
      graph.setNodeAttribute(node, 'community', community);
      seen.add(community);
    }
  }

  return { communities: seen.size, assignments };
}
