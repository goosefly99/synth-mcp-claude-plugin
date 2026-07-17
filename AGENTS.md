# AGENTS.md — synth-mcp

## Purpose

`synth-mcp` is a stdio Model Context Protocol server for **research synthesis**.
It turns an arbitrary JSON array of objects into a searchable, in-memory
collection, lets an agent filter and pull items across one or more collections,
and then synthesizes the chosen items into a structured design-spec template.
It is domain-agnostic: trading strategies, API patterns, UX research, or
anything else expressible as a list of records all work the same way.

The server keeps collections **in memory only** for the lifetime of the process
and persists finished specs as JSON files on disk. There is no database and no
background indexing — every query runs against the records currently loaded.

## Launch

The MCP entrypoint is `uv run --directory ${CLAUDE_PLUGIN_ROOT} python -m
synth_mcp`, wired in `.mcp.json`. `uv` resolves dependencies from
`pyproject.toml` / `uv.lock` on first run — no Node, no build step. Requires
Python >= 3.11 and `uv`. No environment variables are required for basic use.

## Tools

Every tool name is prefixed `synth_`. The complete set:

- **`synth_load_collection(file_path, name=None, items_key=None, id_field=None,
  content_field=None, title_field=None, tags_field=None)`** — Read a JSON file
  from `file_path` and register it as a named collection. Auto-detects the items
  array and the id / content / title / tags / author / date / url fields; any of
  those can be overridden. Returns a summary (item count, detected field map,
  available tags, first five items). The collection name defaults to the file
  stem and becomes the handle used by every other tool.
- **`synth_query(collection=None, tags=None, search=None, fields=None,
  limit=20)`** — Filter items across loaded collections. `tags` matches any
  listed tag, `search` is a case-insensitive full-text match over title +
  content + tags, and `fields` matches substrings against per-item metadata.
  Omitting `collection` searches all loaded collections. Returns `collection/id`
  handles with title summaries (capped at `limit`).
- **`synth_get_items(collection, item_ids)`** — Fetch the full content and
  metadata for specific item IDs from one named collection. Errors if the
  collection is not loaded or any ID is missing.
- **`synth_create_spec(title, items, spec_type=None, domain=None, focus=None)`**
  — Synthesize the selected items into a structured spec. `items` is a list of
  `{collection, item_id, relevance?}` references (typically gathered from
  `synth_query`). Returns a synthesis prompt that assembles every source's
  content, performs a cross-reference pass (shared tags, platforms, instruments,
  dependencies), and embeds an empty spec-template JSON for the agent to
  complete. This tool does **not** write anything to disk.
- **`synth_save_spec(spec, output_dir=None)`** — Persist a completed spec object
  as JSON. The `spec` must carry `spec_id` and `title`; the file is named from a
  slug of the title plus a short id and `updated_date` is refreshed on save.
- **`synth_list_specs(directory=None)`** — List saved specs (id, title, status,
  spec_type, source count, created date, file path) from the output directory.

## Primary workflow

1. **Load** one or more collections with `synth_load_collection` (one call per
   source file). Note the returned collection names and available tags.
2. **Discover** relevant records with `synth_query` (by tag, search term, or
   metadata field); collect the `collection/id` handles it returns.
3. **Inspect** full records with `synth_get_items` when you need complete
   content before deciding what to include.
4. **Synthesize** with `synth_create_spec`, passing the chosen
   `{collection, item_id, relevance}` items. Fill in the empty fields of the
   returned template by reasoning over the assembled source material.
5. **Persist** the completed spec object with `synth_save_spec`, and review the
   saved set with `synth_list_specs`.

## Key invariants

- **Collections are in-memory and ephemeral.** They live only for the server
  process and are lost on restart — reload before querying in a new session.
  Re-loading the same name overwrites the prior copy. The store is unbounded by
  default; set `SYNTH_MAX_COLLECTIONS` to a positive integer to evict whole
  least-recently-loaded collections beyond that cap.
- **Items are addressed by their per-collection `id`.** `synth_query` emits
  `collection/id` handles; `synth_get_items` and `synth_create_spec` consume
  those exact ids, scoped to the collection that owns them.
- **`synth_create_spec` produces, it does not save.** It returns a template plus
  synthesis prompt; the agent completes the JSON and calls `synth_save_spec`
  separately to write it.
- **A spec must include `spec_id` and `title` to be saved.** Use the `spec_id`
  generated inside the `synth_create_spec` template rather than inventing one.
- **Output-directory resolution order:** the `SYNTH_OUTPUT_DIR` environment
  variable, then an `output_dir` entry in `config.local.json`, then a `specs`
  directory under the current working directory. Saved specs and
  `config.local.json` are untracked.
- **Domain-agnostic input.** The collection root must be a JSON object whose
  items live in an array; field detection adapts to common naming, so no fixed
  schema is required.
