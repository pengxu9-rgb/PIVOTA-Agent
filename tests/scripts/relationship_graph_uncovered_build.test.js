// The general candidate pool can contain cooled-down products. Only the eligible anchor lane
// may supply anchors; attempts must be recorded even when a build emits no edges.
jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })), closePool: jest.fn(), withClient: jest.fn() }));
jest.mock('../../src/auroraBff/productRelationshipGraphSources', () => ({
  ...jest.requireActual('../../src/auroraBff/productRelationshipGraphSources'),
  loadProductRelationshipGraphSourceInputs: jest.fn(),
}));
const db = require('../../src/db');
const sources = require('../../src/auroraBff/productRelationshipGraphSources');
const builder = require('../../scripts/build-product-relationship-graph');
const eligible = { product_id:'sig_eligible',product_ref:'product:sig_eligible',pivota_signature_id:'sig_eligible',title:'Serum',category:'skincare',brand:'Eligible' };
const cooled = { product_id:'sig_cooled',product_ref:'product:sig_cooled',pivota_signature_id:'sig_cooled',title:'Cream',category:'skincare',brand:'Cooled' };
const originalArgv = process.argv;
beforeEach(() => {
  jest.clearAllMocks();
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({
    products:[eligible,cooled], eligibleAffectedProducts:[eligible], approvedLiveExternalSeedAnchors:[cooled,eligible],
  });
});
afterEach(() => { process.argv=originalArgv; jest.restoreAllMocks(); });

test.each([false,true])('cooled-down products stay candidates but cannot reenter scoped anchors (approved lane %s)', async (approved) => {
  const payload=await builder.buildInputsFromDb({ limit:200,affectedRefs:['sig_eligible','sig_cooled'],prioritizeUncovered:true,
    includeApprovedLiveExternalSeedAnchors:approved,includeNeedNodes:false,includeTransitiveRecall:false });
  expect(payload.anchors.map((product)=>product.product_ref)).toEqual(['product:sig_eligible']);
});
test('unscoped approved anchors also respect the eligible lane',async()=>{
  const payload=await builder.buildInputsFromDb({limit:200,prioritizeUncovered:true,includeApprovedLiveExternalSeedAnchors:true,
    includeNeedNodes:false,includeTransitiveRecall:false});
  expect(payload.anchors.map((product)=>product.product_ref)).toEqual(['product:sig_eligible']);
});
test.each([[true,true],[true,false],[false,true]])('zero-edge build records an attempt only with priority %s and write mode %s',async(priority,write)=>{
  sources.loadProductRelationshipGraphSourceInputs.mockResolvedValue({products:[eligible],eligibleAffectedProducts:[eligible]});
  process.argv=['node','build-product-relationship-graph','--skip-need-nodes',...(priority?['--prioritize-uncovered']:[]),...(write?['--apply']:[])];
  const output=jest.spyOn(process.stdout,'write').mockImplementation(()=>true);
  await builder.main();
  expect(JSON.parse(output.mock.calls.at(-1)[0]).edge_count).toBe(0);
  const attempts=db.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO relationship_graph_anchor_attempts'));
  expect(attempts).toHaveLength(priority&&write?1:0);
  if (attempts.length) expect(attempts[0][1]).toEqual([['product:sig_eligible'],'US']);
});
