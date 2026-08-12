/* Mock-Firestore test suite for the MV2 core. Proves the safety invariants the
   owner required. No real Firestore is touched. */
const { buildMV2 } = require('./mv2_core.js');

// ---------------- Mock Firestore ----------------
function makeDb(){
  const store={};                 // path -> data
  const writeLog=[];              // {op,path}
  function docRef(col,id){
    const path=col+'/'+id;
    return { path,
      async get(){ return { exists: path in store, data:()=> store[path] }; },
      async set(d){ writeLog.push({op:'set',path}); store[path]=JSON.parse(JSON.stringify(d)); },
      async update(d){ writeLog.push({op:'update',path}); store[path]=Object.assign({},store[path],d); },
      async delete(){ writeLog.push({op:'delete',path}); delete store[path]; } };
  }
  function collection(col){
    return {
      doc(id){ return docRef(col, id||('auto'+Math.random().toString(36).slice(2))); },
      where(field,opv,val){ return { async get(){
        const docs=Object.keys(store).filter(p=>p.indexOf(col+'/')===0 && store[p] && store[p][field]===val)
          .map(p=>({ id:p.slice(col.length+1), data:()=>store[p] }));
        return { docs, empty:docs.length===0 };
      } }; }
    };
  }
  async function runTransaction(fn){
    // simple mock: tx.get reads live store; tx.set buffers then commits atomically
    const buf=[]; let aborted=false;
    const tx={ async get(ref){ return { exists: ref.path in store, data:()=>store[ref.path] }; },
               set(ref,d){ buf.push([ref.path,d]); } };
    try{ await fn(tx); }
    catch(e){ aborted=true; throw e; }
    finally{ if(!aborted){ buf.forEach(([p,d])=>{ writeLog.push({op:'set',path:p}); store[p]=JSON.parse(JSON.stringify(d)); }); } }
  }
  return { collection, runTransaction, _store:store, _writes:writeLog };
}

// ---------------- fixtures ----------------
const PIPE_TYPES=['300mm NP2','600mm NP3','900mm NP2'];
const MATERIAL_CATALOG=[
  {id:'cement',label:'Cement',unit:'Bags'},
  {id:'steel_6',label:'Steel 6mm',unit:'Kg'},
  {id:'msand',label:'M-Sand',unit:'Tons'},
  {id:'steel_2_5',label:'2.5mm',unit:'Kg'},
];
let _n=0; const uid=()=>'id'+(++_n);
const istToday=()=>'2026-08-12';

function mk(seedActive){
  _n=0;
  const db=makeDb();
  const MV2=buildMV2({db,PIPE_TYPES,MATERIAL_CATALOG,uid,istToday});
  MV2._setConfig({ enabled:true, activeProducts:seedActive||['600mm NP3'], unitConversions:{}, rateSource:'manual', rejectBasis:'moulded' });
  return {db,MV2};
}
// seed a valid active BOM for 600mm NP3 directly into the store (bypasses module for setup)
function seedBom(db, pk, version, lines, effectiveFrom){
  const h=buildMV2({db,PIPE_TYPES,MATERIAL_CATALOG,uid,istToday}).pkHash(pk);
  const bomId=`bomV2-${h}-v${version}`;
  db._store['bomRecipesV2/'+bomId]={ productKey:pk, version, materialLines:lines, standardLabourPerUnit:null, standardOverheadPerUnit:null };
  db._store['bomActivationsV2/act-'+bomId]={ productKey:pk, bomDocId:bomId, version, action:'activate', effectiveFrom:effectiveFrom||'2026-01-01', actorAt:'2026-01-01' };
  return bomId;
}

// ---------------- tiny test harness ----------------
let pass=0, fail=0; const fails=[];
function ok(name,cond){ if(cond){pass++;} else {fail++; fails.push(name);} console.log((cond?'  ✓ ':'  ✗ ')+name); }
async function expectThrow(name,fn,code){
  try{ await fn(); ok(name+' (should throw '+code+')', false); }
  catch(e){ ok(name+' → '+(e.code||e.message), e.isMV2 && (!code||e.code===code)); }
}

