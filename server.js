const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 10000;
const WORLD = { width: 4200, height: 2600 };
const TICK_RATE = 20;
const BOT_COUNT = 8;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bakteri multiplayer server çalışıyor");
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });
const players = new Map();
const bots = new Map();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function randomSpawn() {
  return {
    x: WORLD.width / 2 + Math.random() * 240 - 120,
    y: WORLD.height / 2 + Math.random() * 240 - 120
  };
}

function makeBaseEntity(name = "Oyuncu") {
  const spawn = randomSpawn();

  return {
    id: randomUUID(),
    name,

    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    angle: 0,

    level: 1,
    formKey: "mycoplasma",
    size: 12,
    speed: 2.35,
    damage: 10,

    maxHp: 100,
    hp: 100,
    xp: 0,
    xpNeed: 30,
    score: 0,

    inHideZone: false,
    isHiddenFromPlayers: false,

    input: {
      mx: spawn.x,
      my: spawn.y
    },

    isDead: false,
    respawnTimer: 0,
    pvpCooldown: 0
  };
}

function makePlayer() {
  return {
    ...makeBaseEntity("Oyuncu"),
    ws: null,
    isBot: false
  };
}

function makeBot(index) {
  const bot = {
    ...makeBaseEntity(`Bot ${index + 1}`),
    ws: null,
    isBot: true,
    aiTimer: Math.floor(rand(20, 90)),
    targetId: null,
    roamAngle: rand(0, Math.PI * 2)
  };

  bot.level = Math.floor(rand(1, 6));
  applyStatsFromLevel(bot);
  bot.hp = bot.maxHp;

  return bot;
}

function applyStatsFromLevel(entity) {
  const forms = [
    { key: "mycoplasma", size: 12, speed: 2.35, maxHp: 100, damage: 10 },
    { key: "amoeba", size: 17, speed: 2.05, maxHp: 122, damage: 13 },
    { key: "paramecium", size: 15, speed: 2.55, maxHp: 96, damage: 11 },
    { key: "euglena", size: 18, speed: 2.28, maxHp: 106, damage: 12 },
    { key: "yeast", size: 21, speed: 1.92, maxHp: 132, damage: 14 },
    { key: "protozoa", size: 24, speed: 2.10, maxHp: 150, damage: 16 },
    { key: "macrocell", size: 28, speed: 1.80, maxHp: 180, damage: 18 }
  ];

  const idx = clamp(entity.level - 1, 0, forms.length - 1);
  const f = forms[idx];

  entity.formKey = f.key;
  entity.size = f.size + entity.level * 2;
  entity.speed = f.speed;
  entity.damage = f.damage;
  entity.maxHp = f.maxHp + entity.level * 20;

  if (entity.formKey === "macrocell") {
    entity.xp = Math.min(entity.xp, 200);
    entity.xpNeed = 200;
  }
}

function resetEntity(entity) {
  const spawn = randomSpawn();

  entity.x = spawn.x;
  entity.y = spawn.y;
  entity.vx = 0;
  entity.vy = 0;
  entity.angle = 0;

  entity.level = entity.isBot ? Math.floor(rand(1, 6)) : 1;
  entity.xp = 0;
  entity.xpNeed = 30;
  entity.score = 0;

  applyStatsFromLevel(entity);

  entity.hp = entity.maxHp;
  entity.inHideZone = false;
  entity.isHiddenFromPlayers = false;

  entity.input.mx = spawn.x;
  entity.input.my = spawn.y;

  entity.isDead = false;
  entity.respawnTimer = 0;
  entity.pvpCooldown = 60;

  if (entity.isBot) {
    entity.aiTimer = Math.floor(rand(20, 90));
    entity.targetId = null;
    entity.roamAngle = rand(0, Math.PI * 2);
  }
}

function allEntities() {
  return [...players.values(), ...bots.values()];
}

function leaderboardData() {
  return allEntities()
    .filter(e => !e.isDead)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((e, i) => ({
      rank: i + 1,
      id: e.id,
      name: e.name,
      score: Math.floor(e.score),
      level: e.level,
      isBot: !!e.isBot
    }));
}

function visibleEntitiesFor(viewerId) {
  const out = [];

  for (const e of allEntities()) {
    if (e.id === viewerId) continue;
    if (e.isDead) continue;
    if (e.isHiddenFromPlayers) continue;

    out.push({
      id: e.id,
      name: e.name,
      x: e.x,
      y: e.y,
      angle: e.angle,
      level: e.level,
      formKey: e.formKey,
      size: e.size,
      hp: e.hp,
      maxHp: e.maxHp,
      xp: e.xp,
      xpNeed: e.xpNeed,
      score: e.score,
      speed: e.speed,
      damage: e.damage,
      isBot: !!e.isBot
    });
  }

  return out;
}

