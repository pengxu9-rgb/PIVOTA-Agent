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
  category_use_case_match?: number;
  ingredient_functional_similarity?: number;
  skin_fit_similarity?: number;
  social_reference_strength?: number;
  price_distance?: number;
  brand_constraint?: number;
  quality?: number;
  score_total?: number;
  brand_affinity?: number;
  co_view?: number;
  kb_routine?: number;
  [key: string]: number | undefined;
};

export type EvidenceRef = {
  id?: string;
  source_type?: string;
  url?: string;
  excerpt?: string;
  [key: string]: unknown;
};

export type SocialSummaryUserVisible = {
  themes: string[];
  top_keywords?: string[];
  sentiment_hint?: string;
  volume_bucket: 'low' | 'mid' | 'high' | 'unknown';
};

export type WhyCandidateObject = {
  summary: string;
  reasons_user_visible: string[];
  boundary_user_visible?: string;
};

export type RecoCandidate = {
  product_id?: string;
  sku_id?: string;
  name?: string;
  display_name?: string;
  brand?: string;
  similarity_score?: number;
  why_candidate: WhyCandidateObject | string[];
  score_breakdown: ScoreBreakdown;
  source: CandidateSource;
  evidence_refs: EvidenceRef[];
  price_band: PriceBand;
  social_summary_user_visible?: SocialSummaryUserVisible;
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
  social_channels_used?: string[];
  social_fetch_mode?: "kb_hit" | "async_refresh" | "stale_kb";
  social_fresh_until?: string;
  social_source_version?: string;
  dogfood_mode?: boolean;
  dogfood_features_effective?: {
    interleave?: boolean;
    exploration?: boolean;
    async_rerank?: boolean;
    show_employee_feedback_controls?: boolean;
  };
  interleave?: {
    enabled?: boolean;
    rankerA?: string;
    rankerB?: string;
    [key: string]: unknown;
  };
  async_ticket_id?: string;
  lock_top_n_on_first_paint?: number;
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
