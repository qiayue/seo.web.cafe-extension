'use strict';
// Actual preparation/registration/cancellation adapters with synthetic Chrome
// storage and clock. No network, real tabs, account or source requests.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const N=require('../lib/similarweb-nodes');
const source=fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
function fn(name,end){
  const start=source.indexOf('function '+name+'('),stop=source.indexOf(end,start);
  assert.ok(start>=0&&stop>start);return source.slice(start,stop);
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const flush=()=>new Promise(r=>setImmediate(r));
function harness(options={}){
  const id='a'.repeat(32);let jobs={},now=1000,chain=Promise.resolve();
  const session={agentRunning:{id,at:now,pace:'normal'}};
  const events=[],finished=[],removed=[],posts=[];let prepares=0,gets=0;
  const context={URL,Date:{now:()=>now},Number,Object,Promise,AWAKE_MARK:'',JOB_TIMEOUT_MS:45000,FOREGROUND_AFTER_MS:8000,
    INITIAL_CAPTURE_RELOAD_MS:30000,AGENT_STUCK_MS:35*60000,polling:false,setTimeout(){},scheduleCaptureCheck(){},
    serial(callback){const p=chain.then(callback,callback);chain=p.catch(()=>{});return p},
    loadJobs:async()=>structuredClone(jobs),saveJobs:async value=>{if(options.beforeSave)await options.beforeSave();jobs=structuredClone(value);events.push('save')},
    ensureCaptureScripts:async()=>{},waitForAllow:async()=>{events.push('allow')},
    logActivity(){},fromLabel:()=> 'cloud',agentStatus(){},agentConf:async()=>({token:'synthetic',on:true}),
    agentDone:async(requestId,result)=>posts.push({requestId,...result}),
    agentApi:async(method)=>{if(method==='GET'){gets++;return{ok:true,jobs:[]}}return options.cancelledReply?{cancelled:true}:{ok:true}},
    G:{},self:{GefeiSimilarwebNodes:{BASE:N.BASE,prepare:async(api,config,prepareOptions)=>{
      prepares++;events.push('prepare');
      if(options.prepare)return options.prepare({context,prepareOptions,advance:ms=>{now+=ms}});
      return{tabId:44,node:4,returnTabId:900};
    }}},
    finish:async(tabId,result,reveal,cancelled)=>{finished.push({tabId,result,cancelled});delete jobs[tabId];removed.push(tabId)},
    chrome:{permissions:{contains:async()=>options.permission!==false},storage:{
      local:{get:async()=>({similarwebNodeMode:options.mode!==false})},
      session:{get:async()=>structuredClone(session),set:async value=>Object.assign(session,structuredClone(value))},
    },tabs:{query:async()=>[{id:900}],create:async()=>{events.push('create');return{id:45}},get:async id=>{
      if(options.beforeGetTab)await options.beforeGetTab();return{id};
    },sendMessage:async()=>{events.push('arm');return{ok:true}},update:async()=>{events.push('navigate')},remove:async id=>{removed.push(id)}}},
  };
  vm.createContext(context);
  vm.runInContext(fn('openJob','\nfunction fromLabel')+'\n'+
    source.slice(source.indexOf('var remoteStarts ='),source.indexOf('\n/** 页面交上来'))+'\n'+
    fn('agentReport','/** 交结果')+'\n'+fn('agentPoll','chrome.alarms.onAlarm'),context);
  if(options.realFinish)vm.runInContext(fn('finish','\nfunction okResult'),context);
  const msg={requestId:id,kind:'capture',site:'similarweb',base:N.BASE,url:N.BASE+'/#/report',match:'report-api',extract:'sw_referrals',
    requests:[{path:'/api/report'}],timeoutMs:30*60000,pager:{times:19}};
  return{context,msg,events,finished,removed,posts,session,start:extra=>context.startRemoteJob({...msg,...extra},{agent:true}),
    advance:ms=>{now+=ms},get jobs(){return jobs},get prepares(){return prepares},get gets(){return gets}};
}
for(const kind of ['capture','fetch'])test(kind+': a cancelled preparation progress reply cannot start a report',async()=>{
  const h=harness({cancelledReply:true,prepare:async({context,prepareOptions})=>{
    prepareOptions.onProgress('node is loading');await flush();prepareOptions.checkCancelled();return{tabId:44,node:4};
  }});
  await assert.rejects(h.start({kind}),/撤销/);assert.equal(Object.keys(h.jobs).length,0);
  assert.equal(h.events.includes('navigate'),false);assert.equal(h.context.remoteStarts[h.msg.requestId],undefined);
});
test('cancellation after a prepared session returns closes that tab before registration',async()=>{
  const h=harness({prepare:async({context})=>{
    await context.cancelRemoteJob('a'.repeat(32),'cancelled');return{tabId:44,node:4};
  }});
  await assert.rejects(h.start(),/撤销/);assert.ok(h.removed.includes(44));assert.deepEqual(Object.keys(h.jobs),[]);
});
test('cancellation while the prepared tab lookup is pending cannot register or navigate',async()=>{
  const gate=deferred(),entered=deferred(),h=harness({beforeGetTab:async()=>{entered.resolve();await gate.promise}});
  const running=h.start();await entered.promise;
  const cancelling=h.context.cancelRemoteJob(h.msg.requestId,'cancelled');gate.resolve();
  await assert.rejects(running,/撤销/);await cancelling;
  assert.deepEqual(Object.keys(h.jobs),[]);assert.equal(h.events.includes('navigate'),false);assert.ok(h.removed.includes(44));
});
test('cancellation during registration waits for persistence and removes the registered job',async()=>{
  const gate=deferred(),entered=deferred(),h=harness({beforeSave:async()=>{entered.resolve();await gate.promise}});
  const running=h.start();await entered.promise;
  const cancelling=h.context.cancelRemoteJob(h.msg.requestId,'cancelled');gate.resolve();
  await running;await cancelling;
  assert.deepEqual(Object.keys(h.jobs),[]);assert.equal(h.finished.length,1);assert.equal(h.finished[0].cancelled,true);
  assert.equal(h.events.includes('navigate'),false);
});
test('registration cancellation has one result owner across real finish and startup failure handling',async()=>{
  const gate=deferred(),entered=deferred(),h=harness({realFinish:true,beforeSave:async()=>{entered.resolve();await gate.promise}});
  const running=h.start().catch(error=>h.context.agentDone(h.msg.requestId,{ok:false,error:String(error.message||error)}));
  await entered.promise;
  const cancelling=h.context.cancelRemoteJob(h.msg.requestId,'cancelled');gate.resolve();
  await running;await cancelling;await flush();
  assert.deepEqual(Object.keys(h.jobs),[]);assert.equal(h.posts.length,1);assert.equal(h.posts[0].ok,false);
  assert.equal(h.events.includes('navigate'),false);
});
test('a cancellation reply after handoff uses existing job finalization',async()=>{
  const h=harness({cancelledReply:true});await h.start();await flush();
  assert.equal(Object.keys(h.jobs).length,1);await h.context.agentReport(h.msg.requestId,{stage:'progress'});
  assert.deepEqual(Object.keys(h.jobs),[]);assert.equal(h.finished.length,1);assert.equal(h.finished[0].cancelled,true);
});
test('duplicate requests during preparation share one session; registered duplicates do not prepare again',async()=>{
  const gate=deferred(),h=harness({prepare:async()=>{await gate.promise;return{tabId:44,node:4}}});
  const first=h.start(),second=h.start();await flush();assert.equal(h.prepares,1);
  gate.resolve();await Promise.all([first,second]);await h.start();await flush();
  assert.equal(h.prepares,1);assert.equal(Object.keys(h.jobs).length,1);assert.equal(h.events.filter(e=>e==='navigate').length,1);
});
test('failed preparation releases duplicate state and permits a later retry',async()=>{
  let fail=true;
  const h=harness({prepare:async()=>{if(fail)throw Error('node unavailable');return{tabId:44,node:4}}});
  await assert.rejects(h.start(),/unavailable/);fail=false;await h.start();
  assert.equal(h.prepares,2);assert.equal(Object.keys(h.jobs).length,1);
});
test('a long node preparation cannot cause another claim before the capture timeout',async()=>{
  const h=harness({prepare:async({advance})=>{advance(472000);return{tabId:44,node:3}}});
  const claimedAt=h.session.agentRunning.at;await h.start();
  assert.equal(h.jobs[44].startedAt,claimedAt+472000);assert.equal(h.session.agentRunning.at,h.jobs[44].startedAt);
  h.advance(35*60000-472000);await h.context.agentPoll(false);
  assert.equal(h.gets,0,'original 35-minute claim boundary is still inside the live 30-minute capture');
});
test('handoff cannot rewrite a different running task timestamp',async()=>{
  const h=harness();h.session.agentRunning={id:'b'.repeat(32),at:50,pace:'fast'};
  await h.start();assert.equal(h.session.agentRunning.at,50);assert.equal(h.session.agentRunning.id,'b'.repeat(32));
});
for(const kind of ['capture','fetch'])test(kind+': disabling node mode keeps the normal tab path and request fields',async()=>{
  const h=harness({mode:false});await h.start({kind});await flush();
  assert.equal(h.prepares,0);assert.equal(h.jobs[45].kind,kind);assert.equal(h.jobs[45].sourceNode,null);
  assert.equal(h.events.includes('arm'),false);assert.equal(h.session.agentRunning.at,1000);
});
test('missing site permission only opens the original allow flow',async()=>{
  const h=harness({permission:false});await h.start();assert.equal(h.prepares,0);assert.deepEqual(h.events,['allow']);
});
