const {start}=require('../server');const {JSDOM}=require('jsdom');
const fs=require('fs'),path=require('path'),assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function(){
  const s=await start(0);const base='http://127.0.0.1:'+s.port+'/';
  const mk=()=>{const d=new JSDOM(html,{url:base,runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.fetch=(u,o)=>fetch(new URL(u,base),o);w.confirm=()=>true;}});return d.window;};
  const A=mk();
  for(let i=0;i<50&&!A.__tcg.acc.ACC.on;i++)await sleep(100);
  assert(A.__tcg.acc.ACC.on,'account not initialised');
  const code=A.document.getElementById('acCode').textContent;assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code),'recovery code shown');
  const deck=A.__tcg.decks.PRESETS[0];const d={name:'テスト',chars:Object.assign({},deck.chars),skills:Object.assign({},deck.skills),ab:deck.ab};
  A.__tcg.acc.storeDecks([d]);await sleep(1200);
  // 別端末(新しいlocalStorage)で引き継ぎ
  const B=mk();for(let i=0;i<50&&!B.__tcg.acc.ACC.on;i++)await sleep(100);
  assert.equal(B.__tcg.acc.loadDecks().length,0,'new device starts empty');
  B.document.getElementById('acInput').value=code;await B.__tcg.acc.acctRecover();
  const got=B.__tcg.acc.loadDecks();assert.equal(got.length,1);assert.equal(got[0].name,'テスト');assert.equal(JSON.stringify(got[0].chars),JSON.stringify(d.chars));
  // 再読み込み(同じ端末)でもデータが残る
  const stored=A.localStorage.getItem('kumitate.auth.v1');assert(stored);
  console.log('account ok');A.close();B.close();await s.close();
};
if(require.main===module)module.exports().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
