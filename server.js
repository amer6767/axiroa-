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
  SCOUT: { cost: { wood: 20 }, trainTime: 5000, health: 40, attack: 8, moveInterval: 500, attackRange: 1, visionRange: 3, requiredZone: 'forest' },
  ARCHER: { cost: { wood: 30, steel: 10 }, trainTime: 8000, health: 60, attack: 20, moveInterval: 1000, attackRange: 2, requiredZone: 'forest' },
  INFANTRY: { cost: { steel: 30 }, trainTime: 8000, health: 100, attack: 25, moveInterval: 1000, attackRange: 1, requiredZone: 'factory' },
  TANK: { cost: { steel: 50, fuel: 20 }, trainTime: 15000, health: 250, attack: 60, moveInterval: 2000, attackRange: 1, requiredZone: 'factory' },
  ARTILLERY: { cost: { fuel: 40, steel: 30 }, trainTime: 20000, health: 80, attack: 80, moveInterval: 3000, attackRange: 4, minRange: 2, areaAttack: true, requiredZone: 'oil' },
  HELICOPTER: { cost: { fuel: 60, steel: 20 }, trainTime: 25000, health: 150, attack: 45, moveInterval: 333, attackRange: 1, canFlyOver: true, requiredZone: 'oil' },
  MARINE: { cost: { supplies: 30, steel: 20 }, trainTime: 10000, health: 120, attack: 35, moveInterval: 1000, attackRange: 1, canCrossWater: true, requiredZone: 'port' },
  EMP_DRONE: { cost: { research: 50, fuel: 20 }, trainTime: 20000, health: 50, attack: 5, moveInterval: 500, empRange: 3, empDuration: 6000, requiredZone: 'lab' },
  DECOY: { cost: { research: 30 }, trainTime: 8000, health: 30, attack: 0, moveInterval: 1000, isDecoy: true, requiredZone: 'lab' }
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

// ─── PLAYER COLOURS ─────────────────────────────────────────────────
const PLAYER_COLOURS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e91e63'
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

// ─── TRAINING ───────────────────────────────────────────────────────
function trainUnit(room, playerId, unitType) {
  const def = UNIT_TYPES[unitType];
  if (!def) return { ok: false, msg: 'Unknown unit type' };
  const player = room.players.find(p => p.id === playerId);
  if (!player) return { ok: false, msg: 'Player not found' };
  if (player.eliminated) return { ok: false, msg: 'You are eliminated' };
  const map = room.gameState.map;
  let hasZone = false;
  for (let r = 0; r < MAP_SIZE && !hasZone; r++)
    for (let c = 0; c < MAP_SIZE && !hasZone; c++)
      if (map[r][c].owner === playerId && map[r][c].type === def.requiredZone) hasZone = true;
  if (!hasZone) return { ok: false, msg: `Need a ${def.requiredZone} zone` };
  for (const [res, amt] of Object.entries(def.cost)) {
    if ((player.resources[res] || 0) < amt) return { ok: false, msg: `Not enough ${res}` };
  }
  if (player.trainingQueue.length >= 5) return { ok: false, msg: 'Queue full (max 5)' };
  for (const [res, amt] of Object.entries(def.cost)) player.resources[res] -= amt;
  player.trainingQueue.push({ unitType, startTime: Date.now(), duration: def.trainTime, id: generateUniqueId() });
  return { ok: true };
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
    io.to(player.id).emit('resourceUpdate', player.resources);
  }
}

// ─── ENHANCED PATHFINDING (BFS on hex grid) ─────────────────────────
function findPath(map, startR, startC, endR, endC, unitType) {
  if (startR === endR && startC === endC) return [];
  const def = UNIT_TYPES[unitType] || {};
  const canFly = !!def.canFlyOver;
  const canWater = !!def.canCrossWater;

  const key = (r, c) => `${r},${c}`;
  const visited = new Set();
  // BFS with parent tracking for efficiency
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

      // Helicopters can fly over anything
      if (canFly) { /* no blocking */ }
      // Marines can cross water
      else if (canWater) { /* no blocking */ }
      // All other units blocked by water/port hexes
      else if (tile.type === 'port') continue;

      parent[k] = key(r, c);
      if (nr === endR && nc === endC) { found = true; break; }
      // max path depth
      queue.push([nr, nc]);
    }
    if (found) break;
    // safety: limit BFS scope
    if (visited.size > 4000) break;
  }

  if (!found) return null;

  // reconstruct path
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

