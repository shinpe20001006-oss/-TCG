// 本物のChromiumで2画面を動かす対戦テスト(jsdomではなく実ブラウザのWebSocketを使う)
const {start}=require('../server');const {chromium}=require('playwright');const assert=require('assert');
const N=+process.argv[2]||5;
(async()=>{
  const s=await start(0);const b=await chromium.launch();const errs=[];
  const mk=async()=>{const p=await (await b.newContext()).newPage();p.on('pageerror',e=>errs.push(e.message));await p.goto('http://127.0.0.1:'+s.port+'/');await p.evaluate(()=>window.__tcg.setSpeed(0));return p;};
  const A=await mk(),B=await mk();const out=[];
  for(let g=0;g<N;g++){
    const seedA=await A.evaluate(()=>(window.__tcg.state()||{}).seed),seedB=await B.evaluate(()=>(window.__tcg.state()||{}).seed);
    await A.evaluate(()=>{document.getElementById('lbCode').textContent='';const d=window.__tcg.decks.randomDeck();window.__tcg.pv.start('create',null,d,{bot:true});});
    await A.waitForFunction(()=>document.getElementById('lbCode').textContent,null,{timeout:5000});
    const code=await A.evaluate(()=>document.getElementById('lbCode').textContent);
    await B.evaluate(c=>{const d=window.__tcg.decks.randomDeck();window.__tcg.pv.start('join',c,d,{bot:true});},code);
    const fin=(p,sd)=>p.waitForFunction(sd=>{const G=window.__tcg.state();return G&&G.net&&G.seed!==sd&&G.over;},sd,{timeout:90000});
    await Promise.all([fin(A,seedA),fin(B,seedB)]);
    const ra=await A.evaluate(()=>{const G=window.__tcg.state();return[G.over,G.turn,G.p[0].life,G.p[1].life];});
    const rb=await B.evaluate(()=>{const G=window.__tcg.state();return[G.over,G.turn,G.p[0].life,G.p[1].life];});
    assert(ra[0]!=='desync'&&rb[0]!=='desync','desync');
    assert.deepEqual([ra[1],ra[2],ra[3]],[rb[1],rb[2],rb[3]]);
    out.push(ra.join('/'));
  }
  console.log('browser ok',out.join(' '),'errors',errs.length,errs.slice(0,2).join('|'));
  await b.close();await s.close();process.exit(errs.length?1:0);
})().catch(e=>{console.error(e.message);process.exit(1);});
