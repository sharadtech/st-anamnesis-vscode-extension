import { Parser, Language, type Node, type Point } from 'web-tree-sitter';
import type { Extractor, ExtractorContext, ExtractionResult } from './Extractor';
import type { GraphNode, GraphEdge } from './types';
import { loadLanguage, createParser } from './TreeSitterLoader';

export interface TreeSitterNodeConfig {
  function: string[];
  class: string[];
  interface: string[];
  method: string[];
  import: string[];
  call: string[];
}

export interface TreeSitterGrammarConfig {
  id: string;
  name: string;
  extensions: readonly string[];
  grammarPkg: string;
  nodeConfig: TreeSitterNodeConfig;
}

function cleanIdentifier(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 256);
}

function nodeId(file: string, kind: string, name: string): string {
  return `${file}#${kind}:${name}`;
}

export class TreeSitterExtractor implements Extractor {
  readonly id: string;
  readonly name: string;
  readonly extensions: readonly string[];
  private readonly grammarPkg: string;
  private readonly nodeConfig: TreeSitterNodeConfig;
  private language: Language | undefined;
  protected parser: Parser | undefined;

  constructor(config: TreeSitterGrammarConfig) {
    this.id = config.id;
    this.name = config.name;
    this.extensions = config.extensions;
    this.grammarPkg = config.grammarPkg;
    this.nodeConfig = config.nodeConfig;
  }

  async init(): Promise<void> {
    if (this.language) return;
    this.language = await loadLanguage(this.grammarPkg);
    if (this.language) {
      this.parser = createParser(this.language);
    }
  }

