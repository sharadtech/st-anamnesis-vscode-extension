import type { Extractor, ExtractorContext } from '../Extractor';
import type { ExtractionResult, GraphEdge, GraphNode } from '../types';
import { addEdge, ensureFileNode, lineNumber, makeNode, nodeId } from './utils';

const SKIP_ELEMENTS = new Set([
  'jcr:root',
  'items',
  'columns',
  'column',
  'content',
  'tabs',
  '?xml',
]);

const FORM_RESOURCE_RE = /\/form\/|\/authoring\/dialog/i;

type ContentXmlRole = 'component' | 'dialog' | 'design_dialog' | 'edit_config' | 'clientlib' | 'generic';

interface ParsedElement {
  name: string;
  attrs: Record<string, string>;
  index: number;
}

function parseAttributes(block: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([\w:.]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(block)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseElements(source: string): ParsedElement[] {
  const elements: ParsedElement[] = [];
  const regex = /<(\w+)\s([\s\S]*?)\/>|<(\w+)\s([\s\S]*?)>(?!\s*<\/\3>)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1] || match[3];
    const attrBlock = match[2] || match[4] || '';
    if (!name || SKIP_ELEMENTS.has(name)) continue;
    elements.push({ name, attrs: parseAttributes(attrBlock), index: match.index });
  }
  return elements;
}

function parseRootAttributes(source: string): Record<string, string> {
  const rootMatch = source.match(/<jcr:root\s([\s\S]*?)>/);
  return rootMatch ? parseAttributes(rootMatch[1]) : {};
}

/** Infer AEM component path, e.g. adobexp/components/global/header */
export function inferAemComponentPath(relativeFile: string): string | undefined {
  const m = relativeFile.match(/\/apps\/([^/]+\/components(?:\/[^/]+){1,2})(?:\/|$)/i);
  return m ? m[1] : undefined;
}

function getContentXmlRole(relativeFile: string, rootAttrs: Record<string, string>): ContentXmlRole {
  if (/\/_cq_dialog\/\.content\.xml$/i.test(relativeFile)) return 'dialog';
  if (/\/_cq_design_dialog\/\.content\.xml$/i.test(relativeFile)) return 'design_dialog';
  if (/\/_cq_editConfig\/\.content\.xml$/i.test(relativeFile)) return 'edit_config';
  if (/\/clientlibs?\//i.test(relativeFile)) return 'clientlib';
  if (rootAttrs['jcr:primaryType'] === 'cq:Component') return 'component';
  if (rootAttrs['jcr:primaryType'] === 'cq:ClientLibraryFolder') return 'clientlib';
  if (rootAttrs['sling:resourceType']?.includes('authoring/dialog')) return 'dialog';
  return 'generic';
}

function parseBracketList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function propertyName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.startsWith('./') ? raw.slice(2) : raw;
}

function isDialogField(attrs: Record<string, string>): boolean {
  if (attrs.name?.startsWith('./')) return true;
  const rt = attrs['sling:resourceType'] || '';
  return FORM_RESOURCE_RE.test(rt);
}

function isDialogTab(name: string, attrs: Record<string, string>): boolean {
  if (!attrs['jcr:title']) return false;
  if (isDialogField(attrs)) return false;
  if (attrs.text && attrs.value) return false;
  const rt = attrs['sling:resourceType'] || '';
  return /container|section|fieldset|well|tabs/i.test(rt) || !FORM_RESOURCE_RE.test(rt);
}

function widgetType(attrs: Record<string, string>): string {
  const rt = attrs['sling:resourceType'] || '';
  const leaf = rt.split('/').pop() || 'field';
  return leaf;
}

function ensureComponentNode(
  file: string,
  componentPath: string,
  line: number,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  edgeIndex: { value: number },
  fileId: string,
  extra: Record<string, unknown> = {},
  confidence: 'EXTRACTED' | 'INFERRED' = 'EXTRACTED'
): string {
  const componentId = nodeId(file, 'aem_component', componentPath);
  if (!nodes.has(componentId)) {
    nodes.set(
      componentId,
      makeNode(file, 'aem_component', componentPath, componentPath, line, { componentPath, ...extra }, confidence)
    );
    addEdge(file, fileId, componentId, 'contains', edges, edgeIndex, confidence);
  }
  return componentId;
}

