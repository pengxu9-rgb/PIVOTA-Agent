export type RecoDogfoodConfig = {
  dogfood_mode: boolean;
  exploration: {
    enabled: boolean;
    rate_per_block: number;
    max_explore_items: number;
  };
  ui: {
    show_employee_feedback_controls: boolean;
    allow_block_internal_rerank_on_async: boolean;
    lock_top_n_on_first_paint: number;
  };
  retrieval: {
    pool_size: {
      competitors: number;
      dupes: number;
      related_products: number;
    };
  };
  interleave: {
    enabled: boolean;
    rankerA: string;
    rankerB: string;
  };
  async: {
    poll_ttl_ms: number;
  };
};
