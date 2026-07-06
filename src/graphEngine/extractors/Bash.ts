import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import { addEdge, ensureFileNode, lineNumber, makeNode, nodeId } from './utils';

const COMMAND_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'source', regex: /(?:^|\s|\|)(?:source|\.\s+)([^\s;|&]+)/gm },
  { name: 'npm', regex: /\bnpm\s+(run\s+\w+|install|ci|test|build|start)\b/g },
  { name: 'node', regex: /\bnode\s+([^\s;|&]+)/g },
  { name: 'npx', regex: /\bnpx\s+([^\s;|&]+)/g },
  { name: 'git', regex: /\bgit\s+(clone|pull|push|checkout|fetch|merge|commit)\b[^\n|;&]*/g },
  { name: 'ssh', regex: /\bssh\s+([^\s;|&]+)/g },
  { name: 'scp', regex: /\bscp\s+([^\n;|&]+)/g },
  { name: 'curl', regex: /\bcurl\s+([^\n;|&]+)/g },
  { name: 'docker', regex: /\bdocker\s+(run|build|compose|exec|pull|push)\b[^\n|;&]*/g },
  { name: 'kubectl', regex: /\bkubectl\s+([^\n|;&]+)/g },
  { name: 'systemctl', regex: /\bsystemctl\s+(start|stop|restart|enable|status)\s+([^\s;|&]+)/g },
  { name: 'pm2', regex: /\bpm2\s+(start|restart|stop|reload)\s+([^\s;|&]+)/g },
  { name: 'rsync', regex: /\brsync\s+([^\n|;&]+)/g },
  { name: 'tar', regex: /\btar\s+([^\n|;&]+)/g },
];

function extractBash(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const shebang = source.match(/^#!.*$/m)?.[0];
  if (shebang) {
    const shebangId = nodeId(file, 'concept', 'shebang');
    nodes.set(
      shebangId,
      makeNode(file, 'concept', 'shebang', shebang.trim(), 1, { interpreter: shebang })
    );
    addEdge(file, fileId, shebangId, 'contains', edges, edgeIndex);
  }

  const functionRegex = /^(?:function\s+([a-zA-Z_][a-zA-Z0-9_]*)|[a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{/gm;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = functionRegex.exec(source)) !== null) {
    const fnName = fnMatch[1] || fnMatch[0].split('(')[0].trim();
    const line = lineNumber(source, fnMatch.index);
    const fnId = nodeId(file, 'shell_function', fnName);
    nodes.set(fnId, makeNode(file, 'shell_function', fnName, fnName, line));
    addEdge(file, fileId, fnId, 'defines', edges, edgeIndex);
  }

  for (const pattern of COMMAND_PATTERNS) {
    const matches = source.matchAll(pattern.regex);
    for (const match of matches) {
      const cmdText = match[0].trim();
      const line = lineNumber(source, match.index ?? 0);
      const cmdName = `${pattern.name}:${cmdText.slice(0, 80)}`;
      const cmdId = nodeId(file, 'shell_command', cmdName);
      if (nodes.has(cmdId)) continue;
      nodes.set(
        cmdId,
        makeNode(file, 'shell_command', cmdName, cmdText.slice(0, 120), line, {
          commandType: pattern.name,
          command: cmdText,
        })
      );
      addEdge(file, fileId, cmdId, 'calls', edges, edgeIndex);

      if (pattern.name === 'source') {
        const target = match[1]?.replace(/['"]/g, '');
        if (target) {
          const targetId = nodeId(file, 'concept', `script:${target}`);
          nodes.set(
            targetId,
            makeNode(file, 'concept', `script:${target}`, target, line, { scriptPath: target }, 'INFERRED')
          );
          addEdge(file, cmdId, targetId, 'uses', edges, edgeIndex, 'INFERRED');
        }
      }

      const ipMatch = cmdText.match(/\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/);
      if (ipMatch) {
        const hostLabel = `${ipMatch[1]}${ipMatch[2] ? ':' + ipMatch[2] : ''}`;
        const hostId = nodeId(file, 'concept', `host:${hostLabel}`);
        if (!nodes.has(hostId)) {
          nodes.set(
            hostId,
            makeNode(file, 'concept', `host:${hostLabel}`, hostLabel, line, {
              host: ipMatch[1],
              port: ipMatch[2],
            }, 'INFERRED')
          );
        }
        addEdge(file, cmdId, hostId, 'deploys_to', edges, edgeIndex, 'INFERRED');
      }
    }
  }

  const envAssignments = source.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=(["']?)([^"'\n]*)\2/gm);
  for (const env of envAssignments) {
    const key = env[1];
    const value = env[3];
    const line = lineNumber(source, env.index ?? 0);
    const envId = nodeId(file, 'concept', `env:${key}`);
    nodes.set(
      envId,
      makeNode(file, 'concept', `env:${key}`, `${key}=${value}`, line, { key, value }, 'EXTRACTED')
    );
    addEdge(file, fileId, envId, 'defines', edges, edgeIndex);
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export const bashExtractor: Extractor = {
  id: 'bash',
  name: 'Bash Shell Script',
  extensions: ['sh', 'bash'],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractBash(source, ctx.sourceFile);
  },
};

export function isLikelyShellScript(relativePath: string, source: string): boolean {
  if (/\.(sh|bash)$/i.test(relativePath)) return true;
  if (/^#!\/.*\/(ba)?sh/m.test(source)) return true;
  return false;
}
