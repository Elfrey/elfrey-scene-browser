#!/usr/bin/env node
/**
 * End-to-end browser test of the indexer against a live Foundry world, driven over the Chrome DevTools Protocol.
 * Logs in as a GM (password reset), opens the browser window, runs a full indexing pass and reports the outcome.
 * Developer tooling only; needs headless Chrome with --remote-debugging-port=9222 and the constants below.
 *
 * Setup (see dev/README.md):
 *   1. A Foundry data dir whose world has resetKeys:true and the module enabled (a disposable copy).
 *   2. node fvttNN/main.mjs --dataPath=<that dir> --port=30213 --noupdate   (background)
 *   3. Google Chrome --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader \
 *        --remote-debugging-port=9222 --user-data-dir=<tmp>   (background)
 *   4. node dev/browser-index-test.mjs
 *
 * Edit BASE / GM for your instance (GM is the user _id shown by getJoinData).
 */
import { createRequire } from "node:module";
const require = createRequire("/Users/oganes/work/dnd/foundry/fvtt13/");
const WebSocket = require("ws");
const HOST="http://localhost:9222", BASE="http://localhost:30213", GM="y92MjTbjIQdK3cLD";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function newTarget(){return (await fetch(`${HOST}/json/new?about:blank`,{method:"PUT"})).json();}
class CDP{#ws;#id=0;#p=new Map();#h=[];constructor(u){this.url=u;}
 connect(){return new Promise((res,rej)=>{this.#ws=new WebSocket(this.url,{perMessageDeflate:false,maxPayload:5e8});this.#ws.on("open",res);this.#ws.on("error",rej);this.#ws.on("message",raw=>{const m=JSON.parse(raw);if(m.id&&this.#p.has(m.id)){const{res,rej}=this.#p.get(m.id);this.#p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method)for(const h of this.#h)h(m);});});}
 on(fn){this.#h.push(fn);} send(method,params={}){const id=++this.#id;return new Promise((res,rej)=>{this.#p.set(id,{res,rej});this.#ws.send(JSON.stringify({id,method,params}));});}
 async eval(e,awaitPromise=true){const r=await this.send("Runtime.evaluate",{expression:`(async()=>{${e}})()`,awaitPromise,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;} close(){this.#ws?.close();}}
async function login(cdp){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.send("Page.navigate",{url:`${BASE}/join`});
  for(let i=0;i<20;i++){await sleep(1000);const n=await cdp.eval(`return document.querySelectorAll('select[name="userid"] option').length`);if(n>1)break;}
  await cdp.eval(`const s=document.querySelector('select[name="userid"]');s.value=${JSON.stringify(GM)};s.dispatchEvent(new Event('change',{bubbles:true}));const pw=document.querySelector('input[name="password"]');if(pw)pw.value='';document.querySelector('button[name="join"]').click();return true;`);
  for(let i=0;i<50;i++){await sleep(1500);try{if((await cdp.eval(`return !!(globalThis.game&&game.ready)`)))return true;}catch(e){}}
  return false;
}
const t=await newTarget(); const cdp=new CDP(t.webSocketDebuggerUrl); await cdp.connect();
const logs=[]; cdp.on(m=>{ if(m.method==="Runtime.consoleAPICalled")logs.push(`[${m.params.type}] `+(m.params.args||[]).map(a=>a.value??a.description??a.type).join(" ")); else if(m.method==="Runtime.exceptionThrown"){const e=m.params.exceptionDetails;logs.push(`[EXC] `+(e.exception?.description??e.text));}});
await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
if(!await login(cdp)){console.log("login failed");process.exit(1);}
console.log("READY. sources:",JSON.stringify(await cdp.eval(`const s=game.modules.get('elfrey-scene-browser').api.summarizeSources();return {packs:s.packs,live:s.livePacks,dormant:s.dormantPacks}`)));
await cdp.eval(`game.modules.get('elfrey-scene-browser').api.open();return true;`);
await sleep(2000);
await cdp.eval(`document.querySelector('#elfrey-scene-browser button[data-action="index"]').click();return true;`);
// wait for planning → ready
let phase;
for(let i=0;i<20;i++){await sleep(1000);phase=await cdp.eval(`return foundry.applications.instances.get('elfrey-scene-browser-indexing')?.runState?.phase??null`);if(phase==="ready"||phase==="error")break;}
console.log("PLAN phase:",phase,"| summary:",JSON.stringify(await cdp.eval(`return foundry.applications.instances.get('elfrey-scene-browser-indexing')?.plan?.summary??null`)));
if(phase==="ready"){
  await cdp.eval(`document.querySelector('#elfrey-scene-browser-indexing button[data-action="start"]').click();return true;`);
  for(let i=0;i<60;i++){await sleep(1000);phase=await cdp.eval(`return foundry.applications.instances.get('elfrey-scene-browser-indexing')?.runState?.phase??null`);if(["done","cancelled","error"].includes(phase))break;}
  console.log("RUN phase:",phase);
  console.log("RESULT:",JSON.stringify(await cdp.eval(`const r=foundry.applications.instances.get('elfrey-scene-browser-indexing')?.runState?.result;return r?{done:r.done,failed:r.failed,scenes:r.scenes,warnings:r.warnings,results:r.results.map(x=>({c:x.collection,s:x.status,n:x.scenes,strat:x.strategy,err:x.error}))}:null`)));
  console.log("DIALOG TEXT:",await cdp.eval(`const d=document.querySelector('#elfrey-scene-browser-indexing');return d?d.textContent.replace(/\\s+/g,' ').trim().slice(0,400):null`));
}
console.log("\n--- esb logs ---\n"+logs.filter(l=>/EXC|elfrey|cache/i.test(l)).slice(-25).join("\n"));
cdp.close(); process.exit(0);
