const request = require('supertest');

// Manual FLASH_SALE / FREE_SHIPPING promotions are refused at create time with the
// SAME code+message as pivota-backend's gate (routes/merchant_promotions_api.py,
// backend PR #1728): the infra quote engine applies only MULTI_BUY_DISCOUNT, so a
// manually created promo of any other type would display but never change a price.
// Shopify-synced promos of those types apply inside Shopify pricing and must keep
// flowing through PATCH untouched.
const EXPECTED_FLASH_SALE_MESSAGE =
  'Manual FLASH_SALE promotions are not applied by the quote engine — ' +
  'they would display to shoppers but never change a price. Create the ' +
  'discount in Shopify instead (it applies via Shopify pricing and syncs ' +
  'back automatically), or use MULTI_BUY_DISCOUNT.';

const MULTI_BUY_CONFIG = {
  kind: 'MULTI_BUY_DISCOUNT',
  thresholdQuantity: 3,
  discountPercent: 10,
};

const FLASH_SALE_CONFIG = {
  kind: 'FLASH_SALE',
  flashPrice: 5,
  originalPrice: 10,
};

function promoPayload(type, config, overrides = {}) {
  return {
    name: 'Gate test promo',
    type,
    merchantId: 'merch_gate_test',
    startAt: '2026-08-12T00:00:00.000Z',
    endAt: '2026-08-20T00:00:00.000Z',
    channels: ['web'],
    scope: { global: true },
    config,
    ...overrides,
  };
}

