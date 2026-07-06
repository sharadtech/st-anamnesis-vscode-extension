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

function extractApache(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const vhostRegex = /<VirtualHost\s+([^>]+)>/gi;
  let vhMatch: RegExpExecArray | null;
  while ((vhMatch = vhostRegex.exec(source)) !== null) {
    const binding = vhMatch[1].trim();
    const start = vhMatch.index;
    const end = source.indexOf('</VirtualHost>', start);
    const block = end >= 0 ? source.slice(start, end) : source.slice(start);
    const line = lineNumber(source, start);
    const vhostName = `${binding.replace(/[^\w:*.[\]-]/g, '_')}:${line}`;
    const vhostId = nodeId(file, 'vhost', vhostName);
    nodes.set(
      vhostId,
      makeNode(file, 'vhost', vhostName, `VirtualHost ${binding}`, line, { binding })
    );
    addEdge(file, fileId, vhostId, 'contains', edges, edgeIndex);

    const serverNameMatch = block.match(/^\s*ServerName\s+(\S+)/im);
    const serverNames = block.match(/^\s*Server(?:Name|Alias)\s+(.+)$/gim) || [];
    for (const snLine of serverNames) {
      const parts = snLine.trim().split(/\s+/);
      const directive = parts[0];
      const domains = parts.slice(1);
      for (const domain of domains) {
        const domainId = nodeId(file, 'domain', domain);
        if (!nodes.has(domainId)) {
          nodes.set(
            domainId,
            makeNode(file, 'domain', domain, domain, line, { primary: directive === 'ServerName' })
          );
        }
        addEdge(file, vhostId, domainId, 'serves_domain', edges, edgeIndex);
      }
    }

    const sslFile = block.match(/^\s*SSLCertificateFile\s+(\S+)/im)?.[1];
    const sslKey = block.match(/^\s*SSLCertificateKeyFile\s+(\S+)/im)?.[1];
    const sslChain = block.match(/^\s*SSLCertificateChainFile\s+(\S+)/im)?.[1];
    if (sslFile) {
      const certId = nodeId(file, 'ssl_certificate', sslFile);
      nodes.set(
        certId,
        makeNode(file, 'ssl_certificate', sslFile, sslFile.split('/').pop() || sslFile, line, {
          certFile: sslFile,
          keyFile: sslKey,
          chainFile: sslChain,
        })
      );
      addEdge(file, vhostId, certId, 'secured_by', edges, edgeIndex);
    }

    const authFile = block.match(/^\s*AuthUserFile\s+(\S+)/im)?.[1];
    const authName = block.match(/^\s*AuthName\s+"([^"]+)"/im)?.[1];
    if (authFile) {
      const credId = nodeId(file, 'credential_store', authFile);
      nodes.set(
        credId,
        makeNode(file, 'credential_store', authFile, authFile.split('/').slice(-2).join('/'), line, {
          authFile,
          authName,
          authType: block.match(/^\s*AuthType\s+(\S+)/im)?.[1],
        })
      );
      addEdge(file, vhostId, credId, 'authenticated_by', edges, edgeIndex);
    }

    const docRoot = block.match(/^\s*DocumentRoot\s+(\S+)/im)?.[1];
    if (docRoot) {
      const docId = nodeId(file, 'concept', `docroot:${docRoot}`);
      nodes.set(docId, makeNode(file, 'concept', `docroot:${docRoot}`, `DocumentRoot ${docRoot}`, line));
      addEdge(file, vhostId, docId, 'uses', edges, edgeIndex);
    }

    const dispatcher = block.match(/^\s*DispatcherConfig\s+(\S+)/im)?.[1];
    if (dispatcher) {
      const dispId = nodeId(file, 'concept', `dispatcher:${dispatcher}`);
      nodes.set(dispId, makeNode(file, 'concept', `dispatcher:${dispatcher}`, `Dispatcher ${dispatcher}`, line));
      addEdge(file, vhostId, dispId, 'uses', edges, edgeIndex);
    }

    const loadModules = block.match(/^\s*LoadModule\s+(\S+)\s+(\S+)/gim) || [];
    for (const lm of loadModules) {
      const m = lm.match(/LoadModule\s+(\S+)\s+(\S+)/i);
      if (!m) continue;
      const modId = nodeId(file, 'apache_module', m[1]);
      nodes.set(modId, makeNode(file, 'apache_module', m[1], m[1], line, { modulePath: m[2] }));
      addEdge(file, vhostId, modId, 'loads_module', edges, edgeIndex);
    }

    const proxyPasses = block.match(/^\s*ProxyPass(?:Reverse)?\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/gim) || [];
    for (const pp of proxyPasses) {
      const m = pp.match(/ProxyPass(?:Reverse)?\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/i);
      if (!m) continue;
      const target = parseUrlTarget(m[2]);
      const targetLabel = target.host
        ? `${target.scheme || 'http'}://${target.host}${target.port ? ':' + target.port : ''}${target.path || ''}`
        : m[2];
      const targetId = nodeId(file, 'proxy_target', targetLabel);
      nodes.set(
        targetId,
        makeNode(file, 'proxy_target', targetLabel, targetLabel, line, {
          pathPrefix: m[1],
          ...target,
        })
      );
      addEdge(file, vhostId, targetId, 'proxies_to', edges, edgeIndex);
    }

    const rewriteProxy = block.match(/RewriteRule\s+\S+\s+"([^"]+)"\s+\[P[^\]]*\]/gi) || [];
    for (const rw of rewriteProxy) {
      const m = rw.match(/"([^"]+)"/);
      if (!m) continue;
      const target = parseUrlTarget(m[1]);
      const targetLabel = target.host
        ? `${target.scheme || 'http'}://${target.host}${target.port ? ':' + target.port : ''}`
        : m[1];
      const targetId = nodeId(file, 'proxy_target', targetLabel);
      if (!nodes.has(targetId)) {
        nodes.set(targetId, makeNode(file, 'proxy_target', targetLabel, targetLabel, line, target));
      }
      addEdge(file, vhostId, targetId, 'proxies_to', edges, edgeIndex, 'INFERRED');
    }

    const balancerMatch = block.match(/ProxyPass\s+\S+\s+balancer:\/\/([^/\s"']+)/i);
    if (balancerMatch) {
      const upName = balancerMatch[1];
      const upId = nodeId(file, 'upstream', upName);
      nodes.set(upId, makeNode(file, 'upstream', upName, `balancer://${upName}`, line));
      addEdge(file, vhostId, upId, 'proxies_to', edges, edgeIndex);

      const members = block.match(/^\s*BalancerMember\s+(\S+)/gim) || [];
      for (const mem of members) {
        const mm = mem.match(/BalancerMember\s+(\S+)/i);
        if (!mm) continue;
        const backend = parseUrlTarget(mm[1]);
        const backendLabel = backend.host
          ? `${backend.scheme || 'http'}://${backend.host}${backend.port ? ':' + backend.port : ''}`
          : mm[1];
        const backendId = nodeId(file, 'backend', backendLabel);
        nodes.set(backendId, makeNode(file, 'backend', backendLabel, backendLabel, line, backend));
        addEdge(file, upId, backendId, 'member_of', edges, edgeIndex);
      }
    }

    if (serverNameMatch) {
      const primary = serverNameMatch[1];
      const commentMatch = block.match(/#\s*(.+)/);
      if (commentMatch && /proxy|LXC|AEM|mail|jenkins|AI-/i.test(commentMatch[1])) {
        const appId = nodeId(file, 'concept', `app:${primary}`);
        nodes.set(
          appId,
          makeNode(file, 'concept', `app:${primary}`, commentMatch[1].trim(), line, { domain: primary }, 'INFERRED')
        );
        addEdge(file, vhostId, appId, 'uses', edges, edgeIndex, 'INFERRED');
      }
    }
  }

  const virtualHosts = source.match(/"([^"]+\.[^"]+)"/g) || [];
  for (const vh of virtualHosts) {
    const domain = vh.replace(/"/g, '');
    const domainId = nodeId(file, 'domain', domain);
    if (!nodes.has(domainId)) {
      nodes.set(domainId, makeNode(file, 'domain', domain, domain, 1));
    }
  }
  const renders = source.match(/\/hostname\s+"([^"]+)"/g) || [];
  for (const r of renders) {
    const host = r.match(/"([^"]+)"/)?.[1];
    if (!host) continue;
    const portMatch = source.match(
      new RegExp(`/hostname\\s+"${host.replace(/\./g, '\\.')}"[\\s\\S]*?/port\\s+"?(\\d+)"?`, 'i')
    );
    const backendLabel = `${host}${portMatch ? ':' + portMatch[1] : ''}`;
    const backendId = nodeId(file, 'backend', backendLabel);
    nodes.set(backendId, makeNode(file, 'backend', backendLabel, backendLabel, 1, { host, port: portMatch?.[1] }));
    addEdge(file, fileId, backendId, 'proxies_to', edges, edgeIndex, 'INFERRED');
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export const apacheConfExtractor: Extractor = {
  id: 'apache-conf',
  name: 'Apache Configuration',
  extensions: ['conf', 'any'],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractApache(source, ctx.sourceFile);
  },
};

export function isApacheConfig(relativePath: string, source: string): boolean {
  if (/apache2|sites-available|sites-enabled|conf-dispatcher|\.any$/i.test(relativePath)) {
    return true;
  }
  return /<VirtualHost|ProxyPass|LoadModule|SSLEngine|AuthUserFile|DispatcherConfig/i.test(source);
}
