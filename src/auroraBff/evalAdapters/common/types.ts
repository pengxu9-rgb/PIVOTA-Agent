export type EvalCoordSpace = 'image_px' | 'face_crop_norm_v1';

export type GtMask = {
  kind: 'segmentation';
  label_map?: Record<string, number | number[]>;
  mask_path?: string;
  rle?: string;
  width?: number;
  height?: number;
  coord_space: EvalCoordSpace;
};

export type DerivedGtModule = {
  module_id:
    | 'forehead'
    | 'left_cheek'
    | 'right_cheek'
    | 'nose'
    | 'chin'
    | 'under_eye_left'
    | 'under_eye_right';
  polygon_norm?: { points: Array<{ x: number; y: number }>; closed: true };
  mask_rle_norm?: string;
  coord_space: 'face_crop_norm_v1';
};

export type EvalSample = {
  dataset: 'lapa' | 'celebamaskhq' | 'fasseg' | 'acne04';
  sample_id: string;
  image_bytes_path: string;
  gt_masks: GtMask[];
  gt_parts: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
