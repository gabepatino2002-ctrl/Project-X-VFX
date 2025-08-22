// server.js (vfx-api)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const app = express();
app.use(cors()); app.use(express.json());

const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// in-memory effects registry (replace with DB or cloud storage)
const effects = {
  "garu": {
    id: "garu",
    display: "Garu - Wind Bolt",
    template: {
      name: "garu",
      phases: [
        { time: 0, action: "spawn", effect: "gust_swirl", pos: "attacker", duration: 900 },
        { time: 900, action: "spawnProjectile", effect: "gust_projectile" },
        { time: "onImpact", action: "spawn", effect: "gust_impact" }
      ],
      requiredTextures: ["leaf.png","gust_particle.png","gust_trail.png"],
      sfx: ["wind_charge.mp3","wind_impact.mp3"]
    }
  }
};

// WebSocket: clients join session rooms
io.of('/vfx').on('connection', socket => {
  socket.on('join', ({session}) => {
    if (session) socket.join(session);
  });
});

// endpoints
app.get('/', (req,res)=>res.json({ok:true,service:'vfx-api',version:'1.0.0'}));
app.get('/effects', (req,res)=>res.json({ effects: Object.values(effects).map(e=>({id:e.id,display:e.display})) }));
app.get('/effects/:id', (req,res)=>{
  const e = effects[req.params.id];
  if (!e) return res.status(404).json({error:'not found'});
  res.json(e);
});
app.post('/play_sequence', (req,res)=>{
  const body = req.body || {};
  const effectId = body.effectId;
  const sess = body.session || 'global';
  const effect = effects[effectId];
  if (!effect) return res.status(404).json({error:'effect not found'});
  // expand template with coords
  const seq = Object.assign({}, effect.template, { attacker: body.attacker, target: body.target, meta: body.meta||{} });
  // emit to room
  io.of('/vfx').to(sess).emit('sequence.play', { sequence: seq, issuedBy: req.ip, ts: Date.now() });
  res.json({ ok:true, issuedTo: sess });
});

server.listen(port, ()=>console.log(`VFX API listening on ${port}`));
