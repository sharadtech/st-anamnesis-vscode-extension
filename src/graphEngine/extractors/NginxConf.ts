import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import {
  addEdge,
  ensureFileNode,
  lineNumber,
  makeNode,
  nodeId,
  parseUrlTarget,
} from './utils';

function extractNginx(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const upstreamRegex = /upstream\s+([a-zA-Z0-9_.-]+)\s*\{/gi;
  let upMatch: RegExpExecArray | null;
  while ((upMatch = upstreamRegex.exec(source)) !== null) {
    const upName = upMatch[1];
    const start = upMatch.index;
    const end = source.indexOf('}', start);
    const block = end >= 0 ? source.slice(start, end) : source.slice(start);
    const line = lineNumber(source, start);
    const upId = nodeId(file, 'upstream', upName);
    nodes.set(upId, makeNode(file, 'upstream', upName, `upstream ${upName}`, line));
    addEdge(file, fileId, upId, 'contains', edges, edgeIndex);

    const servers = block.match(/^\s*server\s+([^;]+);/gim) || [];
    for (const srv of servers) {
      const target = parseUrlTarget(srv.replace(/^\s*server\s+/i, '').replace(/;$/, ''));
      const backendLabel = target.host
        ? `${target.scheme || 'http'}://${target.host}${target.port ? ':' + target.port : ''}`
        : srv;
      const backendId = nodeId(file, 'backend', backendLabel);
      nodes.set(backendId, makeNode(file, 'backend', backendLabel, backendLabel, line, target));
      addEdge(file, upId, backendId, 'member_of', edges, edgeIndex);
    }
  }

  const serverRegex = /server\s*\{/gi;
  let srvMatch: RegExpExecArray | null;
  while ((srvMatch = serverRegex.exec(source)) !== null) {
    const start = srvMatch.index;
    const end = findMatchingBrace(source, start + srvMatch[0].indexOf('{'));
    const block = end >= 0 ? source.slice(start, end + 1) : source.slice(start);
    const line = lineNumber(source, start);
    const listenMatch = block.match(/listen\s+(\d+)/i);
    const port = listenMatch?.[1] || '80';
    const ssl = /ssl/i.test(block.slice(0, 200));
    const blockName = `${port}${ssl ? 'ssl' : ''}:${line}`;
    const blockId = nodeId(file, 'server_block', blockName);
    nodes.set(
      blockId,
      makeNode(file, 'server_block', blockName, `server :${port}${ssl ? ' ssl' : ''}`, line, {
        listen: port,
        ssl,
      })
    );
    addEdge(file, fileId, blockId, 'contains', edges, edgeIndex);

    const serverNames = block.match(/server_name\s+([^;]+);/i)?.[1]?.trim().split(/\s+/) || [];
    for (const domain of serverNames) {
      if (!domain || domain === '$host') continue;
      const domainId = nodeId(file, 'domain', domain);
      if (!nodes.has(domainId)) {
        nodes.set(domainId, makeNode(file, 'domain', domain, domain, line));
      }
      addEdge(file, blockId, domainId, 'serves_domain', edges, edgeIndex);
    }

    const sslCert = block.match(/ssl_certificate\s+([^;]+);/i)?.[1]?.trim();
    const sslKey = block.match(/ssl_certificate_key\s+([^;]+);/i)?.[1]?.trim();
    const sslTrusted = block.match(/ssl_trusted_certificate\s+([^;]+);/i)?.[1]?.trim();
    if (sslCert) {
      const certId = nodeId(file, 'ssl_certificate', sslCert);
      nodes.set(
        certId,
        makeNode(file, 'ssl_certificate', sslCert, sslCert.split('/').pop() || sslCert, line, {
          certFile: sslCert,
          keyFile: sslKey,
          trustedFile: sslTrusted,
        })
      );
      addEdge(file, blockId, certId, 'secured_by', edges, edgeIndex);
    }

    const authFile = block.match(/auth_basic_user_file\s+([^;]+);/i)?.[1]?.trim();
    const authRealm = block.match(/auth_basic\s+"([^"]+)"/i)?.[1];
    if (authFile) {
      const credId = nodeId(file, 'credential_store', authFile);
      nodes.set(
        credId,
        makeNode(file, 'credential_store', authFile, authFile.split('/').slice(-2).join('/'), line, {
          authFile,
          authRealm,
        })
      );
      addEdge(file, blockId, credId, 'authenticated_by', edges, edgeIndex);
    }

    const includes = block.match(/include\s+([^;]+);/gi) || [];
    for (const inc of includes) {
      const snippet = inc.match(/include\s+([^;]+);/i)?.[1]?.trim();
      if (!snippet) continue;
      const snippetId = nodeId(file, 'concept', `snippet:${snippet}`);
      nodes.set(snippetId, makeNode(file, 'concept', `snippet:${snippet}`, `include ${snippet}`, line));
      addEdge(file, blockId, snippetId, 'uses', edges, edgeIndex);
    }

    const locations = block.match(/location\s+[^{]+\{/gi) || [];
    for (const locHeader of locations) {
      const locStart = block.indexOf(locHeader);
      const locLine = line + lineNumber(block, locStart) - 1;
      const pattern = locHeader.replace(/\s*\{$/, '').replace(/^location\s+/i, '').trim();
      const locId = nodeId(file, 'location', `${pattern}:${locLine}`);
      nodes.set(locId, makeNode(file, 'location', `${pattern}:${locLine}`, `location ${pattern}`, locLine, { pattern }));
      addEdge(file, blockId, locId, 'contains', edges, edgeIndex);

      const locEnd = block.indexOf('}', block.indexOf(locHeader));
      const locBlock = locEnd >= 0 ? block.slice(block.indexOf(locHeader), locEnd) : block.slice(block.indexOf(locHeader));

      const locAuthOff = /auth_basic\s+off/i.test(locBlock);
      const locAuthFile = locBlock.match(/auth_basic_user_file\s+([^;]+);/i)?.[1]?.trim();
      if (locAuthFile && !locAuthOff) {
        const credId = nodeId(file, 'credential_store', locAuthFile);
        if (!nodes.has(credId)) {
          nodes.set(
            credId,
            makeNode(file, 'credential_store', locAuthFile, locAuthFile.split('/').slice(-2).join('/'), locLine, {
              authFile: locAuthFile,
            })
          );
        }
        addEdge(file, locId, credId, 'authenticated_by', edges, edgeIndex);
      }

      const proxyPass = locBlock.match(/proxy_pass\s+([^;]+);/i)?.[1]?.trim();
      if (proxyPass) {
        if (/^https?:\/\//i.test(proxyPass) || /^wss?:\/\//i.test(proxyPass)) {
          const target = parseUrlTarget(proxyPass);
          const targetLabel = target.host
            ? `${target.scheme || 'http'}://${target.host}${target.port ? ':' + target.port : ''}${target.path || ''}`
            : proxyPass;
          const targetId = nodeId(file, 'proxy_target', targetLabel);
          nodes.set(targetId, makeNode(file, 'proxy_target', targetLabel, targetLabel, locLine, target));
          addEdge(file, locId, targetId, 'proxies_to', edges, edgeIndex);
        } else {
          const upName = proxyPass.replace(/;$/, '').trim();
          const upId = nodeId(file, 'upstream', upName);
          if (!nodes.has(upId)) {
            nodes.set(upId, makeNode(file, 'upstream', upName, `upstream ${upName}`, locLine));
          }
          addEdge(file, locId, upId, 'proxies_to', edges, edgeIndex);
        }
      }
    }

    const blockProxy = block.match(/proxy_pass\s+([^;]+);/i)?.[1]?.trim();
    if (blockProxy && !locations.length) {
      if (/^https?:\/\//i.test(blockProxy)) {
        const target = parseUrlTarget(blockProxy);
        const targetLabel = target.host
          ? `${target.scheme || 'http'}://${target.host}${target.port ? ':' + target.port : ''}${target.path || ''}`
          : blockProxy;
        const targetId = nodeId(file, 'proxy_target', targetLabel);
        nodes.set(targetId, makeNode(file, 'proxy_target', targetLabel, targetLabel, line, target));
        addEdge(file, blockId, targetId, 'proxies_to', edges, edgeIndex);
      } else {
        const upId = nodeId(file, 'upstream', blockProxy);
        if (!nodes.has(upId)) {
          nodes.set(upId, makeNode(file, 'upstream', blockProxy, `upstream ${blockProxy}`, line));
        }
        addEdge(file, blockId, upId, 'proxies_to', edges, edgeIndex);
      }
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

export const nginxConfExtractor: Extractor = {
  id: 'nginx-conf',
  name: 'NGINX Configuration',
  extensions: ['conf'],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractNginx(source, ctx.sourceFile);
  },
};

export function isNginxConfig(relativePath: string, source: string): boolean {
  if (/nginx|upstreams|snippets|sites-available|sites-enabled/i.test(relativePath)) {
    return true;
  }
  if (/\.upstream\.conf$/i.test(relativePath)) {
    return true;
  }
  return /^\s*server\s*\{|upstream\s+\w|proxy_pass|listen\s+\d+/m.test(source);
}
