'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/similarweb-nodes');
function fixture(scenario = {}) {
  let next = 1, listener, selected, reloads = 0, opened = [], removed = [], injected = [], activations = [];
  const tabs = new Map();
  const api = {
    permissions: { contains: async () => scenario.permission !== false },
    tabs: {
      query: async () => [{id:900}],
      update: async (id,patch) => { activations.push(id); if(tabs.has(id))Object.assign(tabs.get(id),patch); },
      onCreated: { addListener(fn) { listener = fn; }, removeListener(fn) { assert.equal(listener, fn); listener = null; } },
      create: async () => { const t = { id: next++, url: scenario.portalUrl || N.PORTAL, status: 'complete' }; tabs.set(t.id, t); return t; },
      reload: async () => {reloads++},
      get: async id => { assert.ok(tabs.has(id)); return tabs.get(id); },
      remove: async id => { removed.push(id); tabs.delete(id); },
    },
    scripting: { executeScript: async ({target,func,args}) => {
      injected.push(target.tabId);
      if (func === N.portalStep) {
        const [node,action] = args;
        if (action === 'status') return [{result:{state:'wait'}}];
        if (action === 'select') { selected = node; return [{result:{state:scenario.portal || (scenario.portalUntilReload&&!reloads?'wait':scenario.missing?.includes(node)?'missing':'selected')}}]; }
        opened.push(node);
        if (scenario.openState) return [{result:{state:scenario.openState}}];
        if (scenario.noPopup) return [{result:{state:'opened'}}];
        if (scenario.sameTab) { tabs.get(target.tabId).url=N.BASE; return [{result:{state:'opened'}}]; }
        const t = { id: next++, openerTabId: target.tabId, url: scenario.foreign ? 'https://example.test/login' : N.BASE, status: 'complete' };
        tabs.set(t.id,t); listener(t);
        return [{result:{state:'opened'}}];
      }
      assert.equal(func,N.sourceState);
      return [{result:scenario.needsForeground ? (tabs.get(target.tabId).active ? 'ready' : 'wait') : scenario.source?.[selected] || 'ready'}];
    } },
  };
  return {api,tabs,opened,removed,injected,activations,get reloads(){return reloads},get listening(){return !!listener}};
}
const run = f => N.prepare(f.api,{}, {delay:async()=>{},polls:2});
test('node preference defaults to 4; explicit order is validated and deduplicated',()=>{
  assert.deepEqual(N.nodeOrder(),[4,1,2,3]);assert.deepEqual(N.nodeOrder('4, 2,4,1'),[4,2,1]);
  for(const raw of ['', '5', '4,https://example.test', '4.1', '0'])assert.throws(()=>N.nodeOrder(raw));
});
test('ready node 4 returns only its prepared tab, closes portal, removes listener',async()=>{
  const f=fixture(),r=await run(f);assert.equal(r.node,4);assert.deepEqual(f.opened,[4]);
  assert.deepEqual([...f.tabs.keys()],[r.tabId]);assert.equal(f.listening,false);
});
test('explicit busy node falls back, closes failed tabs and returns healthy node',async()=>{
  const f=fixture({source:{4:'busy'}}),r=await run(f);assert.equal(r.node,1);assert.deepEqual(f.opened,[4,1]);assert.equal(f.tabs.size,1);assert.equal(f.listening,false);
});
test('same-tab portal navigation becomes the owned source without being closed',async()=>{
  const f=fixture({sameTab:true}),r=await run(f);assert.equal(r.node,4);assert.equal(r.tabId,1);
  assert.equal(f.tabs.size,1);assert.equal(f.tabs.get(1).url,N.BASE);assert.equal(f.listening,false);
});
test('busy same-tab source returns to the portal before selecting its fallback',async()=>{
  const f=fixture({sameTab:true,source:{4:'busy'}}),r=await run(f);assert.equal(r.node,1);assert.equal(r.tabId,1);
  assert.deepEqual(f.opened,[4,1]);assert.equal(f.tabs.size,1);assert.equal(f.listening,false);
});
test('missing node uses next configured node; all busy nodes fail and clean up',async()=>{
  const f=fixture({missing:[4]});assert.equal((await run(f)).node,1);
  const busy=fixture({source:{4:'busy',1:'busy',2:'busy',3:'busy'}});await assert.rejects(run(busy),/均不可用/);assert.equal(busy.tabs.size,0);assert.equal(busy.listening,false);
});
for(const source of ['blocked','login','wait'])test(source+' does not switch accounts or return partial success',async()=>{
  const f=fixture({source:{4:source}});await assert.rejects(run(f));assert.deepEqual(f.opened,[4]);assert.equal(f.tabs.size,0);assert.equal(f.listening,false);
});
test('missing permission does not open a tab',async()=>{
  const f=fixture({permission:false});await assert.rejects(run(f),/允许/);assert.equal(f.tabs.size,0);assert.equal(f.listening,false);
});
test('unexpected destination is never injected; no popup stops without fallback',async()=>{
  const f=fixture({foreign:true});await assert.rejects(run(f),/其他网站/);assert.deepEqual(f.injected,[1,1]);assert.equal(f.tabs.size,0);
  const none=fixture({noPopup:true});await assert.rejects(run(none),/未自动切换/);assert.deepEqual(none.opened,[4]);assert.equal(none.tabs.size,0);
});
test('portal redirect diagnostics identify the stage and origin without exposing login query data',async()=>{
  const f=fixture({portalUrl:'https://login.example.test/path?token=synthetic-secret'});
  await assert.rejects(run(f),e=>/3ue用户中心/.test(e.message)&&/https:\/\/login.example.test/.test(e.message)&&!e.message.includes('synthetic-secret')&&!e.message.includes('/path'));
  assert.equal(f.injected.length,0);assert.equal(f.tabs.size,0);
  const blank=fixture({portalUrl:'about:blank'});
  await assert.rejects(run(blank),/当前域名：空白或非网页地址/);assert.equal(blank.injected.length,0);
});
for(const portal of ['blocked','login','challenge','wait'])test('portal '+portal+' stops without trying other nodes',async()=>{
  const f=fixture({portal});await assert.rejects(run(f));assert.equal(f.opened.length,0);assert.equal(f.tabs.size,0);
});
test('stalled owned portal is foregrounded and reloaded once, without changing nodes',async()=>{
  const f=fixture({portalUntilReload:true});let tick=100;const progress=[];
  const r=await N.prepare(f.api,{}, {polls:5,now:()=>tick,foregroundAfterMs:5,portalReloadAfterMs:15,delay:async()=>{tick+=10},onProgress:s=>progress.push(s)});
  assert.equal(r.node,4);assert.equal(r.preparationReloads,1);assert.equal(f.reloads,1);assert.deepEqual(f.opened,[4]);assert.ok(progress.some(s=>/自动重载一次/.test(s)));
});
test('persistently blank portal exhausts its one reload without cycling nodes',async()=>{
  const f=fixture({portal:'wait'});let tick=100;
  await assert.rejects(N.prepare(f.api,{}, {polls:6,now:()=>tick,foregroundAfterMs:5,portalReloadAfterMs:15,delay:async()=>{tick+=10}}),/自动重载一次后仍未就绪/);
  assert.equal(f.reloads,1);assert.deepEqual(f.opened,[]);assert.equal(f.tabs.size,0);
});
for(const portal of ['blocked','login','challenge'])test('portal '+portal+' never uses the reload recovery',async()=>{
  const f=fixture({portal});await assert.rejects(N.prepare(f.api,{}, {polls:5,portalReloadAfterMs:0,foregroundAfterMs:0,delay:async()=>{}}));
  assert.equal(f.reloads,0);
});

