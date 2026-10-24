# Anamnesis Cloud

A VS Code extension that builds, uploads, and visualizes **Anamnesis knowledge graphs** on [Anamnesis Cloud](https://www.anamnesis.cloud). Use it for AI-assisted architecture, dependency analysis, and impact exploration across multi-language codebases.

## What's new

- **AI Context** — Save a Markdown project brief against a project name. Click a row to read it (tables, and Mermaid when a Mermaid extension is installed). Hover for **Copy**, **Edit**, and **Delete**. Chat can create and fetch these records through MCP.
- **Credentials for AI** — Store encrypted key/value credential sets in the sidebar and tag them to one or more Anamnesis projects. Agents can list and decrypt them locally via MCP.
- **Project Prompts** — Manage per-project prompts with **Prompt Parameters**, optional **Skip verification via AI Model**, and a **View** action that renders original, AI-generated, and parameter text as markdown.

## Key features

- **Create knowledge graphs** — Right-click a workspace folder → **Anamnesis: Create Knowledge Graph**
- **Projects tree** — Browse graphs stored on the Anamnesis Cloud Server
- **Project Prompts** — Add, view, edit, and delete prompts for a selected project (parameters + optional skip-AI save)
- **Credentials for AI** — Encrypted named credential sets, multi-project tags, and local MCP tools for agents
- **AI Context** — Markdown briefs stored per project name, with a read-only viewer and MCP tools to save and fetch them from chat
- **Dual viewer**
  - **Table view** (default): fast render and text filtering for large graphs
  - **Graph view**: Cytoscape.js force-directed, circle, grid, concentric, or preset layouts
- **Node inspection** — Label, kind, community, source file, line, and neighbors
- **Click to source** — Open the original file at the correct line from the graph
- **AI tools** — **Install MCP & Skill** (Settings) or **Anamnesis: Enable AI Tools (MCP + Skill)** registers graph MCP plus a localhost **anamnesis-credentials** MCP server and an agent skill. Paths follow the host IDE (Cursor vs VS Code).
- **Settings panel** — Server URL, credentials, default tag, **Test Connection**, **Save**, and **Install MCP & Skill**

## Supported project types

Anamnesis scans a workspace folder and produces **one unified graph** per project. Multiple extractors run in parallel; edges link code, config, build, and documentation layers together.

### Application & backend code

| Project type | Typical repos | What the graph captures |
|--------------|---------------|-------------------------|
| **Node / TypeScript / JavaScript** | SPAs, APIs, VS Code extensions, React/Vue apps | Classes, interfaces, functions, methods, imports, call relationships |
| **Java** | Spring, OSGi, AEM Sling Models, microservices | Classes, interfaces, methods, imports, method invocations |
| **Maven (Java)** | Multi-module Java/Maven monorepos | Project coordinates, parent POM inheritance, modules, dependencies, plugins, properties, profiles — linked to `.java` source nodes |
| **HTML (plain)** | Static sites, non-AEM templates | HTML tags, attributes, script blocks |

**Example:** A Spring Boot repo gets Java class/method graphs **and** Maven module + dependency graphs in the same project graph.

### Adobe Experience Manager (AEM)

| Layer | File patterns | What the graph captures |
|-------|---------------|-------------------------|
| **HTL / Sightly** | `.html` under `apps/.../components/`, or any file with `data-sly-*` | AEM component path, Sling Model bindings (`data-sly-use`), HTL includes/calls, templates, resources |
| **AEM Content XML** | `.content.xml` under component paths | Component metadata, `_cq_dialog` / design dialog, dialog tabs & fields, `fieldLabel` / `fieldDescription`, JCR property names, clientlibs, `sling:resourceSuperType` inheritance |
| **Java (Sling Models)** | `core/src/.../*.java` | Model classes linked from HTL via `uses_model` |
| **Maven** | `ui.apps/pom.xml`, root `pom.xml` | HTL validator plugins, Sling dependencies, module structure |

**Example:** An AEM project like `adobexp` produces a graph connecting `header.html` → `HeaderModel` → `_cq_dialog` fields → `./headerTitle` → Maven modules — enabling AI to find components, dialogs, and models without blind grep.

### Infrastructure & DevOps

| Project type | File patterns | What the graph captures |
|--------------|---------------|-------------------------|
| **Apache Web Server** | `.conf`, `.any` (vhosts, dispatcher farms) | VirtualHosts, domains, SSL certs, proxy targets, balancers, backends, credentials, modules |
| **NGINX** | `.conf`, `.upstream.conf` | Server blocks, domains, upstreams, backends, locations, SSL, snippets |
| **Bash** | `.sh`, `.bash`, shebang scripts | Functions, shell commands, env vars, deploy targets |
| **Jenkins** | `Jenkinsfile`, `Jenkinsfile.*`, `*.jenkinsfile` | Pipelines, stages, steps, environment, deploy servers, Git repos |

Apache and NGINX configs are auto-detected by path (`sites-available`, `nginx`, `upstreams`, etc.) and directive syntax.

### Architecture documentation

| Project type | File patterns | What the graph captures |
|--------------|---------------|-------------------------|
| **Markdown architecture** | `.md` | Projects, modules, API routes, Mermaid flows, cross-project `uses` edges ([st-ck-architecture KG conventions](https://github.com/sharadtech/st-ck-architecture)) |

## Extractors reference

When you run **Anamnesis: Create Knowledge Graph**, these extractors are applied automatically:

| Technology | File patterns | Graph entities |
|------------|---------------|----------------|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | classes, interfaces, functions, methods, imports, calls |
| Java | `.java` | classes, interfaces, methods, imports, invocations |
| Maven | `pom.xml`, `*.pom` | `maven_project`, modules, dependencies, plugins, properties, profiles |
| HTL / Sightly (AEM) | `.html` with `data-sly-*` or under `apps/.../components/` | `htl_component`, `htl_use_model`, `htl_include`, `htl_template`, tags |
| AEM Content XML | `.content.xml` under AEM component paths | `aem_component`, `aem_dialog`, `aem_dialog_tab`, `aem_dialog_field`, `aem_property`, `aem_clientlib` |
| HTML | `.html`, `.htm` (non-HTL) | tags, attributes, script blocks |
| Apache Web Server | `.conf`, `.any` | vhosts, domains, SSL, proxies, backends, modules |
| NGINX Server | `.conf`, `.upstream.conf` | server blocks, upstreams, backends, locations |
| Markdown Architecture | `.md` | projects, modules, API routes, mermaid flows |
| Bash | `.sh`, `.bash`, shebang scripts | functions, commands, env vars, deploy targets |
| Jenkins Pipeline | `Jenkinsfile`, `*.jenkinsfile` | pipeline, stages, steps, environment |

### Auto-detection notes

- **Maven** — Detected by `pom.xml` filename or Maven `<project>` / `modelVersion` in `.xml` files (not generic AEM `.content.xml`).
- **HTL** — Detected when the path is under `apps/.../components/` or the file contains `data-sly-*` directives (takes precedence over plain HTML extraction).
- **AEM `.content.xml`** — Detected for JCR content files under `jcr_root/apps/` (component definition, `_cq_dialog`, clientlibs, edit config).
- **Plain HTML** — Used only when the file is not classified as HTL.

### Recommended scan settings

For Java/Maven/AEM repos, add build output folders to **`anamnesis.excludeGlobs`** to avoid duplicate nodes:

```json
"anamnesis.excludeGlobs": ["target/", "dist/", "node_modules/"]
```

Default excludes already skip `dist/`, `build/`, `out/`, `.git/`, and `node_modules/`.

## Project Prompts

The **Project Prompts** view in the Anamnesis activity bar lists prompts stored for each knowledge-graph project.

- Open a project row (or use **Anamnesis: View Prompts** on a folder) to load that project's prompt table.
- **Add Prompt / Edit** dialog fields:
  - **Title** and **Original Prompt** (required)
  - **Prompt Parameters** — optional values for placeholders or variables in a generic prompt (for example brand, locale, or task constraints)
  - **Skip verification via AI Model** — when checked, the original prompt is stored as-is (`ready`) and the server does **not** generate an AI-improved prompt
- **Actions** on each row:
  - **View** — markdown preview of Original Prompt, AI Generated Prompt, and Prompt Parameters, each with **Copy**
  - **Edit** / **Delete**
- Without skip-AI, create/update still queues AI improvement of the original prompt on the Anamnesis server.

## Credentials for AI

The **Credentials for AI** view stores named key/value sets for agents (database URLs, API tokens, environment secrets, and similar). Ciphertext is saved on Anamnesis Cloud; values are decrypted only inside the extension.

- Toolbar **+** opens **Add Credentials**. Click an unlocked set to edit it. Click a locked set to open it read-only, with **Copy** on every field.
- Each row has **Copy name**, **Lock** or **Unlock**, and **Delete**. Delete is hidden while the set is locked.
- The editor has **Save**, **Cancel**, **Lock** / **Unlock**, and **Delete**. **Delete** stays disabled until the set is unlocked.
- Each set has a name, one or more key/value pairs, and optional **Project tags**.
- Tag a set with **multiple** Anamnesis projects so the same credentials apply across graphs. Older single-tag sets still load.
- After **Install MCP & Skill**, the agent in the current IDE can call:
  - `list_credential_sets` — names and metadata (no secret values)
  - `get_credentials(name)` — decrypt a named set locally and return key/value pairs
- Prefer a set whose project tags include the current graph when more than one match exists.

## AI Context

The **AI Context** view stores one Markdown brief per project name. The text lives on Anamnesis Cloud and is what an agent loads when you ask it to fetch that project.

- Toolbar **+** opens **New AI Context**. **Refresh** reloads the list.
- The form has **Project name**, an **AI Context** text area, **Save**, and **Cancel**. Saving the same project name again replaces the previous text.
- Click a saved row to open it **read-only**. The project name is a heading. The body is rendered as Markdown, including tables.
- Mermaid fences in that view are drawn when Cursor or VS Code already has a Mermaid Markdown extension installed. Without one, those fences stay as code.
- Hover a row for:
  - **Copy** — copies the project name
  - **Edit** — opens the form. The row click does not open the editor
  - **Delete**

After **Install MCP & Skill**, the **anamnesis** MCP server exposes:

| Tool | What it does |
|------|----------------|
| `context-save(project, context)` | Creates or replaces the AI Context record for that project name |
| `get_project_context(key)` | Returns the stored Markdown brief |
| `list_project_contexts` | Lists project names and a short preview |
| `save_project_context(key, context)` | Same save as `context-save`, with the project name passed as `key` |

The installed skill treats these sentences as that workflow:

- **Create Anamnesis Context for the project : \<project path\> and store it against the project name = \<project name\>** — read that path (graph first, then the files) and call `context-save`
- **Use Anamnesis to create AI Context for this conversation against the project name = \<project name\>** — save the current conversation brief
- **Use Anamnesis and store the Context Information of the project against the key = \<KeyName\>** — same save, using the key as the project name
- **Use Anamnesis and fetch the project context against the key = \<KeyName\>** — call `get_project_context` and use the returned text as the working brief

**Install MCP & Skill** detects the running IDE and writes only that IDE’s files:

| IDE | MCP config | Skill |
|-----|------------|--------|
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills/anamnesis/SKILL.md` |
| Visual Studio Code | User `mcp.json` (for example `~/Library/Application Support/Code/User/mcp.json` on macOS) | `~/.copilot/skills/anamnesis/SKILL.md` |

The settings page shows the detected IDE and those two paths before you install.

## Quick start

1. Install the extension and open **Anamnesis** in the activity bar.
2. Configure **Anamnesis Settings** (Server URL, Client Id, Secret Key from [Anamnesis Cloud](https://www.anamnesis.cloud)). Use **Install MCP & Skill** so the current IDE (Cursor or VS Code) gets the graph MCP server and Anamnesis skill.
3. Right-click a project folder in the Explorer → **Anamnesis: Create Knowledge Graph**.
4. Open the project from the **Projects** tree to explore the graph.
5. Use **Project Prompts** to add reusable prompts (with parameters, or skip AI generation).
6. Use **Credentials for AI** to store encrypted secrets tagged to one or more projects.
7. Use **AI Context** to save a Markdown brief for a project, or ask chat to create one with `context-save` after **Install MCP & Skill**.
8. Optional: if you skipped the Settings button, run **Anamnesis: Enable AI Tools (MCP + Skill)** from the command palette. The same installer detects Cursor vs VS Code and writes the matching MCP config and skill files.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `anamnesis.serverUrl` | `https://apigateway.anamnesis.cloud` | API base URL (no trailing slash) |
| `anamnesis.clientId` | `""` | Client Id from Anamnesis Settings → View Credentials |
| `anamnesis.secretKey` | `""` | Secret Key from Anamnesis Settings → View Credentials |
| `anamnesis.defaultTag` | `"default"` | Default graph tag when none is selected |
| `anamnesis.excludeGlobs` | `[]` | Extra path prefixes to skip during graph generation |

## Anamnesis Cloud

Graphs are stored on Anamnesis Cloud. Create an account at [anamnesis.cloud](https://www.anamnesis.cloud), configure credentials in the extension, and upload graphs directly from VS Code.

## License

MIT
