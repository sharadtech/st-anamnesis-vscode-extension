import type { Node } from 'web-tree-sitter';
import type { ExtractorContext, ExtractionResult } from '../Extractor';
import type { GraphNode, GraphEdge } from '../types';
import { TreeSitterExtractor } from '../treeSitter';

const nodeConfig = {
  function: [],
  class: [],
  interface: [],
  method: [],
  import: [],
  call: [],
};

class HtmlExtractor extends TreeSitterExtractor {
  constructor() {
    super({
      id: 'html',
      name: 'HTML',
      extensions: ['html', 'htm'],
      grammarPkg: 'tree-sitter-html',
      nodeConfig,
    });
  }

  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    await this.init();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const fileId = ctx.sourceFile;

    nodes.push({
      id: fileId,
      label: fileId.split('/').pop() || fileId,
      kind: 'file',
      sourceFile: fileId,
      sourceLocation: { file: fileId, line: 1, column: 1 },
      confidence: 'EXTRACTED',
    });

    if (this.parser) {
      try {
        const tree = this.parser.parse(source);
        if (!tree) return extractHtmlFallback(source, ctx, nodes, edges);
        const root = tree.rootNode;
        const tagNodes = root.descendantsOfType('element').filter((t): t is Node => t !== null);
        for (const tag of tagNodes) {
          const startTag = tag.childForFieldName?.('start_tag');
          if (!startTag) continue;
          const nameNode = startTag.childForFieldName?.('tag_name');
          if (!nameNode) continue;
          const tagName = nameNode.text;
          const tagId = `${fileId}#tag:${tagName}:${tag.startPosition.row}`;
          nodes.push({
            id: tagId,
            label: `<${tagName}>`,
            kind: 'tag',
            sourceFile: fileId,
            sourceLocation: {
              file: fileId,
              line: tag.startPosition.row + 1,
              column: tag.startPosition.column + 1,
            },
            confidence: 'EXTRACTED',
          });
          edges.push({
            id: `${fileId}->${tagId}:contains`,
            source: fileId,
            target: tagId,
            relation: 'contains',
            confidence: 'EXTRACTED',
            sourceFile: fileId,
          });

          const attrs = startTag.children.filter(
            (c): c is Node => c !== null && c.type === 'attribute'
          );
          for (const attr of attrs) {
            const attrNameNode = attr.childForFieldName?.('name') ?? attr.firstChild;
            if (!attrNameNode) continue;
            const attrName = attrNameNode.text;
            const attrId = `${tagId}:attr:${attrName}`;
            nodes.push({
              id: attrId,
              label: attrName,
              kind: 'attribute',
              sourceFile: fileId,
              sourceLocation: {
                file: fileId,
                line: attr.startPosition.row + 1,
                column: attr.startPosition.column + 1,
              },
              confidence: 'EXTRACTED',
            });
            edges.push({
              id: `${tagId}->${attrId}:attribute_of`,
              source: tagId,
              target: attrId,
              relation: 'attribute_of',
              confidence: 'EXTRACTED',
              sourceFile: fileId,
            });
          }
        }

        const scriptNodes = root
          .descendantsOfType('script_element')
          .filter((s): s is Node => s !== null);
        for (const script of scriptNodes) {
          const id = `${fileId}#script:${script.startPosition.row}`;
          nodes.push({
            id,
            label: '<script>',
            kind: 'tag',
            sourceFile: fileId,
            sourceLocation: {
              file: fileId,
              line: script.startPosition.row + 1,
              column: script.startPosition.column + 1,
            },
            confidence: 'EXTRACTED',
          });
          edges.push({
            id: `${fileId}->${id}:has_scriptlet`,
            source: fileId,
            target: id,
            relation: 'has_scriptlet',
            confidence: 'EXTRACTED',
            sourceFile: fileId,
          });
        }

        return { nodes, edges };
      } catch {
        return extractHtmlFallback(source, ctx, nodes, edges);
      }
    }

    return extractHtmlFallback(source, ctx, nodes, edges);
  }
}

function extractHtmlFallback(
  source: string,
  ctx: { sourceFile: string },
  nodes: GraphNode[],
  edges: GraphEdge[]
): ExtractionResult {
  const fileId = ctx.sourceFile;
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  let match;
  while ((match = tagRegex.exec(source)) !== null) {
    const tagName = match[1];
    const line = source.slice(0, match.index).split('\n').length;
    const tagId = `${fileId}#tag:${tagName}:${line}`;
    nodes.push({
      id: tagId,
      label: `<${tagName}>`,
      kind: 'tag',
      sourceFile: fileId,
      sourceLocation: { file: fileId, line, column: 1 },
      confidence: 'EXTRACTED',
    });
    edges.push({
      id: `${fileId}->${tagId}:contains`,
      source: fileId,
      target: tagId,
      relation: 'contains',
      confidence: 'EXTRACTED',
      sourceFile: fileId,
    });
  }
  return { nodes, edges };
}

export const htmlExtractor = new HtmlExtractor();
