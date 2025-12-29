const { loadTechniqueKBUS } = require("../../src/layer2/kb/loadTechniqueKBUS");

function stripLangSuffix(id) {
  return String(id || "").replace(/-(en|zh)$/i, "");
}

describe("US technique KB bilingual pairing", () => {
  test("all -en/-zh technique ids are paired", () => {
    const kb = loadTechniqueKBUS();
    const ids = new Set(kb.list.map((c) => String(c.id || "")));

    const en = [...ids].filter((id) => id.endsWith("-en"));
    const zh = [...ids].filter((id) => id.endsWith("-zh"));

    const missing = [];
    for (const id of en) {
      const base = stripLangSuffix(id);
      const pair = `${base}-zh`;
      if (!ids.has(pair)) missing.push({ id, missing: pair });
    }
    for (const id of zh) {
      const base = stripLangSuffix(id);
      const pair = `${base}-en`;
      if (!ids.has(pair)) missing.push({ id, missing: pair });
    }

    expect(missing).toEqual([]);
    expect(en.length).toBe(zh.length);
  });
});

