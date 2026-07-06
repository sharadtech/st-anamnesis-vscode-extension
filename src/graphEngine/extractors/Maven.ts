import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import { addEdge, ensureFileNode, lineNumber, makeNode, nodeId } from './utils';

const CONTAINER_TAGS = [
  'parent',
  'dependencies',
  'dependencyManagement',
  'build',
  'profiles',
  'modules',
  'reporting',
  'repositories',
  'pluginRepositories',
  'distributionManagement',
  'reporting',
];

/** Read the inner text of the first `<tag>...</tag>` occurrence in a block. */
function tagValue(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
  return m ? m[1].trim() : undefined;
}

/** Return the inner text of the first `<tag>...</tag>` block, if present. */
function firstBlock(source: string, tag: string): { body: string; index: number } | undefined {
  const m = source.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m || m.index === undefined) return undefined;
  return { body: m[1], index: m.index };
}

/** Iterate over every `<tag>...</tag>` block in the source, yielding body + start index. */
function allBlocks(source: string, tag: string): Array<{ body: string; index: number }> {
  const results: Array<{ body: string; index: number }> = [];
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    results.push({ body: match[1], index: match.index });
  }
  return results;
}

function coordinate(groupId: string | undefined, artifactId: string, version?: string): string {
  const g = groupId && groupId.length ? groupId : '(inherited)';
  return version && version.length ? `${g}:${artifactId}:${version}` : `${g}:${artifactId}`;
}

