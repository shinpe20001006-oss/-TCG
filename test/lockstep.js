const {start}=require('../server');
const {JSDOM,VirtualConsole}=require('jsdom');
const fs=require('fs'),path=require('path'),assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function(N){
  N=N||6;const s=await start(0);const errs=[];
  function client(){
    const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(String(e.detail&&e.detail.stack||e.message)));vc.on('error',(...a)=>errs.push(a.join(' ')));
    const dom=new JSDOM(html,{url:'http://127.0.0.1:'+s.port+'/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc});
    dom.window.__tcg.setSpeed(0);return dom.window;
  }
  const A=client(),B=client();
  const out=[];
  for(let g=0;g<N;g++){
    const dA=A.__tcg.decks.randomDeck(),dB=B.__tcg.decks.randomDeck();
    const ra=(A.__tcg.state()||{}).seed,rb=(B.__tcg.state()||{}).seed;
    const opt={bot:true,url:'ws://127.0.0.1:'+s.port+'/ws'};
    A.document.getElementById('lbCode').textContent='';
    await A.__tcg.pv.start('create',null,dA,opt);
    // wait for code
    let code='';const t0=Date.now();
    while(!(code=A.document.getElementById('lbCode').textContent)&&Date.now()-t0<3000)await sleep(10);
    assert(code,'no room code');
    await B.__tcg.pv.start('join',code,dB,opt);
    const t1=Date.now();let ga,gb;
    while(Date.now()-t1<20000){await sleep(20);ga=A.__tcg.state();gb=B.__tcg.state();if(ga&&gb&&ga.seed!==ra&&gb.seed!==rb&&ga.net&&gb.net&&ga.over&&gb.over)break;}
    if(!(ga.over&&gb.over)){const f=(w,g)=>g.phase+' t'+g.turn+' cur'+g.cur+' busy'+g.busy+' '+JSON.stringify(w.__tcg.trace().TRACE.slice(-10))+' w'+w.__tcg.trace().waiters+' i'+w.__tcg.trace().inbox;const rm=require('../lib/rooms').rooms;rm.forEach(r=>console.log('ROOM sentA',r.a.sentN,'sentB',r.b&&r.b.sentN,'A.rs',A.__tcg.pv.PV.rs,'B.rs',B.__tcg.pv.PV.rs,'A.ws',A.__tcg.pv.PV.ws&&A.__tcg.pv.PV.ws.readyState,'buf',r.a._socket&&r.a._socket.bufferSize));console.log('A:',f(A,ga));console.log('B:',f(B,gb));}
    assert(ga.seed!==ra&&gb.seed!==rb&&ga.over&&gb.over,'timeout A:'+ga.over+'@'+ga.turn+' B:'+gb.over+'@'+gb.turn);
    if(ga.over==='desync'||gb.over==='desync'){console.log('TR A',JSON.stringify(A.__tcg.trace().TRACE.slice(-6)));console.log('TR B',JSON.stringify(B.__tcg.trace().TRACE.slice(-6)));}
    assert(ga.over!=='desync'&&gb.over!=='desync','desync');
    const exp={win:'lose',lose:'win',draw:'draw'};
    assert.equal(exp[ga.over],gb.over,'result mismatch '+ga.over+' '+gb.over);
    assert.equal(ga.turn,gb.turn);
    assert.equal(ga.p[0].life,gb.p[0].life);assert.equal(ga.p[1].life,gb.p[1].life);
    out.push(ga.over+'@'+ga.turn+'('+ga.p[0].life+','+ga.p[1].life+','+Object.keys(dA.chars).length+','+ga.seed+','+gb.seed+','+JSON.stringify(dA).length+')');
  }
  console.log('lockstep ok',out.join(' '),'errors',errs.length);
  if(errs.length)console.log(errs.slice(0,3).join('\n').slice(0,1500));
  A.close();B.close();await s.close();
  assert.equal(errs.length,0);
};
if(require.main===module)module.exports(+process.argv[2]||6).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
