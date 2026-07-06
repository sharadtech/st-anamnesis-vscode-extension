import { TreeSitterExtractor } from '../treeSitter';

export const typeScriptExtractor = new TreeSitterExtractor({
  id: 'typescript',
  name: 'TypeScript',
  extensions: ['ts'],
  grammarPkg: 'tree-sitter-typescript',
  nodeConfig: {
    function: [
      'function_declaration',
      'function_expression',
      'arrow_function',
      'generator_function_declaration',
    ],
    class: ['class_declaration', 'abstract_class_declaration'],
    interface: ['interface_declaration', 'type_alias_declaration'],
    method: ['method_definition', 'method_signature'],
    import: ['import_statement', 'import_declaration'],
    call: ['call_expression'],
  },
});

export const tsxExtractor = new TreeSitterExtractor({
  id: 'tsx',
  name: 'TSX',
  extensions: ['tsx'],
  grammarPkg: 'tree-sitter-tsx',
  nodeConfig: {
    function: [
      'function_declaration',
      'function_expression',
      'arrow_function',
      'generator_function_declaration',
    ],
    class: ['class_declaration', 'abstract_class_declaration'],
    interface: ['interface_declaration', 'type_alias_declaration'],
    method: ['method_definition', 'method_signature'],
    import: ['import_statement', 'import_declaration'],
    call: ['call_expression'],
  },
});
