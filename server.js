const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

// ─── UNIT DEFINITIONS ───────────────────────────────────────────────
// Units no longer require zones — they require LAND (territory).
// Max units = floor(hexesOwned / LAND_PER_UNIT)
const LAND_PER_UNIT = 3;

const UNIT_TYPES = {
  SCOUT: { cost: { wood: 20 }, trainTime: 5000, health: 40, attack: 8, moveInterval: 500, attackRange: 1, visionRange: 3 },
  ARCHER: { cost: { wood: 30, steel: 10 }, trainTime: 8000, health: 60, attack: 20, moveInterval: 1000, attackRange: 2 },
  INFANTRY: { cost: { steel: 30 }, trainTime: 8000, health: 100, attack: 25, moveInterval: 1000, attackRange: 1 },
  TANK: { cost: { steel: 50, fuel: 20 }, trainTime: 15000, health: 250, attack: 60, moveInterval: 2000, attackRange: 1 },
  ARTILLERY: { cost: { fuel: 40, steel: 30 }, trainTime: 20000, health: 80, attack: 80, moveInterval: 3000, attackRange: 4, minRange: 2, areaAttack: true },
  HELICOPTER: { cost: { fuel: 60, steel: 20 }, trainTime: 25000, health: 150, attack: 45, moveInterval: 333, attackRange: 1, canFlyOver: true },
  MARINE: { cost: { supplies: 30, steel: 20 }, trainTime: 10000, health: 120, attack: 35, moveInterval: 1000, attackRange: 1, canCrossWater: true },
  EMP_DRONE: { cost: { research: 50, fuel: 20 }, trainTime: 20000, health: 50, attack: 5, moveInterval: 500, empRange: 3, empDuration: 6000 },
  DECOY: { cost: { research: 30 }, trainTime: 8000, health: 30, attack: 0, moveInterval: 1000, isDecoy: true }
};

const MAP_SIZE = 80;
const TOTAL_HEXES = MAP_SIZE * MAP_SIZE;
const DOMINATION_THRESHOLD = 0.70;
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
    ? [[-1, -1], [-1, 0], [0, 1], [1, 0], [1, -1], [0, -1]]
    : [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [0, -1]];
  return dirs.map(([dr, dc]) => [row + dr, col + dc])
    .filter(([r, c]) => r >= 0 && r < MAP_SIZE && c >= 0 && c < MAP_SIZE);
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

const PLAYER_COLOURS = [
  '#e74c3c', '#3498db', '#2ecc71', '#e67e22', '#9b59b6', '#00bcd4', '#f1c40f', '#e91e63'
];

// ─── COUNT HEXES ────────────────────────────────────────────────────
function countPlayerHexes(map, playerId) {
  let count = 0;
  for (let r = 0; r < MAP_SIZE; r++)
    for (let c = 0; c < MAP_SIZE; c++)
      if (map[r][c].owner === playerId) count++;
  return count;
}

function countPlayerUnits(room, playerId) {
  return room.gameState.units.filter(u => u.owner === playerId).length +
    (room.players.find(p => p.id === playerId)?.trainingQueue.length || 0);
}

