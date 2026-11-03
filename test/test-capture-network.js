'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs');
const hook=fs.readFileSync(require('node:path').join(__dirname,'../content/capture-hook.js'),'utf8');
for(const via of ['xhr','fetch']) for(const failure of (via==='xhr'?['error','timeout','abort','body']:['network','body','AbortError','TimeoutError'])) test(`${via} ${failure} records request start and precise failure without secrets`,async()=>{
 const events=[], listeners={}; let control;
 const window={addEventListener:(t,f)=>control=f,postMessage:e=>events.push(e)};
 function XHR(){}; XHR.prototype.open=function(){}; XHR.prototype.send=function(){}; XHR.prototype.setRequestHeader=function(){};
 XHR.prototype.addEventListener=function(t,f){listeners[t]=f}; XHR.prototype.getResponseHeader=()=> 'application/json';
 window.fetch=()=>['network','AbortError','TimeoutError'].includes(failure)?Promise.reject(Object.assign(new Error('secret-network-details'),{name:failure})):Promise.resolve({status:200,url:'https://sim.3ue.com/report',headers:{get:()=> 'application/json'},clone:()=>({text:()=>Promise.reject(new Error('secret-body'))})});
 vm.runInNewContext(hook,{window,XMLHttpRequest:XHR,URL,location:{origin:'https://sim.3ue.com',href:'https://sim.3ue.com/'}});
 control({source:window,data:{source:'gefei-seo-capture-ctl',on:true}});
 if(via==='xhr'){const x=new XHR();x.open('GET','https://sim.3ue.com/report'); x.status=200;x.responseType='text';Object.defineProperty(x,'responseText',{get(){throw Error('secret-body')}});x.send();listeners[failure==='body'?'load':failure]();}
 else {await window.fetch('https://sim.3ue.com/report').catch(()=>{});await new Promise(resolve=>setImmediate(resolve));}
 assert.deepEqual(events.map(e=>e.event),['started',failure==='body'?'body_read_failed':failure==='network'||failure==='error'?'network_error':failure==='AbortError'?'abort':failure==='TimeoutError'?'timeout':failure]);
 assert.doesNotMatch(JSON.stringify(events),/secret-/);
});