describe('manual promo type gate on /api/merchant/promotions', () => {
  let prevEnv;
  let storeMock;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));

    storeMock = {
      getAllPromotions: jest.fn(async () => []),
      getPromotionsForMerchant: jest.fn(async () => []),
      getPromotionById: jest.fn(async () => null),
      upsertPromotion: jest.fn(async () => {}),
      softDeletePromotion: jest.fn(async () => true),
      PROMO_MODE: 'local',
      USE_REMOTE_PROMO: false,
    };
    jest.doMock('../src/promotionStore', () => storeMock);

    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/promotionStore');
    jest.resetModules();
    const restore = (key) => {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    };
    restore('ADMIN_API_KEY');
    restore('AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED');
  });

  const post = (app, body) =>
    request(app)
      .post('/api/merchant/promotions')
      .set('X-ADMIN-KEY', 'admin_test_key')
      .send(body);

  const patch = (app, id, body) =>
    request(app)
      .patch(`/api/merchant/promotions/${id}`)
      .set('X-ADMIN-KEY', 'admin_test_key')
      .send(body);

  test('POST FLASH_SALE is refused with the backend gate code and message, and nothing is stored', async () => {
    const app = require('../src/server');
    const resp = await post(app, promoPayload('FLASH_SALE', FLASH_SALE_CONFIG));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('PROMO_TYPE_NOT_APPLIED_AT_QUOTE');
    expect(resp.body.message).toBe(EXPECTED_FLASH_SALE_MESSAGE);
    expect(storeMock.upsertPromotion).not.toHaveBeenCalled();
  });

  test('POST FREE_SHIPPING gets the named refusal, not the generic INVALID_PROMOTION', async () => {
    const app = require('../src/server');
    const resp = await post(app, promoPayload('FREE_SHIPPING', undefined));
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('PROMO_TYPE_NOT_APPLIED_AT_QUOTE');
    expect(resp.body.message).toContain('Manual FREE_SHIPPING promotions');
    expect(storeMock.upsertPromotion).not.toHaveBeenCalled();
  });

  // Every shape validateAndNormalizePromotion will read a type out of. The gate
  // has to read the SAME set, or a request refused on one spelling gets stored on
  // another. Driven as a table because covering only `config.kind` left two
  // mutants alive: dropping the `config.type` fallback, and dropping the
  // {promotion: …} envelope unwrap — each of which makes a FLASH_SALE storable.
  const BYPASS_SHAPES = [
    ['type', (p) => p],
    ['config.kind', (p) => ({ ...p, type: undefined, config: { kind: 'FLASH_SALE' } })],
    ['config.type', (p) => ({ ...p, type: undefined, config: { type: 'FLASH_SALE' } })],
    ['{promotion} envelope + type', (p) => ({ promotion: p })],
    [
      '{promotion} envelope + config.kind',
      (p) => ({ promotion: { ...p, type: undefined, config: { kind: 'FLASH_SALE' } } }),
    ],
    [
      '{promotion} envelope + config.type',
      (p) => ({ promotion: { ...p, type: undefined, config: { type: 'FLASH_SALE' } } }),
    ],
  ];

  test.each(BYPASS_SHAPES)(
    'POST cannot smuggle FLASH_SALE past the gate via %s',
    async (_label, shape) => {
      const app = require('../src/server');
      const resp = await post(app, shape(promoPayload('FLASH_SALE', FLASH_SALE_CONFIG)));
      expect(resp.status).toBe(400);
      expect(resp.body.error).toBe('PROMO_TYPE_NOT_APPLIED_AT_QUOTE');
      expect(storeMock.upsertPromotion).not.toHaveBeenCalled();
    }
  );

  test.each(BYPASS_SHAPES)(
    'PATCH cannot convert MULTI_BUY_DISCOUNT into FLASH_SALE via %s',
    async (_label, shape) => {
      const existing = {
        id: 'promo_multibuy_shape',
        ...promoPayload('MULTI_BUY_DISCOUNT', MULTI_BUY_CONFIG),
      };
      storeMock.getPromotionById.mockResolvedValue(existing);
      const app = require('../src/server');
      const resp = await patch(
        app,
        existing.id,
        shape(promoPayload('FLASH_SALE', FLASH_SALE_CONFIG))
      );
      expect(resp.status).toBe(400);
      expect(resp.body.error).toBe('PROMO_TYPE_NOT_APPLIED_AT_QUOTE');
      expect(storeMock.upsertPromotion).not.toHaveBeenCalled();
    }
  );

  test('POST MULTI_BUY_DISCOUNT passes the gate and is stored', async () => {
    const app = require('../src/server');
    const resp = await post(app, promoPayload('MULTI_BUY_DISCOUNT', MULTI_BUY_CONFIG));
    expect(resp.status).toBe(201);
    expect(resp.body.promotion?.type).toBe('MULTI_BUY_DISCOUNT');
    expect(storeMock.upsertPromotion).toHaveBeenCalledTimes(1);
  });

  test('PATCH round-tripping an existing (Shopify-synced) FLASH_SALE stays allowed', async () => {
    const existing = {
      id: 'promo_flash_1',
      ...promoPayload('FLASH_SALE', FLASH_SALE_CONFIG),
    };
    storeMock.getPromotionById.mockResolvedValue(existing);
    const app = require('../src/server');
    const resp = await patch(
      app,
      existing.id,
      promoPayload('FLASH_SALE', FLASH_SALE_CONFIG, { name: 'Renamed synced flash' })
    );
    expect(resp.status).toBe(200);
    expect(storeMock.upsertPromotion).toHaveBeenCalledTimes(1);
  });

  test('PATCH converting a MULTI_BUY_DISCOUNT into FLASH_SALE is refused with the named code', async () => {
    const existing = {
      id: 'promo_multibuy_1',
      ...promoPayload('MULTI_BUY_DISCOUNT', MULTI_BUY_CONFIG),
    };
    storeMock.getPromotionById.mockResolvedValue(existing);
    const app = require('../src/server');
    const resp = await patch(
      app,
      existing.id,
      promoPayload('FLASH_SALE', FLASH_SALE_CONFIG)
    );
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('PROMO_TYPE_NOT_APPLIED_AT_QUOTE');
    expect(resp.body.message).toBe(EXPECTED_FLASH_SALE_MESSAGE);
    expect(storeMock.upsertPromotion).not.toHaveBeenCalled();
  });

  // NOTE ON SCOPE: this pins the GATEWAY's refusal text only. It does NOT detect
  // drift from pivota-backend's copy of the same sentence — editing the string in
  // both this repo's source and the constant above keeps it green while the two
  // repos diverge. The message was verified byte-identical to
  // routes/merchant_promotions_api.py by hand at authoring time; making that
  // durable needs the digest-pinned mirror this repo pair already uses for
  // contracts/protocol_vocabulary_v1.json, which is tracked as a follow-up.
  test('refusal text and the exemption rules are pinned (gateway side)', () => {
    const app = require('../src/server');
    const rejection = app._debug.manualPromoTypeRejection('FLASH_SALE');
    expect(rejection).toEqual({
      error: 'PROMO_TYPE_NOT_APPLIED_AT_QUOTE',
      message: EXPECTED_FLASH_SALE_MESSAGE,
    });
    // The allowed type and the round-trip exemption, driven from both sides so a
    // regression to "reject everything" cannot pass.
    expect(app._debug.manualPromoTypeRejection('MULTI_BUY_DISCOUNT')).toBeNull();
    expect(app._debug.manualPromoTypeRejection('FLASH_SALE', 'FLASH_SALE')).toBeNull();
    expect(
      app._debug.manualPromoTypeRejection('FLASH_SALE', 'MULTI_BUY_DISCOUNT')
    ).not.toBeNull();
  });
});
