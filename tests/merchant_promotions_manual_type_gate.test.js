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

  test('POST with the type only in config.kind cannot bypass the gate', async () => {
    const app = require('../src/server');
    const payload = promoPayload(undefined, FLASH_SALE_CONFIG);
    delete payload.type;
    const resp = await post(app, payload);
    expect(resp.status).toBe(400);
    expect(resp.body.error).toBe('PROMO_TYPE_NOT_APPLIED_AT_QUOTE');
    expect(storeMock.upsertPromotion).not.toHaveBeenCalled();
  });

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

  test('refusal message is byte-identical to the backend gate (cross-repo contract)', () => {
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
