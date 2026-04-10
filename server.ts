#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
  loadCollection,
  queryItems,
  getItems,
  listCollections,
  getCollection,
} from './collections.ts'
import {
  createSpecSynthesis,
  saveSpec,
  listSpecs,
  getSpec,
} from './specs.ts'
import type { DesignSpec, ResearchItem } from './types.ts'

// ── Server setup ─────────────────────────────────────────────────

const server = new Server(
  { name: 'synth', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Research synthesis server.',
      'Load JSON research collections with synth_load_collection,',
      'query and retrieve items, then create structured design specs',
      'by combining multiple research items.',
      'Generalizable to any domain — trading strategies, API design, etc.',
    ].join(' '),
  },
)

// ── Tool definitions ─────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'synth_load_collection',
      description:
        'Load a JSON research collection into memory. Auto-detects the array of items, ID field, content field, tags, author, and date fields. Returns a summary of the collection including item count and available tags.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the JSON collection file',
          },
          name: {
            type: 'string',
            description: 'Friendly name for the collection (defaults to filename)',
          },
          items_key: {
            type: 'string',
            description: 'Override: key for the items array (auto-detected from first array field)',
          },
          id_field: {
            type: 'string',
            description: 'Override: field name for item IDs (auto-detected)',
          },
          content_field: {
            type: 'string',
            description: 'Override: field name for item content (auto-detected)',
          },
          title_field: {
            type: 'string',
            description: 'Override: field name for item title/summary (auto-detected)',
          },
          tags_field: {
            type: 'string',
            description: 'Override: field name for item tags (auto-detected)',
          },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'synth_query',
      description:
        'Search and filter items across loaded research collections. Supports tag filtering, full-text search, and arbitrary metadata field matching. Returns item summaries (use synth_get_items for full content).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name to search (searches all if omitted)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by tags — items with any matching tag are returned',
          },
          search: {
            type: 'string',
            description: 'Full-text search across title, content, and tags',
          },
          fields: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Filter by metadata field values, e.g. {"platform": "Polymarket"}',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20)',
          },
        },
      },
    },
    {
      name: 'synth_get_items',
      description:
        'Get the full content and metadata of specific items by ID from a loaded collection.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name',
          },
          item_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of item IDs to retrieve',
          },
        },
        required: ['collection', 'item_ids'],
      },
    },
    {
      name: 'synth_create_spec',
      description:
        'Create a structured design spec by synthesising multiple research items. Returns the full source material, cross-reference analysis, and a spec template to complete. Supports combining items from multiple collections.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description: 'Title for the design spec',
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                collection: { type: 'string', description: 'Collection name' },
                item_id: { type: 'string', description: 'Item ID' },
                relevance: { type: 'string', description: 'Why this item is relevant' },
              },
              required: ['collection', 'item_id'],
            },
            description: 'Items to synthesise — can span multiple collections',
          },
          spec_type: {
            type: 'string',
            enum: ['implementation', 'architecture', 'research', 'comparison'],
            description: 'Type of spec to generate (default: implementation)',
          },
          domain: {
            type: 'string',
            description: 'Domain context (e.g. "trading", "web development")',
          },
          focus: {
            type: 'string',
            description: 'Additional constraints or focus areas for the synthesis',
          },
        },
        required: ['title', 'items'],
      },
    },
    {
      name: 'synth_save_spec',
      description:
        'Save a completed design spec to disk as JSON. Creates the output directory if needed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spec: {
            type: 'object',
            description: 'The completed DesignSpec JSON object',
          },
          output_dir: {
            type: 'string',
            description: 'Directory to save in (default: ./specs/)',
          },
        },
        required: ['spec'],
      },
    },
    {
      name: 'synth_list_specs',
      description:
        'List all saved design specs with their title, status, type, and source count.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          directory: {
            type: 'string',
            description: 'Specs directory (default: ./specs/)',
          },
        },
      },
    },
  ],
}))

// ── Tool handlers ────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'synth_load_collection':
        return handleLoadCollection(args)
      case 'synth_query':
        return handleQuery(args)
      case 'synth_get_items':
        return handleGetItems(args)
      case 'synth_create_spec':
        return handleCreateSpec(args)
      case 'synth_save_spec':
        return handleSaveSpec(args)
      case 'synth_list_specs':
        return handleListSpecs(args)
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    }
  }
})

// ── Handler implementations ──────────────────────────────────────

function handleLoadCollection(args: Record<string, unknown>) {
  const filePath = args.file_path as string
  if (!filePath) throw new Error('file_path is required')

  const overrides: Record<string, string | undefined> = {}
  for (const key of ['items_key', 'id_field', 'content_field', 'title_field', 'tags_field']) {
    if (args[key]) overrides[key] = args[key] as string
  }

  const col = loadCollection(filePath, args.name as string | undefined, overrides)

  const lines = [
    `Collection "${col.name}" loaded successfully`,
    `  Items: ${col.item_count}`,
    `  Source: ${col.file_path}`,
    `  Field map: ${JSON.stringify(col.field_map)}`,
    '',
    `  Tags (${col.available_tags.length}): ${col.available_tags.join(', ')}`,
    '',
    '  First 5 items:',
    ...col.items.slice(0, 5).map(
      i => `    [${i.id}] ${i.title}${i.tags.length ? ` (${i.tags.slice(0, 4).join(', ')})` : ''}`,
    ),
    col.item_count > 5 ? `    ... and ${col.item_count - 5} more` : '',
  ]

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
}