function extractAemContentXml(source: string, file: string): ExtractionResult {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIndex = { value: 0 };
  const fileId = ensureFileNode(file, nodes, edges, edgeIndex);

  const rootAttrs = parseRootAttributes(source);
  const role = getContentXmlRole(file, rootAttrs);
  const componentPath = inferAemComponentPath(file);
  const elements = parseElements(source);

  let componentId: string | undefined;
  if (role === 'component' && componentPath) {
    const title = rootAttrs['jcr:title'] || componentPath.split('/').pop() || 'component';
    componentId = ensureComponentNode(
      file,
      componentPath,
      1,
      nodes,
      edges,
      edgeIndex,
      fileId,
      {
        title,
        componentGroup: rootAttrs.componentGroup,
        description: rootAttrs['jcr:description'],
        resourceSuperType: rootAttrs['sling:resourceSuperType'],
      },
      'EXTRACTED'
    );

    const superType = rootAttrs['sling:resourceSuperType'];
    if (superType) {
      const superId = nodeId(file, 'aem_component', superType);
      nodes.set(
        superId,
        makeNode(file, 'aem_component', superType, superType, 1, { componentPath: superType }, 'INFERRED')
      );
      addEdge(file, componentId, superId, 'inherits_from', edges, edgeIndex, 'INFERRED');
    }
  } else if (componentPath) {
    componentId = ensureComponentNode(file, componentPath, 1, nodes, edges, edgeIndex, fileId, {}, 'INFERRED');
  }

  if (role === 'dialog' || role === 'design_dialog') {
    const dialogTitle = rootAttrs['jcr:title'] || (role === 'design_dialog' ? 'Design Dialog' : 'Dialog');
    const dialogId = nodeId(file, 'aem_dialog', dialogTitle);
    nodes.set(
      dialogId,
      makeNode(file, 'aem_dialog', dialogTitle, dialogTitle, 1, {
        dialogType: role,
        resourceType: rootAttrs['sling:resourceType'],
        extraClientlibs: parseBracketList(rootAttrs.extraClientlibs),
      })
    );
    addEdge(file, fileId, dialogId, 'contains', edges, edgeIndex);
    if (componentId) {
      addEdge(file, componentId, dialogId, 'contains', edges, edgeIndex);
    }

    for (const category of parseBracketList(rootAttrs.extraClientlibs)) {
      const clientlibId = nodeId(file, 'aem_clientlib', category);
      if (!nodes.has(clientlibId)) {
        nodes.set(
          clientlibId,
          makeNode(file, 'aem_clientlib', category, category, 1, { category }, 'INFERRED')
        );
      }
      addEdge(file, dialogId, clientlibId, 'uses_clientlib', edges, edgeIndex);
    }

    let currentTabId = dialogId;
    for (const element of elements) {
      const line = lineNumber(source, element.index);
      const attrs = element.attrs;

      if (isDialogTab(element.name, attrs)) {
        const tabTitle = attrs['jcr:title'] || element.name;
        const tabId = nodeId(file, 'aem_dialog_tab', tabTitle);
        nodes.set(
          tabId,
          makeNode(file, 'aem_dialog_tab', tabTitle, tabTitle, line, { tabName: element.name, tabTitle })
        );
        addEdge(file, dialogId, tabId, 'contains', edges, edgeIndex);
        currentTabId = tabId;
        continue;
      }

      if (!isDialogField(attrs)) continue;

      const fieldLabel = attrs.fieldLabel || element.name;
      const prop = propertyName(attrs.name);
      const fieldId = nodeId(file, 'aem_dialog_field', element.name);
      nodes.set(
        fieldId,
        makeNode(file, 'aem_dialog_field', element.name, fieldLabel, line, {
          fieldName: element.name,
          fieldLabel,
          fieldDescription: attrs.fieldDescription || null,
          widgetType: widgetType(attrs),
          propertyName: prop || null,
          resourceType: attrs['sling:resourceType'],
        })
      );
      addEdge(file, currentTabId, fieldId, 'contains', edges, edgeIndex);

      if (prop) {
        const propId = nodeId(file, 'aem_property', prop);
        if (!nodes.has(propId)) {
          nodes.set(
            propId,
            makeNode(file, 'aem_property', prop, `./${prop}`, line, { propertyName: prop })
          );
        }
        addEdge(file, fieldId, propId, 'defines', edges, edgeIndex);

        const getter = `get${prop.charAt(0).toUpperCase()}${prop.slice(1)}`;
        const modelRefId = nodeId(file, 'concept', `getter:${getter}`);
        if (!nodes.has(modelRefId)) {
          nodes.set(
            modelRefId,
            makeNode(file, 'concept', `getter:${getter}`, getter, line, { getter, propertyName: prop }, 'INFERRED')
          );
        }
        addEdge(file, propId, modelRefId, 'maps_to', edges, edgeIndex, 'INFERRED');
      }
    }
  }

  if (role === 'clientlib') {
    const folderName = file.split('/').slice(-2, -1)[0] || 'clientlib';
    const clientlibId = nodeId(file, 'aem_clientlib', folderName);
    nodes.set(
      clientlibId,
      makeNode(file, 'aem_clientlib', folderName, folderName, 1, {
        categories: parseBracketList(rootAttrs.categories),
        dependencies: parseBracketList(rootAttrs.dependencies),
        primaryType: rootAttrs['jcr:primaryType'],
      })
    );
    addEdge(file, fileId, clientlibId, 'contains', edges, edgeIndex);
    if (componentId) {
      addEdge(file, componentId, clientlibId, 'contains', edges, edgeIndex);
    }
  }

  if (role === 'edit_config') {
    const editId = nodeId(file, 'concept', 'cq:editConfig');
    nodes.set(editId, makeNode(file, 'concept', 'cq:editConfig', 'cq:editConfig', 1));
    addEdge(file, fileId, editId, 'contains', edges, edgeIndex);
    if (componentId) {
      addEdge(file, componentId, editId, 'contains', edges, edgeIndex);
    }
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export const aemContentXmlExtractor: Extractor = {
  id: 'aem-content-xml',
  name: 'AEM Content XML',
  extensions: [],
  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    return extractAemContentXml(source, ctx.sourceFile);
  },
};

/** Detect AEM JCR `.content.xml` files under apps or other JCR content paths. */
export function isAemContentXmlFile(relativePath: string, source: string): boolean {
  if (!relativePath.endsWith('.content.xml')) return false;
  if (/<jcr:root\b/i.test(source)) return true;
  if (/\/apps\/|\/jcr_root\/|\/content\//i.test(relativePath)) return true;
  return false;
}
