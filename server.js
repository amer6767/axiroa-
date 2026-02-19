const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

// ─── UNIT DEFINITIONS ───────────────────────────────────────────────
const UNIT_TYPES = {
  SCOUT:      { cost:{wood:20}, trainTime:5000, health:40, attack:8, moveInterval:500, attackRange:1, visionRange:3, requiredZone:'forest' },
  ARCHER:     { cost:{wood:30,steel:10}, trainTime:8000, health:60, attack:20, moveInterval:1000, attackRange:2, requiredZone:'forest' },
  INFANTRY:   { cost:{steel:30}, trainTime:8000, health:100, attack:25, moveInterval:1000, attackRange:1, requiredZone:'factory' },
  TANK:       { cost:{steel:50,fuel:20}, trainTime:15000, health:250, attack:60, moveInterval:2000, attackRange:1, requiredZone:'factory' },
  ARTILLERY:  { cost:{fuel:40,steel:30}, trainTime:20000, health:80, attack:80, moveInterval:3000, attackRange:4, minRange:2, areaAttack:true, requiredZone:'oil' },
  HELICOPTER: { cost:{fuel:60,steel:20}, trainTime:25000, health:150, attack:45, moveInterval:333, attackRange:1, canFlyOver:true, requiredZone:'oil' },
  MARINE:     { cost:{supplies:30,steel:20}, trainTime:10000, health:120, attack:35, moveInterval:1000, attackRange:1, canCrossWater:true, requiredZone:'port' },
  EMP_DRONE:  { cost:{research:50,fuel:20}, trainTime:20000, health:50, attack:5, moveInterval:500, empRange:3, empDuration:6000, requiredZone:'lab' },
  DECOY:      { cost:{research:30}, trainTime:8000, health:30, attack:0, moveInterval:1000, isDecoy:true, requiredZone:'lab' }
};

const MAP_SIZE = 80;
const rooms = {};

// ─── HELPERS ────────────────────────────────────────────────────────
function generateUniqueId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── HEX MATH (odd-r offset, pointy-top) ───────────────────────────
function getHexNeighbours(row, col) {
  const dirs = row % 2 === 0
    ? [[-1,-1],[-1,0],[0,1],[1,0],[1,-1],[0,-1]]
    : [[-1,0],[-1,1],[0,1],[1,1],[1,0],[0,-1]];
  return dirs.map(([dr,dc]) => [row+dr, col+dc])
    .filter(([r,c]) => r >= 0 && r < MAP_SIZE && c >= 0 && c < MAP_SIZE);
}

function hexToCube(row, col) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  const y = -x - z;
  return { x, y, z };
}

function hexDistance(r1, c1, r2, c2) {
  const a = hexToCube(r1, c1);
  const b = hexToCube(r2, c2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

// ─── MAP GENERATION ─────────────────────────────────────────────────
function generateMap() {
  const map = [];
  for (let r = 0; r < MAP_SIZE; r++) {
    map[r] = [];
    for (let c = 0; c < MAP_SIZE; c++) {
      map[r][c] = { owner: null, type: 'empty', resourceType: null };
    }
  }
  const zones = [
    { type: 'forest', count: 20 },
    { type: 'factory', count: 15 },
    { type: 'oil', count: 10 },
    { type: 'port', count: 10 },
    { type: 'lab', count: 6 }
  ];
  for (const zone of zones) {
    let placed = 0;
    let attempts = 0;
    while (placed < zone.count && attempts < 5000) {
      attempts++;
      const r = 3 + Math.floor(Math.random() * (MAP_SIZE - 6));
      const c = 3 + Math.floor(Math.random() * (MAP_SIZE - 6));
      if (map[r][c].type !== 'empty') continue;
      map[r][c].type = zone.type;
      map[r][c].resourceType = zone.type;
      // cluster: also mark 1-2 neighbours
      const neighbours = getHexNeighbours(r, c);
      const extra = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < Math.min(extra, neighbours.length); i++) {
        const [nr, nc] = neighbours[i];
        if (map[nr][nc].type === 'empty') {
          map[nr][nc].type = zone.type;
          map[nr][nc].resourceType = zone.type;
        }
      }
      placed++;
    }
  }
  return map;
}

// ─── PLAYER COLOURS ─────────────────────────────────────────────────
const PLAYER_COLOURS = [
  '#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#e67e22','#1abc9c','#e91e63'
];

// ─── SPAWN PLAYER ───────────────────────────────────────────────────
function spawnPlayer(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  const map = room.gameState.map;
  let bestRow, bestCol;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const r = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    const c = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    // check min 15 from other spawns
    let tooClose = false;
    for (const p of room.players) {
      if (p.id !== playerId && p.baseRow != null) {
        if (hexDistance(r, c, p.baseRow, p.baseCol) < 15) { tooClose = true; break; }
      }
    }
    if (tooClose) continue;
    bestRow = r; bestCol = c;
    break;
  }
  if (bestRow == null) { bestRow = 5 + Math.floor(Math.random() * 70); bestCol = 5 + Math.floor(Math.random() * 70); }
  player.baseRow = bestRow;
  player.baseCol = bestCol;
  // claim 5x5 area
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const nr = bestRow + dr;
      const nc = bestCol + dc;
      if (nr >= 0 && nr < MAP_SIZE && nc >= 0 && nc < MAP_SIZE) {
        map[nr][nc].owner = playerId;
      }
    }
  }
}

