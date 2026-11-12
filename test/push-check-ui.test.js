'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/continuity.html'),'utf8');
function registration(id) {const a=source.indexOf(`    document.getElementById('${id}').addEventListener`);return source.slice(a,source.indexOf('\n    });',a)+8);}
test('late save/check cannot replace the message from clearing a target',async()=>{
 for(const pending of ['save','check']) {
  const handlers={},messages=[];let finish,saved=true;
  const node={value:'fixture_secret_1234',checked:true,addEventListener:()=>{}};
  const context={pushRegistrationRequest:null,window:{confirm:()=>true},
   document:{getElementById:id=>({...node,addEventListener:(_event,fn)=>{handlers[id]=fn;}})},
   setSwitchMessage:text=>messages.push(text),loadReadiness:async()=>{},
   API:{put:async()=>new Promise(resolve=>{finish=resolve;}),post:async()=>new Promise(resolve=>{finish=resolve;}),del:async()=>{saved=false;}}};
  vm.createContext(context);vm.runInContext(['brrr-form','brrr-check','brrr-clear'].map(registration).join('\n'),context);
  const event={preventDefault(){},currentTarget:{disabled:false,querySelector:()=>({disabled:false})}};
  const old=handlers[pending==='save'?'brrr-form':'brrr-check'](event);
  await handlers['brrr-clear']();
  const verification={status:'verified',message:'OLD SECRET VERIFIED'};
  finish(pending==='save'?{verification}:verification);
  await old;
  assert.equal(saved,false);assert.equal(messages.at(-1),'brrr target cleared.',pending);
 }
});