// ─── SPAWN PLAYER ───────────────────────────────────────────────────
function spawnPlayer(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  const map = room.gameState.map;
  let bestRow, bestCol;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const r = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
    const c = 5 + Math.floor(Math.random() * (MAP_SIZE - 10));
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

// ─── TRAINING (land-based) ──────────────────────────────────────────
function trainUnit(room, playerId, unitType) {
  const def = UNIT_TYPES[unitType];
  if (!def) return { ok: false, msg: 'Unknown unit type' };
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { ok: false, msg: 'Player not found' };
  if (player.eliminated) return { ok: false, msg: 'You are eliminated' };

  // Land-based unit cap
  const hexes = countPlayerHexes(room.gameState.map, playerId);
  const maxUnits = Math.floor(hexes / LAND_PER_UNIT);
  const currentUnits = countPlayerUnits(room, playerId);
  if (currentUnits >= maxUnits) {
    return { ok: false, msg: `Unit cap reached (${currentUnits}/${maxUnits}). Conquer more land!` };
  }

  // Check resources
  for (const [res, amt] of Object.entries(def.cost)) {
    if ((player.resources[res] || 0) < amt) return { ok: false, msg: `Not enough ${res}` };
  }
  if (player.trainingQueue.length >= 5) return { ok: false, msg: 'Queue full (max 5)' };
  for (const [res, amt] of Object.entries(def.cost)) player.resources[res] -= amt;
  player.trainingQueue.push({ unitType, startTime: Date.now(), duration: def.trainTime, id: generateUniqueId() });
  return { ok: true, maxUnits, currentUnits: currentUnits + 1 };
}

function processTrainingQueues(room) {
  const now = Date.now();
  for (const player of room.players) {
    if (player.eliminated) continue;
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
        break;
      }
    }
  }
}

// ─── RESOURCE GENERATION ────────────────────────────────────────────
function generateResources(room) {
  const map = room.gameState.map;
  const resMap = { forest: 'wood', factory: 'steel', oil: 'fuel', port: 'supplies', lab: 'research' };
  for (const player of room.players) {
    if (!player.isConnected || player.eliminated) continue;
    const gains = { wood: 0, steel: 0, fuel: 0, supplies: 0, research: 0 };
    for (let r = 0; r < MAP_SIZE; r++) {
      for (let c = 0; c < MAP_SIZE; c++) {
        if (map[r][c].owner === player.id && map[r][c].resourceType) {
          const resKey = resMap[map[r][c].resourceType];
          if (resKey) gains[resKey] += 10;
        }
      }
    }
    for (const k of Object.keys(gains)) {
      player.resources[k] += gains[k];
      player.stats.resourcesGathered += gains[k];
    }
    // Also send land info for UI
    const hexes = countPlayerHexes(map, player.id);
    const maxUnits = Math.floor(hexes / LAND_PER_UNIT);
    const currentUnits = countPlayerUnits(room, player.id);
    io.to(player.id).emit('resourceUpdate', { ...player.resources, _hexes: hexes, _maxUnits: maxUnits, _currentUnits: currentUnits });
  }
}

// ─── PATHFINDING ────────────────────────────────────────────────────
function findPath(map, startR, startC, endR, endC, unitType) {
  if (startR === endR && startC === endC) return [];
  const def = UNIT_TYPES[unitType] || {};
  const canFly = !!def.canFlyOver;
  const canWater = !!def.canCrossWater;
  const key = (r, c) => `${r},${c}`;
  const visited = new Set();
  const queue = [[startR, startC]];
  const parent = {};
  visited.add(key(startR, startC));
  let found = false;
  while (queue.length > 0) {
    const [r, c] = queue.shift();
    for (const [nr, nc] of getHexNeighbours(r, c)) {
      const k = key(nr, nc);
      if (visited.has(k)) continue;
      visited.add(k);
      const tile = map[nr][nc];
      if (!canFly && !canWater && tile.type === 'port') continue;
      parent[k] = key(r, c);
      if (nr === endR && nc === endC) { found = true; break; }
      queue.push([nr, nc]);
    }
    if (found) break;
    if (visited.size > 4000) break;
  }
  if (!found) return null;
  const path = [];
  let cur = key(endR, endC);
  while (cur !== key(startR, startC)) {
    const [cr, cc] = cur.split(',').map(Number);
    path.unshift({ row: cr, col: cc });
    cur = parent[cur];
    if (!cur) return null;
  }
  return path.length > 80 ? path.slice(0, 80) : path;
}

