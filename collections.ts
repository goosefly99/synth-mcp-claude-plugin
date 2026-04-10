import { readFileSync } from 'node:fs'
import type { ResearchCollection, ResearchItem, FieldMap } from './types.ts'

// ── In-memory store ──────────────────────────────────────────────

const collections = new Map<string, ResearchCollection>()

// ── Public API ───────────────────────────────────────────────────

/**
 * Load a JSON research collection, auto-detect its schema,
 * normalise every item, and store it in memory for subsequent queries.
 */
export function loadCollection(
  filePath: string,
  name?: string,
  fieldOverrides?: Partial<FieldMap>,
): ResearchCollection {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  const fieldMap = detectFieldMap(raw, fieldOverrides)
  const rawItems: unknown[] = raw[fieldMap.items_key] ?? []

  const items = rawItems.map((item, idx) =>
    normalizeItem(item as Record<string, unknown>, fieldMap, idx),
  )

  const collectionName = name ?? deriveCollectionName(filePath)

  const collection: ResearchCollection = {
    name: collectionName,
    file_path: filePath,
    loaded_at: new Date().toISOString(),
    item_count: items.length,
    items,
    field_map: fieldMap,
    raw_metadata: (raw.metadata as Record<string, unknown>) ?? {},
    available_tags: [...new Set(items.flatMap(i => i.tags))].sort(),
  }

  collections.set(collectionName, collection)
  return collection
}

/** Search / filter items across one or all loaded collections. */
export function queryItems(options: {
  collection?: string
  tags?: string[]
  search?: string
  fields?: Record<string, string>
  limit?: number
}): Array<{ collection: string; item: ResearchItem }> {
  const results: Array<{ collection: string; item: ResearchItem }> = []
  const limit = options.limit ?? 20

  const targets: ResearchCollection[] = options.collection
    ? [collections.get(options.collection)].filter(Boolean) as ResearchCollection[]
    : [...collections.values()]

  if (targets.length === 0) {
    throw new Error(
      options.collection
        ? `Collection '${options.collection}' not loaded. Use synth_load_collection first.`
        : 'No collections loaded. Use synth_load_collection first.',
    )
  }

  for (const col of targets) {
    for (const item of col.items) {
      if (!matchesFilters(item, options)) continue
      results.push({ collection: col.name, item })
      if (results.length >= limit) return results
    }
  }

  return results
}

/** Retrieve full content of specific items by ID. */
export function getItems(
  collectionName: string,
  itemIds: string[],
): ResearchItem[] {
  const col = collections.get(collectionName)
  if (!col) throw new Error(`Collection '${collectionName}' not loaded`)

  return itemIds.map(id => {
    const item = col.items.find(i => i.id === id)
    if (!item) throw new Error(`Item '${id}' not found in collection '${collectionName}'`)
    return item
  })
}

/** Return summary info for all loaded collections. */
export function listCollections(): Array<{
  name: string
  item_count: number
  file_path: string
  loaded_at: string
  available_tags: string[]
}> {
  return [...collections.values()].map(c => ({
    name: c.name,
    item_count: c.item_count,
    file_path: c.file_path,
    loaded_at: c.loaded_at,
    available_tags: c.available_tags,
  }))
}

export function getCollection(name: string): ResearchCollection | undefined {
  return collections.get(name)
}

// ── Field-map auto-detection ─────────────────────────────────────

const ID_CANDIDATES     = ['id', 'tweet_id', 'post_id', 'article_id', 'item_id', 'uid', 'key']
const CONTENT_CANDIDATES = ['content', 'body', 'text', 'description', 'full_text', 'article_text']
const TITLE_CANDIDATES   = ['summary', 'title', 'name', 'headline', 'subject']
const TAGS_CANDIDATES    = ['tags', 'categories', 'labels', 'keywords', 'topics']
const AUTHOR_CANDIDATES  = ['profile', 'author', 'user', 'creator', 'poster']
const DATE_CANDIDATES    = ['date', 'created_at', 'published', 'timestamp', 'published_at', 'created']
const URL_CANDIDATES     = ['url', 'link', 'href', 'source_url', 'permalink']

function firstMatch(keys: string[], candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (keys.includes(c)) return c
  }
  // Fallback: check for suffix patterns (e.g. any key ending in _id)
  return undefined
}