// ─── TRAINING ───────────────────────────────────────────────────────
function trainUnit(room, playerId, unitType) {
  const def = UNIT_TYPES[unitType];
  if (!def) return { ok: false, msg: 'Unknown unit type' };
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { ok: false, msg: 'Player not found' };
  // check required zone ownership
  const map = room.gameState.map;
  let hasZone = false;
  for (let r = 0; r < MAP_SIZE && !hasZone; r++)
    for (let c = 0; c < MAP_SIZE && !hasZone; c++)
      if (map[r][c].owner === playerId && map[r][c].type === def.requiredZone) hasZone = true;
  if (!hasZone) return { ok: false, msg: `Need a ${def.requiredZone} zone` };
  // check resources
  for (const [res, amt] of Object.entries(def.cost)) {
    if ((player.resources[res] || 0) < amt) return { ok: false, msg: `Not enough ${res}` };
  }
  if (player.trainingQueue.length >= 5) return { ok: false, msg: 'Queue full (max 5)' };
  // deduct
  for (const [res, amt] of Object.entries(def.cost)) player.resources[res] -= amt;
  player.trainingQueue.push({ unitType, startTime: Date.now(), duration: def.trainTime, id: generateUniqueId() });
  return { ok: true };
}

function processTrainingQueues(room) {
  const now = Date.now();
  for (const player of room.players) {
    while (player.trainingQueue.length > 0) {
      const item = player.trainingQueue[0];
      if (now - item.startTime >= item.duration) {
        player.trainingQueue.shift();
        const def = UNIT_TYPES[item.unitType];
        const unit = {
          id: generateUniqueId(),
          type: item.unitType,
          owner: player.id,
          row: player.baseRow,
          col: player.baseCol,
          currentHealth: def.health,
          frozen: false,
          frozenUntil: null,
          targetPath: [],
          lastMoveTime: now,
          landed: true
        };
        room.gameState.units.push(unit);
        io.to(player.id).emit('unitTrained', { unitType: item.unitType, unitId: unit.id });
        io.to(room.code).emit('unitSpawned', unit);
      } else {
        break; // queue is ordered
      }
    }
  }
}

// ─── RESOURCE GENERATION ────────────────────────────────────────────
function generateResources(room) {
  const map = room.gameState.map;
  const resMap = { forest: 'wood', factory: 'steel', oil: 'fuel', port: 'supplies', lab: 'research' };
  for (const player of room.players) {
    if (!player.isConnected) continue;
    const gains = { wood:0, steel:0, fuel:0, supplies:0, research:0 };
    for (let r = 0; r < MAP_SIZE; r++) {
      for (let c = 0; c < MAP_SIZE; c++) {
        if (map[r][c].owner === player.id && map[r][c].resourceType) {
          const resKey = resMap[map[r][c].resourceType];
          if (resKey) gains[resKey] += 10;
        }
      }
    }
    for (const k of Object.keys(gains)) player.resources[k] += gains[k];
    io.to(player.id).emit('resourceUpdate', player.resources);
  }
}