// ─── COMBAT ─────────────────────────────────────────────────────────
function handleCombat(room, attacker, defender) {
  const atkDef = UNIT_TYPES[attacker.type];
  const defDef = UNIT_TYPES[defender.type];
  if (!atkDef || !defDef) return;
  const map = room.gameState.map;
  const dist = hexDistance(attacker.row, attacker.col, defender.row, defender.col);

  if (defDef.isDecoy) {
    defender.currentHealth = 0;
    io.to(room.code).emit('decoyRevealed', { unitId: defender.id, attackerId: attacker.id, row: defender.row, col: defender.col, msg: 'DECOY!' });
    removeUnit(room, defender);
    addKill(room, attacker.owner);
    if (map[defender.row] && map[defender.row][defender.col]) {
      map[defender.row][defender.col].owner = attacker.owner;
      io.to(room.code).emit('hexCaptured', { r: defender.row, c: defender.col, owner: attacker.owner });
    }
    return;
  }

  if (atkDef.empRange && dist <= 1) {
    const frozenIds = [];
    for (const u of room.gameState.units) {
      if (u.owner === attacker.owner) continue;
      if (hexDistance(attacker.row, attacker.col, u.row, u.col) <= atkDef.empRange) {
        const defPlayer = room.players.find(p => p.id === u.owner);
        if (u.type === 'TANK' && defPlayer && defPlayer.activeBonuses.includes('tankShield') && !u.empHitOnce) {
          u.empHitOnce = true; continue;
        }
        u.frozen = true;
        u.frozenUntil = Date.now() + (atkDef.empDuration || 6000);
        frozenIds.push(u.id);
      }
    }
    io.to(room.code).emit('empDetonated', { droneId: attacker.id, frozenUnitIds: frozenIds, row: attacker.row, col: attacker.col });
    attacker.currentHealth = 0;
    removeUnit(room, attacker);
    return;
  }

  if (defender.type === 'HELICOPTER' && !defender.landed) {
    if (dist <= (defDef.attackRange || 1)) attacker.currentHealth -= defDef.attack;
    emitCombat(room, attacker, defender);
    if (attacker.currentHealth <= 0) { removeUnit(room, attacker); addKill(room, defender.owner); }
    return;
  }

  let atkDmg = atkDef.attack;
  let defDmg = defDef.attack;
  if (attacker.type === 'TANK' && defender.type === 'INFANTRY') atkDmg *= 2;
  if (defender.type === 'TANK' && attacker.type === 'INFANTRY') defDmg *= 2;
  if (attacker.type === 'SCOUT' && defender.type === 'TANK') defDmg *= 3;
  if (defender.type === 'SCOUT' && attacker.type === 'TANK') atkDmg *= 3;

  if (attacker.type === 'ARCHER' && dist <= 2 && dist > 0) {
    defender.currentHealth -= atkDmg;
    if (dist > (defDef.attackRange || 1)) defDmg = 0;
  }

  if (atkDef.areaAttack) {
    if (dist < (atkDef.minRange || 0)) return;
    defender.currentHealth -= atkDmg;
    for (const u of room.gameState.units) {
      if (u.id === defender.id || u.owner === attacker.owner) continue;
      if (hexDistance(defender.row, defender.col, u.row, u.col) <= 1) {
        u.currentHealth -= Math.floor(atkDmg * 0.4);
        if (u.currentHealth <= 0) { removeUnit(room, u); addKill(room, attacker.owner); }
      }
    }
    io.to(room.code).emit('artilleryStrike', { row: defender.row, col: defender.col, owner: attacker.owner });
    defDmg = 0;
  } else if (attacker.type !== 'ARCHER' || dist <= 1) {
    defender.currentHealth -= atkDmg;
  }

  if (defDmg > 0 && dist <= (defDef.attackRange || 1)) attacker.currentHealth -= defDmg;

  emitCombat(room, attacker, defender);

  if (defender.currentHealth <= 0) {
    removeUnit(room, defender);
    addKill(room, attacker.owner);
    if (map[defender.row] && map[defender.row][defender.col]) {
      map[defender.row][defender.col].owner = attacker.owner;
      io.to(room.code).emit('hexCaptured', { r: defender.row, c: defender.col, owner: attacker.owner });
    }
  }
  if (attacker.currentHealth <= 0) { removeUnit(room, attacker); addKill(room, defender.owner); }
}

