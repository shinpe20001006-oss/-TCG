(async()=>{
  for(const [n,f] of [['api',()=>require('./api')()],['account',()=>require('./account')()],['browser',async()=>{const {spawnSync}=require('child_process');const r=spawnSync('node',[__dirname+'/browser.js','4'],{stdio:'inherit'});if(r.status)throw new Error('browser test failed');}]]){
    await f();
  }
  console.log('ALL OK');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
