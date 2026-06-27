# Anamnesis Knowledge Graph

A VS Code extension that visualizes the Anamnesis knowledge graph stored on its cloud Server.

It displays an interactive knowledge graph for AI-Assisted Architecture.

## Key Features

- **Projects tree** — Browse project graphs fetched from the Anamnesis Cloud Server
- **Dual viewer**:
  - **Table view** (default): instant render for large graphs with text filtering.
  - **Graph view**: Cytoscape.js force-directed (cose), circle, grid, concentric, or preset layouts.
- **Node inspection** — Click a node to inspect its label, kind, community, source file, LOC, and neighbors.
- **Click to source** — Open the original source file at the right line directly from the graph or inspector.
- **Settings panel** — Configure the Anamnesis Server URL, API key, and default tag, with a built-in **Test Connection** button.
- **Explorer context menu** — Right-click any file and select **Anamnesis: View in Knowledge Graph** to highlight it in the graph.

## Configuration

Open VS Code settings and search for **Anamnesis**, or open the Anamnesis Settings panel from the Projects view.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `anamnesis.serverUrl` | `string` | `""` | Base URL of the Anamnesis Server (no trailing slash). |
| `anamnesis.apiKey` | `string` | `""` | Bearer token if the server requires authentication. |
| `anamnesis.defaultTag` | `string` | `"default"` | Graph tag to load when none is selected. |

## Anamnesis Server API contract

The extension relies on the Anamnesis Cloud Server to expose the following endpoints. All requests may include `Authorization: Bearer <anamnesis.apiKey>` if an API key is configured.

To generate knowledge for your code repository, create an account on [Anamnesis Cloud](https://www.anamnesis.cloud), upload your Git Repo to be scanned and generate the knowledge graph in no time.


## License

MIT
