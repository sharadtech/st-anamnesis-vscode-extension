import * as path from 'path';
import * as vscode from 'vscode';
import { setWasmDir } from './graphEngine/TreeSitterLoader';
import './graphEngine/grammars/index';
import { extractRepo } from './graphEngine/ExtractFile';
import { buildGraph, graphToSerialized } from './graphEngine/GraphBuilder';
import { clusterGraph } from './graphEngine/Cluster';
import { createRepo, uploadGraph, config } from './api';

export async function generateAndUpload(
  folderUri: vscode.Uri,
  extensionPath: string
): Promise<string> {
  const { serverUrl, clientId, secretKey } = config();
  if (!serverUrl) {
    throw new Error('No API Base URL configured. Open Anamnesis Settings first.');
  }
  if (!clientId || !secretKey) {
    throw new Error('Client Id and Secret Key are required. Configure them in Anamnesis Settings.');
  }

  const folderPath = folderUri.fsPath;
  const projectName = path.basename(folderPath);

  setWasmDir(path.join(extensionPath, 'dist', 'wasm'));

  const cfg = vscode.workspace.getConfiguration('anamnesis');
  const userExcludes = cfg.get<string[]>('excludeGlobs') || [];
  const filesToExclude = ['dist/', 'build/', 'out/', '.git/', 'node_modules/', ...userExcludes];

  let serialized: ReturnType<typeof graphToSerialized>;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Anamnesis: Creating knowledge graph for "${projectName}"`,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Scanning codebase...' });
      const extraction = await extractRepo(folderPath, filesToExclude);

      progress.report({ message: 'Building graph...' });
      const graph = buildGraph({ companyId: 'vscode', extraction });
      clusterGraph(graph);
      serialized = graphToSerialized(graph, 'vscode');

      progress.report({ message: 'Registering project on server...' });
      await createRepo(projectName);

      progress.report({ message: 'Uploading knowledge graph...' });
      await uploadGraph(projectName, serialized);
    }
  );

  return projectName;
}