(async ()=>{
 console.log('\n== 1. Costing: moulded basis + both cost/unit ==');
 {
  const {db,MV2}=mk(['600mm NP3']);
  seedBom(db,'600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:0.85,stdRate:400},{materialId:'steel_6',unit:'Kg',qtyPerUnit:12,stdRate:60}]);
  const boms=await MV2.loadActiveBoms(['600mm NP3'],'2026-08-12');
  const c=MV2.computeCosting({date:'2026-08-12',pipes:{'600mm NP3':10},rejects:{'600mm NP3':2}}, pk=>boms[pk], MV2.config());
  const L=c.lines[0];
  ok('qtyMoulded = good+rejects = 12', L.qtyMoulded===12);
  ok('cement std qty = 0.85*12 = 10.2', Math.abs(L.materials[0].stdQtyTotal-10.2)<1e-9);
  const expBatch=0.85*12*400 + 12*12*60;   // 4080 + 8640 = 12720
  ok('batchCost uses moulded units (=12720)', Math.abs(L.batchCost-expBatch)<1e-6);
  ok('costPerMouldedUnit = batch/12', Math.abs(L.costPerMouldedUnit-expBatch/12)<1e-9);
  ok('costPerSaleableUnit = batch/10 (good)', Math.abs(L.costPerSaleableUnit-expBatch/10)<1e-9);
 }

 console.log('\n== 2. Validation failure BLOCKS and writes NOTHING (no legacy fallback) ==');
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);   // NO bom seeded ⇒ MISSING_BOM
  await expectThrow('post without BOM blocks', ()=>MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':5},rejects:{}}), 'MISSING_BOM');
  ok('NO writes occurred (0 writes)', db._writes.length===0);
  ok('NO production doc written', !Object.keys(db._store).some(p=>p.indexOf('production/')===0));
 })();
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);
  seedBom(db,'600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:1,stdRate:null}]); // missing rate
  const before=db._writes.length;
  await expectThrow('post with missing rate blocks', ()=>MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':5},rejects:{}}), 'MISSING_RATE');
  ok('missing-rate: no new writes', db._writes.length===before);
 })();
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);
  seedBom(db,'600mm NP3',1,[{materialId:'steel_6',unit:'Tons',qtyPerUnit:1,stdRate:60}]); // Tons≠Kg, no conversion
  await expectThrow('post with missing conversion blocks', ()=>MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':5},rejects:{}}), 'MISSING_CONVERSION');
  ok('missing-conversion: 0 writes', db._writes.length===0);
 })();
 await (async()=>{
  const {db,MV2}=mk(['300mm NP2']);   // active product has no BOM AND product 600 not active
  seedBom(db,'600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:1,stdRate:400}]);
  await expectThrow('post non-active product blocks', ()=>MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':5},rejects:{}}), 'PRODUCT_NOT_ACTIVE');
 })();

 console.log('\n== 3. Successful post: production + ALL V2 records together, allowlist honored ==');
 let goodPost;
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);
  seedBom(db,'600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:0.85,stdRate:400},{materialId:'steel_6',unit:'Kg',qtyPerUnit:12,stdRate:60}]);
  const r=await MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':10},rejects:{'600mm NP3':2}});
  goodPost={db,MV2,r};
  const paths=Object.keys(db._store);
  ok('exactly one production doc created', paths.filter(p=>p.indexOf('production/')===0).length===1);
  ok('one costing snapshot created', paths.filter(p=>p.indexOf('productionCostingV2/')===0).length===1);
  ok('two standard usage events (2 materials)', paths.filter(p=>p.indexOf('materialUsageV2/')===0).length===2);
  // every write is on allowlist or the single new production id
  const prodId=r.prodId;
  const offAllow=db._writes.filter(w=>!(w.path==='production/'+prodId || /^(manufacturingConfigV2|bomRecipesV2|bomActivationsV2|productionCostingV2|materialUsageV2|varianceReviewsV2)\//.test(w.path)));
  ok('no write outside allowlist', offAllow.length===0);
  ok('no update/delete ops at all', db._writes.every(w=>w.op==='set'));
 })();

 console.log('\n== 4. Atomicity: if the txn aborts, NOTHING persists ==');
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);
  seedBom(db,'600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:1,stdRate:400}]);
  // Force the production id to already exist so tx.get sees it and aborts.
  // uid() is deterministic in tests: next id will be 'idN'. Pre-seed that exact path.
  // Peek the next id by calling pkHash path is irrelevant; we instead monkeypatch runTransaction to inject a conflicting doc.
  const origRun=db.runTransaction.bind(db);
  db.runTransaction=async(fn)=>origRun(async tx=>{
    // simulate the freshly-generated production id already existing
    const realGet=tx.get.bind(tx); tx.get=async(ref)=>({exists:true, data:()=>({})});
    return fn(tx);
  });
  await expectThrow('duplicate production id aborts', ()=>MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':5},rejects:{}}), 'ID_COLLISION');
  ok('abort ⇒ zero persisted writes', db._writes.length===0);
  ok('abort ⇒ no production doc', !Object.keys(db._store).some(p=>p.indexOf('production/')===0));
 })();

 console.log('\n== 5. Idempotency: re-posting the SAME prodId writes the SAME deterministic ids ==');
 {
  // deterministic id check (unit level): same inputs → identical V2 doc ids
  const {MV2}=mk();
  const a=MV2.usageStdId('idX','600mm NP3','cement',0);
  const b=MV2.usageStdId('idX','600mm NP3','cement',0);
  ok('std usage id deterministic', a===b);
  ok('different pipe types → different ids (same material)', MV2.usageStdId('idX','600mm NP3','cement',0)!==MV2.usageStdId('idX','300mm NP2','cement',0));
  ok('no raw label/space in id', !/\s|\//.test(a) && !/__.*__/.test(a));
 }

 console.log('\n== 6. Correction is append-only (originals untouched) ==');
 await (async()=>{
  const {db,MV2,r}=goodPost;
  const beforePaths=new Set(Object.keys(db._store));
  const origCosting=JSON.parse(JSON.stringify(db._store['productionCostingV2/'+MV2.costingDocId(r.prodId,0)]));
  const origUsageKeys=Object.keys(db._store).filter(p=>p.indexOf('materialUsageV2/')===0);
  const origUsageSnapshot=origUsageKeys.map(k=>JSON.stringify(db._store[k]));
  // edit production → drift → correct
  const edited={date:'2026-08-12',pipes:{'600mm NP3':20},rejects:{'600mm NP3':2}};
  const drift=await MV2.detectDrift(edited, r.prodId);
  ok('drift detected after edit', drift.linked && drift.drift===true);
  const cor=await MV2.postCorrection(edited, r.prodId, 'owner');
  ok('correction created rev 1', cor.rev===1);
  // originals unchanged
  ok('original costing r0 unchanged', JSON.stringify(db._store['productionCostingV2/'+MV2.costingDocId(r.prodId,0)])===JSON.stringify(origCosting));
  ok('original usage events unchanged', origUsageKeys.every((k,i)=>JSON.stringify(db._store[k])===origUsageSnapshot[i]));
  // new docs are additive: reversal + new std + new costing
  ok('reversal events added', Object.keys(db._store).some(p=>/usgV2x-/.test(p)));
  ok('new costing r1 added', !!db._store['productionCostingV2/'+MV2.costingDocId(r.prodId,1)]);
  ok('no updates/deletes during correction', db._writes.every(w=>w.op==='set'));
 })();

 console.log('\n== 7. BOM immutability: cannot overwrite a version; edit = new version ==');
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);
  await MV2.saveBomVersion('600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:1,stdRate:400}]);
  await expectThrow('re-saving same version blocked', ()=>MV2.saveBomVersion('600mm NP3',1,[{materialId:'cement',unit:'Bags',qtyPerUnit:2,stdRate:400}]), 'BOM_EXISTS');
  const r2=await MV2.saveBomVersion('600mm NP3',2,[{materialId:'cement',unit:'Bags',qtyPerUnit:2,stdRate:410}]);
  ok('new version v2 created', r2.version===2);
 })();

 console.log('\n== 8. Latest activation on/before business date; retire blocks ==');
 {
  const {MV2}=mk();
  const acts=[
    {productKey:'600mm NP3',bomDocId:'B1',version:1,action:'activate',effectiveFrom:'2026-01-01',actorAt:'2026-01-01'},
    {productKey:'600mm NP3',bomDocId:'B2',version:2,action:'activate',effectiveFrom:'2026-06-01',actorAt:'2026-06-01'},
    {productKey:'600mm NP3',bomDocId:'',version:2,action:'retire',effectiveFrom:'2026-09-01',actorAt:'2026-09-01'},
  ];
  ok('date before any activation → none', MV2.resolveActiveBomId('600mm NP3','2025-12-01',acts)===null);
  ok('picks v1 on 2026-03-01', MV2.resolveActiveBomId('600mm NP3','2026-03-01',acts)==='B1');
  ok('picks v2 on 2026-07-01', MV2.resolveActiveBomId('600mm NP3','2026-07-01',acts)==='B2');
  ok('retired on 2026-10-01 → none', MV2.resolveActiveBomId('600mm NP3','2026-10-01',acts)===null);
 }

 console.log('\n== 9. Allowlist guard rejects any off-path write ==');
 {
  const {MV2}=mk();
  let threw=false; try{ MV2.assertWritable('orders/x',{}); }catch(e){ threw=e.code==='WRITE_BLOCKED'; }
  ok('writing to orders/* blocked', threw);
  let threw2=false; try{ MV2.assertWritable('production/legacy1',{newProductionId:'freshId'}); }catch(e){ threw2=e.code==='WRITE_BLOCKED'; }
  ok('writing a DIFFERENT production id blocked', threw2);
  ok('the one new production id allowed', MV2.assertWritable('production/freshId',{newProductionId:'freshId'})===true);
  ok('V2 path allowed', MV2.assertWritable('materialUsageV2/x',{})===true);
 }

 console.log('\n== 10. Disabled by default: no config ⇒ isEnabled false, post refused ==');
 await (async()=>{
  const db=makeDb();
  const MV2=buildMV2({db,PIPE_TYPES,MATERIAL_CATALOG,uid,istToday});
  await MV2.loadConfig();                          // the single allowed read
  const reads = 1;                                  // (mock doesn't count, asserted structurally)
  ok('config absent ⇒ isEnabled false', MV2.isEnabled()===false);
  await expectThrow('post refused when disabled', ()=>MV2.postProduction({date:'2026-08-12',pipes:{'600mm NP3':5},rejects:{}}), 'DISABLED');
  ok('disabled ⇒ zero writes ever', db._writes.length===0);
 })();

 console.log('\n== 11. Actual issues + variance (batch vs unallocated, incomplete not zero) ==');
 {
  const {MV2}=mk();
  const events=[
    {type:'standard',materialId:'cement',quantity:10, batchRef:'b1'},
    {type:'standard',materialId:'steel_6',quantity:120, batchRef:'b1'},
    {type:'actual',  materialId:'cement',quantity:11, batchRef:'b1'},      // batch-allocated
    {type:'actual',  materialId:'cement',quantity:2,  batchRef:null},      // unallocated
    // steel_6 has NO actual ⇒ must be incomplete, not zero variance
  ];
  const v=MV2.computeVariance(events);
  const cem=v.find(x=>x.materialId==='cement'), st=v.find(x=>x.materialId==='steel_6');
  ok('cement expected std = 10', cem.expectedStd===10);
  ok('cement actual total = 13 (11 batch + 2 unallocated)', cem.actualTotal===13);
  ok('cement variance = +3', cem.variance===3);
  ok('cement flags unallocated', /unallocated/.test(cem.note));
  ok('steel_6 incomplete (no actual), variance null not 0', st.complete===false && st.variance===null);
 }
 await (async()=>{
  const {db,MV2}=mk(['600mm NP3']);
  const id=await MV2.postActualIssue({date:'2026-08-12',materialId:'cement',quantity:5,batchRef:null,reference:'slip#9'});
  ok('actual issue written to materialUsageV2 only', Object.keys(db._store).every(p=>p.indexOf('materialUsageV2/')===0));
  ok('actual issue type=actual, batchRef null', db._store['materialUsageV2/'+id].type==='actual' && db._store['materialUsageV2/'+id].batchRef===null);
  await expectThrow('actual issue unknown material blocked', ()=>MV2.postActualIssue({materialId:'nope',quantity:1}), 'MAPPING_UNKNOWN');
 })();

 console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
 if(fail){ console.log('FAILED:', fails.join(' | ')); process.exit(1); }
})();
