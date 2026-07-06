import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import { addEdge, ensureFileNode, lineNumber, makeNode, nodeId } from './utils';

function extractJenkins(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const pipelineMatch = source.match(/\bpipeline\s*\{/);
  if (pipelineMatch) {
    const pipelineId = nodeId(file, 'pipeline', 'main');
    nodes.set(
      pipelineId,
      makeNode(file, 'pipeline', 'main', 'Jenkins Pipeline', lineNumber(source, pipelineMatch.index ?? 0))
    );
    addEdge(file, fileId, pipelineId, 'contains', edges, edgeIndex);
  }

  const agentMatch = source.match(/agent\s+(any|\{[^}]+\}|['"][^'"]+['"])/);
  if (agentMatch) {
    const agentId = nodeId(file, 'concept', `agent:${agentMatch[1].slice(0, 40)}`);
    nodes.set(
      agentId,
      makeNode(file, 'concept', `agent:${agentMatch[1].slice(0, 40)}`, `agent ${agentMatch[1]}`, lineNumber(source, agentMatch.index ?? 0))
    );
    addEdge(file, fileId, agentId, 'uses', edges, edgeIndex);
  }

  const toolsMatch = source.match(/tools\s*\{([\s\S]*?)\}/);
  if (toolsMatch) {
    const toolLines = toolsMatch[1].match(/^\s*(\w+)\s+'([^']+)'/gm) || [];
    for (const tl of toolLines) {
      const m = tl.match(/(\w+)\s+'([^']+)'/);
      if (!m) continue;
      const toolId = nodeId(file, 'concept', `tool:${m[1]}:${m[2]}`);
      nodes.set(
        toolId,
        makeNode(file, 'concept', `tool:${m[1]}:${m[2]}`, `${m[1]} ${m[2]}`, lineNumber(source, toolsMatch.index ?? 0), {
          tool: m[1],
          version: m[2],
        })
      );
      addEdge(file, fileId, toolId, 'uses', edges, edgeIndex);
    }
  }

  const triggers = source.match(/triggers\s*\{([\s\S]*?)\}/);
  if (triggers) {
    const triggerItems = triggers[1].match(/\w+\([^)]*\)/g) || [];
    for (const trigger of triggerItems) {
      const triggerId = nodeId(file, 'concept', `trigger:${trigger}`);
      nodes.set(
        triggerId,
        makeNode(file, 'concept', `trigger:${trigger}`, trigger, lineNumber(source, source.indexOf(trigger)))
      );
      addEdge(file, fileId, triggerId, 'uses', edges, edgeIndex);
    }
  }

  const envBlock = source.match(/environment\s*\{([\s\S]*?)\n\s*\}/);
  if (envBlock) {
    const envLines = envBlock[1].match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*['"]?([^'"\n]+)['"]?/gm) || [];
    for (const el of envLines) {
      const m = el.match(/([A-Z_][A-Z0-9_]*)\s*=\s*['"]?([^'"\n]+)['"]?/);
      if (!m) continue;
      const envId = nodeId(file, 'concept', `env:${m[1]}`);
      nodes.set(
        envId,
        makeNode(file, 'concept', `env:${m[1]}`, `${m[1]}=${m[2]}`, lineNumber(source, source.indexOf(el)), {
          key: m[1],
          value: m[2],
        })
      );
      addEdge(file, fileId, envId, 'defines', edges, edgeIndex);

      if (/SERVERS|SERVER|HOST|URL|REPO|APP_NAME|GIT/i.test(m[1])) {
        const ips = m[2].match(/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g) || [];
        for (const ip of ips) {
          const hostId = nodeId(file, 'concept', `deploy:${ip}`);
          if (!nodes.has(hostId)) {
            nodes.set(
              hostId,
              makeNode(file, 'concept', `deploy:${ip}`, ip, lineNumber(source, source.indexOf(el)), {}, 'INFERRED')
            );
          }
          addEdge(file, envId, hostId, 'deploys_to', edges, edgeIndex, 'INFERRED');
        }
        const repoMatch = m[2].match(/github\.com[:/]([\w-]+\/[\w-]+)/i);
        if (repoMatch) {
          const repoId = nodeId(file, 'concept', `repo:${repoMatch[1]}`);
          nodes.set(
            repoId,
            makeNode(file, 'concept', `repo:${repoMatch[1]}`, repoMatch[1], lineNumber(source, source.indexOf(el)), {}, 'INFERRED')
          );
          addEdge(file, envId, repoId, 'uses', edges, edgeIndex, 'INFERRED');
        }
      }
    }
  }

  const stageRegex = /stage\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\{/g;
  let stageMatch: RegExpExecArray | null;
  const pipelineId = nodeId(file, 'pipeline', 'main');
  while ((stageMatch = stageRegex.exec(source)) !== null) {
    const stageName = stageMatch[1];
    const line = lineNumber(source, stageMatch.index);
    const stageId = nodeId(file, 'stage', stageName);
    nodes.set(stageId, makeNode(file, 'stage', stageName, stageName, line));
    if (nodes.has(pipelineId)) {
      addEdge(file, pipelineId, stageId, 'runs_stage', edges, edgeIndex);
    } else {
      addEdge(file, fileId, stageId, 'contains', edges, edgeIndex);
    }

    const start = stageMatch.index;
    const end = findMatchingBrace(source, stageMatch[0].lastIndexOf('{'));
    const block = end >= 0 ? source.slice(start, end) : source.slice(start);

    const steps = block.match(/\b(sh|bat|echo|withCredentials|git|checkout|sshagent|docker|node|npm|npx)\s*\(/gi) || [];
    for (const step of steps) {
      const stepType = step.replace(/\s*\($/, '').toLowerCase();
      const stepId = nodeId(file, 'pipeline_step', `${stageName}:${stepType}`);
      if (nodes.has(stepId)) continue;
      nodes.set(
        stepId,
        makeNode(file, 'pipeline_step', `${stageName}:${stepType}`, stepType, line, { stage: stageName, stepType })
      );
      addEdge(file, stageId, stepId, 'calls', edges, edgeIndex);
    }

    const shScripts = block.match(/sh\s+['"]([^'"]+)['"]/g) || [];
    for (const sh of shScripts) {
      const script = sh.match(/['"]([^'"]+)['"]/)?.[1];
      if (!script) continue;
      const stepId = nodeId(file, 'pipeline_step', `${stageName}:sh:${script.slice(0, 40)}`);
      nodes.set(
        stepId,
        makeNode(file, 'pipeline_step', `${stageName}:sh:${script.slice(0, 40)}`, `sh ${script.slice(0, 80)}`, line, {
          stage: stageName,
          stepType: 'sh',
          script,
        })
      );
      addEdge(file, stageId, stepId, 'calls', edges, edgeIndex);

      const ips = script.match(/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g) || [];
      for (const ip of ips) {
        const hostId = nodeId(file, 'concept', `deploy:${ip}`);
        if (!nodes.has(hostId)) {
          nodes.set(hostId, makeNode(file, 'concept', `deploy:${ip}`, ip, line, {}, 'INFERRED'));
        }
        addEdge(file, stepId, hostId, 'deploys_to', edges, edgeIndex, 'INFERRED');
      }
    }
  }

  const postBlock = source.match(/post\s*\{([\s\S]*?)\n\s*\}/);
  if (postBlock) {
    const conditions = postBlock[1].match(/^\s*(success|failure|always|unstable|changed)\s*\{/gm) || [];
    for (const cond of conditions) {
      const name = cond.trim().replace(/\s*\{$/, '');
      const postId = nodeId(file, 'concept', `post:${name}`);
      nodes.set(postId, makeNode(file, 'concept', `post:${name}`, `post ${name}`, lineNumber(source, postBlock.index ?? 0)));
      addEdge(file, fileId, postId, 'uses', edges, edgeIndex);
    }
  }

  return { nodes: Array.from(nodes.values()), edges };
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export const jenkinsExtractor: Extractor = {
  id: 'jenkins',
  name: 'Jenkins Pipeline',
  extensions: ['jenkinsfile', 'groovy'],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractJenkins(source, ctx.sourceFile);
  },
};

export function isJenkinsPipelineFile(relativePath: string): boolean {
  const base = relativePath.split('/').pop()?.toLowerCase() || '';
  return (
    base === 'jenkinsfile' ||
    base.startsWith('jenkinsfile.') ||
    base.endsWith('.jenkinsfile') ||
    base === 'jenkinsfile.build' ||
    base === 'jenkinsfile.deploy'
  );
}