function extractMaven(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  // Strip nested container blocks so the project-level coordinates are not
  // confused with those declared inside <parent>, <dependencies>, etc.
  let header = source;
  for (const t of CONTAINER_TAGS) {
    header = header.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?</${t}>`, 'gi'), '');
  }

  const parentBlock = firstBlock(source, 'parent');
  const parentGroup = parentBlock ? tagValue(parentBlock.body, 'groupId') : undefined;
  const parentArtifact = parentBlock ? tagValue(parentBlock.body, 'artifactId') : undefined;
  const parentVersion = parentBlock ? tagValue(parentBlock.body, 'version') : undefined;

  const artifactId = tagValue(header, 'artifactId');
  const groupId = tagValue(header, 'groupId') || parentGroup;
  const version = tagValue(header, 'version') || parentVersion;
  const packaging = tagValue(header, 'packaging') || 'jar';

  if (!artifactId) {
    // Not a recognizable Maven POM; return just the file node.
    return { nodes: Array.from(nodes.values()), edges };
  }

  const projectCoord = coordinate(groupId, artifactId, version);
  const projectId = nodeId(file, 'maven_project', projectCoord);
  nodes.set(
    projectId,
    makeNode(file, 'maven_project', projectCoord, projectCoord, 1, {
      groupId: groupId ?? null,
      artifactId,
      version: version ?? null,
      packaging,
    })
  );
  addEdge(file, fileId, projectId, 'contains', edges, edgeIndex);

  // Parent POM -> inheritance relationship.
  if (parentArtifact) {
    const parentCoord = coordinate(parentGroup, parentArtifact, parentVersion);
    const parentId = nodeId(file, 'maven_project', parentCoord);
    if (!nodes.has(parentId)) {
      nodes.set(
        parentId,
        makeNode(
          file,
          'maven_project',
          parentCoord,
          parentCoord,
          lineNumber(source, parentBlock?.index ?? 0),
          {
            groupId: parentGroup ?? null,
            artifactId: parentArtifact,
            version: parentVersion ?? null,
          },
          'INFERRED'
        )
      );
    }
    addEdge(file, projectId, parentId, 'inherits_from', edges, edgeIndex);
  }

  // Modules (aggregator POMs).
  const modulesBlock = firstBlock(source, 'modules');
  if (modulesBlock) {
    const moduleTags = modulesBlock.body.match(/<module>\s*([\s\S]*?)\s*<\/module>/gi) || [];
    for (const mod of moduleTags) {
      const name = mod.replace(/<\/?module>/gi, '').trim();
      if (!name) continue;
      const moduleId = nodeId(file, 'maven_module', name);
      nodes.set(
        moduleId,
        makeNode(file, 'maven_module', name, name, lineNumber(source, modulesBlock.index), {
          modulePath: name,
        })
      );
      addEdge(file, projectId, moduleId, 'has_module', edges, edgeIndex);
    }
  }

  // Dependencies (covers <dependencies> and <dependencyManagement>).
  for (const dep of allBlocks(source, 'dependency')) {
    const depArtifact = tagValue(dep.body, 'artifactId');
    if (!depArtifact) continue;
    const depGroup = tagValue(dep.body, 'groupId');
    const depVersion = tagValue(dep.body, 'version');
    const scope = tagValue(dep.body, 'scope') || 'compile';
    const optional = tagValue(dep.body, 'optional') === 'true';
    const coord = coordinate(depGroup, depArtifact, depVersion);
    const depId = nodeId(file, 'maven_dependency', coord);
    if (!nodes.has(depId)) {
      nodes.set(
        depId,
        makeNode(file, 'maven_dependency', coord, coord, lineNumber(source, dep.index), {
          groupId: depGroup ?? null,
          artifactId: depArtifact,
          version: depVersion ?? null,
          scope,
          optional,
        })
      );
    }
    addEdge(file, projectId, depId, 'depends_on', edges, edgeIndex, 'EXTRACTED', { scope });
  }

  // Build plugins.
  for (const plugin of allBlocks(source, 'plugin')) {
    const pluginArtifact = tagValue(plugin.body, 'artifactId');
    if (!pluginArtifact) continue;
    const pluginGroup = tagValue(plugin.body, 'groupId') || 'org.apache.maven.plugins';
    const pluginVersion = tagValue(plugin.body, 'version');
    const coord = coordinate(pluginGroup, pluginArtifact, pluginVersion);
    const pluginId = nodeId(file, 'maven_plugin', coord);
    if (!nodes.has(pluginId)) {
      nodes.set(
        pluginId,
        makeNode(file, 'maven_plugin', coord, coord, lineNumber(source, plugin.index), {
          groupId: pluginGroup,
          artifactId: pluginArtifact,
          version: pluginVersion ?? null,
        })
      );
    }
    addEdge(file, projectId, pluginId, 'builds_with', edges, edgeIndex);
  }

  // Properties.
  const propsBlock = firstBlock(source, 'properties');
  if (propsBlock) {
    const propRegex = /<([A-Za-z0-9_.\-]+)>\s*([\s\S]*?)\s*<\/\1>/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propRegex.exec(propsBlock.body)) !== null) {
      const key = propMatch[1];
      const value = propMatch[2].trim();
      const propId = nodeId(file, 'maven_property', key);
      nodes.set(
        propId,
        makeNode(file, 'maven_property', key, `${key}=${value}`, lineNumber(source, propsBlock.index), {
          key,
          value,
        })
      );
      addEdge(file, projectId, propId, 'defines', edges, edgeIndex);
    }
  }

  // Profiles.
  const profilesBlock = firstBlock(source, 'profiles');
  if (profilesBlock) {
    for (const profile of allBlocks(profilesBlock.body, 'profile')) {
      const profileId = tagValue(profile.body, 'id') || 'default';
      const id = nodeId(file, 'maven_profile', profileId);
      nodes.set(
        id,
        makeNode(file, 'maven_profile', profileId, `profile ${profileId}`, lineNumber(source, profilesBlock.index), {
          profileId,
        })
      );
      addEdge(file, projectId, id, 'contains', edges, edgeIndex);
    }
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export const mavenExtractor: Extractor = {
  id: 'maven',
  name: 'Maven Project',
  extensions: ['pom'],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractMaven(source, ctx.sourceFile);
  },
};

/** Detect Maven POM files (`pom.xml`, module POMs, or `*.pom`). */
export function isMavenPomFile(relativePath: string, source: string): boolean {
  const base = relativePath.split('/').pop()?.toLowerCase() || '';
  if (base === 'pom.xml' || base.endsWith('.pom.xml') || base.endsWith('.pom')) {
    return true;
  }
  // Any .xml file whose root element is a Maven <project> with the POM namespace.
  if (base.endsWith('.xml')) {
    return /<project\b[^>]*maven\.apache\.org\/POM/i.test(source) || /<modelVersion>\s*4\.0\.0/i.test(source);
  }
  return false;
}
