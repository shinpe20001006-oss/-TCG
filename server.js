'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const store = require('./lib/store');
const { router } = require('./lib/api');
const rooms = require('./lib/rooms');

async function start(port, dbUrl) {
  const st = await store.open(dbUrl);
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api', router(st, c => { const r = rooms.rooms.get(String(c)); return !!r && !r.b; }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  const server = http.createServer(app);
  const wss = rooms.attach(server);
  await new Promise(r => server.listen(port, r));
  return { server, st, wss, port: server.address().port, close: async () => { wss.clients.forEach(c => c.terminate()); await new Promise(r => server.close(r)); await st.close(); } };
}
module.exports = { start };
if (require.main === module) {
  start(process.env.PORT || 3000, process.env.DATABASE_URL).then(s => console.log('listening on', s.port, '(db: ' + s.st.kind + ')')).catch(e => { console.error(e.message); process.exit(1); });
}
