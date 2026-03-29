const http = require("http");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 10000;

const WORLD = { width: 4200, height: 2600 };
const TICK_RATE = 20;

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

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({ server });

const players = new Map();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function makePlayer() {
  return {
    id: randomUUID(),
    name: "Oyuncu",
    x: WORLD.width / 2 + Math.random() * 120 - 60,
    y: WORLD.height / 2 + Math.random() * 120 - 60,
    vx: 0,
    vy: 0,
    angle: 0,
    level: 1,
    formKey: "mycoplasma",
    size: 12,
    speed: 2.35,
    maxHp: 100,
    hp: 100,
    xp: 0,
    xpNeed: 30,
    score: 0,
    inHideZone: false,
    isHiddenFromPlayers: false,
    input: {
      mx: WORLD.width / 2,
      my: WORLD.height / 2
    },
    boss: null,
    teleportGate: null
  };
}

function getFormStats(level) {
  const forms = [
    { key: "mycoplasma", size: 12, speed: 2.35, maxHp: 100 },
    { key: "amoeba", size: 17, speed: 2.05, maxHp: 122 },
    { key: "paramecium", size: 15, speed: 2.55, maxHp: 96 },
    { key: "euglena", size: 18, speed: 2.28, maxHp: 106 },
    { key: "yeast", size: 21, speed: 1.92, maxHp: 132 },
    { key: "protozoa", size: 24, speed: 2.10, maxHp: 150 },
    { key: "macrocell", size: 28, speed: 1.80, maxHp: 180 }
  ];
  const idx = Math.min(Math.max(level - 1, 0), forms.length - 1);
  return forms[idx];
}

function applyEvolution(player) {
  const form = getFormStats(player.level);
  player.formKey = form.key;
  player.size = form.size + player.level * 2;
  player.speed = form.speed;
  player.maxHp = form.maxHp + player.level * 20;
  player.hp = Math.min(player.maxHp, player.hp + 20);

  if (player.formKey === "macrocell" && !player.boss && !player.teleportGate) {
    player.boss = {
      ownerId: player.id,
      x: 450 + Math.random() * (WORLD.width - 900),
      y: 320 + Math.random() * (WORLD.height - 640),
      hp: 520,
      maxHp: 520,
      size: 46,
      active: true
    };
  }
}

function visiblePlayersFor(viewerId) {
  const out = [];
  for (const p of players.values()) {
    if (p.id === viewerId) continue;
    if (p.isHiddenFromPlayers) continue;

    out.push({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      angle: p.angle,
      level: p.level,
      formKey: p.formKey,
      size: p.size,
      hp: p.hp,
      maxHp: p.maxHp,
      score: p.score
    });
  }
  return out;
}

function tick() {
  for (const p of players.values()) {
    const dx = p.input.mx - p.x;
    const dy = p.input.my - p.y;
    const len = Math.hypot(dx, dy) || 1;

    const nx = dx / len;
    const ny = dy / len;

    p.vx = nx * p.speed;
    p.vy = ny * p.speed;

    p.x = clamp(p.x + p.vx, 0, WORLD.width);
    p.y = clamp(p.y + p.vy, 0, WORLD.height);
    p.angle = Math.atan2(ny, nx);

    if (p.level < 7 && p.xp >= p.xpNeed) {
      p.xp -= p.xpNeed;
      p.xpNeed = Math.min(200, Math.floor(p.xpNeed * 1.4));
      p.level += 1;
      applyEvolution(p);
    }

    if (p.formKey === "macrocell") {
      p.xp = Math.min(p.xp, 200);
      p.xpNeed = 200;
    }
  }

  for (const p of players.values()) {
    if (p.ws.readyState !== WebSocket.OPEN) continue;

    p.ws.send(JSON.stringify({
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
        hp: p.hp,
        maxHp: p.maxHp,
        xp: p.xp,
        xpNeed: p.xpNeed,
        score: p.score,
        inHideZone: p.inHideZone,
        boss: p.boss,
        teleportGate: p.teleportGate
      },
      others: visiblePlayersFor(p.id)
    }));
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
        if (typeof msg.mx === "number") p.input.mx = msg.mx;
        if (typeof msg.my === "number") p.input.my = msg.my;
      }

      if (msg.type === "profile" && typeof msg.name === "string") {
        p.name = msg.name.slice(0, 24) || "Oyuncu";
      }

      if (msg.type === "hide") {
        p.inHideZone = !!msg.active;
        p.isHiddenFromPlayers = !!msg.active;
      }

      if (msg.type === "gainXp" && typeof msg.amount === "number") {
        p.xp = clamp(p.xp + msg.amount, 0, 999);
      }
    } catch (e) {
      // bozuk mesajı yok say
    }
  });

  ws.on("close", () => {
    players.delete(player.id);
  });
});

setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});