function emitCombat(room, attacker, defender) {
  io.to(room.code).emit('combatResult', {
    attacker: { id: attacker.id, type: attacker.type, owner: attacker.owner, hp: attacker.currentHealth, row: attacker.row, col: attacker.col },
    defender: { id: defender.id, type: defender.type, owner: defender.owner, hp: defender.currentHealth, row: defender.row, col: defender.col },
    damage: UNIT_TYPES[attacker.type]?.attack || 0
  });
}

function removeUnit(room, unit) {
  const player = room.players.find(p => p.id === unit.owner);
  if (player) player.stats.unitsLost++;
  room.gameState.units = room.gameState.units.filter(u => u.id !== unit.id);
  io.to(room.code).emit('unitsDestroyed', [unit.id]);
}

function addKill(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (player) player.stats.unitsKilled++;
}

// ─── AUTO-COMBAT ────────────────────────────────────────────────────
function processAutoCombat(room) {
  const units = [...room.gameState.units];
  const attacked = new Set();
  for (const unit of units) {
    if (!room.gameState.units.includes(unit)) continue;
    if (unit.frozen || attacked.has(unit.id)) continue;
    const def = UNIT_TYPES[unit.type];
    if (!def || def.attack <= 0) continue;
    let target = null, bestDist = Infinity;
    for (const other of room.gameState.units) {
      if (other.owner === unit.owner || attacked.has(other.id)) continue;
      const d = hexDistance(unit.row, unit.col, other.row, other.col);
      const maxRange = def.attackRange || 1;
      const minRange = def.minRange || 0;
      if (d <= maxRange && d >= minRange && d < bestDist) { bestDist = d; target = other; }
    }
    if (target) { attacked.add(unit.id); attacked.add(target.id); handleCombat(room, unit, target); }
  }
}

// ─── MOVEMENT ───────────────────────────────────────────────────────
function processUnitMovement(room) {
  const now = Date.now();
  const map = room.gameState.map;
  for (const unit of [...room.gameState.units]) {
    if (!room.gameState.units.includes(unit)) continue;
    if (unit.frozen && unit.frozenUntil && now >= unit.frozenUntil) { unit.frozen = false; unit.frozenUntil = null; }
    if (unit.frozen || unit.targetPath.length === 0) continue;
    const def = UNIT_TYPES[unit.type];
    if (!def || now - unit.lastMoveTime < def.moveInterval) continue;
    const next = unit.targetPath[0];
    const enemyAtDest = room.gameState.units.find(u => u.owner !== unit.owner && u.row === next.row && u.col === next.col);
    if (enemyAtDest) {
      handleCombat(room, unit, enemyAtDest);
      if (room.gameState.units.includes(unit) && !room.gameState.units.includes(enemyAtDest)) {
        unit.targetPath.shift(); unit.row = next.row; unit.col = next.col; unit.lastMoveTime = now;
        map[next.row][next.col].owner = unit.owner;
        io.to(room.code).emit('unitMoved', { id: unit.id, row: next.row, col: next.col });
        io.to(room.code).emit('hexCaptured', { r: next.row, c: next.col, owner: unit.owner });
      } else if (room.gameState.units.includes(unit)) { unit.targetPath = []; }
      continue;
    }
    unit.targetPath.shift();
    unit.row = next.row; unit.col = next.col; unit.lastMoveTime = now;
    if (map[next.row][next.col].owner !== unit.owner) {
      map[next.row][next.col].owner = unit.owner;
      io.to(room.code).emit('hexCaptured', { r: next.row, c: next.col, owner: unit.owner, prevOwner: map[next.row][next.col].owner });
    }
    io.to(room.code).emit('unitMoved', { id: unit.id, row: next.row, col: next.col });
  }
}

