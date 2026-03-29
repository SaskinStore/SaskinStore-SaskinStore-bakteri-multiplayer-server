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

    x: WORLD.width / 2,
    y: WORLD.height / 2,
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
      mx: WORLD.width / 2,
      my: WORLD.height / 2
    },

    ws: null
  };
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
      xp: p.xp,
      xpNeed: p.xpNeed,
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

    // Makro hücre limiti
    if (p.formKey === "macrocell") {
      p.xp = Math.min(p.xp, 200);
      p.xpNeed = 200;
    }
  }

  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;

    p.ws.send(JSON.stringify({
      type: "state",
      self: p,
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

      // Hareket input
      if (msg.type === "input") {
        if (typeof msg.mx === "number") p.input.mx = clamp(msg.mx, 0, WORLD.width);
        if (typeof msg.my === "number") p.input.my = clamp(msg.my, 0, WORLD.height);
      }

      // İsim
      if (msg.type === "profile") {
        if (typeof msg.name === "string") {
          p.name = msg.name.slice(0, 24);
        }
      }

      // Saklanma
      if (msg.type === "hide") {
        p.inHideZone = !!msg.active;
        p.isHiddenFromPlayers = !!msg.active;
      }

      // 🔥 EN ÖNEMLİ KISIM (SYNC)
      if (msg.type === "sync") {

        if (typeof msg.level === "number") {
          p.level = clamp(msg.level, 1, 999);
        }

        if (typeof msg.formKey === "string") {
          p.formKey = msg.formKey;
        }

        if (typeof msg.size === "number") {
          p.size = clamp(msg.size, 4, 999);
        }

        if (typeof msg.speed === "number") {
          p.speed = clamp(msg.speed, 0.1, 20);
        }

        if (typeof msg.damage === "number") {
          p.damage = clamp(msg.damage, 1, 9999);
        }

        if (typeof msg.hp === "number") {
          p.hp = clamp(msg.hp, 0, 999999);
        }

        if (typeof msg.maxHp === "number") {
          p.maxHp = clamp(msg.maxHp, 1, 999999);
          p.hp = clamp(p.hp, 0, p.maxHp);
        }

        if (typeof msg.score === "number") {
          p.score = msg.score;
        }

        if (typeof msg.xp === "number") {
          p.xp = msg.xp;
        }

        if (typeof msg.xpNeed === "number") {
          p.xpNeed = msg.xpNeed;
        }

        if (typeof msg.x === "number") {
          p.x = clamp(msg.x, 0, WORLD.width);
        }

        if (typeof msg.y === "number") {
          p.y = clamp(msg.y, 0, WORLD.height);
        }

        if (typeof msg.angle === "number") {
          p.angle = msg.angle;
        }

        if (typeof msg.inHideZone === "boolean") {
          p.inHideZone = msg.inHideZone;
          p.isHiddenFromPlayers = msg.inHideZone;
        }
      }

    } catch (e) {
      console.log("Hata:", e.message);
    }
  });

  ws.on("close", () => {
    players.delete(player.id);
  });

  ws.on("error", () => {});
});

setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log("Server çalışıyor:", PORT);
});