// ─── PATHFINDING (BFS on hex grid) ──────────────────────────────────
function findPath(map, startR, startC, endR, endC, canFly, canWater) {
  if (startR === endR && startC === endC) return [];
  const key = (r,c) => `${r},${c}`;
  const visited = new Set();
  const queue = [[startR, startC, []]];
  visited.add(key(startR, startC));
  while (queue.length > 0) {
    const [r, c, path] = queue.shift();
    for (const [nr, nc] of getHexNeighbours(r, c)) {
      const k = key(nr, nc);
      if (visited.has(k)) continue;
      visited.add(k);
      const tile = map[nr][nc];
      // water tiles block non-marine non-helicopter
      if (tile.type === 'port' && !canFly && !canWater) continue;
      const newPath = [...path, { row: nr, col: nc }];
      if (nr === endR && nc === endC) return newPath;
      if (newPath.length > 60) continue; // max path length
      queue.push([nr, nc, newPath]);
    }
  }
  return null; // no path found
}

// ─── COMBAT ─────────────────────────────────────────────────────────
function processCombat(room) {
  const units = room.gameState.units;
  const toRemove = new Set();
  for (const unit of units) {
    if (toRemove.has(unit.id)) continue;
    if (unit.frozen) continue;
    const def = UNIT_TYPES[unit.type];
    if (!def || def.attack <= 0) continue;
    // find nearest enemy in range
    let target = null, bestDist = Infinity;
    for (const other of units) {
      if (other.owner === unit.owner || toRemove.has(other.id)) continue;
      const d = hexDistance(unit.row, unit.col, other.row, other.col);
      if (d <= (def.attackRange || 1)) {
        if (def.minRange && d < def.minRange) continue;
        if (d < bestDist) { bestDist = d; target = other; }
      }
    }
    if (target) {
      target.currentHealth -= def.attack;
      if (def.areaAttack) {
        // splash damage to neighbours of target
        for (const other of units) {
          if (other.id === target.id || other.owner === unit.owner || toRemove.has(other.id)) continue;
          if (hexDistance(target.row, target.col, other.row, other.col) <= 1) {
            other.currentHealth -= Math.floor(def.attack * 0.4);
          }
        }
      }
      // EMP effect
      if (def.empRange) {
        for (const other of units) {
          if (other.owner === unit.owner) continue;
          if (hexDistance(unit.row, unit.col, other.row, other.col) <= def.empRange) {
            other.frozen = true;
            other.frozenUntil = Date.now() + (def.empDuration || 6000);
          }
        }
      }
      if (target.currentHealth <= 0) toRemove.add(target.id);
    }
  }
  // remove dead
  room.gameState.units = units.filter(u => !toRemove.has(u.id));
  if (toRemove.size > 0) {
    io.to(room.code).emit('unitsDestroyed', Array.from(toRemove));
  }
}

// ─── MOVEMENT ───────────────────────────────────────────────────────
function processMovement(room) {
  const now = Date.now();
  const map = room.gameState.map;
  for (const unit of room.gameState.units) {
    // unfreeze
    if (unit.frozen && unit.frozenUntil && now >= unit.frozenUntil) {
      unit.frozen = false;
      unit.frozenUntil = null;
    }
    if (unit.frozen) continue;
    if (unit.targetPath.length === 0) continue;
    const def = UNIT_TYPES[unit.type];
    if (now - unit.lastMoveTime < def.moveInterval) continue;
    const next = unit.targetPath.shift();
    unit.row = next.row;
    unit.col = next.col;
    unit.lastMoveTime = now;
    // capture hex
    if (map[next.row][next.col].owner !== unit.owner) {
      map[next.row][next.col].owner = unit.owner;
    }
  }
}

// ─── GAME LOOP ──────────────────────────────────────────────────────
function startGameLoop(room) {
  room.gameLoopInterval = setInterval(() => {
    processTrainingQueues(room);
    processMovement(room);
    processCombat(room);
    // send state snapshot every tick
    const snapshot = {
      units: room.gameState.units,
      mapOwnership: getOwnershipChanges(room)
    };
    io.to(room.code).emit('gameUpdate', snapshot);
  }, 500);

  room.resourceInterval = setInterval(() => {
    generateResources(room);
  }, 3000);
}

function getOwnershipChanges(room) {
  // send compact ownership map
  const changes = [];
  const map = room.gameState.map;
  for (let r = 0; r < MAP_SIZE; r++) {
    for (let c = 0; c < MAP_SIZE; c++) {
      if (map[r][c].owner) {
        changes.push({ r, c, owner: map[r][c].owner });
      }
    }
  }
  return changes;
}

