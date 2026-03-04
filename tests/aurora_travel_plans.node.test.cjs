const test = require('node:test');
const assert = require('node:assert/strict');

const { UserProfilePatchSchema } = require('../src/auroraBff/schemas');
const { resolveQaPlan } = require('../src/auroraBff/qaPlanner');
const { INTENT_ENUM } = require('../src/auroraBff/intentCanonical');
const {
  normalizeTravelProfilePatch,
  resolveTravelPlansState,
  selectActiveTrip,
  applyTravelExtractionToProfile,
} = require('../src/auroraBff/travelPlans');

test('UserProfilePatchSchema accepts legacy travel_plan and new travel_plans', () => {
  const legacy = UserProfilePatchSchema.safeParse({
    travel_plan: {
      destination: 'Tokyo',
      start_date: '2026-03-01',
      end_date: '2026-03-05',
      indoor_outdoor_ratio: 0.4,
    },
  });
  assert.equal(legacy.success, true);

  const modern = UserProfilePatchSchema.safeParse({
    travel_plans: [
      {
        destination: 'Paris',
        start_date: '2026-04-01',
        end_date: '2026-04-06',
      },
    ],
  });
  assert.equal(modern.success, true);
});

test('normalizeTravelProfilePatch bridges legacy travel_plan into travel_plans', () => {
  const patch = normalizeTravelProfilePatch({
    baseProfile: {
      travel_plans: [
        {
          trip_id: 'trip_existing',
          destination: 'Seoul',
          start_date: '2026-06-01',
          end_date: '2026-06-04',
          created_at_ms: 1,
          updated_at_ms: 2,
        },
      ],
    },
    patch: {
      travel_plan: {
        destination: 'Paris',
        start_date: '2026-04-01',
        end_date: '2026-04-06',
      },
    },
    options: { nowMs: Date.parse('2026-03-10T00:00:00.000Z') },
  });

  assert.ok(Array.isArray(patch.travel_plans));
  assert.ok(patch.travel_plans.some((item) => item.destination === 'Paris'));
  assert.ok(patch.travel_plan && patch.travel_plan.destination);
});

test('normalizeTravelProfilePatch appends incoming travel_plans instead of replacing existing trips', () => {
  const patch = normalizeTravelProfilePatch({
    baseProfile: {
      travel_plans: [
        {
          trip_id: 'trip_existing_1',
          destination: 'Seoul',
          start_date: '2026-06-01',
          end_date: '2026-06-04',
          created_at_ms: 1,
          updated_at_ms: 2,
        },
        {
          trip_id: 'trip_existing_2',
          destination: 'Berlin',
          start_date: '2026-07-01',
          end_date: '2026-07-03',
          created_at_ms: 3,
          updated_at_ms: 4,
        },
      ],
    },
    patch: {
      travel_plans: [
        {
          destination: 'Paris',
          start_date: '2026-04-01',
          end_date: '2026-04-06',
        },
      ],
    },
    options: { nowMs: Date.parse('2026-03-10T00:00:00.000Z') },
  });

  const destinations = (Array.isArray(patch.travel_plans) ? patch.travel_plans : []).map((item) => item.destination).sort();
  assert.deepEqual(destinations, ['Berlin', 'Paris', 'Seoul']);
});

test('selectActiveTrip prefers in-range then nearest upcoming; expired trips excluded', () => {
  const plans = [
    {
      trip_id: 'trip_old_expired',
      destination: 'London',
      start_date: '2026-02-01',
      end_date: '2026-02-02',
      created_at_ms: 1,
      updated_at_ms: 1,
    },
    {
      trip_id: 'trip_in_range',
      destination: 'Tokyo',
      start_date: '2026-02-20',
      end_date: '2026-02-25',
      created_at_ms: 2,
      updated_at_ms: 2,
    },
    {
      trip_id: 'trip_upcoming',
      destination: 'Paris',
      start_date: '2026-03-02',
      end_date: '2026-03-05',
      created_at_ms: 3,
      updated_at_ms: 3,
    },
  ];

  const inRange = selectActiveTrip(plans, { nowMs: Date.parse('2026-02-23T10:00:00.000Z') });
  assert.equal(inRange.mode, 'in_range');
  assert.equal(inRange.trip && inRange.trip.trip_id, 'trip_in_range');

  const upcoming = selectActiveTrip(plans, { nowMs: Date.parse('2026-02-27T10:00:00.000Z') });
  assert.equal(upcoming.mode, 'nearest_upcoming');
  assert.equal(upcoming.trip && upcoming.trip.trip_id, 'trip_upcoming');

  const none = selectActiveTrip(plans, { nowMs: Date.parse('2026-03-08T10:00:00.000Z') });
  assert.equal(none.mode, 'none');
  assert.equal(none.trip, null);
});

test('resolveQaPlan travel gate uses active trip from travel_plans', () => {
  const profile = {
    skinType: 'oily',
    sensitivity: 'low',
    barrierStatus: 'stable',
    goals: ['acne'],
    travel_plans: [
      {
        trip_id: 'trip_live',
        destination: 'Tokyo',
        start_date: '2020-01-01',
        end_date: '2099-12-31',
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    ],
  };
  const plan = resolveQaPlan({
    intent: INTENT_ENUM.TRAVEL_PLANNING,
    profile,
    message: 'Help me plan travel skincare',
    language: 'EN',
    hasAnchor: false,
    session: {},
  });

  assert.equal(plan.gate_type, 'soft');
  assert.ok(Array.isArray(plan.required_fields) && plan.required_fields.length > 0);
  assert.equal(plan.next_step, 'upstream');
});

test('resolveTravelPlansState falls back to home region when no active trip', () => {
  const state = resolveTravelPlansState(
    {
      region: 'San Francisco',
      travel_plans: [],
      travel_plan: null,
    },
    { nowMs: Date.parse('2026-02-23T10:00:00.000Z') },
  );
  assert.equal(state.home_region, 'San Francisco');
  assert.equal(state.active_trip, null);
  assert.equal(state.active_mode, 'none');
});

test('resolveQaPlan weather/travel uses home region fallback when all trips are expired', () => {
  const profile = {
    skinType: 'oily',
    sensitivity: 'low',
    barrierStatus: 'stable',
    goals: ['acne'],
    region: 'San Francisco',
    travel_plans: [
      {
        trip_id: 'trip_expired',
        destination: 'Tokyo',
        start_date: '2020-01-01',
        end_date: '2020-01-03',
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    ],
    travel_plan: null,
  };

  const plan = resolveQaPlan({
    intent: INTENT_ENUM.WEATHER_ENV,
    profile,
    message: 'How should I adjust to weather this week?',
    language: 'EN',
    hasAnchor: false,
    session: {},
  });

  assert.equal(plan.gate_type, 'soft');
  assert.ok(Array.isArray(plan.required_fields) && plan.required_fields.length > 0);
  assert.equal(plan.next_step, 'upstream');
});

test('applyTravelExtractionToProfile ignores non-destination phrases', () => {
  const out = applyTravelExtractionToProfile(
    {
      region: 'San Francisco',
      travel_plans: [],
      travel_plan: null,
    },
    { destination: 'weather this week' },
    { nowMs: Date.parse('2026-02-23T10:00:00.000Z') },
  );

  assert.ok(out && typeof out === 'object');
  assert.equal(out.patch, null);
});
