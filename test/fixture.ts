/** a.ts: Service.run -> helper ; b.ts: Controller.handle -> Service.run ; c.ts imports a.ts */
export const FIXTURE = {
  version: 1,
  companyId: "vscode",
  builtAt: "2026-01-01T00:00:00Z",
  nodes: [
    { id: "a.ts", label: "a.ts", kind: "file", sourceFile: "a.ts", confidence: "EXTRACTED", community: 0 },
    { id: "a.ts#Service", label: "Service", kind: "class", sourceFile: "a.ts", sourceLocation: { file: "a.ts", line: 3, column: 0 }, confidence: "EXTRACTED", community: 0 },
    { id: "a.ts#Service.run", label: "run", kind: "method", sourceFile: "a.ts", sourceLocation: { file: "a.ts", line: 5, column: 2 }, confidence: "EXTRACTED", community: 0 },
    { id: "a.ts#helper", label: "helper", kind: "function", sourceFile: "a.ts", sourceLocation: { file: "a.ts", line: 20, column: 0 }, confidence: "EXTRACTED", community: 0 },
    { id: "b.ts#Controller", label: "Controller", kind: "class", sourceFile: "b.ts", confidence: "EXTRACTED", community: 1 },
    { id: "b.ts#Controller.handle", label: "handle", kind: "method", sourceFile: "b.ts", sourceLocation: { file: "b.ts", line: 8, column: 2 }, confidence: "EXTRACTED", community: 1 },
    { id: "c.ts", label: "c.ts", kind: "file", sourceFile: "c.ts", confidence: "EXTRACTED", community: 1 },
  ],
  edges: [
    { id: "e1", source: "a.ts", target: "a.ts#Service", relation: "contains", confidence: "EXTRACTED", sourceFile: "a.ts" },
    { id: "e2", source: "a.ts#Service", target: "a.ts#Service.run", relation: "contains", confidence: "EXTRACTED", sourceFile: "a.ts" },
    { id: "e3", source: "a.ts#Service.run", target: "a.ts#helper", relation: "calls", confidence: "EXTRACTED", sourceFile: "a.ts" },
    { id: "e4", source: "b.ts#Controller", target: "b.ts#Controller.handle", relation: "contains", confidence: "EXTRACTED", sourceFile: "b.ts" },
    { id: "e5", source: "b.ts#Controller.handle", target: "a.ts#Service.run", relation: "calls", confidence: "EXTRACTED", sourceFile: "b.ts" },
    { id: "e6", source: "c.ts", target: "a.ts", relation: "imports", confidence: "EXTRACTED", sourceFile: "c.ts" },
  ],
};
