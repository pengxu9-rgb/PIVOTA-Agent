// Mock Pivota API for local E2E testing.
require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

const port = process.env.MOCK_PIVOTA_PORT || 8080;

// Simple request log.
app.use((req, res, next) => {
  console.log(`[mock-pivota] ${req.method} ${req.path}`);
  next();
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// find_products
app.post('/agent/shop/v1/find_products', async (req, res) => {
  await sleep(200);

  const query = req.body?.search?.query || '';
  const city = req.body?.search?.city || 'unknown city';

  // Import mock products
  const { searchProducts } = require('../src/mockProducts');
  const products = searchProducts(
    req.body?.search?.merchant_id || 'merch_208139f7600dbf42',
    query,
    req.body?.search?.price_max,
    req.body?.search?.price_min,
    req.body?.search?.category
  );

  res.json({
    status: 'success',
    products: products,
    total: products.length,
    page: 1,
    page_size: products.length,
    acp_state: {
      acp_session_id: 'mock_acp_s_123',
    },
  });
});

// create_order
app.post('/agent/shop/v1/create_order', async (req, res) => {
  await sleep(200);
  const items = req.body?.order?.items || [];

  const subtotal = items.length > 0 ? 759 : 0;
  const shipping_fee = 10;
  const discount = 0;
  const tax = 0;
  const total = subtotal + shipping_fee - discount + tax;

  res.json({
    order_id: 'mock_ord_123',
    amount_subtotal: subtotal,
    shipping_fee,
    discount,
    tax,
    amount_total: total,
    currency: 'CNY',
    eta_days: 2,
    acp_state: {
      acp_session_id: 'mock_acp_s_123',
      order_stage: 'draft_created',
    },
  });
});

// submit_payment
app.post('/agent/shop/v1/submit_payment', async (req, res) => {
  await sleep(200);
  const orderId = req.body?.payment?.order_id || 'unknown';

  res.json({
    payment_status: 'succeeded',
    ap2_state: {
      payment_session_id: 'mock_pay_s_456',
      mandate_id: 'mock_mand_001',
    },
    order_id: orderId,
  });
});

// get_order_status
app.post('/agent/shop/v1/get_order_status', async (req, res) => {
  await sleep(100);
  const orderId = req.body?.status?.order_id || 'mock_ord_123';

  res.json({
    order_id: orderId,
    status: 'shipped',
    shipping_carrier: 'SF',
    tracking_number: 'SF123456789CN',
    eta_days: 1,
    last_update: new Date().toISOString(),
  });
});

// request_after_sales
app.post('/agent/shop/v1/request_after_sales', async (req, res) => {
  await sleep(150);
  const orderId = req.body?.status?.order_id || 'mock_ord_123';
  const requested_action = req.body?.status?.requested_action || 'support';

  res.json({
    order_id: orderId,
    requested_action,
    request_id: 'mock_aftersales_001',
    status: 'created',
    message: 'After-sales request has been created and will be reviewed.',
  });
});

// get_product_detail
app.post('/agent/shop/v1/get_product_detail', async (req, res) => {
  await sleep(100);
  const sku = req.body?.product?.sku_id || 'sku_001_42';
  res.json({
    product_id: 'p_001',
    sku_id: sku,
    title: 'Nike Pegasus Running Shoes 42 - black',
    price: 759,
    currency: 'CNY',
    stock: 42,
    attributes: {
      size: '42',
      color: 'black',
    },
  });
});

app.listen(port, () => {
  console.log(`[mock-pivota] Listening on port ${port}`);
});