// ─── COMBINATION BONUSES ────────────────────────────────────────────
function checkCombinationBonuses(room) {
  const map = room.gameState.map;
  for (const player of room.players) {
    if (player.eliminated) continue;
    const ownedZones = new Set();
    for (let r = 0; r < MAP_SIZE; r++)
      for (let c = 0; c < MAP_SIZE; c++)
        if (map[r][c].owner === player.id && map[r][c].type !== 'empty') ownedZones.add(map[r][c].type);
    const newBonuses = [];
    if (ownedZones.has('forest') && ownedZones.has('lab')) newBonuses.push('ghostScouts');
    if (ownedZones.has('oil') && ownedZones.has('factory')) newBonuses.push('armouredHelicopters');
    if (ownedZones.has('port') && ownedZones.has('forest')) newBonuses.push('amphibiousArchers');
    if (ownedZones.has('lab') && ownedZones.has('factory')) newBonuses.push('tankShield');
    if (ownedZones.has('oil') && ownedZones.has('lab')) newBonuses.push('stealthDrones');
    if (ownedZones.has('port') && ownedZones.has('oil')) newBonuses.push('navalArtillery');
    if (newBonuses.includes('armouredHelicopters') && !player.activeBonuses.includes('armouredHelicopters')) {
      for (const u of room.gameState.units) { if (u.owner === player.id && u.type === 'HELICOPTER') u.currentHealth += 100; }
    }
    if (!newBonuses.includes('armouredHelicopters') && player.activeBonuses.includes('armouredHelicopters')) {
      for (const u of room.gameState.units) { if (u.owner === player.id && u.type === 'HELICOPTER') u.currentHealth = Math.min(u.currentHealth, UNIT_TYPES.HELICOPTER.health); }
    }
    const oldStr = player.activeBonuses.sort().join(',');
    const newStr = newBonuses.sort().join(',');
    if (oldStr !== newStr) { player.activeBonuses = newBonuses; io.to(player.id).emit('bonusUpdate', { bonuses: newBonuses }); }
  }
}

// ─── VICTORY ────────────────────────────────────────────────────────
function checkVictory(room) {
  if (room.gameOver) return;
  const map = room.gameState.map;
  const hexCount = {};
  for (const p of room.players) hexCount[p.id] = 0;
  for (let r = 0; r < MAP_SIZE; r++)
    for (let c = 0; c < MAP_SIZE; c++)
      if (map[r][c].owner && hexCount[map[r][c].owner] !== undefined) hexCount[map[r][c].owner]++;
  for (const p of room.players) p.stats.hexesOwned = hexCount[p.id] || 0;

  for (const player of room.players) {
    if (player.eliminated || player.baseRow == null) continue;
    const baseTile = map[player.baseRow][player.baseCol];
    if (baseTile.owner !== player.id && baseTile.owner !== null) {
      player.eliminated = true;
      room.gameState.units = room.gameState.units.filter(u => u.owner !== player.id);
      for (let r = 0; r < MAP_SIZE; r++)
        for (let c = 0; c < MAP_SIZE; c++)
          if (map[r][c].owner === player.id) map[r][c].owner = null;
      io.to(room.code).emit('playerEliminated', { playerId: player.id, name: player.name, eliminatedBy: baseTile.owner });
    }
  }
  const alive = room.players.filter(p => !p.eliminated);
  for (const p of alive) {
    if ((hexCount[p.id] || 0) >= TOTAL_HEXES * DOMINATION_THRESHOLD) { endGame(room, p, 'domination'); return; }
  }
  if (alive.length === 1 && room.players.length > 1) { endGame(room, alive[0], 'last_standing'); return; }
  if (alive.length === 0 && room.players.length > 0) endGame(room, null, 'draw');
}

