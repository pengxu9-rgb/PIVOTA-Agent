const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseCsvString } = require("../../src/layer2/kb/importTechniqueCsv");
const {
  buildExternalLinksPools,
  loadRoleIdsV1,
  stableHashShort,
} = require("../../scripts/build-external-links-pool");
const { lintExternalOffersPool } = require("../../scripts/lint-external-offers-pool");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pivota-external-pool-"));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

describe("external offers pool (CSV -> JSON) + lint", () => {
  test("buildExternalLinksPools is deterministic and dedupes by canonicalUrl", () => {
    const roles = Array.from(loadRoleIdsV1()).sort();
    expect(roles.length).toBeGreaterThan(0);
    const roleId = roles[0];

    const csv = [
      "market,scope,scope_id,url,priority,partner_type,partner_program,partner_name,disclosure_text,tags,notes",
      `US,role,${roleId},https://example.com/p?utm_source=x&gclid=y,90,affiliate,,,,tag1,Note A`,
      `US,role,${roleId},https://example.com/p?utm_campaign=z,30,affiliate,,,,tag2,Note B`,
      "US,category,base,https://shop.example.com/base?fbclid=1,60,none,,,,,",
      "",
    ].join("\n");

    const { rows } = parseCsvString(csv);
    const out1 = buildExternalLinksPools({
      csvRows: rows,
      updatedAt: "2025-01-01",
      domainAllowlistByMarket: { US: ["example.com"], JP: ["example.jp"] },
      partnersByMarket: { US: {}, JP: {} },
      domainCap: 2,
      marketFilter: null,
      allowedRoleIds: new Set(roles),
    });
    const out2 = buildExternalLinksPools({
      csvRows: rows,
      updatedAt: "2025-01-01",
      domainAllowlistByMarket: { US: ["example.com"], JP: ["example.jp"] },
      partnersByMarket: { US: {}, JP: {} },
      domainCap: 2,
      marketFilter: null,
      allowedRoleIds: new Set(roles),
    });

    expect(stableHashShort(JSON.stringify(out1))).toEqual(stableHashShort(JSON.stringify(out2)));

    const usPool = out1.pools.US;
    expect(usPool).toBeTruthy();
    expect(usPool.byRole[roleId]).toHaveLength(1);
    expect(usPool.byRole[roleId][0].url).toBe("https://example.com/p");
    expect(usPool.byCategory.base).toHaveLength(1);
    expect(usPool.byCategory.base[0].url).toBe("https://shop.example.com/base");
  });

  test("lintExternalOffersPool rejects domain not in allowlist", () => {
    const tmpDir = makeTempDir();
    writeFile(path.join(tmpDir, "external_allowlist_US.txt"), "example.com\n");
    writeFile(path.join(tmpDir, "external_allowlist_JP.txt"), "example.jp\n");

    const roles = Array.from(loadRoleIdsV1()).sort();
    const roleId = roles[0];

    const csv = [
      "market,scope,scope_id,url,priority,partner_type",
      `US,role,${roleId},https://bad.com/item,50,affiliate`,
      "",
    ].join("\n");
    const csvPath = path.join(tmpDir, "external_offers_pool.csv");
    writeFile(csvPath, csv);

    const result = lintExternalOffersPool({ inputPath: csvPath, outDir: tmpDir, marketFilter: null });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/Domain not allowed/i);
  });

  test("lintExternalOffersPool rejects duplicate canonicalUrl within a scope group", () => {
    const tmpDir = makeTempDir();
    writeFile(path.join(tmpDir, "external_allowlist_US.txt"), "example.com\n");
    writeFile(path.join(tmpDir, "external_allowlist_JP.txt"), "example.jp\n");

    const roles = Array.from(loadRoleIdsV1()).sort();
    const roleId = roles[0];

    const csv = [
      "market,scope,scope_id,url,priority,partner_type",
      `US,role,${roleId},https://example.com/p?utm_source=x,90,affiliate`,
      `US,role,${roleId},https://example.com/p?gclid=y,80,affiliate`,
      "",
    ].join("\n");
    const csvPath = path.join(tmpDir, "external_offers_pool.csv");
    writeFile(csvPath, csv);

    const result = lintExternalOffersPool({ inputPath: csvPath, outDir: tmpDir, marketFilter: null });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/duplicate canonicalUrl/i);
  });
});