// Exercise the real background adapter and tab lifecycle, including re-arming
// the existing hook only after an owned job is registered.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const background = fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
function fn(name,end) {
  const begin=background.indexOf('function '+name+'('),stop=background.indexOf(end,begin);
  assert.ok(begin>=0&&stop>begin);return background.slice(begin,stop);
}
async function adapter(mode,base='https://sim.3ue.com',kind='capture') {
  const events=[],jobs={},Nmock={BASE:N.BASE,prepare:async()=>{events.push('prepare');return{tabId:44,node:4,returnTabId:900,foregroundAt:123}}};
  const context={URL,Date,Number,Object,Promise,setTimeout(){},AWAKE_MARK:'',JOB_TIMEOUT_MS:100,FOREGROUND_AFTER_MS:10,
    self:{GefeiSimilarwebNodes:Nmock},serial:async cb=>cb(),loadJobs:async()=>jobs,saveJobs:async()=>{events.push('save')},
    logActivity(){},fromLabel(){return'cloud'},ensureCaptureScripts:async()=>{events.push('scripts')},waitForAllow:async()=>{throw Error('unexpected permission prompt')},
    chrome:{permissions:{contains:async()=>true},storage:{local:{get:async()=>({similarwebNodeMode:mode})}},
      tabs:{query:async()=>[{id:10}],create:async()=>{events.push('create');return{id:45}},get:async id=>({id}),
        sendMessage:async id=>{assert.ok(jobs[id]);events.push('arm');return{ok:true}},update:async id=>{assert.ok(jobs[id]);events.push('navigate')},reload:async()=>{throw Error('must not race a reload with navigation')},remove:async()=>{events.push('remove')}}},
  };
  vm.createContext(context);
  vm.runInContext(fn('openJob','\nfunction fromLabel')+'\n'+fn('startRemoteJob','\n/** 页面交上来'),context);
  await context.startRemoteJob({requestId:'a'.repeat(32),kind,site:'similarweb',base,url:base+'/#/report',extract:'sw_referrals',pager:{times:19},requests:['/api/report']}, {agent:true});
  await new Promise(r=>setImmediate(r));return{events,jobs,context};
}
test('node-enabled capture saves the job before re-arming and navigating its prepared tab',async()=>{
  const {events,jobs}=await adapter(true);assert.deepEqual(events,['scripts','prepare','save','arm','navigate']);
  assert.equal(jobs[44].sourceNode,4);assert.equal(jobs[44].pager.times,19);assert.equal(jobs[44].toAgent,true);assert.equal(jobs[44].returnTabId,900);assert.ok(jobs[44].foregroundAt>=jobs[44].startedAt);
});
test('disabled node mode and official-site callers retain the original create-tab path',async()=>{
  for(const [mode,base] of [[false,N.BASE],[undefined,N.BASE],[true,'https://pro.similarweb.com']]){
    const {events,jobs}=await adapter(mode,base);assert.deepEqual(events,['scripts','create','save']);assert.equal(jobs[45].sourceNode,null);
  }
});
test('node-enabled fetch keeps its request path without arming a capture-only hook',async()=>{
  const {events,jobs}=await adapter(true,N.BASE,'fetch');assert.deepEqual(events,['prepare','save','navigate']);
  assert.equal(jobs[44].kind,'fetch');assert.deepEqual(Array.from(jobs[44].requests),['/api/report']);
});