// ─── ENHANCED COMBAT ────────────────────────────────────────────────
function handleCombat(room, attacker, defender) {
  const atkDef = UNIT_TYPES[attacker.type];
  const defDef = UNIT_TYPES[defender.type];
  if (!atkDef || !defDef) return;

  const map = room.gameState.map;
  const dist = hexDistance(attacker.row, attacker.col, defender.row, defender.col);

  // ── Decoy: dies in one hit
  if (defDef.isDecoy) {
    defender.currentHealth = 0;
    io.to(room.code).emit('decoyRevealed', { unitId: defender.id, attackerId: attacker.id, msg: 'DECOY!' });
    removeUnit(room, defender);
    attacker.owner && addKill(room, attacker.owner);
    // claim hex
    if (map[defender.row] && map[defender.row][defender.col]) {
      map[defender.row][defender.col].owner = attacker.owner;
      io.to(room.code).emit('hexCaptured', { r: defender.row, c: defender.col, owner: attacker.owner });
    }
    return;
  }

  // ── EMP Drone contact: freeze all enemies nearby, destroy drone
  if (atkDef.empRange && dist <= 1) {
    const frozenIds = [];
    for (const u of room.gameState.units) {
      if (u.owner === attacker.owner) continue;
      if (hexDistance(attacker.row, attacker.col, u.row, u.col) <= atkDef.empRange) {
        // tankShield bonus: tanks immune to first EMP
        const defPlayer = room.players.find(p => p.id === u.owner);
        if (u.type === 'TANK' && defPlayer && defPlayer.activeBonuses.includes('tankShield') && !u.empHitOnce) {
          u.empHitOnce = true;
          continue;
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

  // ── Helicopter: only takes damage when landed
  if (defender.type === 'HELICOPTER' && !defender.landed) {
    // attacker can't hit airborne helicopter, but helicopter can still attack
    let hpDmg = atkDef.attack;
    // only helicopter attacks if in range
    if (dist <= (defDef.attackRange || 1)) {
      attacker.currentHealth -= defDef.attack;
    }
    // helicopter takes no damage when airborne
    emitCombat(room, attacker, defender);
    if (attacker.currentHealth <= 0) {
      removeUnit(room, attacker);
      addKill(room, defender.owner);
    }
    return;
  }

  // ── Calculate damage modifiers
  let atkDmg = atkDef.attack;
  let defDmg = defDef.attack;

  // Tank vs Infantry: tank deals double damage
  if (attacker.type === 'TANK' && defender.type === 'INFANTRY') atkDmg *= 2;
  if (defender.type === 'TANK' && attacker.type === 'INFANTRY') defDmg *= 2;

  // Scout vs Tank: scout takes triple damage from tank
  if (attacker.type === 'SCOUT' && defender.type === 'TANK') defDmg *= 3;
  if (defender.type === 'SCOUT' && attacker.type === 'TANK') atkDmg *= 3;

  // Archer range 2: full damage, stays in place
  if (attacker.type === 'ARCHER' && dist <= 2 && dist > 0) {
    // archer attacks at range, defender can't retaliate if out of range
    defender.currentHealth -= atkDmg;
    if (dist > (defDef.attackRange || 1)) defDmg = 0;
  }

  // Artillery: area attack
  if (atkDef.areaAttack) {
    // check minRange
    if (dist < (atkDef.minRange || 0)) {
      // can't attack too close
      return;
    }
    // hit target
    defender.currentHealth -= atkDmg;
    // splash: hit all 6 adjacent hexes of target
    for (const u of room.gameState.units) {
      if (u.id === defender.id || u.owner === attacker.owner) continue;
      if (hexDistance(defender.row, defender.col, u.row, u.col) <= 1) {
        u.currentHealth -= Math.floor(atkDmg * 0.4);
        if (u.currentHealth <= 0) {
          removeUnit(room, u);
          addKill(room, attacker.owner);
        }
      }
    }
    // artillery doesn't take counter-attack at range
    defDmg = 0;
  } else if (attacker.type !== 'ARCHER' || dist <= 1) {
    // normal simultaneous damage
    defender.currentHealth -= atkDmg;
  }

  // defender retaliates if in range and has attack
  if (defDmg > 0 && dist <= (defDef.attackRange || 1)) {
    attacker.currentHealth -= defDmg;
  }

  emitCombat(room, attacker, defender);

  // remove dead units
  if (defender.currentHealth <= 0) {
    removeUnit(room, defender);
    addKill(room, attacker.owner);
    // attacker claims hex
    if (map[defender.row] && map[defender.row][defender.col]) {
      map[defender.row][defender.col].owner = attacker.owner;
      io.to(room.code).emit('hexCaptured', { r: defender.row, c: defender.col, owner: attacker.owner });
    }
  }
  if (attacker.currentHealth <= 0) {
    removeUnit(room, attacker);
    addKill(room, defender.owner);
  }
}

function emitCombat(room, attacker, defender) {
  io.to(room.code).emit('combatResult', {
    attacker: { id: attacker.id, type: attacker.type, owner: attacker.owner, hp: attacker.currentHealth, row: attacker.row, col: attacker.col },
    defender: { id: defender.id, type: defender.type, owner: defender.owner, hp: defender.currentHealth, row: defender.row, col: defender.col }
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

// ─── AUTO-COMBAT (range-based, every tick) ──────────────────────────
function processAutoCombat(room) {
  const units = [...room.gameState.units]; // snapshot
  const attacked = new Set();
  for (const unit of units) {
    if (!room.gameState.units.includes(unit)) continue; // already removed
    if (unit.frozen || attacked.has(unit.id)) continue;
    const def = UNIT_TYPES[unit.type];
    if (!def || def.attack <= 0) continue;

    // find nearest enemy in attack range
    let target = null, bestDist = Infinity;
    for (const other of room.gameState.units) {
      if (other.owner === unit.owner || attacked.has(other.id)) continue;
      const d = hexDistance(unit.row, unit.col, other.row, other.col);
      const maxRange = def.attackRange || 1;
      const minRange = def.minRange || 0;
      if (d <= maxRange && d >= minRange && d < bestDist) {
        bestDist = d;
        target = other;
      }
    }
    if (target) {
      attacked.add(unit.id);
      attacked.add(target.id);
      handleCombat(room, unit, target);
    }
  }
}

// ─── ENHANCED MOVEMENT (100ms tick) ─────────────────────────────────
function processUnitMovement(room) {
  const now = Date.now();
  const map = room.gameState.map;
  const unitsSnapshot = [...room.gameState.units];

  for (const unit of unitsSnapshot) {
    if (!room.gameState.units.includes(unit)) continue; // removed mid-loop
    // unfreeze check
    if (unit.frozen && unit.frozenUntil && now >= unit.frozenUntil) {
      unit.frozen = false;
      unit.frozenUntil = null;
    }
    if (unit.frozen) continue;
    if (unit.targetPath.length === 0) continue;
    const def = UNIT_TYPES[unit.type];
    if (!def) continue;
    if (now - unit.lastMoveTime < def.moveInterval) continue;

    const next = unit.targetPath[0];
    const tile = map[next.row][next.col];

    // Check for enemy unit at destination
    const enemyAtDest = room.gameState.units.find(u =>
      u.owner !== unit.owner && u.row === next.row && u.col === next.col
    );

    if (enemyAtDest) {
      // combat instead of moving
      handleCombat(room, unit, enemyAtDest);
      // if attacker survived and enemy died, continue path
      if (room.gameState.units.includes(unit) && !room.gameState.units.includes(enemyAtDest)) {
        unit.targetPath.shift();
        unit.row = next.row;
        unit.col = next.col;
        unit.lastMoveTime = now;
        map[next.row][next.col].owner = unit.owner;
        io.to(room.code).emit('unitMoved', { id: unit.id, row: next.row, col: next.col });
        io.to(room.code).emit('hexCaptured', { r: next.row, c: next.col, owner: unit.owner });
      } else {
        // combat happened, clear path if attacker died or enemy survived
        if (room.gameState.units.includes(unit)) {
          unit.targetPath = []; // stop, enemy blocks
        }
      }
      continue;
    }

    // Move one step
    unit.targetPath.shift();
    const prevRow = unit.row, prevCol = unit.col;
    unit.row = next.row;
    unit.col = next.col;
    unit.lastMoveTime = now;

    // Hex ownership
    if (tile.owner !== unit.owner) {
      const prevOwner = tile.owner;
      tile.owner = unit.owner;
      io.to(room.code).emit('hexCaptured', { r: next.row, c: next.col, owner: unit.owner, prevOwner });
    }

    io.to(room.code).emit('unitMoved', { id: unit.id, row: next.row, col: next.col });
  }
}

// ─── COMBINATION BONUSES ────────────────────────────────────────────
function checkCombinationBonuses(room) {
  const map = room.gameState.map;

  for (const player of room.players) {
    if (player.eliminated) continue;

    // determine which zone types this player owns
    const ownedZones = new Set();
    for (let r = 0; r < MAP_SIZE; r++) {
      for (let c = 0; c < MAP_SIZE; c++) {
        if (map[r][c].owner === player.id && map[r][c].type !== 'empty') {
          ownedZones.add(map[r][c].type);
        }
      }
    }

    const newBonuses = [];

    // Forest + Lab → ghostScouts: scouts invisible to enemies
    if (ownedZones.has('forest') && ownedZones.has('lab')) newBonuses.push('ghostScouts');

    // Oil + Factory → armouredHelicopters: helicopters +100hp and area attack
    if (ownedZones.has('oil') && ownedZones.has('factory')) newBonuses.push('armouredHelicopters');

    // Port + Forest → amphibiousArchers: archers can cross water
    if (ownedZones.has('port') && ownedZones.has('forest')) newBonuses.push('amphibiousArchers');

    // Lab + Factory → tankShield: tanks immune to first EMP hit
    if (ownedZones.has('lab') && ownedZones.has('factory')) newBonuses.push('tankShield');

    // Oil + Lab → stealthDrones: EMP drones invisible to enemies
    if (ownedZones.has('oil') && ownedZones.has('lab')) newBonuses.push('stealthDrones');

    // Port + Oil → navalArtillery: marines can call artillery strike every 30s within 5 hex range
    if (ownedZones.has('port') && ownedZones.has('oil')) newBonuses.push('navalArtillery');

    // Apply armoured helicopter bonus
    if (newBonuses.includes('armouredHelicopters') && !player.activeBonuses.includes('armouredHelicopters')) {
      for (const u of room.gameState.units) {
        if (u.owner === player.id && u.type === 'HELICOPTER') {
          u.currentHealth += 100;
        }
      }
    }
    // Remove armoured helicopter bonus if lost
    if (!newBonuses.includes('armouredHelicopters') && player.activeBonuses.includes('armouredHelicopters')) {
      for (const u of room.gameState.units) {
        if (u.owner === player.id && u.type === 'HELICOPTER') {
          u.currentHealth = Math.min(u.currentHealth, UNIT_TYPES.HELICOPTER.health);
        }
      }
    }

    // check if bonuses changed
    const oldStr = player.activeBonuses.sort().join(',');
    const newStr = newBonuses.sort().join(',');
    if (oldStr !== newStr) {
      player.activeBonuses = newBonuses;
      io.to(player.id).emit('bonusUpdate', { bonuses: newBonuses });
    }
  }
}

// ─── VICTORY CONDITIONS ─────────────────────────────────────────────
function checkVictory(room) {
  if (room.gameOver) return;
  const map = room.gameState.map;

  // count hexes per player
  const hexCount = {};
  for (const p of room.players) hexCount[p.id] = 0;
  for (let r = 0; r < MAP_SIZE; r++) {
    for (let c = 0; c < MAP_SIZE; c++) {
      if (map[r][c].owner && hexCount[map[r][c].owner] !== undefined) {
        hexCount[map[r][c].owner]++;
      }
    }
  }

  // update stats
  for (const p of room.players) {
    p.stats.hexesOwned = hexCount[p.id] || 0;
  }

  // check base capture → elimination
  for (const player of room.players) {
    if (player.eliminated) continue;
    if (player.baseRow == null) continue;
    const baseTile = map[player.baseRow][player.baseCol];
    if (baseTile.owner !== player.id && baseTile.owner !== null) {
      // player eliminated!
      player.eliminated = true;
      // remove their units
      room.gameState.units = room.gameState.units.filter(u => u.owner !== player.id);
      // turn territory grey
      for (let r = 0; r < MAP_SIZE; r++) {
        for (let c = 0; c < MAP_SIZE; c++) {
          if (map[r][c].owner === player.id) map[r][c].owner = null;
        }
      }
      io.to(room.code).emit('playerEliminated', { playerId: player.id, name: player.name, eliminatedBy: baseTile.owner });
      console.log(`${player.name} eliminated!`);
    }
  }

  const alivePlayers = room.players.filter(p => !p.eliminated);

  // domination victory: 70%+ of map
  for (const p of alivePlayers) {
    if ((hexCount[p.id] || 0) >= TOTAL_HEXES * DOMINATION_THRESHOLD) {
      endGame(room, p, 'domination');
      return;
    }
  }

  // last player standing
  if (alivePlayers.length === 1 && room.players.length > 1) {
    endGame(room, alivePlayers[0], 'last_standing');
    return;
  }

  // all eliminated (shouldn't happen but safety)
  if (alivePlayers.length === 0 && room.players.length > 0) {
    endGame(room, null, 'draw');
  }
}

function endGame(room, winner, reason) {
  room.gameOver = true;
  clearInterval(room.gameLoopInterval);
  clearInterval(room.movementInterval);
  clearInterval(room.resourceInterval);
  clearInterval(room.bonusInterval);
  clearInterval(room.victoryInterval);

  const duration = Date.now() - room.startTime;
  const stats = {};
  for (const p of room.players) {
    stats[p.id] = {
      name: p.name,
      colour: p.colour,
      hexesOwned: p.stats.hexesOwned,
      unitsKilled: p.stats.unitsKilled,
      unitsLost: p.stats.unitsLost,
      resourcesGathered: p.stats.resourcesGathered,
      eliminated: !!p.eliminated
    };
  }

  io.to(room.code).emit('gameOver', {
    winner: winner ? { id: winner.id, name: winner.name, colour: winner.colour } : null,
    reason,
    duration,
    stats
  });
  console.log(`Game over in room ${room.code}: ${winner ? winner.name : 'Draw'} (${reason})`);
}

// ─── REPLAY BUFFER ──────────────────────────────────────────────────
function captureSnapshot(room) {
  if (!room.replayBuffer) room.replayBuffer = [];
  const snapshot = {
    timestamp: Date.now(),
    units: room.gameState.units.map(u => ({ id: u.id, type: u.type, owner: u.owner, row: u.row, col: u.col, hp: u.currentHealth, frozen: u.frozen })),
  };
  room.replayBuffer.push(snapshot);
  // keep last 60 seconds (~120 snapshots at 500ms)
  const cutoff = Date.now() - 60000;
  while (room.replayBuffer.length > 0 && room.replayBuffer[0].timestamp < cutoff) {
    room.replayBuffer.shift();
  }
}

// ─── GAME LOOP ──────────────────────────────────────────────────────
function startGameLoop(room) {
  room.startTime = Date.now();

  // Main tick every 500ms — training, auto-combat, state broadcast
  room.gameLoopInterval = setInterval(() => {
    processTrainingQueues(room);
    processAutoCombat(room);
    captureSnapshot(room);
    const snapshot = {
      units: room.gameState.units,
      mapOwnership: getOwnershipChanges(room)
    };
    io.to(room.code).emit('gameUpdate', snapshot);
  }, 500);

  // Movement tick every 100ms — smooth unit movement
  room.movementInterval = setInterval(() => {
    processUnitMovement(room);
  }, 100);

  // Resource generation every 3000ms
  room.resourceInterval = setInterval(() => {
    generateResources(room);
  }, 3000);

  // Combination bonuses every 5000ms
  room.bonusInterval = setInterval(() => {
    checkCombinationBonuses(room);
  }, 5000);

  // Victory check every 5000ms
  room.victoryInterval = setInterval(() => {
    checkVictory(room);
  }, 5000);
}

function getOwnershipChanges(room) {
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
        isConnected: true,
        eliminated: false,
        stats: { hexesOwned: 0, unitsKilled: 0, unitsLost: 0, resourcesGathered: 0 }
      }],
      gameState: { map: generateMap(), units: [] },
      isStarted: false,
      gameOver: false,
      replayBuffer: [],
      startTime: null
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
      isConnected: true,
      eliminated: false,
      stats: { hexesOwned: 0, unitsKilled: 0, unitsLost: 0, resourcesGathered: 0 }
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
    const playerData = room.players.map(p => ({
      id: p.id, name: p.name, colour: p.colour,
      baseRow: p.baseRow, baseCol: p.baseCol,
      resources: p.resources
    }));
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
    const path = findPath(room.gameState.map, unit.row, unit.col, data.row, data.col, unit.type);
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
      const path = findPath(room.gameState.map, unit.row, unit.col, row, col, unit.type);
      if (path) unit.targetPath = path;
    }
  });

  // Naval artillery strike (bonus)
  socket.on('navalStrike', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || !rooms[code].isStarted) return;
    const room = rooms[code];
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.activeBonuses.includes('navalArtillery')) return;
    // cooldown check
    const now = Date.now();
    if (player.lastNavalStrike && now - player.lastNavalStrike < 30000) {
      return socket.emit('trainError', { msg: 'Naval strike on cooldown' });
    }
    // find a marine
    const marine = room.gameState.units.find(u => u.owner === socket.id && u.type === 'MARINE');
    if (!marine) return socket.emit('trainError', { msg: 'Need a marine for naval strike' });
    // check range
    if (hexDistance(marine.row, marine.col, data.row, data.col) > 5) {
      return socket.emit('trainError', { msg: 'Target out of range (5 hexes from marine)' });
    }
    player.lastNavalStrike = now;
    // deal artillery damage to target and surrounding hexes
    const hitHexes = [[data.row, data.col], ...getHexNeighbours(data.row, data.col)];
    for (const u of [...room.gameState.units]) {
      if (u.owner === socket.id) continue;
      for (const [hr, hc] of hitHexes) {
        if (u.row === hr && u.col === hc) {
          u.currentHealth -= 60;
          if (u.currentHealth <= 0) {
            removeUnit(room, u);
            addKill(room, socket.id);
          }
          break;
        }
      }
    }
    io.to(room.code).emit('navalStrikeEffect', { row: data.row, col: data.col, ownerId: socket.id });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isConnected = false;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      clearInterval(room.gameLoopInterval);
      clearInterval(room.movementInterval);
      clearInterval(room.resourceInterval);
      clearInterval(room.bonusInterval);
      clearInterval(room.victoryInterval);
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
