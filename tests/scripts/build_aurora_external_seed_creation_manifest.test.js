const http = require('node:http');
const {
  _internals: { buildSeedRow, buildMarketGuardrailDecision },
} = require('../../scripts/build_aurora_external_seed_creation_manifest.cjs');

function startServer(html) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind test server'));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/products/test-product`,
      });
    });
    server.on('error', reject);
  });
}

function makeExtractDoc(targetUrl, { price = '59.00', currency = 'USD' } = {}) {
  return {
    brand: 'The Formularx',
    domain: 'theformularx.com',
    mode: 'puppeteer',
    platform: 'Shopify (Direct PDP)',
    products: [
      {
        title: 'Barrier Relief Lightweight Ceramide Moisturizer with Niacinamide',
        url: targetUrl,
        canonical_url: targetUrl,
        image_url: 'https://cdn.shopify.com/test.png',
        variants: [
          {
            id: 'variant-1',
            sku: 'BR-M-50',
            url: targetUrl,
            option_name: 'Size',
            option_value: '50g',
            price,
            currency,
            stock: 'In Stock',
            image_url: 'https://cdn.shopify.com/test.png',
          },
        ],
      },
    ],
  };
}

describe('build_aurora_external_seed_creation_manifest', () => {
  test('blocks US seed creation when page shows India market signals', async () => {
    const { server, url } = await startServer(`
      <html>
        <body>
          <div>Consumer care address: Noida, Uttar Pradesh, India</div>
          <div>Consumer helpline: +91-7042771727</div>
          <div>Regular price Rs. 594.00</div>
        </body>
      </html>
    `);

    try {
      const item = {
        ingredient_id: null,
        ingredient_name: null,
        target_brand: 'The Formularx',
        target_url: url,
        extract_status: 'usable',
      };
      const extractDoc = makeExtractDoc(url, { price: '594.00', currency: 'USD' });
      const seedRow = buildSeedRow(item, extractDoc);
      const guardrail = await buildMarketGuardrailDecision(item, extractDoc, seedRow);
      expect(guardrail.blocked).toBe(true);
      expect(guardrail.reason).toBe('market_signal_mismatch');
      expect(guardrail.evidence.target_url).toBe(url);
      expect(guardrail.evidence.country_matches).toContain('India');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('keeps candidate when no non-US market signals are present', async () => {
    const { server, url } = await startServer(`
      <html>
        <body>
          <div>Regular price $59.00</div>
          <div>Customer support: support@example.com</div>
        </body>
      </html>
    `);

    try {
      const item = {
        ingredient_id: null,
        ingredient_name: null,
        target_brand: 'Example Brand',
        target_url: url,
        extract_status: 'usable',
      };
      const extractDoc = makeExtractDoc(url);
      const seedRow = buildSeedRow(item, extractDoc);
      const guardrail = await buildMarketGuardrailDecision(item, extractDoc, seedRow);
      expect(guardrail.blocked).toBe(false);
      expect(seedRow.market).toBe('US');
      expect(seedRow.canonical_url).toBe(url);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not block on country-only footer market directory links', async () => {
    const { server, url } = await startServer(`
      <html>
        <body>
          <footer>
            <div>ASIA</div>
            <a href="http://paulaschoice.in">India</a>
            <a href="http://paulaschoice.tw">Taiwan</a>
          </footer>
          <div>Regular price $35.00</div>
        </body>
      </html>
    `);

    try {
      const item = {
        ingredient_id: null,
        ingredient_name: null,
        target_brand: "Paula's Choice",
        target_url: url,
        extract_status: 'usable',
      };
      const extractDoc = makeExtractDoc(url, { price: '35.00', currency: 'USD' });
      const seedRow = buildSeedRow(item, extractDoc);
      const guardrail = await buildMarketGuardrailDecision(item, extractDoc, seedRow);
      expect(guardrail.blocked).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('does not block on footer country selector tokens without priced INR signals', async () => {
    const { server, url } = await startServer(`
      <html>
        <body>
          <footer>
            <label
              class="flex items-center justify-between cursor-pointer order-2"
              for="FooterFormIN"
              data-country-name="India"
            >
              India
            </label>
            <input type="radio" class="hidden" value="IN" id="FooterFormIN" />
            <div>Preferred currency: INR</div>
            <div>Symbol: ₹</div>
          </footer>
          <div>Regular price $39.00</div>
        </body>
      </html>
    `);

    try {
      const item = {
        ingredient_id: null,
        ingredient_name: null,
        target_brand: 'Peach & Lily',
        target_url: url,
        extract_status: 'usable_partial',
      };
      const extractDoc = makeExtractDoc(url, { price: '39.00', currency: 'USD' });
      const seedRow = buildSeedRow(item, extractDoc);
      const guardrail = await buildMarketGuardrailDecision(item, extractDoc, seedRow);
      expect(guardrail.blocked).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