  async extract(source: string, ctx: ExtractorContext): Promise<ExtractionResult> {
    await this.init();
    if (!this.parser) {
      return { nodes: [], edges: [] };
    }

    const tree = this.parser.parse(source);
    if (!tree) return { nodes: [], edges: [] };
    const root = tree.rootNode;
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    const ensureFileNode = () => {
      if (!nodes.has(ctx.sourceFile)) {
        nodes.set(ctx.sourceFile, {
          id: ctx.sourceFile,
          label: ctx.sourceFile.split('/').pop() || ctx.sourceFile,
          kind: 'file',
          sourceFile: ctx.sourceFile,
          sourceLocation: { file: ctx.sourceFile, line: 1, column: 1 },
          confidence: 'EXTRACTED',
        });
      }
    };

    const addNode = (
      kind: 'class' | 'interface' | 'function' | 'method' | 'import',
      name: string,
      loc: Point
    ): string => {
      const id = nodeId(ctx.sourceFile, kind, name);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: name,
          kind,
          sourceFile: ctx.sourceFile,
          sourceLocation: { file: ctx.sourceFile, line: loc.row + 1, column: loc.column + 1 },
          confidence: 'EXTRACTED',
        });
      }
      return id;
    };

    const addEdge = (
      source: string,
      target: string,
      relation: GraphEdge['relation'],
      confidence: GraphEdge['confidence'] = 'EXTRACTED'
    ): void => {
      edges.push({
        id: `${source}->${target}:${relation}:${edges.length}`,
        source,
        target,
        relation,
        confidence,
        sourceFile: ctx.sourceFile,
      });
    };

    const findName = (node: Node): string | undefined => {
      const nameNode = node.childForFieldName?.('name') ?? node.childForFieldName?.('function');
      if (nameNode) return cleanIdentifier(nameNode.text);
      const identifiers = (node.descendantsOfType?.('identifier') ?? []).filter(
        (n): n is Node => n !== null
      );
      for (const child of identifiers) {
        if (child.parent?.id === node.id) return cleanIdentifier(child.text);
      }
      return undefined;
    };

    const findCalleeName = (node: Node): string | undefined => {
      const func = node.childForFieldName?.('function');
      if (!func) return undefined;
      if (func.type === 'identifier') return cleanIdentifier(func.text);
      if (func.type === 'member_expression') {
        const prop = func.childForFieldName?.('property');
        if (prop) return cleanIdentifier(prop.text);
      }
      const funcIds = (func.descendantsOfType?.('identifier') ?? []).filter(
        (n): n is Node => n !== null
      );
      const firstId = funcIds[0];
      if (firstId) return cleanIdentifier(firstId.text);
      return undefined;
    };

    const findImportSource = (node: Node): string | undefined => {
      const stringNodes = (
        node.descendantsOfType?.('string_fragment') ??
        node.descendantsOfType?.('string') ??
        node.descendantsOfType?.('scoped_identifier') ??
        []
      ).filter((n): n is Node => n !== null);
      const txt = stringNodes[0]?.text ?? '';
      return txt.replace(/['"]/g, '').trim() || undefined;
    };

    const scopeStack: { kind: string; id: string; name: string }[] = [];

    const isType = (node: Node, kinds: string[]) => kinds.includes(node.type);

    const walk = (node: Node) => {
      const cfg = this.nodeConfig;
      const parent = scopeStack.length ? scopeStack[scopeStack.length - 1] : undefined;

      if (isType(node, cfg.class)) {
        const name = findName(node) || '<anonymous>';
        const id = addNode('class', name, node.startPosition);
        ensureFileNode();
        if (parent) addEdge(parent.id, id, 'contains');
        else addEdge(ctx.sourceFile, id, 'contains');
        scopeStack.push({ kind: 'class', id, name });
      } else if (isType(node, cfg.interface)) {
        const name = findName(node) || '<interface>';
        const id = addNode('interface', name, node.startPosition);
        ensureFileNode();
        if (parent) addEdge(parent.id, id, 'contains');
        else addEdge(ctx.sourceFile, id, 'contains');
        scopeStack.push({ kind: 'interface', id, name });
      } else if (isType(node, cfg.function)) {
        const name = findName(node) || '<anonymous>';
        const id = addNode('function', name, node.startPosition);
        ensureFileNode();
        if (parent) addEdge(parent.id, id, 'contains');
        else addEdge(ctx.sourceFile, id, 'contains');
        scopeStack.push({ kind: 'function', id, name });
      } else if (isType(node, cfg.method)) {
        const name = findName(node) || '<method>';
        const id = addNode('method', name, node.startPosition);
        ensureFileNode();
        if (parent && (parent.kind === 'class' || parent.kind === 'interface'))
          addEdge(parent.id, id, 'defines');
        else if (parent) addEdge(parent.id, id, 'contains');
        else addEdge(ctx.sourceFile, id, 'contains');
        scopeStack.push({ kind: 'method', id, name });
      } else if (isType(node, cfg.import)) {
        const source = findImportSource(node);
        if (source) {
          const id = addNode('import', source, node.startPosition);
          addEdge(ctx.sourceFile, id, 'imports');
        }
      } else if (isType(node, cfg.call)) {
        const callee = findCalleeName(node);
        if (callee) {
          let targetId = nodeId(ctx.sourceFile, 'function', callee);
          if (!nodes.has(targetId)) {
            nodes.set(targetId, {
              id: targetId,
              label: callee,
              kind: 'function',
              sourceFile: ctx.sourceFile,
              sourceLocation: {
                file: ctx.sourceFile,
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
              },
              confidence: 'INFERRED',
            });
          }
          const src = parent ? parent.id : ctx.sourceFile;
          addEdge(src, targetId, 'calls', 'INFERRED');
        }
      }

      for (const child of node.children) {
        if (child === null) continue;
        walk(child);
      }

      if (
        isType(node, cfg.class) ||
        isType(node, cfg.interface) ||
        isType(node, cfg.function) ||
        isType(node, cfg.method)
      ) {
        scopeStack.pop();
      }
    };

    walk(root);

    return {
      nodes: Array.from(nodes.values()),
      edges,
    };
  }
}
