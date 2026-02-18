export type PriceBand = 'budget' | 'mid' | 'premium' | 'luxury' | 'unknown';

export type Confidence = {
  score: number;
  level: 'low' | 'med' | 'high';
  reasons: string[];
};

export type BlockMeta = {
  generated_at?: string;
  freshness_ttl_hours?: number;
  version?: string;
  confidence?: Confidence;
  evidence?: Record<string, unknown>[];
  missing_fields?: string[];
  warnings?: string[];
  [key: string]: unknown;
};

export type CandidateSource = {
  type: string;
  name?: string;
  url?: string;
};

export type ScoreBreakdown = {
  category_score?: number;
  ingredient_similarity?: number;
  skin_fit_similarity?: number;
  social_reference_score?: number;
  query_overlap_score?: number;
  brand_score?: number;
  [key: string]: number | undefined;
};

export type EvidenceRef = {
  id?: string;
  source_type?: string;
  url?: string;
  excerpt?: string;
  [key: string]: unknown;
};

export type RecoCandidate = {
  product_id?: string;
  sku_id?: string;
  name?: string;
  display_name?: string;
  brand?: string;
  similarity_score?: number;
  why_candidate: string[];
  score_breakdown: ScoreBreakdown;
  source: CandidateSource;
  evidence_refs: EvidenceRef[];
  price_band: PriceBand;
  compare_highlights?: string[];
  [key: string]: unknown;
};

export type RecoBlock = {
  candidates: RecoCandidate[];
  _meta?: BlockMeta;
  [key: string]: unknown;
};

export type RecoBlocksProvenance = {
  generated_at: string;
  contract_version: string;
  pipeline: string;
  source: string;
  validation_mode: string;
  [key: string]: unknown;
};

export type RecoBlocksResponse = {
  competitors: RecoBlock;
  related_products: RecoBlock;
  dupes: RecoBlock;
  confidence_by_block: Record<string, Confidence>;
  provenance: RecoBlocksProvenance;
  missing_info_internal: string[];
  missing_info?: string[];
  [key: string]: unknown;
};