function sendToPlayer(player, payload) {
  if (!player.ws || player.ws.readyState !== WebSocket.OPEN) return;
  player.ws.send(JSON.stringify(payload));
}

function grantKillRewards(killer) {
  killer.score += 50;
  killer.xp = clamp(killer.xp + 25, 0, 999999);
  applyEvolutionIfNeeded(killer);
  killer.hp = clamp(killer.hp + killer.maxHp * 0.18, 0, killer.maxHp);
  killer.pvpCooldown = 8;
}

function killEntity(victim, killer = null) {
  if (victim.isDead) return;

  victim.isDead = true;
  victim.respawnTimer = 60;
  victim.hp = 0;
  victim.inHideZone = false;
  victim.isHiddenFromPlayers = false;

  if (!victim.isBot) {
    sendToPlayer(victim, {
      type: "death",
      by: killer ? killer.name : "Bilinmiyor"
    });
  }

  if (killer) {
    grantKillRewards(killer);
  }
}

function applyEvolutionIfNeeded(entity) {
  while (entity.level < 7 && entity.xp >= entity.xpNeed) {
    entity.xp -= entity.xpNeed;
    entity.xpNeed = Math.min(200, Math.floor(entity.xpNeed * 1.4));
    entity.level += 1;
    applyStatsFromLevel(entity);
    entity.hp = Math.min(entity.maxHp, entity.hp + 20);
  }

  if (entity.formKey === "macrocell") {
    entity.xp = Math.min(entity.xp, 200);
    entity.xpNeed = 200;
  }
}

function chooseBotTarget(bot) {
  const entities = allEntities().filter(e => e.id !== bot.id && !e.isDead && !e.inHideZone && !e.isHiddenFromPlayers);

  if (entities.length === 0) {
    bot.targetId = null;
    return null;
  }

  let best = null;
  let bestScore = -Infinity;

  for (const e of entities) {
    const d = dist(bot.x, bot.y, e.x, e.y);
    let score = 0;

    if (bot.size > e.size) {
      score += 200 - d * 0.25;
    } else if (e.size > bot.size) {
      score -= 160 - d * 0.2;
    } else {
      score -= d * 0.05;
    }

    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }

  bot.targetId = best ? best.id : null;
  return best;
}

function getEntityById(id) {
  return players.get(id) || bots.get(id) || null;
}

function updateBots() {
  for (const bot of bots.values()) {
    if (bot.isDead) continue;

    bot.aiTimer--;

    let target = null;
    if (bot.targetId) {
      target = getEntityById(bot.targetId);
      if (!target || target.isDead || target.inHideZone || target.isHiddenFromPlayers) {
        target = null;
      }
    }

    if (!target || bot.aiTimer <= 0) {
      target = chooseBotTarget(bot);
      bot.aiTimer = Math.floor(rand(25, 80));
    }

    let tx = bot.x + Math.cos(bot.roamAngle) * 140;
    let ty = bot.y + Math.sin(bot.roamAngle) * 140;

    if (target) {
      if (bot.size > target.size) {
        tx = target.x;
        ty = target.y;
      } else {
        const dx = bot.x - target.x;
        const dy = bot.y - target.y;
        const len = Math.hypot(dx, dy) || 1;
        tx = bot.x + (dx / len) * 180;
        ty = bot.y + (dy / len) * 180;
      }
    } else {
      bot.roamAngle += rand(-0.4, 0.4);
      tx = bot.x + Math.cos(bot.roamAngle) * 160;
      ty = bot.y + Math.sin(bot.roamAngle) * 160;
    }

    bot.input.mx = clamp(tx, 0, WORLD.width);
    bot.input.my = clamp(ty, 0, WORLD.height);
  }
}

function handlePvP() {
  const list = allEntities().filter((p) => !p.isDead);

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      if (a.inHideZone || b.inHideZone) continue;
      if (a.isHiddenFromPlayers || b.isHiddenFromPlayers) continue;
      if (a.pvpCooldown > 0 || b.pvpCooldown > 0) continue;

      const d = dist(a.x, a.y, b.x, b.y);
      if (d > a.size + b.size + 4) continue;

      if (a.size > b.size) {
        killEntity(b, a);
      } else if (b.size > a.size) {
        killEntity(a, b);
      }
    }
  }
}