function handleQuery(args: Record<string, unknown>) {
  const results = queryItems({
    collection: args.collection as string | undefined,
    tags: args.tags as string[] | undefined,
    search: args.search as string | undefined,
    fields: args.fields as Record<string, string> | undefined,
    limit: args.limit as number | undefined,
  })

  if (results.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No matching items found.' }] }
  }

  const lines = [`Found ${results.length} item(s):`, '']
  for (const { collection, item } of results) {
    lines.push(`[${collection}/${item.id}] ${item.title}`)
    if (item.author) lines.push(`  Author: ${item.author.name}${item.author.handle ? ` (${item.author.handle})` : ''}`)
    if (item.tags.length) lines.push(`  Tags: ${item.tags.join(', ')}`)
    if (item.metadata.strategy_type) lines.push(`  Strategy: ${item.metadata.strategy_type}`)
    if (item.metadata.platform) lines.push(`  Platform: ${item.metadata.platform}`)
    lines.push('')
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
}

function handleGetItems(args: Record<string, unknown>) {
  const collection = args.collection as string
  const itemIds = args.item_ids as string[]
  if (!collection) throw new Error('collection is required')
  if (!itemIds?.length) throw new Error('item_ids is required (non-empty array)')

  const items = getItems(collection, itemIds)

  const lines = items.map(item => {
    const parts = [
      `=== ${item.title} (${item.id}) ===`,
    ]
    if (item.author) {
      parts.push(`Author: ${item.author.name}${item.author.handle ? ` (${item.author.handle})` : ''}`)
      if (item.author.bio) parts.push(`Bio: ${item.author.bio}`)
    }
    if (item.date) parts.push(`Date: ${item.date}`)
    if (item.url) parts.push(`URL: ${item.url}`)
    if (item.tags.length) parts.push(`Tags: ${item.tags.join(', ')}`)
    parts.push('')
    parts.push(item.content)
    parts.push('')

    // Surface all metadata
    for (const [k, v] of Object.entries(item.metadata)) {
      parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }

    return parts.join('\n')
  })

  return { content: [{ type: 'text' as const, text: lines.join('\n\n---\n\n') }] }
}

function handleCreateSpec(args: Record<string, unknown>) {
  const title = args.title as string
  if (!title) throw new Error('title is required')

  const rawItems = args.items as Array<{ collection: string; item_id: string; relevance?: string }>
  if (!rawItems?.length) throw new Error('items is required (non-empty array)')

  // Group items by collection and resolve them
  const byCollection = new Map<string, { ids: string[]; relevance: Record<string, string> }>()
  for (const entry of rawItems) {
    if (!entry.collection || !entry.item_id) {
      throw new Error('Each item must have collection and item_id')
    }
    const existing = byCollection.get(entry.collection) ?? { ids: [], relevance: {} }
    existing.ids.push(entry.item_id)
    if (entry.relevance) existing.relevance[entry.item_id] = entry.relevance
    byCollection.set(entry.collection, existing)
  }

  const sourceGroups: Array<{
    collection: string
    items: ResearchItem[]
    relevance_notes: Record<string, string>
  }> = []

  for (const [collectionName, { ids, relevance }] of byCollection) {
    const items = getItems(collectionName, ids)
    sourceGroups.push({ collection: collectionName, items, relevance_notes: relevance })
  }

  const { synthesis_prompt } = createSpecSynthesis(title, sourceGroups, {
    spec_type: args.spec_type as string | undefined,
    domain: args.domain as string | undefined,
    focus: args.focus as string | undefined,
  })

  return { content: [{ type: 'text' as const, text: synthesis_prompt }] }
}

function handleSaveSpec(args: Record<string, unknown>) {
  const spec = args.spec as DesignSpec
  if (!spec) throw new Error('spec is required')
  if (!spec.spec_id || !spec.title) throw new Error('spec must have spec_id and title')

  const filePath = saveSpec(spec, args.output_dir as string | undefined)

  return {
    content: [{
      type: 'text' as const,
      text: `Spec saved: ${filePath}\n  Title: ${spec.title}\n  Status: ${spec.status}\n  Sources: ${spec.sources?.length ?? 0}`,
    }],
  }
}

function handleListSpecs(args: Record<string, unknown>) {
  const specs = listSpecs(args.directory as string | undefined)

  if (specs.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No saved specs found.' }] }
  }

  const lines = [`${specs.length} saved spec(s):`, '']
  for (const s of specs) {
    lines.push(`[${s.spec_id.substring(0, 8)}] ${s.title}`)
    lines.push(`  Type: ${s.spec_type} | Status: ${s.status} | Sources: ${s.source_count} | Created: ${s.created_date}`)
    lines.push(`  File: ${s.file_path}`)
    lines.push('')
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
}

// ── Transport & lifecycle ────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)

function shutdown() {
  server.close().catch(() => {})
  process.exit(0)
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err: unknown) => {
  process.stderr.write(`Unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`Uncaught exception: ${err.message}\n`)
  shutdown()
})
