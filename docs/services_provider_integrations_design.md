# Services Provider Integrations — Design

Status: draft · Author: Claude (Sonnet) · 2026-05-28
Scope: how Pivota moves from manual-relay bookings (Stage 1) to direct
integration with provider SaaS platforms (Stage 2+), without changing the
traveler-facing booking flow.

## 1. Context

Stage 1 (live) is the **manual-relay tier**: a traveler submits a request, the
backend stores a `service_bookings` row, and Pivota notifies the provider via
KakaoTalk Alimtalk (the `bookings/notifierAdapters/*` modules). A human confirms
and the booking transitions through `requested → confirmed | declined | expired`.

The integration question: how do we let some providers confirm/availability-check
*automatically* through their existing booking SaaS (Naver Booking, Kakao
Hairshop, Vagaro, Mindbody, Square, Fresha) while leaving the traveler UX and the
manual tier untouched for everyone else.

### The seam that already exists

- `service_providers.source` (TEXT) — currently `'scrape'`. Stage 2 plugs each
  platform in as a new `source` value (`'mindbody'`, `'naver_booking'`, …).
- `service_bookings` is already `source`-agnostic — it stores the request and a
  status machine, not platform-specific fields.
- `bookings/notifier.js` already demonstrates the **adapter registry** pattern we
  reuse below: a frozen map of `{ channel, modulePath, apiKeyEnv }` + transient /
  permanent error classes + a `manual_ops` fallback.

Nothing in the traveler flow changes across tiers. Only what happens *after*
"Send request" differs: ops relays (T1) vs. deep-link handoff (T2) vs. live API
write (T3).

## 2. Capability tiers

| Tier | Mechanism | Confirmation | Platforms (realistic) |
|------|-----------|--------------|------------------------|
| **T1 manual_relay** | Pivota messages provider; human logs reply | ~24h SLA, human | any provider, no API |
| **T2 deep_link** | Prefilled deep-link into the platform's own booking page | platform-native | Naver Booking, Kakao Hairshop, Booksy |
| **T3 api** | OAuth + REST: read availability, write booking, webhook confirm | instant, real inventory | Mindbody, Vagaro, Square Appointments, Fresha (partner) |

Platform reality check (drives sequencing):
- **Mindbody / Square / Vagaro** — full public booking APIs (availability + create
  + webhooks). True T3. Best-documented → build the adapter contract here first.
- **Fresha** — partner API, gated. T2→T3 once a partnership is signed.
- **Naver Booking / Kakao Hairshop** (KR pilot targets) — no open public booking
  API. Realistically T2 (deep-link) until a B2B data partnership unlocks feeds.

## 3. Schema: `provider_integrations`

One row per (provider, platform) binding. Capability is explicit so the booking
path can branch without guessing. Migration `049_provider_integrations.sql`.

```sql
CREATE TABLE IF NOT EXISTS provider_integrations (
  integration_id        UUID PRIMARY KEY,
  provider_id           UUID NOT NULL REFERENCES service_providers(provider_id) ON DELETE CASCADE,
  platform              TEXT NOT NULL,                 -- 'mindbody' | 'square' | 'vagaro' | 'naver_booking' | 'kakao_hairshop' | 'fresha'
  capability            TEXT NOT NULL DEFAULT 'manual_relay',  -- 'manual_relay' | 'deep_link' | 'api'
  external_provider_id  TEXT,                          -- the platform's own id for this provider/location
  deep_link_template    TEXT,                          -- T2: URL template w/ {listing}/{date}/{time} placeholders
  auth_ref              TEXT,                           -- T3: opaque ref into secret store (NOT raw tokens)
  listing_id_map        JSONB NOT NULL DEFAULT '{}'::JSONB,  -- pivota listing_id -> platform service id
  status                TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'paused' | 'revoked'
  last_synced_at        TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active binding per provider+platform.
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_integrations_active
  ON provider_integrations (provider_id, platform)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_provider_integrations_platform
  ON provider_integrations (platform, capability, status);
```

Design notes:
- **`auth_ref`, not raw tokens.** OAuth tokens live in the secret store
  (Railway env / a vault); the table holds only an opaque reference. Mirrors how
  notifier API keys are pulled from `process.env`, never persisted.
- **`listing_id_map`** bridges Pivota `service_listings.listing_id` →
  platform service id, so a T3 `createBooking` knows which platform SKU to book.
- **`capability` is the dispatch key.** The booking path reads it to decide relay
  vs. deep-link vs. API. Absent row ⇒ implicit `manual_relay` (back-compat).

## 4. Adapter interface

Mirror `bookings/notifier.js`: a frozen registry + a uniform async contract +
shared transient/permanent error classes. New directory:
`src/services/bookings/integrationAdapters/`.

