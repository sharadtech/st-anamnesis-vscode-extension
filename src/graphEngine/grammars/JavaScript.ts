import { TreeSitterExtractor } from '../treeSitter';

export const javaScriptExtractor = new TreeSitterExtractor({
  id: 'javascript',
  name: 'JavaScript',
  extensions: ['js', 'jsx', 'mjs', 'cjs'],
  grammarPkg: 'tree-sitter-javascript',
  nodeConfig: {
    function: [
      'function_declaration',
      'function_expression',
      'arrow_function',
      'generator_function_declaration',
    ],
    class: ['class_declaration'],
    interface: [],
    method: ['method_definition'],
    import: ['import_statement'],
    call: ['call_expression'],
  },
});