function endGame(room, winner, reason) {
  room.gameOver = true;
  clearInterval(room.gameLoopInterval); clearInterval(room.movementInterval);
  clearInterval(room.resourceInterval); clearInterval(room.bonusInterval); clearInterval(room.victoryInterval);
  const stats = {};
  for (const p of room.players) {
    stats[p.id] = {
      name: p.name, colour: p.colour, hexesOwned: p.stats.hexesOwned,
      unitsKilled: p.stats.unitsKilled, unitsLost: p.stats.unitsLost,
      resourcesGathered: p.stats.resourcesGathered, eliminated: !!p.eliminated
    };
  }
  io.to(room.code).emit('gameOver', {
    winner: winner ? { id: winner.id, name: winner.name, colour: winner.colour } : null,
    reason, duration: Date.now() - room.startTime, stats
  });
}

// ─── REPLAY BUFFER ──────────────────────────────────────────────────
function captureSnapshot(room) {
  if (!room.replayBuffer) room.replayBuffer = [];
  room.replayBuffer.push({
    timestamp: Date.now(),
    units: room.gameState.units.map(u => ({ id: u.id, type: u.type, owner: u.owner, row: u.row, col: u.col, hp: u.currentHealth, frozen: u.frozen }))
  });
  const cutoff = Date.now() - 60000;
  while (room.replayBuffer.length > 0 && room.replayBuffer[0].timestamp < cutoff) room.replayBuffer.shift();
}

// ─── GAME LOOP ──────────────────────────────────────────────────────
function startGameLoop(room) {
  room.startTime = Date.now();
  room.gameLoopInterval = setInterval(() => {
    processTrainingQueues(room);
    processAutoCombat(room);
    captureSnapshot(room);
    io.to(room.code).emit('gameUpdate', { units: room.gameState.units, mapOwnership: getOwnershipChanges(room) });
  }, 500);
  room.movementInterval = setInterval(() => processUnitMovement(room), 100);
  room.resourceInterval = setInterval(() => generateResources(room), 3000);
  room.bonusInterval = setInterval(() => checkCombinationBonuses(room), 5000);
  room.victoryInterval = setInterval(() => checkVictory(room), 5000);
}

function getOwnershipChanges(room) {
  const changes = [];
  const map = room.gameState.map;
  for (let r = 0; r < MAP_SIZE; r++)
    for (let c = 0; c < MAP_SIZE; c++)
      if (map[r][c].owner) changes.push({ r, c, owner: map[r][c].owner });
  return changes;
}

