import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { DesignSpec, ResearchItem, SpecSource, SpecType } from './types.ts'

// ── Configurable output directory ───────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadOutputDir(): string {
  // 1. Environment variable takes highest priority
  if (process.env.SYNTH_OUTPUT_DIR) {
    return resolve(process.env.SYNTH_OUTPUT_DIR)
  }

  // 2. Local config file (not committed to git)
  const configPath = join(__dirname, 'config.local.json')
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { output_dir?: string }
      if (config.output_dir) return resolve(config.output_dir)
    } catch {
      // Ignore malformed config, fall through to default
    }
  }

  // 3. Default: relative ./specs directory
  return resolve('./specs')
}

const OUTPUT_DIR = loadOutputDir()

// ── Spec creation ────────────────────────────────────────────────

/**
 * Build a synthesis prompt containing:
 * - Full source material from all selected items
 * - Cross-reference analysis (shared tags, deps, platforms)
 * - A blank spec template pre-wired with source references
 *
 * Claude fills in the template using the source material.
 */
export function createSpecSynthesis(
  title: string,
  sourceGroups: Array<{
    collection: string
    items: ResearchItem[]
    relevance_notes?: Record<string, string>
  }>,
  options: {
    spec_type?: string
    domain?: string
    focus?: string
  } = {},
): { template: DesignSpec; synthesis_prompt: string } {
  const specId = randomUUID()
  const now = new Date().toISOString().split('T')[0]!

  // Flatten all items with collection context
  const allItems = sourceGroups.flatMap(g =>
    g.items.map(item => ({
      item,
      collection: g.collection,
      relevance: g.relevance_notes?.[item.id] ?? '',
    })),
  )

  // ── Source references for the spec ──
  const specSources: SpecSource[] = allItems.map(({ item, collection, relevance }) => ({
    collection,
    item_id: item.id,
    title: item.title,
    relevance,
  }))

  // ── Formatted source material ──
  const sourceContent = allItems
    .map(({ item, collection }) => {
      const lines: string[] = [
        `=== Source: ${item.title} ===`,
        `Collection: ${collection} | ID: ${item.id}`,
      ]
      if (item.author) {
        lines.push(`Author: ${item.author.name}${item.author.handle ? ` (${item.author.handle})` : ''}`)
        if (item.author.bio) lines.push(`Bio: ${item.author.bio}`)
      }
      if (item.date) lines.push(`Date: ${item.date}`)
      if (item.url) lines.push(`URL: ${item.url}`)
      if (item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`)
      lines.push('')
      lines.push(item.content)

      // Surface domain-specific metadata
      const domainKeys = [
        'strategy_type', 'instrument', 'platform', 'dependencies',
        'engagement', 'embedded_content', 'has_article_content',
      ]
      for (const k of domainKeys) {
        if (item.metadata[k] != null) {
          const v = item.metadata[k]
          lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        }
      }

      return lines.join('\n')
    })
    .join('\n\n---\n\n')

  // ── Cross-reference analysis ──
  const tagCounts = new Map<string, number>()
  allItems.forEach(({ item }) =>
    item.tags.forEach(t => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)),
  )
  const sharedTags = [...tagCounts.entries()]
    .filter(([, c]) => c > 1)
    .sort(([, a], [, b]) => b - a)
    .map(([t, c]) => `${t} (${c})`)

  const allDeps = new Set<string>()
  const allPlatforms = new Set<string>()
  const allInstruments = new Set<string>()
  allItems.forEach(({ item }) => {
    const deps = item.metadata.dependencies
    if (Array.isArray(deps)) deps.forEach(d => allDeps.add(String(d)))
    if (item.metadata.platform) allPlatforms.add(String(item.metadata.platform))
    if (item.metadata.instrument) allInstruments.add(String(item.metadata.instrument))
  })

  // ── Blank spec template ──
  const template: DesignSpec = {
    spec_id: specId,
    title,
    created_date: now,
    updated_date: now,
    version: '1.0',
    status: 'draft',
    domain: options.domain,
    spec_type: (options.spec_type as SpecType) ?? 'implementation',
    sources: specSources,
    overview: {
      description: '',
      objectives: [],
      constraints: options.focus ? [options.focus] : [],
      assumptions: [],
    },
    architecture: {
      components: [],
      data_flow: '',
      integration_points: [...allDeps, ...allPlatforms],
    },
    implementation: {
      phases: [],
      tech_stack: [...allDeps],
      complexity: 'medium',
    },
    risks: [],
    success_criteria: [],
    notes: '',
  }

  // ── Assemble synthesis prompt ──
  const synthesis = [
    `# Design Spec Synthesis: ${title}`,
    '',
    `**Spec ID:** ${specId}`,
    `**Type:** ${options.spec_type ?? 'implementation'}`,
    options.domain ? `**Domain:** ${options.domain}` : null,
    options.focus ? `**Focus:** ${options.focus}` : null,
    '',
    `## Source Material (${allItems.length} items from ${sourceGroups.length} collection(s))`,
    '',
    sourceContent,
    '',
    '## Cross-Reference Analysis',
    '',
    `**Shared tags:** ${sharedTags.join(', ') || 'None'}`,
    `**Platforms:** ${[...allPlatforms].join(', ') || 'None'}`,
    `**Instruments:** ${[...allInstruments].join(', ') || 'None'}`,
    `**Dependencies:** ${[...allDeps].join(', ') || 'None'}`,
    '',
    '## Spec Template',
    '',
    'Complete this spec by synthesising the source material above.',
    'Fill in all empty strings and arrays. Return the full JSON object.',
    '',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
  ]
    .filter(line => line !== null)
    .join('\n')

  return { template, synthesis_prompt: synthesis }
}

// ── Spec persistence ─────────────────────────────────────────────

export function saveSpec(spec: DesignSpec, outputDir?: string): string {
  const dir = outputDir ? resolve(outputDir) : OUTPUT_DIR
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Use a slug of the title for the filename
  const slug = spec.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60)
  const fileName = `${slug}--${spec.spec_id.substring(0, 8)}.json`
  const filePath = join(dir, fileName)

  spec.updated_date = new Date().toISOString().split('T')[0]!
  writeFileSync(filePath, JSON.stringify(spec, null, 2), 'utf-8')
  return filePath
}

export function listSpecs(
  directory?: string,
): Array<{
  spec_id: string
  title: string
  created_date: string
  status: string
  spec_type: string
  source_count: number
  file_path: string
}> {
  const dir = directory ? resolve(directory) : OUTPUT_DIR
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => {
      const filePath = join(dir, f)
      try {
        const spec = JSON.parse(readFileSync(filePath, 'utf-8')) as DesignSpec
        return {
          spec_id: spec.spec_id,
          title: spec.title,
          created_date: spec.created_date,
          status: spec.status,
          spec_type: spec.spec_type,
          source_count: spec.sources.length,
          file_path: filePath,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean) as Array<{
    spec_id: string
    title: string
    created_date: string
    status: string
    spec_type: string
    source_count: number
    file_path: string
  }>
}

export function getSpec(
  specId: string,
  directory?: string,
): DesignSpec | null {
  const dir = directory ? resolve(directory) : OUTPUT_DIR
  if (!existsSync(dir)) return null

  // Search all JSON files for matching spec_id
  const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'))
  for (const f of files) {
    const filePath = join(dir, f)
    try {
      const spec = JSON.parse(readFileSync(filePath, 'utf-8')) as DesignSpec
      if (spec.spec_id === specId) return spec
    } catch {
      continue
    }
  }
  return null
}
