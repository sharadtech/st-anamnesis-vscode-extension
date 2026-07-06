import { Parser, Language } from 'web-tree-sitter';
import path from 'path';
import fs from 'fs/promises';

let initialized = false;
let wasmDir: string | undefined;

const GRAMMAR_FILES: Record<string, string> = {
  'tree-sitter-java': 'tree-sitter-java.wasm',
  'tree-sitter-javascript': 'tree-sitter-javascript.wasm',
  'tree-sitter-typescript': 'tree-sitter-typescript.wasm',
  'tree-sitter-tsx': 'tree-sitter-tsx.wasm',
  'tree-sitter-html': 'tree-sitter-html.wasm',
};

export function setWasmDir(dir: string): void {
  wasmDir = dir;
}

export function getWasmDir(): string | undefined {
  return wasmDir;
}

export async function ensureParser(): Promise<typeof Parser> {
  if (!initialized) {
    const dir = wasmDir || path.join(__dirname, 'wasm');
    await Parser.init({
      locateFile(scriptName: string) {
        return path.join(dir, scriptName);
      },
    });
    initialized = true;
  }
  return Parser;
}

export async function loadLanguage(grammarPkg: string): Promise<Language | undefined> {
  await ensureParser();
  const fileName = GRAMMAR_FILES[grammarPkg];
  if (!fileName) return undefined;
  const dir = wasmDir || path.join(__dirname, 'wasm');
  const wasmPath = path.join(dir, fileName);
  try {
    await fs.access(wasmPath);
    return Language.load(wasmPath);
  } catch {
    return undefined;
  }
}

export function createParser(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