test('hidden source app gets the existing foreground fallback; the caller receives the original return tab',async()=>{
  const f=fixture({needsForeground:true});let tick=100;
  const result=await N.prepare(f.api,{}, {polls:4,foregroundAfterMs:5,now:()=>tick,delay:async()=>{tick+=10}});
  assert.equal(result.node,4);assert.equal(result.returnTabId,900);assert.equal(result.foregroundAt,100);
  assert.deepEqual(f.activations,[1,result.tabId]);assert.equal(f.tabs.size,1);
});
test('failed hidden app returns focus and does not switch nodes on a generic timeout',async()=>{
  const f=fixture({source:{4:'wait'}});let tick=100;
  await assert.rejects(N.prepare(f.api,{}, {polls:3,foregroundAfterMs:5,now:()=>tick,delay:async()=>{tick+=10}}),/未自动切换/);
  assert.deepEqual(f.opened,[4]);assert.deepEqual(f.activations,[1,2,900]);assert.equal(f.tabs.size,0);
});

test('a disabled portal entry stops without treating unknown account state as a busy node',async()=>{
  const f=fixture({openState:'disabled'});await assert.rejects(run(f));assert.deepEqual(f.opened,[4]);assert.equal(f.tabs.size,0);
});

function bridgeHarness() {
  let owns=false,listener,forwarded=[];
  const controls=[],window={addEventListener(type,fn){if(type==='message')this.receive=fn},postMessage(m){controls.push(m.on)}};
  const chrome={runtime:{id:'synthetic-extension',onMessage:{addListener(fn){listener=fn}},sendMessage(msg,cb){if(msg.type==='capture:hello')cb({job:owns});else{forwarded.push(msg);if(cb)cb()}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../content/capture-bridge.js'),'utf8'),{window,chrome,location:{origin:N.BASE},document:{querySelector(){return null}},setTimeout(){}});
  return{controls,forwarded,setOwned(value){owns=value},arm(id='synthetic-extension'){let ack;listener({type:'capture:arm'},{id},r=>ack=r);return ack},emit(){window.receive({source:window,origin:N.BASE,data:{source:'gefei-seo-capture',url:N.BASE+'/api/report',body:'{}'}})}};
}
test('prepared shell re-arms only after the background confirms ownership and then forwards once',()=>{
  const b=bridgeHarness();b.emit();assert.equal(b.forwarded.length,0);assert.equal(b.arm().ok,false);
  b.setOwned(true);assert.equal(b.arm('foreign-extension'),undefined);b.emit();assert.equal(b.forwarded.length,0);
  assert.equal(b.arm().ok,true);b.emit();assert.equal(b.forwarded.length,1);assert.equal(b.controls.at(-1),true);
});
