const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  generateExternalPoolReport,
  writeExternalPoolReportFiles,
} = require("../../scripts/report-external-links-pool");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pivota-external-report-"));
}

describe("external offers pool report", () => {
  test("computes category coverage and gaps with default targets", () => {
    const pool = {
      market: "US",
      version: "v0",
      updatedAt: "2025-01-01",
      defaults: { disclosure: { type: "unknown", text: "Disclosure" } },
      domainAllowlist: ["example.com"],
      partners: {},
      byRole: {
        "ROLE:thin_felt_tip_liner": [
          { url: "https://example.com/liner", domain: "example.com", priority: 90, partner: { type: "none" } },
        ],
      },
      byCategory: {
        base: [
          { url: "https://example.com/base", domain: "example.com", priority: 90, partner: { type: "none" } },
          { url: "https://example.com/base2", domain: "example.com", priority: 60, partner: { type: "none" } },
        ],
        eye: [
          { url: "https://example.com/eye", domain: "example.com", priority: 80, partner: { type: "none" } },
        ],
      },
    };

    const { reportJson, reportMd } = generateExternalPoolReport({
      market: "US",
      date: "2025-02-03",
      pool,
      allowlistDomains: ["example.com"],
      targets: null,
    });

    expect(reportJson.market).toBe("US");
    expect(reportJson.date).toBe("2025-02-03");
    expect(reportJson.totals.offers).toBeGreaterThan(0);

    expect(reportJson.byCategory.base.offers).toBe(2);
    expect(reportJson.byCategory.base.target).toBe(12);
    expect(reportJson.byCategory.base.meetsTarget).toBe(false);
    expect(reportJson.gaps.categories.find((g) => g.category === "base")).toBeTruthy();

    expect(reportMd).toMatch(/Coverage by category/);
    expect(reportMd).toMatch(/\| base \| 2 \|/);
  });

  test("flags invalid domains not in allowlist", () => {
    const pool = {
      market: "US",
      version: "v0",
      updatedAt: "2025-01-01",
      defaults: { disclosure: { type: "unknown", text: "Disclosure" } },
      domainAllowlist: ["example.com"],
      partners: {},
      byRole: {},
      byCategory: {
        base: [
          { url: "https://evil.com/base", domain: "evil.com", priority: 90, partner: { type: "none" } },
        ],
      },
    };

    const { reportJson } = generateExternalPoolReport({
      market: "US",
      date: "2025-02-03",
      pool,
      allowlistDomains: ["example.com"],
      targets: null,
    });

    expect(reportJson.hygiene.invalidDomainCount).toBe(1);
  });

  test("writes markdown and JSON report files", () => {
    const tmpDir = makeTempDir();
    const pool = {
      market: "JP",
      version: "v0",
      updatedAt: "2025-01-01",
      defaults: { disclosure: { type: "unknown", text: "Disclosure" } },
      domainAllowlist: ["example.jp"],
      partners: {},
      byRole: {},
      byCategory: {},
    };

    const { reportJson, reportMd } = generateExternalPoolReport({
      market: "JP",
      date: "2025-02-03",
      pool,
      allowlistDomains: ["example.jp"],
      targets: null,
    });

    const { mdPath, jsonPath } = writeExternalPoolReportFiles({
      outDir: tmpDir,
      market: "JP",
      date: "2025-02-03",
      reportJson,
      reportMd,
    });

    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.readFileSync(mdPath, "utf8")).toMatch(/External Offers Pool Report/);
    expect(JSON.parse(fs.readFileSync(jsonPath, "utf8")).market).toBe("JP");
  });
});