// ─── SOCKET EVENTS ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('createRoom', (data) => {
    const code = generateRoomCode();
    const colour = data.colour || PLAYER_COLOURS[0];
    const room = {
      code, host: socket.id,
      players: [{
        id: socket.id, name: data.name || 'Player 1', colour,
        resources: { wood: 0, steel: 0, fuel: 0, supplies: 0, research: 0 },
        trainingQueue: [], baseRow: null, baseCol: null, activeBonuses: [],
        isConnected: true, eliminated: false,
        stats: { hexesOwned: 0, unitsKilled: 0, unitsLost: 0, resourcesGathered: 0 }
      }],
      gameState: { map: generateMap(), units: [] },
      isStarted: false, gameOver: false, replayBuffer: [], startTime: null
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
    // prevent duplicate colour
    const usedColours = room.players.map(p => p.colour);
    let colour = data.colour || PLAYER_COLOURS[room.players.length % PLAYER_COLOURS.length];
    if (usedColours.includes(colour)) colour = PLAYER_COLOURS.find(c => !usedColours.includes(c)) || colour;
    room.players.push({
      id: socket.id, name: data.name || `Player ${room.players.length + 1}`, colour,
      resources: { wood: 0, steel: 0, fuel: 0, supplies: 0, research: 0 },
      trainingQueue: [], baseRow: null, baseCol: null, activeBonuses: [],
      isConnected: true, eliminated: false,
      stats: { hexesOwned: 0, unitsKilled: 0, unitsLost: 0, resourcesGathered: 0 }
    });
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('roomUpdated', { players: room.players.map(p => ({ id: p.id, name: p.name, colour: p.colour })) });
  });

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return socket.emit('error', { msg: 'Only host can start' });
    if (room.isStarted) return;
    room.isStarted = true;
    for (const player of room.players) spawnPlayer(room, player.id);
    const playerData = room.players.map(p => ({
      id: p.id, name: p.name, colour: p.colour, baseRow: p.baseRow, baseCol: p.baseCol, resources: p.resources
    }));
    const mapData = [];
    for (let r = 0; r < MAP_SIZE; r++) {
      mapData[r] = [];
      for (let c = 0; c < MAP_SIZE; c++) {
        const t = room.gameState.map[r][c];
        mapData[r][c] = { t: t.type === 'empty' ? 0 : t.type, o: t.owner };
      }
    }
    // countdown
    io.to(code).emit('countdown', 3);
    setTimeout(() => {
      io.to(code).emit('gameStarted', { map: mapData, players: playerData });
      startGameLoop(room);
    }, 3000);
  });

  socket.on('trainUnit', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const result = trainUnit(rooms[code], socket.id, data.unitType);
    if (!result.ok) return socket.emit('trainError', { msg: result.msg });
    const player = rooms[code].players.find(p => p.id === socket.id);
    socket.emit('playerUpdate', { resources: player.resources, trainingQueue: player.trainingQueue, maxUnits: result.maxUnits, currentUnits: result.currentUnits });
  });

  socket.on('moveUnit', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const unit = rooms[code].gameState.units.find(u => u.id === data.unitId && u.owner === socket.id);
    if (!unit) return;
    const path = findPath(rooms[code].gameState.map, unit.row, unit.col, data.row, data.col, unit.type);
    if (path) unit.targetPath = path;
  });

  socket.on('moveUnits', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const room = rooms[code];
    if (!data.unitIds || !Array.isArray(data.unitIds)) return;
    for (const uid of data.unitIds) {
      const unit = room.gameState.units.find(u => u.id === uid && u.owner === socket.id);
      if (!unit) continue;
      const path = findPath(room.gameState.map, unit.row, unit.col, data.row, data.col, unit.type);
      if (path) unit.targetPath = path;
    }
  });

  socket.on('navalStrike', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const room = rooms[code];
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.activeBonuses.includes('navalArtillery')) return;
    const now = Date.now();
    if (player.lastNavalStrike && now - player.lastNavalStrike < 30000) return socket.emit('trainError', { msg: 'Naval strike on cooldown' });
    const marine = room.gameState.units.find(u => u.owner === socket.id && u.type === 'MARINE');
    if (!marine) return socket.emit('trainError', { msg: 'Need a marine' });
    if (hexDistance(marine.row, marine.col, data.row, data.col) > 5) return socket.emit('trainError', { msg: 'Out of range' });
    player.lastNavalStrike = now;
    const hitHexes = [[data.row, data.col], ...getHexNeighbours(data.row, data.col)];
    for (const u of [...room.gameState.units]) {
      if (u.owner === socket.id) continue;
      for (const [hr, hc] of hitHexes) {
        if (u.row === hr && u.col === hc) { u.currentHealth -= 60; if (u.currentHealth <= 0) { removeUnit(room, u); addKill(room, socket.id); } break; }
      }
    }
    io.to(room.code).emit('artilleryStrike', { row: data.row, col: data.col, owner: socket.id });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isConnected = false;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      clearInterval(room.gameLoopInterval); clearInterval(room.movementInterval);
      clearInterval(room.resourceInterval); clearInterval(room.bonusInterval); clearInterval(room.victoryInterval);
      delete rooms[code];
    } else {
      if (room.host === socket.id) room.host = room.players[0].id;
      io.to(code).emit('roomUpdated', { players: room.players.map(p => ({ id: p.id, name: p.name, colour: p.colour })) });
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`FRONTLINE server running on http://localhost:${PORT}`));