// ─── SOCKET EVENTS ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('createRoom', (data) => {
    const code = generateRoomCode();
    const room = {
      code,
      host: socket.id,
      players: [{
        id: socket.id,
        name: data.name || 'Player 1',
        colour: PLAYER_COLOURS[0],
        resources: { wood: 0, steel: 0, fuel: 0, supplies: 0, research: 0 },
        trainingQueue: [],
        baseRow: null,
        baseCol: null,
        activeBonuses: [],
        isConnected: true
      }],
      gameState: { map: generateMap(), units: [] },
      isStarted: false
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code, players: room.players.map(p => ({ id: p.id, name: p.name, colour: p.colour })) });
    console.log(`Room ${code} created by ${data.name}`);
  });

  socket.on('joinRoom', (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Room not found' });
    if (room.isStarted) return socket.emit('error', { msg: 'Game already started' });
    if (room.players.length >= 8) return socket.emit('error', { msg: 'Room full' });
    const colour = PLAYER_COLOURS[room.players.length % PLAYER_COLOURS.length];
    room.players.push({
      id: socket.id,
      name: data.name || `Player ${room.players.length + 1}`,
      colour,
      resources: { wood: 0, steel: 0, fuel: 0, supplies: 0, research: 0 },
      trainingQueue: [],
      baseRow: null,
      baseCol: null,
      activeBonuses: [],
      isConnected: true
    });
    socket.join(code);
    socket.roomCode = code;
    const pList = room.players.map(p => ({ id: p.id, name: p.name, colour: p.colour }));
    io.to(code).emit('roomUpdated', { players: pList });
    console.log(`${data.name} joined room ${code}`);
  });

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return socket.emit('error', { msg: 'Only host can start' });
    if (room.isStarted) return;
    room.isStarted = true;
    for (const player of room.players) spawnPlayer(room, player.id);
    // send full map + player data
    const playerData = room.players.map(p => ({
      id: p.id, name: p.name, colour: p.colour,
      baseRow: p.baseRow, baseCol: p.baseCol,
      resources: p.resources
    }));
    // compress map for transport: send tile types and owners
    const mapData = [];
    for (let r = 0; r < MAP_SIZE; r++) {
      mapData[r] = [];
      for (let c = 0; c < MAP_SIZE; c++) {
        const t = room.gameState.map[r][c];
        mapData[r][c] = { t: t.type === 'empty' ? 0 : t.type, o: t.owner };
      }
    }
    io.to(code).emit('gameStarted', { map: mapData, players: playerData });
    startGameLoop(room);
    console.log(`Game started in room ${code}`);
  });

  socket.on('trainUnit', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const result = trainUnit(rooms[code], socket.id, data.unitType);
    if (!result.ok) return socket.emit('trainError', { msg: result.msg });
    const player = rooms[code].players.find(p => p.id === socket.id);
    socket.emit('playerUpdate', {
      resources: player.resources,
      trainingQueue: player.trainingQueue
    });
  });

  socket.on('moveUnit', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const room = rooms[code];
    const unit = room.gameState.units.find(u => u.id === data.unitId && u.owner === socket.id);
    if (!unit) return;
    const def = UNIT_TYPES[unit.type];
    const path = findPath(room.gameState.map, unit.row, unit.col, data.row, data.col, def.canFlyOver, def.canCrossWater);
    if (path) unit.targetPath = path;
  });

  socket.on('moveUnits', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const room = rooms[code];
    const { unitIds, row, col } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    for (const uid of unitIds) {
      const unit = room.gameState.units.find(u => u.id === uid && u.owner === socket.id);
      if (!unit) continue;
      const def = UNIT_TYPES[unit.type];
      const path = findPath(room.gameState.map, unit.row, unit.col, row, col, def.canFlyOver, def.canCrossWater);
      if (path) unit.targetPath = path;
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isConnected = false;
    // remove player
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      clearInterval(room.gameLoopInterval);
      clearInterval(room.resourceInterval);
      delete rooms[code];
      console.log(`Room ${code} deleted`);
    } else {
      if (room.host === socket.id) room.host = room.players[0].id;
      io.to(code).emit('roomUpdated', { players: room.players.map(p => ({ id: p.id, name: p.name, colour: p.colour })) });
    }
  });
});

// ─── START ───────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`FRONTLINE server running on http://localhost:${PORT}`);
});
