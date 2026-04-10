# synth-mcp-claude-plugin

Research synthesis MCP server - load research collections, query items, and generate structured design specs.

## What it does

`synth-mcp` is a Model Context Protocol server that turns arbitrary JSON research collections into a searchable knowledge base, then helps synthesize items from one or more collections into structured design specs. It is domain-agnostic: trading strategies, API patterns, UX research, or anything else you can express as a JSON array.

Exposed MCP tools:

- `synth_load_collection` - load a JSON file and auto-detect items/IDs/content/tags fields
- `synth_query` - filter across loaded collections by tags, full-text search, or metadata fields
- `synth_get_items` - fetch full content and metadata for specific item IDs
- `synth_create_spec` - synthesize multiple research items into a structured spec template
- `synth_save_spec` - persist a completed spec as JSON
- `synth_list_specs` - list all saved specs with status and source counts

## Installation

Inside Claude Code:

```
/plugin install goosefly99/synth-mcp-claude-plugin
```

Or clone manually:

```
git clone https://github.com/goosefly99/synth-mcp-claude-plugin.git
cd synth-mcp-claude-plugin
npm install
```

## Configuration

The server registers itself via `.mcp.json` and is launched through `start.mjs`. No environment variables are required for basic operation.

Runtime data:

- `specs/` - default output directory for saved design specs (gitignored)
- `config.local.json` - optional local overrides, never tracked

Collections are loaded on demand by passing an absolute `file_path` to `synth_load_collection`; they are not bundled with the plugin.
