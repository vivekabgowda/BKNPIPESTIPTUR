/* ============================================================================
   Manufacturing Intelligence V2 — core module (factory form for testability)
   PURE + DB layers. Disabled by default. Writes ONLY to the V2 allowlist
   (+ exactly one NEW production doc inside the posting transaction).
   No existing collection/doc is ever updated or deleted by this module.
   Injected deps let the same code run in the browser (real firestoreDb) and
   under a Node mock in tests.
   ==========================================================================*/
function buildMV2(deps){
  const {
    db,                 // firestore instance (real or mock)
    PIPE_TYPES,         // array of product keys (existing display strings)
    MATERIAL_CATALOG,   // [{id,label,unit}] union of MAT_SINGLE + STEEL_WIRE_SIZES
    uid,                // () => firestore-safe unique id
    istToday,           // () => 'YYYY-MM-DD' in Asia/Kolkata
  } = deps;

  // ---- error type: any validation block throws this; callers must NOT fall back ----
  class MV2Error extends Error { constructor(code,msg){ super(msg||code); this.code=code; this.isMV2=true; } }

  // ---- deterministic 32-bit FNV-1a → 8 hex chars (safe id encoding, no raw labels) ----
  function fnv1a(str){
    let h=0x811c9dc5;
    for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0; }
    return ('0000000'+h.toString(16)).slice(-8);
  }
  const pkHash = pk => fnv1a(String(pk));

  // stable content hash of a production doc's cost-relevant fields (drift detection)
  function prodHash(p){
    const norm = o => Object.keys(o||{}).filter(k=>Number(o[k])>0).sort()
      .map(k=>k+'='+Number(o[k])).join(',');
    return fnv1a([p.date||'','P['+norm(p.pipes)+']','R['+norm(p.rejects)+']'].join('|'));
  }

  // ---- Firestore-safe deterministic ids (no '/', no spaces, never '__…__') ----
  const bomDocId       = (pk,ver)         => `bomV2-${pkHash(pk)}-v${ver}`;
  const costingDocId   = (prodId,rev)     => `cstV2-${prodId}-r${rev}`;
  const usageStdId     = (prodId,pk,mat,rev) => `usgV2s-${prodId}-${mat}-p${pkHash(pk)}-r${rev}`;
  const usageRevId     = (prodId,pk,mat,rev) => `usgV2x-${prodId}-${mat}-p${pkHash(pk)}-r${rev}`;
  const usageActualId  = ()               => `usgV2a-${uid()}`;

  // ---- write allowlist: the ONLY paths this module may write ----
  const WRITE_PREFIXES = [
    'manufacturingConfigV2/','bomRecipesV2/','bomActivationsV2/',
    'productionCostingV2/','materialUsageV2/','varianceReviewsV2/'
  ];
  // ctx.newProductionId (optional): the single brand-new production doc a posting
  // transaction may create. No other production path — and no other legacy path — is writable.
  function assertWritable(path, ctx){
    ctx = ctx||{};
    if(ctx.newProductionId && path === 'production/'+ctx.newProductionId) return true;
    if(WRITE_PREFIXES.some(pre => path.indexOf(pre)===0)) return true;
    throw new MV2Error('WRITE_BLOCKED','V2 refused to write outside its allowlist: '+path);
  }
  function refOf(path){ const i=path.indexOf('/'); return db.collection(path.slice(0,i)).doc(path.slice(i+1)); }

  const catalogById = {};
  (MATERIAL_CATALOG||[]).forEach(m=>catalogById[m.id]=m);

  // ---- unit conversion: explicit factor required; missing ⇒ block (never guess) ----
  function convertQty(qty, matId, bomUnit, config){
    const cat = catalogById[matId];
    if(!cat) throw new MV2Error('MAPPING_UNKNOWN','Material not in catalog: '+matId);
    if(!bomUnit || bomUnit===cat.unit) return { qty, unit:cat.unit };      // identity
    const conv = ((config&&config.unitConversions)||{})[matId];
    if(!conv || conv.fromUnit!==bomUnit || conv.toUnit!==cat.unit || !(Number(conv.factor)>0))
      throw new MV2Error('MISSING_CONVERSION',`No unit conversion for ${matId}: ${bomUnit} → ${cat.unit}`);
    return { qty: qty*Number(conv.factor), unit:cat.unit };
  }

  // ---- resolve active BOM: latest valid activation effective on/before istDate ----
  // activations: array of {productKey,bomDocId,version,action,effectiveFrom,actorAt}
  function resolveActiveBomId(pk, istDate, activations){
    const evts = (activations||[]).filter(a=>a.productKey===pk && (a.effectiveFrom||'')<=istDate)
      .sort((a,b)=> (a.effectiveFrom||'').localeCompare(b.effectiveFrom||'') || (a.actorAt||'').localeCompare(b.actorAt||''));
    if(!evts.length) return null;
    const last = evts[evts.length-1];
    return last.action==='activate' ? last.bomDocId : null;   // 'retire' ⇒ none
  }

  // ---- PURE costing: moulded-basis consumption; both cost/unit; blocks on any gap ----
  // resolveBom(pk) must return the BOM doc (already validated active for the date) or null.
  function computeCosting(prodDoc, resolveBom, config){
    const pipes=prodDoc.pipes||{}, rejects=prodDoc.rejects||{};
    const productKeys = PIPE_TYPES.filter(t=>Number(pipes[t])>0);
    if(!productKeys.length) throw new MV2Error('NO_PRODUCTION','No produced quantity to cost');
    const lines = productKeys.map(pk=>{
      const qtyGood=Number(pipes[pk])||0, qtyRejected=Number(rejects[pk])||0;
      const qtyMoulded=qtyGood+qtyRejected;                    // <-- moulded basis (good + rejects)
      const bom = resolveBom(pk);
      if(!bom) throw new MV2Error('MISSING_BOM','No active BOM for '+pk+' as of '+prodDoc.date);
      const materials=(bom.materialLines||[]).map(ml=>{
        if(!catalogById[ml.materialId]) throw new MV2Error('MAPPING_UNKNOWN','Unknown material '+ml.materialId+' in BOM '+pk);
        if(ml.stdRate===null||ml.stdRate===undefined||isNaN(Number(ml.stdRate)))
          throw new MV2Error('MISSING_RATE','No standard rate for '+ml.materialId+' in BOM '+pk);
        const conv=convertQty(Number(ml.qtyPerUnit)||0, ml.materialId, ml.unit, config);
        const stdQtyTotal=conv.qty*qtyMoulded, rate=Number(ml.stdRate);
        return { materialId:ml.materialId, unit:conv.unit, stdQtyPerUnit:conv.qty,
                 stdQtyTotal, rateUsed:rate, rateSource:'manual', materialCost:stdQtyTotal*rate };
      });
      const materialCostTotal=materials.reduce((s,m)=>s+m.materialCost,0);
      const labourCost=(Number(bom.standardLabourPerUnit)||0)*qtyMoulded;
      const overheadCost=(Number(bom.standardOverheadPerUnit)||0)*qtyMoulded;
      const batchCost=materialCostTotal+labourCost+overheadCost;
      return { productKey:pk, bomDocId:bom._id, bomVersion:bom.version,
        qtyGood, qtyRejected, qtyMoulded, materials, materialCostTotal, labourCost, overheadCost, batchCost,
        costPerMouldedUnit: qtyMoulded>0 ? batchCost/qtyMoulded : 'unknown',
        costPerSaleableUnit: qtyGood>0   ? batchCost/qtyGood    : 'unknown' };   // 0 good ⇒ 'unknown', never ∞/0
    });
    const totals=lines.reduce((a,l)=>({
      materialCost:a.materialCost+l.materialCostTotal, labourCost:a.labourCost+l.labourCost,
      overheadCost:a.overheadCost+l.overheadCost, batchCost:a.batchCost+l.batchCost
    }),{materialCost:0,labourCost:0,overheadCost:0,batchCost:0});
    return { lines, totals, rateSource:'manual' };
  }

  // ---- pre-read active BOMs for a set of products (queries — MUST be outside the txn) ----
  async function loadActiveBoms(productKeys, istDate){
    const out={};
    for(const pk of productKeys){
      const snap = await db.collection('bomActivationsV2').where('productKey','==',pk).get();
      const activations = snap.docs.map(d=>d.data());
      const bomId = resolveActiveBomId(pk, istDate, activations);
      if(!bomId){ out[pk]=null; continue; }
      const bomSnap = await db.collection('bomRecipesV2').doc(bomId).get();
      out[pk] = bomSnap.exists ? Object.assign({_id:bomId}, bomSnap.data()) : null;
    }
    return out;
  }

  // ============================ POSTING (online, atomic) =====================
  // Creates the NEW production doc AND all V2 records in ONE transaction, or none.
  // Validation failure throws BEFORE any write — caller must surface the error and
  // must NOT write a legacy production doc as a fallback.
  async function postProduction(entry){
    if(!config().enabled) throw new MV2Error('DISABLED','V2 is not enabled');
    const date = entry.date || istToday();
    const pipes = entry.pipes||{}, rejects = entry.rejects||{};
    const productKeys = PIPE_TYPES.filter(t=>Number(pipes[t])>0);
    if(!productKeys.length) throw new MV2Error('NO_PRODUCTION','Enter at least one produced quantity');
    const notActive = productKeys.filter(pk=>!(config().activeProducts||[]).includes(pk));
    if(notActive.length) throw new MV2Error('PRODUCT_NOT_ACTIVE','Not V2-active: '+notActive.join(', '));

    // ---- pre-read (queries can't run inside a transaction) ----
    const boms = await loadActiveBoms(productKeys, date);
    // ---- validate + compute BEFORE opening the transaction; any gap blocks here ----
    const prodDoc = { date, pipes, rejects, notes: entry.notes||'' };
    const costing = computeCosting(prodDoc, pk=>boms[pk], config());   // throws on any missing BOM/rate/mapping/conversion

    const prodId = uid();
    const prodPath = 'production/'+prodId;
    const costingId = costingDocId(prodId,0);
    const costingDoc = {
      sourceProductionId: prodId, sourceProductionHash: prodHash(prodDoc), revision:0, correctionOf:null,
      lines: costing.lines, totals: costing.totals, rateSource:'manual',
      postedBy: entry.actorBy||'owner', postedAt: istToday()
    };
    // standard usage events (deterministic ids → replay-safe within this prodId)
    const usageDocs=[];
    costing.lines.forEach(l=>l.materials.forEach(m=>{
      usageDocs.push({ path:'materialUsageV2/'+usageStdId(prodId,l.productKey,m.materialId,0),
        data:{ type:'standard', materialId:m.materialId, unit:m.unit, quantity:m.stdQtyTotal,
               productKey:l.productKey, sourceProductionId:prodId, bomVersion:l.bomVersion, revision:0,
               batchRef:null, reference:'', note:'', eventTime:istToday(), enteredBy:entry.actorBy||'owner' } });
    }));

    // ---- ONE transaction: get(prodRef) first → abort if exists → then create all ----
    const ctx={ newProductionId: prodId };
    await db.runTransaction(async tx=>{
      const prodRef=refOf(prodPath);
      const snap=await tx.get(prodRef);
      if(snap.exists) throw new MV2Error('ID_COLLISION','Generated production id already exists; aborted');
      // write nothing legacy other than this brand-new production doc:
      assertWritable(prodPath, ctx);        tx.set(prodRef, prodDoc);
      assertWritable('productionCostingV2/'+costingId, ctx); tx.set(refOf('productionCostingV2/'+costingId), costingDoc);
      usageDocs.forEach(u=>{ assertWritable(u.path, ctx); tx.set(refOf(u.path), u.data); });
    });
    return { prodId, costingId, lines:costing.lines, totals:costing.totals };
  }

  // ============================ DRIFT + CORRECTION ===========================
  // latest costing revision via EQUALITY-ONLY query (no composite index), max in memory
  async function latestCosting(prodId){
    const snap=await db.collection('productionCostingV2').where('sourceProductionId','==',prodId).get();
    let best=null; snap.docs.forEach(d=>{ const c=d.data(); if(!best||Number(c.revision)>Number(best.revision)) best=c; });
    return best;
  }
  async function detectDrift(prodDoc, prodId){
    const c=await latestCosting(prodId);
    if(!c) return { linked:false, drift:false };
    return { linked:true, drift: c.sourceProductionHash !== prodHash(prodDoc), latest:c };
  }
  // Append-only correction: reversal events for the prior revision + NEW costing (rev+1) + new std events.
  // NEVER updates/deletes the prior costing, prior usage, or the production doc.
  async function postCorrection(prodDoc, prodId, actorBy){
    if(!config().enabled) throw new MV2Error('DISABLED','V2 is not enabled');
    const prev=await latestCosting(prodId);
    if(!prev) throw new MV2Error('NOT_LINKED','This production has no V2 costing to correct');
    const rev=Number(prev.revision)+1;
    const date=prodDoc.date;
    const productKeys=PIPE_TYPES.filter(t=>Number((prodDoc.pipes||{})[t])>0);
    const boms=await loadActiveBoms(productKeys, date);
    const costing=computeCosting(prodDoc, pk=>boms[pk], config());   // recompute; blocks on any gap

    const costingId=costingDocId(prodId,rev);
    const newCosting={ sourceProductionId:prodId, sourceProductionHash:prodHash(prodDoc), revision:rev,
      correctionOf:costingDocId(prodId,prev.revision), lines:costing.lines, totals:costing.totals,
      rateSource:'manual', postedBy:actorBy||'owner', postedAt:istToday() };

    const writes=[];
    // reversal events negate the PRIOR revision's standard usage (read from prev snapshot)
    (prev.lines||[]).forEach(l=>(l.materials||[]).forEach(m=>{
      writes.push({ path:'materialUsageV2/'+usageRevId(prodId,l.productKey,m.materialId,rev),
        data:{ type:'reversal', materialId:m.materialId, unit:m.unit, quantity: -Number(m.stdQtyTotal),
               productKey:l.productKey, sourceProductionId:prodId, bomVersion:l.bomVersion, revision:rev,
               supersedes:usageStdId(prodId,l.productKey,m.materialId,prev.revision),
               batchRef:null, reference:'correction', note:'', eventTime:istToday(), enteredBy:actorBy||'owner' } });
    }));
    // new standard events at the new revision
    costing.lines.forEach(l=>l.materials.forEach(m=>{
      writes.push({ path:'materialUsageV2/'+usageStdId(prodId,l.productKey,m.materialId,rev),
        data:{ type:'standard', materialId:m.materialId, unit:m.unit, quantity:Number(m.stdQtyTotal),
               productKey:l.productKey, sourceProductionId:prodId, bomVersion:l.bomVersion, revision:rev,
               batchRef:null, reference:'correction', note:'', eventTime:istToday(), enteredBy:actorBy||'owner' } });
    }));
    writes.push({ path:'productionCostingV2/'+costingId, data:newCosting });

    await db.runTransaction(async tx=>{
      // sets only; no gets of legacy; no update/delete of any prior doc
      writes.forEach(w=>{ assertWritable(w.path,{}); tx.set(refOf(w.path), w.data); });
    });
    return { costingId, rev, reversals:(prev.lines||[]).reduce((s,l)=>s+(l.materials||[]).length,0) };
  }

  // ============================ BOM lifecycle ================================
  // Draft = write-once doc. "Edit draft" => NEW version doc (never edit in place).
  async function saveBomVersion(pk, version, materialLines, opts){
    opts=opts||{};
    const id=bomDocId(pk,version);
    const exists=(await db.collection('bomRecipesV2').doc(id).get()).exists;
    if(exists) throw new MV2Error('BOM_EXISTS','That BOM version already exists — create a new version instead');
    const doc={ productKey:pk, pkHash:pkHash(pk), version, effectiveFrom:opts.effectiveFrom||istToday(),
      materialLines, standardLabourPerUnit:opts.labour??null, standardOverheadPerUnit:opts.overhead??null,
      rejectPolicy:{basis:'moulded'}, validation:validateBom(materialLines),
      createdBy:opts.actorBy||'owner', createdAt:istToday() };
    assertWritable('bomRecipesV2/'+id,{});
    await refOf('bomRecipesV2/'+id).set(doc);       // create-only
    return { id, version };
  }
  function validateBom(materialLines){
    const issues=[];
    (materialLines||[]).forEach(ml=>{
      if(!catalogById[ml.materialId]) issues.push('Unknown material: '+ml.materialId);
      if(ml.stdRate===null||ml.stdRate===undefined||isNaN(Number(ml.stdRate))) issues.push('Missing rate: '+ml.materialId);
      if(!(Number(ml.qtyPerUnit)>=0)) issues.push('Bad qty/unit: '+ml.materialId);
    });
    return { status: issues.length?'invalid':'valid', issues };
  }
  // Activation = append-only event; never mutates BOM docs.
  async function activateBom(pk, version, effectiveFrom, actorBy){
    const bomId=bomDocId(pk,version);
    if(!(await db.collection('bomRecipesV2').doc(bomId).get()).exists)
      throw new MV2Error('BOM_MISSING','BOM version not found');
    const id='bomActV2-'+uid();
    const evt={ productKey:pk, pkHash:pkHash(pk), bomDocId:bomId, version, action:'activate',
      effectiveFrom:effectiveFrom||istToday(), actorBy:actorBy||'owner', actorAt:istToday() };
    assertWritable('bomActivationsV2/'+id,{});
    await refOf('bomActivationsV2/'+id).set(evt);
    return id;
  }

  // ============================ ACTUAL ISSUES ===============================
  // Manual, append-only. batchRef optional; null ⇒ "unallocated to batch".
  async function postActualIssue(issue){
    if(!config().enabled) throw new MV2Error('DISABLED','V2 is not enabled');
    if(!catalogById[issue.materialId]) throw new MV2Error('MAPPING_UNKNOWN','Unknown material: '+issue.materialId);
    if(!(Number(issue.quantity)>0)) throw new MV2Error('BAD_QTY','Quantity must be greater than 0');
    const id=usageActualId();
    const doc={ type:'actual', materialId:issue.materialId, unit:catalogById[issue.materialId].unit,
      quantity:Number(issue.quantity), productKey:issue.productKey||null,
      sourceProductionId:issue.batchRef||null, bomVersion:null, revision:null,
      batchRef:issue.batchRef||null, reference:issue.reference||'', note:issue.note||'',
      eventTime:issue.date||istToday(), enteredBy:issue.actorBy||'owner' };
    assertWritable('materialUsageV2/'+id,{});
    await refOf('materialUsageV2/'+id).set(doc);
    return id;
  }

  // ============================ VARIANCE (pure) =============================
  // events: array of materialUsageV2 docs. Standard net = Σ(standard)+Σ(reversal).
  // Returns per-material {expectedStd, actualTotal, actualBatch, actualUnallocated, variance, variancePct, complete}.
  function computeVariance(events, opts){
    opts=opts||{}; const by={};
    const get=m=>by[m]||(by[m]={expectedStd:0, actualTotal:0, actualBatch:0, actualUnallocated:0});
    (events||[]).forEach(e=>{
      const r=get(e.materialId);
      if(e.type==='standard'||e.type==='reversal') r.expectedStd+=Number(e.quantity)||0; // reversal is negative
      else if(e.type==='actual'){ const q=Number(e.quantity)||0; r.actualTotal+=q; if(e.batchRef) r.actualBatch+=q; else r.actualUnallocated+=q; }
    });
    return Object.keys(by).map(m=>{
      const r=by[m]; const hasActual=r.actualTotal!==0;
      const variance = hasActual ? (r.actualTotal - r.expectedStd) : null;   // no actual ⇒ incomplete, NOT zero
      const variancePct = (hasActual && r.expectedStd!==0) ? (variance/r.expectedStd*100) : null;
      return { materialId:m, expectedStd:r.expectedStd, actualTotal:r.actualTotal,
        actualBatch:r.actualBatch, actualUnallocated:r.actualUnallocated,
        variance, variancePct, complete:hasActual,
        note: hasActual ? (r.actualUnallocated>0 ? 'includes unallocated-to-batch issues' : '') : 'incomplete — no actual issues recorded' };
    });
  }

  // ============================ config ======================================
  let _config=null;
  async function loadConfig(){
    const snap=await db.collection('manufacturingConfigV2').doc('config').get();  // the single allowed read when absent
    _config = snap.exists ? snap.data() : null;                                    // null ⇒ disabled
    return _config;
  }
  function config(){ return _config || { enabled:false, activeProducts:[], unitConversions:{}, rateSource:'manual', rejectBasis:'moulded' }; }
  function isEnabled(){ return !!(_config && _config.enabled); }

  return { MV2Error, fnv1a, pkHash, prodHash, bomDocId, costingDocId, usageStdId, usageRevId, usageActualId,
    WRITE_PREFIXES, assertWritable, convertQty, resolveActiveBomId, computeCosting, loadActiveBoms,
    postProduction, latestCosting, detectDrift, postCorrection, saveBomVersion, validateBom, activateBom,
    postActualIssue, computeVariance,
    loadConfig, config, isEnabled, _setConfig:c=>{_config=c;} };
}
if(typeof module!=='undefined') module.exports={ buildMV2 };
