// public/index.html からカード一覧を取り出して lib/catalog.json を作る(カード追加時に実行)
const {JSDOM}=require('jsdom');const fs=require('fs');
const dom=new JSDOM(fs.readFileSync(__dirname+'/public/index.html','utf8'),{runScripts:'dangerously',pretendToBeVisual:true});
const d=dom.window.__tcg.defs();
const cat={chars:{},skills:{},abilities:d.AB_KEYS.slice()};
d.CHARS.forEach(c=>{cat.chars[c.key]=d.maxCopies(c);});
['cond','targ','eff'].forEach(t=>Object.keys(d[{cond:'COND',targ:'TARG',eff:'EFF'}[t]]).forEach(k=>{cat.skills[t+'.'+k]=3;}));
fs.writeFileSync(__dirname+'/lib/catalog.json',JSON.stringify(cat,null,1));
console.log(Object.keys(cat.chars).length+' chars, '+Object.keys(cat.skills).length+' skills');process.exit(0);
