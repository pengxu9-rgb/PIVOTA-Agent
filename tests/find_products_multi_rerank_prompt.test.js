const fs = require('fs');
const path = require('path');

describe('product rerank prompt', () => {
  test('includes beauty skincare ranking guidance', () => {
    const promptPath = path.join(__dirname, '..', 'prompts', 'product_rerank_prompt_v1.txt');
    const prompt = fs.readFileSync(promptPath, 'utf8');

    expect(prompt).toContain('generic beauty/skincare 查询规则');
    expect(prompt).toContain('同产品形态 > 同关键成分/功效 > 同品类近似替代');
    expect(prompt).toContain('brush/sponge/puff/applicator/beauty tool/fragrance/perfume');
    expect(prompt).toContain('不能把 brush 排到 serum 前');
    expect(prompt).toContain('niacinamide、retinol、vitamin c、ceramide');
  });
});
