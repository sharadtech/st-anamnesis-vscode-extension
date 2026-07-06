export type EntityKind =
  | 'file'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'variable'
  | 'import'
  | 'export'
  | 'tag'
  | 'attribute'
  | 'scriptlet'
  | 'expression'
  | 'module'
  | 'comment'
  | 'concept'
  | 'vhost'
  | 'server_block'
  | 'domain'
  | 'ssl_certificate'
  | 'proxy_target'
  | 'upstream'
  | 'backend'
  | 'credential_store'
  | 'apache_module'
  | 'location'
  | 'pipeline'
  | 'stage'
  | 'shell_function'
  | 'shell_command'
  | 'pipeline_step'
  | 'maven_project'
  | 'maven_module'
  | 'maven_dependency'
  | 'maven_plugin'
  | 'maven_property'
  | 'maven_profile'
  | 'htl_component'
  | 'htl_template'
  | 'htl_use_model'
  | 'htl_include'
  | 'aem_component'
  | 'aem_dialog'
  | 'aem_dialog_tab'
  | 'aem_dialog_field'
  | 'aem_clientlib'
  | 'aem_property';

export type RelationType =
  | 'contains'
  | 'defines'
  | 'imports'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'calls'
  | 'uses'
  | 'references'
  | 'attribute_of'
  | 'child_of'
  | 'has_scriptlet'
  | 'proxies_to'
  | 'secured_by'
  | 'authenticated_by'
  | 'loads_module'
  | 'member_of'
  | 'serves_domain'
  | 'documents'
  | 'deploys_to'
  | 'depends_on'
  | 'runs_stage'
  | 'has_module'
  | 'inherits_from'
  | 'builds_with'
  | 'uses_model'
  | 'includes'
  | 'uses_clientlib'
  | 'maps_to';

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' | 'INJECTED';

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: EntityKind;
  sourceFile: string;
  sourceLocation?: SourceLocation;
  confidence: Confidence;
  community?: number;
  [key: string]: unknown;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  confidence: Confidence;
  sourceFile: string;
  [key: string]: unknown;
}

export interface ExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SerializedGraph {
  version: 1;
  companyId: string;
  builtAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