function tick() {
  updateBots();

  for (const e of allEntities()) {
    if (e.isDead) {
      if (e.respawnTimer > 0) {
        e.respawnTimer--;
      } else {
        resetEntity(e);
      }
      continue;
    }

    const dx = e.input.mx - e.x;
    const dy = e.input.my - e.y;
    const len = Math.hypot(dx, dy) || 1;

    const nx = dx / len;
    const ny = dy / len;

    e.vx = nx * e.speed;
    e.vy = ny * e.speed;

    e.x = clamp(e.x + e.vx, 0, WORLD.width);
    e.y = clamp(e.y + e.vy, 0, WORLD.height);
    e.angle = Math.atan2(ny, nx);

    if (e.formKey === "macrocell") {
      e.xp = Math.min(e.xp, 200);
      e.xpNeed = 200;
    }

    if (e.pvpCooldown > 0) {
      e.pvpCooldown--;
    }
  }

  handlePvP();

  const leaderboard = leaderboardData();

  for (const p of players.values()) {
    sendToPlayer(p, {
      type: "state",
      self: {
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        angle: p.angle,
        level: p.level,
        formKey: p.formKey,
        size: p.size,
        speed: p.speed,
        damage: p.damage,
        hp: p.hp,
        maxHp: p.maxHp,
        xp: p.xp,
        xpNeed: p.xpNeed,
        score: p.score,
        inHideZone: p.inHideZone,
        isDead: p.isDead,
        respawnTimer: p.respawnTimer
      },
      others: visibleEntitiesFor(p.id),
      leaderboard
    });
  }
}

wss.on("connection", (ws) => {
  const player = makePlayer();
  player.ws = ws;
  players.set(player.id, player);

  ws.send(JSON.stringify({
    type: "welcome",
    id: player.id,
    world: WORLD
  }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const p = players.get(player.id);
      if (!p) return;

      if (msg.type === "input") {
        if (typeof msg.mx === "number") p.input.mx = clamp(msg.mx, 0, WORLD.width);
        if (typeof msg.my === "number") p.input.my = clamp(msg.my, 0, WORLD.height);
      }

      if (msg.type === "profile") {
        if (typeof msg.name === "string") {
          const trimmed = msg.name.trim();
          p.name = trimmed ? trimmed.slice(0, 24) : "Oyuncu";
        }
      }

      if (msg.type === "hide") {
        p.inHideZone = !!msg.active;
        p.isHiddenFromPlayers = !!msg.active;
      }

      if (msg.type === "sync") {
        if (typeof msg.level === "number") p.level = clamp(Math.floor(msg.level), 1, 999);
        if (typeof msg.formKey === "string") p.formKey = msg.formKey.slice(0, 32);
        if (typeof msg.size === "number") p.size = clamp(msg.size, 4, 999);
        if (typeof msg.speed === "number") p.speed = clamp(msg.speed, 0.1, 20);
        if (typeof msg.damage === "number") p.damage = clamp(msg.damage, 1, 9999);
        if (typeof msg.hp === "number") p.hp = clamp(msg.hp, 0, 999999);
        if (typeof msg.maxHp === "number") {
          p.maxHp = clamp(msg.maxHp, 1, 999999);
          p.hp = clamp(p.hp, 0, p.maxHp);
        }
        if (typeof msg.score === "number") p.score = clamp(msg.score, 0, 999999999);
        if (typeof msg.xp === "number") p.xp = clamp(msg.xp, 0, 999999);
        if (typeof msg.xpNeed === "number") p.xpNeed = clamp(msg.xpNeed, 1, 999999);
        if (typeof msg.x === "number") p.x = clamp(msg.x, 0, WORLD.width);
        if (typeof msg.y === "number") p.y = clamp(msg.y, 0, WORLD.height);
        if (typeof msg.angle === "number") p.angle = msg.angle;
        if (typeof msg.inHideZone === "boolean") {
          p.inHideZone = msg.inHideZone;
          p.isHiddenFromPlayers = msg.inHideZone;
        }
      }
    } catch (e) {
      console.log("Mesaj parse hatası:", e.message);
    }
  });

  ws.on("close", () => {
    players.delete(player.id);
  });

  ws.on("error", (err) => {
    console.log("Socket error:", err.message);
  });
});

function initBots() {
  bots.clear();
  for (let i = 0; i < BOT_COUNT; i++) {
    const bot = makeBot(i);
    bots.set(bot.id, bot);
  }
}

initBots();
setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
