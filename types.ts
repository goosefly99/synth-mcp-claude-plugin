// ── Collection types ──────────────────────────────────────────────

/** Field mapping that describes how to read a generic JSON collection */
export interface FieldMap {
  items_key: string
  id_field: string
  content_field: string
  title_field: string
  tags_field: string
  author_field?: string
  date_field?: string
  url_field?: string
}

/** A normalized research item extracted from any collection */
export interface ResearchItem {
  id: string
  title: string
  content: string
  url?: string
  date?: string
  author?: {
    name: string
    handle?: string
    bio?: string
  }
  tags: string[]
  /** All fields not captured by the primary field map */
  metadata: Record<string, unknown>
}

/** An in-memory loaded research collection */
export interface ResearchCollection {
  name: string
  file_path: string
  loaded_at: string
  item_count: number
  items: ResearchItem[]
  field_map: FieldMap
  raw_metadata: Record<string, unknown>
  available_tags: string[]
}

// ── Spec types ────────────────────────────────────────────────────

export interface SpecSource {
  collection: string
  item_id: string
  title: string
  relevance: string
}

export interface SpecComponent {
  name: string
  purpose: string
  inputs: string[]
  outputs: string[]
  dependencies: string[]
}

export interface SpecPhase {
  phase: number
  name: string
  tasks: string[]
  deliverables: string[]
}

export interface SpecRisk {
  description: string
  severity: 'low' | 'medium' | 'high'
  mitigation: string
}

export type SpecType = 'implementation' | 'architecture' | 'research' | 'comparison'
export type SpecStatus = 'draft' | 'review' | 'approved' | 'implemented'

/** A structured design specification synthesised from research items */
export interface DesignSpec {
  spec_id: string
  title: string
  created_date: string
  updated_date: string
  version: string
  status: SpecStatus
  domain?: string
  spec_type: SpecType

  sources: SpecSource[]

  overview: {
    description: string
    objectives: string[]
    constraints: string[]
    assumptions: string[]
  }

  architecture: {
    components: SpecComponent[]
    data_flow: string
    integration_points: string[]
  }

  implementation: {
    phases: SpecPhase[]
    tech_stack: string[]
    complexity: 'low' | 'medium' | 'high'
  }

  risks: SpecRisk[]
  success_criteria: string[]
  notes: string
}
