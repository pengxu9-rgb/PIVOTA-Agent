const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const { StrictInvokeRequestSchema } = require('../src/schema');

const root = path.join(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function expectRequired(schema, fields) {
  expect(schema.required || []).toEqual(expect.arrayContaining(fields));
}

function expectClosed(schema) {
  expect(schema.additionalProperties).toBe(false);
}

function expectNoProperties(schema, fields) {
  for (const field of fields) {
    expect(schema.properties || {}).not.toHaveProperty(field);
  }
}

function v2Tool(schema, name) {
  const tool = (schema.tools || []).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing v2 tool ${name}`);
  return tool.input_schema;
}

function createOrderInvoke(overrides = {}) {
  const base = {
    operation: 'create_order',
    payload: {
      idempotency_key: 'idem-create-001',
      order: {
        quote_id: 'quote_001',
        customer_email: 'test-buyer@example.com',
        shipping_address: {
          country: 'US',
          city: 'San Francisco',
          postal_code: '94102',
          address_line1: '1 Market St',
          recipient_name: 'Test Buyer',
        },
      },
    },
  };
  return {
    ...base,
    ...overrides,
    payload: {
      ...base.payload,
      ...(overrides.payload || {}),
      order: {
        ...base.payload.order,
        ...(overrides.payload?.order || {}),
      },
    },
  };
}

function submitPaymentInvoke(overrides = {}) {
  const base = {
    operation: 'submit_payment',
    payload: {
      idempotency_key: 'idem-pay-001',
      confirmation_token: 'confirm_001',
      payment: {
        order_id: 'order_001',
        expected_amount: 2900,
        currency: 'USD',
      },
    },
  };
  return {
    ...base,
    ...overrides,
    payload: {
      ...base.payload,
      ...(overrides.payload || {}),
      payment: {
        ...base.payload.payment,
        ...(overrides.payload?.payment || {}),
      },
    },
  };
}

describe('agent checkout v2 contract drift guards', () => {
  test('public tool schema pins quote-bound order and confirmation-bound pay payloads', () => {
    const schema = readJson('docs/tool-schema.json');
    const params = schema.parameters;
    const payload = params.properties.payload;
    const payloadProps = payload.properties;
    const order = payloadProps.order;
    const payment = payloadProps.payment;

    expect(schema.version).toBe('2.0');
    expect(payloadProps.idempotency_key.minLength).toBeGreaterThanOrEqual(8);
    expect(payloadProps).toHaveProperty('confirmation_token');

    expectRequired(order, ['quote_id', 'customer_email', 'shipping_address']);
    expectClosed(order);
    expectClosed(order.properties.shipping_address);
    expectRequired(order.properties.shipping_address, ['postal_code']);
    expectClosed(order.properties.delivery_preferences);
    expectNoProperties(order, ['items', 'amount', 'total_amount', 'unit_price']);

    expectRequired(payment, ['order_id', 'expected_amount', 'currency']);
    expectClosed(payment);
    expectNoProperties(payment, ['amount', 'total_amount', 'quote_id']);

    const createOrderRule = params.allOf.find(
      (rule) => rule.if?.properties?.operation?.const === 'create_order',
    );
    expect(createOrderRule.then.properties.payload.required).toEqual(
      expect.arrayContaining(['idempotency_key', 'order']),
    );

    const submitPaymentRule = params.allOf.find(
      (rule) => rule.if?.properties?.operation?.const === 'submit_payment',
    );
    expect(submitPaymentRule.then.properties.payload.required).toEqual(
      expect.arrayContaining(['idempotency_key', 'confirmation_token', 'payment']),
    );
  });

  test('agent-checkout v2 split tools keep money payloads closed', () => {
    const schema = readJson('docs/agent-checkout/tool-schema.v2.json');

    const createOrderPayload = v2Tool(schema, 'pivota_create_order').properties.payload;
    expectRequired(createOrderPayload, ['idempotency_key', 'order']);
    expectClosed(createOrderPayload);
    expectRequired(createOrderPayload.properties.order, ['quote_id', 'customer_email', 'shipping_address']);
    expectClosed(createOrderPayload.properties.order);
    expectRequired(createOrderPayload.properties.order.properties.shipping_address, ['postal_code']);
    expectNoProperties(createOrderPayload.properties.order, ['items', 'amount', 'total_amount']);

    const payPayload = v2Tool(schema, 'pivota_pay').properties.payload;
    expectRequired(payPayload, ['idempotency_key', 'confirmation_token', 'payment']);
    expectClosed(payPayload);
    expectRequired(payPayload.properties.payment, ['order_id', 'expected_amount', 'currency']);
    expectClosed(payPayload.properties.payment);
    expectNoProperties(payPayload.properties.payment, ['amount', 'total_amount', 'quote_id']);
  });

  test('OpenAPI export keeps checkout money objects closed', () => {
    const schema = readJson('chatgpt-gpt-openapi-schema.json');
    const payload = schema.components.schemas.ShoppingRequest.properties.payload;
    const order = payload.properties.order;
    const payment = payload.properties.payment;

    expect(payload.properties.idempotency_key.minLength).toBeGreaterThanOrEqual(8);
    expect(payload.properties).toHaveProperty('confirmation_token');

    expectRequired(order, ['quote_id', 'customer_email', 'shipping_address']);
    expectClosed(order);
    expectClosed(order.properties.shipping_address);
    expectRequired(order.properties.shipping_address, ['postal_code']);
    expectNoProperties(order, ['items', 'amount', 'total_amount', 'unit_price']);

    expectRequired(payment, ['order_id', 'expected_amount', 'currency']);
    expectClosed(payment);
    expectNoProperties(payment, ['amount', 'total_amount', 'quote_id']);
  });

  test('public JSON schema rejects missing required money fields and extra amount fields', () => {
    const schema = readJson('docs/tool-schema.json');
    const validate = new Ajv({ strict: false }).compile(schema.parameters);

    expect(validate(createOrderInvoke())).toBe(true);
    expect(validate(createOrderInvoke({ payload: { idempotency_key: undefined } }))).toBe(false);
    expect(validate(createOrderInvoke({ payload: { order: { quote_id: undefined } } }))).toBe(false);
    expect(validate(createOrderInvoke({ payload: { order: { amount: 2900 } } }))).toBe(false);

    expect(validate(submitPaymentInvoke())).toBe(true);
    expect(validate(submitPaymentInvoke({ payload: { idempotency_key: undefined } }))).toBe(false);
    expect(validate(submitPaymentInvoke({ payload: { confirmation_token: undefined } }))).toBe(false);
    expect(validate(submitPaymentInvoke({ payload: { payment: { expected_amount: undefined } } }))).toBe(false);
    expect(validate(submitPaymentInvoke({ payload: { payment: { amount: 2900 } } }))).toBe(false);
  });

  test('gateway StrictInvokeRequestSchema rejects drifted checkout money payloads', () => {
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke()).success).toBe(true);
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke({ payload: { idempotency_key: undefined } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke({ payload: { order: { quote_id: undefined } } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke({ payload: { order: { customer_email: undefined } } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke({ payload: { order: { shipping_address: { postal_code: undefined } } } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke({ payload: { order: { amount: 2900 } } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(createOrderInvoke({ payload: { order: { items: [] } } })).success).toBe(false);

    expect(StrictInvokeRequestSchema.safeParse(submitPaymentInvoke()).success).toBe(true);
    expect(StrictInvokeRequestSchema.safeParse(submitPaymentInvoke({ payload: { idempotency_key: undefined } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(submitPaymentInvoke({ payload: { confirmation_token: undefined } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(submitPaymentInvoke({ payload: { payment: { expected_amount: undefined } } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(submitPaymentInvoke({ payload: { payment: { amount: 2900 } } })).success).toBe(false);
    expect(StrictInvokeRequestSchema.safeParse(submitPaymentInvoke({ payload: { payment: { quote_id: 'quote_001' } } })).success).toBe(false);
  });
});
