const {start}=require('../server');const {JSDOM}=require('jsdom');const fs=require('fs');
const html=fs.readFileSync(__dirname+'/../public/index.html','utf8');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const s=await start(0);
const mk=()=>{const d=new JSDOM(html,{url:'http://127.0.0.1:'+s.port+'/',runScripts:'dangerously',pretendToBeVisual:true});d.window.__tcg.setSpeed(0);return d.window;};
const A=mk(),B=mk();console.log('rand',A.Math.random(),A.Math.random(),B.Math.random());
for(let g=0;g<3;g++){const opt={bot:true,url:'ws://127.0.0.1:'+s.port+'/ws'};
await A.__tcg.pv.start('create',null,A.__tcg.decks.randomDeck(),opt);await sleep(200);const code=A.document.getElementById('lbCode').textContent;
await B.__tcg.pv.start('join',code,B.__tcg.decks.randomDeck(),opt);
for(let i=0;i<40;i++){await sleep(100);const a=A.__tcg.state();if(a.over)break;}
const a=A.__tcg.state();console.log(g,code,a.seed,a.over,a.turn,a.p[0].life,a.p[1].life);}
process.exit(0)})();
