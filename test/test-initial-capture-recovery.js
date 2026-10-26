'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const N=require('../lib/similarweb-nodes');
const source=fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
const recovery=source.slice(source.indexOf('async function recoverInitialCapture('),source.indexOf('\nfunction captureCheck('));
function harness(options={}){
  let jobs={7:{kind:'capture',origin:N.BASE,items:[],seen:[],startedAt:123,quietMs:10,...options.job}},chain=Promise.resolve();
  const reloaded=[],finished=[],probes=[],scheduled=[];
  const context={URL,self:{GefeiSimilarwebNodes:N},loadJobs:async()=>structuredClone(jobs),saveJobs:async value=>{jobs=structuredClone(value)},
    serial(fn){const run=chain.then(fn,fn);chain=run.catch(()=>{});return run},notify(){},scheduleCaptureCheck:id=>scheduled.push(id),
    finish:async(id,result)=>{finished.push(result);delete jobs[id]},
    chrome:{tabs:{get:async()=>({url:options.url||N.BASE+'/#/report',status:options.status,pendingUrl:options.pendingUrl}),reload:async id=>reloaded.push(id)},scripting:{executeScript:async spec=>{
      probes.push(spec);assert.equal(spec.func,N.sourceState);
      if(options.arriving)jobs[7].items.push({page:0,parsed:{rows:[{domain:'arrived.test'}]}});
      return [{result:options.state||'wait',documentId:options.noDocument?undefined:'old-document'}];
    }}},
  };
  vm.runInNewContext(recovery,context);
  return{context,reloaded,finished,probes,scheduled,get job(){return jobs[7]}};
}
test('initial 3ue capture reloads once without resetting its timeout and records the old document',async()=>{
  const h=harness();await h.context.recoverInitialCapture(7);await h.context.recoverInitialCapture(7);
  assert.deepEqual(h.reloaded,[7]);assert.equal(h.job.startedAt,123);assert.equal(h.job.initialLoadReloads,1);
  assert.equal(h.job.ignoredDocumentId,'old-document');assert.equal(h.finished.length,0);
});
test('concurrent checks cannot issue two reloads',async()=>{
  const h=harness();await Promise.all([h.context.recoverInitialCapture(7),h.context.recoverInitialCapture(7)]);assert.equal(h.reloaded.length,1);
});
for(const state of ['blocked','login','challenge'])test(state+' stops without reloading',async()=>{
  const h=harness({state});await h.context.recoverInitialCapture(7);assert.equal(h.reloaded.length,0);assert.equal(h.finished.length,1);assert.equal(h.finished[0].ok,false);
});
test('captured data, unrelated sites and prior failure never enter recovery',async()=>{
  for(const job of [{items:[{page:0}]},{origin:'https://pro.similarweb.com'},{captureError:'bad response'},{throttled:'429'}]){
    const h=harness({job});await h.context.recoverInitialCapture(7);assert.equal(h.probes.length,0);assert.equal(h.reloaded.length,0);
  }
});
test('data arriving during the DOM check prevents a reload and is preserved',async()=>{
  const h=harness({arriving:true});await h.context.recoverInitialCapture(7);assert.equal(h.reloaded.length,0);assert.equal(h.job.items[0].parsed.rows[0].domain,'arrived.test');
});
test('a foreign redirect is not inspected or reloaded',async()=>{
  const h=harness({url:'https://other.example/login'});await h.context.recoverInitialCapture(7);assert.equal(h.probes.length,0);assert.equal(h.reloaded.length,0);assert.equal(h.finished.length,1);
});
test('missing trusted document identity disables reload and keeps the existing wait path',async()=>{
  const h=harness({noDocument:true});await h.context.recoverInitialCapture(7);assert.equal(h.reloaded.length,0);assert.equal(h.finished.length,0);assert.equal(h.scheduled.length,1);
});
test('an uncommitted navigation to the authorized report keeps waiting without reloading about:blank',async()=>{
  const h=harness({url:'about:blank',status:'loading',pendingUrl:N.BASE+'/#/report'});await h.context.recoverInitialCapture(7);
  assert.equal(h.probes.length,0);assert.equal(h.reloaded.length,0);assert.equal(h.finished.length,0);assert.equal(h.job.initialLoadRetried,undefined);
});
