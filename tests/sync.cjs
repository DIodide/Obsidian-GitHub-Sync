const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { transformSync } = require('esbuild');
const code = transformSync(fs.readFileSync('main.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
function fixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
 const remote = path.join(root, 'remote.git');
 const local = path.join(root, 'local');
 const git = (...args) => execFileSync('git', args, { cwd: local, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
 fs.mkdirSync(local);
 git('init','--bare',remote); git('init','-b','main');
 git('config','user.name','Sync Test'); git('config','user.email','sync@example.test');
 fs.writeFileSync(path.join(local,'note.md'),'initial');
 git('add','-A'); git('commit','-m','initial'); git('remote','add','origin',remote); git('push','-u','origin','main');
 fs.writeFileSync(path.join(local,'note.md'),'pending'); git('commit','-am','pending');
 return { root, remote, local, git };
}
function plugin(f) {
 const notices=[]; const module={exports:{}};
 const context={ module, exports:module.exports, require:(name)=> name==='obsidian' ? {
  Plugin:class{}, PluginSettingTab:class{}, Notice:class { constructor(message){notices.push(String(message));} }
 } : require(name) };
 vm.runInNewContext(code,context);
 const p=new module.exports.default();
 p.settings={remoteURL:f.remote,gitLocation:'',additionalRepoPaths:'',noticeLevel:'ALL',showSyncSuccessNotice:true};
 p.app={vault:{adapter:{getBasePath:()=>f.local}}};
 return {p,notices};
}
test('clean vault pushes pending commit and preserves upstream',async()=>{
 const f=fixture(); const {p}=plugin(f);
 assert.equal(await p.SyncVault(),true);
 assert.equal(f.git('rev-parse','HEAD'),f.git('rev-parse','origin/main'));
 assert.equal(f.git('config','branch.main.remote'),'origin');
});
test('additional repo pushes clean pending commit without upstream',async()=>{
 const f=fixture(); const {p}=plugin(f); f.git('branch','--unset-upstream');
 assert.equal(await p.SyncAdditionalRepo(f.local),true);
 assert.equal(f.git('rev-parse','HEAD'),f.git('rev-parse','origin/main'));
});
test('startup check reports ahead and surfaces fetch failure',async()=>{
 const f=fixture(); const {p,notices}=plugin(f);
 await p.CheckStatusOnStart(); assert.match(notices.pop(),/1 commits ahead/);
 f.git('remote','set-url','origin',path.join(f.root,'missing.git'));
 await p.CheckStatusOnStart(); assert.equal(notices.length,1); assert.match(notices[0],/repository/);
});
test('failed push is retried on next clean sync',async()=>{
 const f=fixture(); const {p}=plugin(f);
 const hook=path.join(f.remote,'hooks','pre-receive');
 fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n',{mode:0o755});
 assert.equal(await p.SyncVault(),false);
 fs.writeFileSync(hook,'#!/bin/sh\nexit 0\n');
 assert.equal(await p.SyncVault(),true);
 assert.equal(f.git('rev-parse','HEAD'),f.git('rev-parse','origin/main'));
});
test('overlapping sync requests share one operation',async()=>{
 const f=fixture(); const {p}=plugin(f); let count=0; let release;
 p.SyncVault=()=>{count++;return new Promise(resolve=>{release=resolve;});};
 const first=p.SyncNotes(); const second=p.SyncNotes();
 assert.equal(first,second); assert.equal(count,1); release(true); await first;
 const third=p.SyncNotes();
 assert.equal(count,2); release(true); await third;
});
test('startup sync runs independently of status checking and covers extras',async()=>{
 const f=fixture(); const {p}=plugin(f); let vault=0,extra=0;
 p.settings.isSyncOnLoad=true; p.settings.checkStatusOnLoad=false; p.settings.syncinterval=0; p.settings.additionalRepoPaths=f.local;
 p.loadSettings=async()=>{}; p.addRibbonIcon=()=>({addClass(){}}); p.addCommand=()=>{}; p.addSettingTab=()=>{};
 p.SyncVault=async()=>{vault++;return true;}; p.SyncAdditionalRepo=async()=>{extra++;return true;};
 let ready;
 p.app.workspace={onLayoutReady:(callback)=>{ready=callback;}};
 await p.onload(); assert.equal(vault,0); assert.equal(extra,0);
 ready(); await p.SyncNotes(); assert.equal(vault,1); assert.equal(extra,1);
});
