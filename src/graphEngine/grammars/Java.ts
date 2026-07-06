import { TreeSitterExtractor } from '../treeSitter';

export const javaExtractor = new TreeSitterExtractor({
  id: 'java',
  name: 'Java',
  extensions: ['java'],
  grammarPkg: 'tree-sitter-java',
  nodeConfig: {
    function: ['method_declaration', 'constructor_declaration'],
    class: ['class_declaration', 'enum_declaration'],
    interface: ['interface_declaration'],
    method: [],
    import: ['import_declaration'],
    call: ['method_invocation'],
  },
});
