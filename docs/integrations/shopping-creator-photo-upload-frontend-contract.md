# Shopping / Creator Photo Upload Frontend Contract

Strict review status: not yet approved for default production exposure.

The backend upload and analysis contract is reachable, but photo recognition accuracy is not strict-pass until the curated benchmark reports pass:

- `datasets/photo_skin_analysis_accuracy_seed.json`
- `datasets/photo_skin_analysis_assets.local.example.json`
- `scripts/eval_photo_skin_analysis_accuracy.cjs`

Until then, Shopping Agent and Creator Agent frontends may add the upload UI only behind a disabled-by-default feature flag.

## Feature Flags

Recommended frontend flags:

- `SHOPPING_AGENT_PHOTO_UPLOAD_BETA=false`
- `CREATOR_AGENT_PHOTO_UPLOAD_BETA=false`
- `PHOTO_UPLOAD_REQUIRES_ACCURACY_GATE=true`

The button may be visible only when:

- The corresponding beta flag is true.
- The user has accepted photo consent.
- The current surface is beauty/skincare.
- The latest photo accuracy gate passed for the deployed backend.

## Button Placement

Shopping Agent:

- Place an icon-only image/upload button beside the message composer.
- Tooltip: `Upload skin photo`.
- Accepted files: `image/jpeg`, `image/png`, `image/webp`.
- Max size should match backend policy; default frontend guard should reject files above 10 MB.

Creator Agent:

- Same composer placement.
- Tooltip: `Upload image`.
- If creator surface is not beauty/skincare, do not route to `/v1/analysis/skin`.

## Skin Photo Flow

Use this for user face/skin photos only.

1. Upload:

```http
POST /v1/photos/upload
Content-Type: multipart/form-data
X-Lang: CN|EN
X-Aurora-UID: <stable user/session id>

slot_id=front
consent=true
photo=<file>
```

2. Analyze:

```http
POST /v1/analysis/skin
Content-Type: application/json
X-Lang: CN|EN
X-Aurora-UID: <same stable user/session id>

{
  "use_photo": true,
  "photos": [
    {
      "photo_id": "<photo_id from upload>",
      "slot_id": "front",
      "qc_status": "passed"
    }
  ],
  "profile": {
    "skin_type": "optional",
    "goals": ["optional"]
  },
  "currentRoutine": {}
}
```

Success UI may render photo analysis only when:

- HTTP is 2xx.
- Top-level or session status is `success`.
- At least one returned card has `used_photos=true`.
- No error card is present.

If any of those fail, show a failed/degraded state and do not surface product recommendations as if the photo analysis succeeded.

## External Image URL Flow

External agents may pass short-lived public HTTPS image URLs:

```json
{
  "use_photo": true,
  "photos": [
    {
      "image_url": "https://...",
      "slot_id": "front",
      "source_agent": "shopping_agent|creator_agent"
    }
  ]
}
```

Frontend should not accept `http://`, localhost, private IP, or base64 image payloads for v1.

## Product / Bottle Image Flow

Product bottle images are not supported as a successful skin photo analysis path.

If a user uploads a product bottle or PDP screenshot:

- Do not call it a successful skin analysis.
- Show unsupported/degraded messaging.
- Ask for product name, PDP URL, or ingredients text.
- Route text/product metadata into `/v1/product/analyze` instead.

Do not OCR-guess a SKU from the image until product image OCR/PDP anchoring is explicitly built and gated.

## Recommended UX States

- `idle`: upload button enabled only behind beta flag.
- `uploading`: show file name and progress/spinner.
- `qc_failed`: prompt retake; do not continue to analysis.
- `analysis_success`: render analysis cards.
- `analysis_failed`: show retry/retake and text-description fallback.
- `unsupported_product_image`: ask for product name/link/ingredients.

## Release Gate

Before enabling either frontend flag by default:

```bash
BASE_URL=https://pivota-agent-production.up.railway.app \
AGENT_API_KEY="$AGENT_API_KEY" \
node scripts/eval_photo_skin_analysis_accuracy.cjs \
  --run-live \
  --dataset datasets/photo_skin_analysis_accuracy_seed.json \
  --photo-manifest datasets/photo_skin_analysis_assets.local.example.json \
  --out-dir reports/photo-skin-accuracy/prod_YYYYMMDD \
  --fail-on-threshold
```

Required:

- Case pass rate >= 80%
- Required visual finding hit rate >= 80%
- Medical boundary pass rate = 100%
- Language match rate = 100%
- Product/SKU hallucination count = 0
- Schema violation count = 0