```js
// integrationAdapters/index.js
const PLATFORMS = Object.freeze({
  mindbody:       { capability: 'api',       module: './mindbody',  apiKeyEnv: 'SERVICES_MINDBODY_API_KEY' },
  square:         { capability: 'api',       module: './square',    apiKeyEnv: 'SERVICES_SQUARE_API_KEY' },
  vagaro:         { capability: 'api',       module: './vagaro',    apiKeyEnv: 'SERVICES_VAGARO_API_KEY' },
  naver_booking:  { capability: 'deep_link', module: './naverBooking' },
  kakao_hairshop: { capability: 'deep_link', module: './kakaoHairshop' },
});
```

Every adapter implements the same contract (T2 adapters implement only the subset
they can; the rest throw `IntegrationUnsupportedError`):

```ts
interface ProviderIntegrationAdapter {
  readonly platform: string;
  readonly capability: 'deep_link' | 'api';

  // T3 only — real-time availability for a listing on a date.
  getAvailability(args: {
    integration: ProviderIntegrationRow;
    listingId: string;
    date: string;          // YYYY-MM-DD, provider-local
  }): Promise<Array<{ start: string; end: string }>>;  // ISO-8601, +09:00 for KR

  // T2 — build the prefilled handoff URL. T3 — write the booking.
  buildDeepLink?(args: {
    integration: ProviderIntegrationRow;
    listingId: string;
    requestedSlot: string; // ISO-8601
  }): string;

  // T3 only — write a real booking, return the platform's confirmation.
  createBooking(args: {
    integration: ProviderIntegrationRow;
    booking: ServiceBookingRow;       // our row, already persisted as 'requested'
  }): Promise<{ externalBookingId: string; status: 'confirmed' | 'pending' }>;

  cancelBooking?(args: {
    integration: ProviderIntegrationRow;
    externalBookingId: string;
  }): Promise<void>;
}
```

Shared error classes (copy the notifier pattern verbatim so the retry/worker
logic is identical):
- `IntegrationTransientError` — retryable (timeout, 5xx, rate limit).
- `IntegrationPermanentError` — do not retry (auth revoked, slot gone, bad map).
- `IntegrationUnsupportedError` — capability not implemented → fall back to T1.

## 5. How the booking path branches

`createBooking` in `bookings/api.js` stays the single entry point. After the row
is inserted as `requested`, dispatch on the provider's integration capability:

```
insert service_bookings row (status='requested')
  └─ look up active provider_integrations for booking.provider_id
       ├─ none  / capability='manual_relay' → existing notifier path (T1, unchanged)
       ├─ 'deep_link' → store adapter.buildDeepLink(...) in booking.metadata,
       │                 surface it to the traveler; provider confirms on-platform
       └─ 'api' → adapter.createBooking(...)
                    ├─ confirmed → transition row to 'confirmed', skip the 24h SLA
                    ├─ pending   → keep 'requested', rely on platform webhook
                    └─ Transient → enqueue retry; Permanent/Unsupported → fall back to T1
```

Key invariants:
- **Fallback is always T1.** Any adapter failure degrades to manual relay rather
  than failing the traveler's request. (Consistent with the no-execution-layer-
  fallbacks rule: the button still delivers a real request, just via a slower
  channel — it never shows a dead end.)
- **Webhooks** (T3 platforms that confirm async) land on a new route
  `POST /api/services/integrations/:platform/webhook`, verify signature, map
  `external_booking_id → booking_id`, transition status. Reuses the existing
  `bookings/state.js` transition guards.

## 6. Sequencing

1. **Keep T1 for the Seoul pilot.** Prove traveler demand before paying any
   integration cost. (Naver/Kakao have no open API anyway.)
2. **Ship migration `049_provider_integrations.sql`** + the registry skeleton with
   only the `manual_relay` default path wired. Zero behavior change.
3. **Build one T3 adapter end-to-end — Mindbody or Square** (best docs) to
   validate the `getAvailability`/`createBooking`/webhook contract against a real
   API. This is the contract-hardening milestone.
4. **Add T2 deep-link adapters** for Naver Booking / Kakao Hairshop once KR
   providers onboard — low cost, no auth, immediate traveler value.
5. **Fan out** remaining T3 platforms behind the now-proven adapter interface.

## 7. Open questions

- Secret storage for `auth_ref`: Railway env is fine for a handful of pilot
  providers; revisit a real vault before multi-tenant scale.
- Availability caching TTL for T3 `getAvailability` (real-time vs. a short cache)
  — depends on per-platform rate limits.
- Deposit handling: `service_bookings.deposit_cents` exists but is unused at T1.
  T3 platforms that require a deposit-to-confirm need a payment step before
  `createBooking` — out of scope for this doc, flag for a payments design.