function detectFieldMap(
  data: Record<string, unknown>,
  overrides?: Partial<FieldMap>,
): FieldMap {
  // Find the items array — first array-valued key that isn't 'metadata'
  const arrayKeys = Object.keys(data).filter(
    k => Array.isArray(data[k]) && (data[k] as unknown[]).length > 0,
  )
  const items_key = overrides?.items_key ?? arrayKeys[0] ?? 'items'

  const sample = ((data[items_key] as unknown[]) ?? [])[0] as Record<string, unknown> | undefined
  const keys = sample ? Object.keys(sample) : []

  return {
    items_key,
    id_field:      overrides?.id_field      ?? firstMatch(keys, ID_CANDIDATES) ?? keys.find(k => k.endsWith('_id')) ?? 'id',
    content_field: overrides?.content_field ?? firstMatch(keys, CONTENT_CANDIDATES) ?? 'content',
    title_field:   overrides?.title_field   ?? firstMatch(keys, TITLE_CANDIDATES) ?? firstMatch(keys, CONTENT_CANDIDATES) ?? 'content',
    tags_field:    overrides?.tags_field    ?? firstMatch(keys, TAGS_CANDIDATES) ?? 'tags',
    author_field:  overrides?.author_field  ?? firstMatch(keys, AUTHOR_CANDIDATES),
    date_field:    overrides?.date_field    ?? firstMatch(keys, DATE_CANDIDATES),
    url_field:     overrides?.url_field     ?? firstMatch(keys, URL_CANDIDATES),
  }
}

// ── Item normalisation ───────────────────────────────────────────

function normalizeItem(
  raw: Record<string, unknown>,
  fieldMap: FieldMap,
  index: number,
): ResearchItem {
  const id = String(raw[fieldMap.id_field] ?? index)

  // Author — handle both string and object shapes
  let author: ResearchItem['author'] = undefined
  if (fieldMap.author_field && raw[fieldMap.author_field] != null) {
    const a = raw[fieldMap.author_field]
    if (typeof a === 'string') {
      author = { name: a }
    } else if (typeof a === 'object' && a !== null) {
      const obj = a as Record<string, unknown>
      author = {
        name: String(obj.display_name ?? obj.name ?? obj.username ?? 'Unknown'),
        handle: obj.handle != null ? String(obj.handle) : obj.username != null ? String(obj.username) : undefined,
        bio: obj.bio != null ? String(obj.bio) : obj.description != null ? String(obj.description) : undefined,
      }
    }
  }

  // Tags — coerce to string array
  let tags: string[] = []
  const rawTags = raw[fieldMap.tags_field]
  if (Array.isArray(rawTags)) {
    tags = rawTags.map(String)
  } else if (rawTags != null) {
    tags = [String(rawTags)]
  }

  // Content
  const content = raw[fieldMap.content_field] != null ? String(raw[fieldMap.content_field]) : ''

  // Title — fall back to first 120 chars of content
  const rawTitle = raw[fieldMap.title_field]
  const title = rawTitle != null && rawTitle !== content
    ? String(rawTitle)
    : content.length > 120
      ? content.substring(0, 120) + '...'
      : content || `Item ${index}`

  // Metadata — everything not captured by primary fields
  const primaryFields = new Set([
    fieldMap.id_field,
    fieldMap.content_field,
    fieldMap.title_field,
    fieldMap.tags_field,
    fieldMap.author_field,
    fieldMap.date_field,
    fieldMap.url_field,
  ].filter(Boolean) as string[])

  const metadata: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!primaryFields.has(k)) metadata[k] = v
  }

  return {
    id,
    title,
    content,
    url: fieldMap.url_field ? (raw[fieldMap.url_field] as string | undefined) : undefined,
    date: fieldMap.date_field ? (raw[fieldMap.date_field] as string | undefined) : undefined,
    author,
    tags,
    metadata,
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function matchesFilters(
  item: ResearchItem,
  options: { tags?: string[]; search?: string; fields?: Record<string, string> },
): boolean {
  // Tag filter — item must have at least one matching tag
  if (options.tags?.length) {
    const lower = item.tags.map(t => t.toLowerCase())
    if (!options.tags.some(t => lower.includes(t.toLowerCase()))) return false
  }

  // Full-text search — case-insensitive substring in title, content, or tags
  if (options.search) {
    const needle = options.search.toLowerCase()
    const haystack = [item.title, item.content, ...item.tags].join(' ').toLowerCase()
    if (!haystack.includes(needle)) return false
  }

  // Arbitrary field filter — checks metadata values
  if (options.fields) {
    for (const [k, v] of Object.entries(options.fields)) {
      const val = String(item.metadata[k] ?? '')
      if (!val.toLowerCase().includes(v.toLowerCase())) return false
    }
  }

  return true
}

function deriveCollectionName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  const fileName = parts[parts.length - 1]!
  return fileName.replace(/\.json$/i, '')
}
