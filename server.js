// ==================== СЕРВЕР A.N.O.D.E ====================
// Один файл, ноль зависимостей, только встроенный http Node.js. Так его можно выложить
// на бесплатный хостинг (Render) одним git push, без npm install и без сборки.
//
// ЧЕМ ОН ВЛАДЕЕТ. Людьми: кто в партии, где он стоит, кто в кого попал, что сказано в
// чат, что лежит на земле. Мир вокруг (бойцы, погода) считает один из подключённых -
// ВЕДУЩИЙ, тот, кто вошёл раньше всех, - а сервер только передаёт его состояние
// остальным. Считать сотню бойцов ещё и здесь значило бы переписать сюда половину игры.
//
// ПОЧЕМУ ОПРОС, А НЕ СОКЕТЫ. Клиент - телефон с libcurl и без библиотеки веб-сокетов.
// Обмен идёт тактами: раз в сотню миллисекунд игра шлёт POST /state со своим состоянием
// и в том же ответе получает чужие. Задержка от этого больше, чем у настоящего игрового
// протокола, и это честная плата за сервер, который поднимается бесплатно.
//
// ==================== НАСТРОЙКА ====================
// Всё - через переменные окружения (в Render это вкладка Environment):
//   SERVER_NAME   имя сервера в списке              (по умолчанию "Сервер A.N.O.D.E")
//   SERVER_DESC   описание: раскрывается по тапу     ("")
//   MAX_PLAYERS   сколько человек пускать            (16)
//   GAME_MAP      какую карту поднять                ("kordon")
//   RULES         правила: число или имена через запятую ("")
//                 имена: no_bots, no_pvp, all_friendly, all_zombies, no_traders,
//                        army_hold, roleplay
//                 пример: RULES=army_hold,roleplay  - служба по РП на захваченной карте
//                 пример: RULES=all_zombies         - режим смерти
//   MASTER_URL    если задан, сервер регистрируется в чужом списке ("")
//   PORT          порт (Render задаёт сам)
'use strict';

const http = require('http');

// ==================== ПРАВИЛА ====================
// Значения обязаны совпадать с GameRuleBit в src/Game/Net/GameRules.h. Расходиться им
// нельзя: одно число едет по сети и разбирается там же битами.
const RULE = {
  no_bots:      1 << 0,
  no_pvp:       1 << 1,
  all_friendly: 1 << 2,
  all_zombies:  1 << 3,
  no_traders:   1 << 4,
  army_hold:    1 << 5,
  roleplay:     1 << 6,
};
const RULE_NAMES_RU = {
  no_bots: 'Без ботов', no_pvp: 'Без PvP', all_friendly: 'Все дружелюбны',
  all_zombies: 'Все зомби', no_traders: 'Без торговцев',
  army_hold: 'Армия: всё захвачено', roleplay: 'Служба по РП',
};

function parseRules(raw) {
  if (!raw) return 0;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && String(asNumber) === String(raw).trim()) return asNumber | 0;
  let mask = 0;
  for (const part of String(raw).split(',')) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    if (RULE[key] === undefined) {
      console.log(`RULES: не знаю правила "${key}" - пропускаю`);
      continue;
    }
    mask |= RULE[key];
  }
  return mask;
}

// Служба по РП - это по определению мир без стрельбы между людьми: караул, который
// расстреливает проходящего, никакой службы не отыграет. Клиент считает так же
// (см. rulesNoPvp в src/Game/Net/GameRules.cpp), и расходиться этим двум местам нельзя:
// клиент бы не слал попадания, а сервер их ждал - или наоборот.
function pvpDisabled(mask) {
  return (mask & RULE.no_pvp) !== 0 || (mask & RULE.roleplay) !== 0;
}

function modeText(mask) {
  const on = Object.keys(RULE).filter(k => (mask & RULE[k]) !== 0).map(k => RULE_NAMES_RU[k]);
  return on.length ? on.join(', ') : 'обычный';
}

const CFG = {
  name: process.env.SERVER_NAME || 'Сервер A.N.O.D.E',
  desc: process.env.SERVER_DESC || '',
  max: parseInt(process.env.MAX_PLAYERS || '16', 10),
  map: process.env.GAME_MAP || 'kordon',
  rules: parseRules(process.env.RULES),
  masterUrl: (process.env.MASTER_URL || '').replace(/\/+$/, ''),
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  port: parseInt(process.env.PORT || '10000', 10),
};

// Протокол: клиент присылает свою версию, и разошедшиеся версии пускать нельзя - иначе
// поля молча разъедутся и превратятся в чужие координаты.
const PROTO = 1;

// Зерно состава мира. Одно на весь запуск сервера: все, кто вошёл, обязаны видеть одних и
// тех же бойцов на одних и тех же местах.
const WORLD_SEED = (Math.floor(Math.random() * 0xfffffff) + 1) >>> 0;

// ==================== СОСТОЯНИЕ ====================
const players = new Map();     // token -> игрок
let nextId = 1;

const PLAYER_TIMEOUT_MS = 10000;   // молчит дольше - значит, ушёл
const DROP_LIFETIME_MS = 10 * 60 * 1000;
const NPC_LIFETIME_MS = 5000;      // состояние бойца от ведущего живёт недолго

const npcs = new Map();        // индекс бойца -> его состояние от ведущего
const drops = new Map();       // netId -> вещь на земле
const peersRegistry = new Map(); // url -> чужой сервер, зарегистрировавшийся у нас

function now() { return Date.now(); }

function alivePlayers() {
  const t = now();
  const out = [];
  for (const [token, p] of players) {
    if (t - p.lastSeen > PLAYER_TIMEOUT_MS) { players.delete(token); continue; }
    out.push(p);
  }
  return out;
}

// Ведущий - тот, кто вошёл раньше всех: у него наименьший номер. Правило то же, что было
// в прежней версии игры, и выбрано оно за то, что не требует переговоров.
function leaderId() {
  let best = -1;
  for (const p of alivePlayers()) if (best < 0 || p.id < best) best = p.id;
  return best;
}

function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function selfEntry() {
  return {
    name: CFG.name,
    url: CFG.publicUrl,
    desc: CFG.desc,
    mode: modeText(CFG.rules),
    map: CFG.map,
    online: alivePlayers().length,
    max: CFG.max,
    rules: CFG.rules,
  };
}

// ==================== HTTP ====================
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      // Тело такта - пара килобайт. Всё, что заметно больше, - либо ошибка, либо
      // попытка занять память сервера; такое проще отбросить, чем разбирать.
      if (data.length > 65536) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// ==================== РУЧКИ ====================
function handleServers(res) {
  const list = [];
  if (CFG.publicUrl) list.push(selfEntry());
  const t = now();
  for (const [url, entry] of peersRegistry) {
    // Чужой сервер, не подтверждавший себя пять минут, из списка убирается: показывать
    // мёртвый адрес хуже, чем не показывать ничего.
    if (t - entry.seen > 5 * 60 * 1000) { peersRegistry.delete(url); continue; }
    list.push(entry.card);
  }
  sendJson(res, 200, { servers: list });
}

async function handleRegister(req, res) {
  const body = await readBody(req);
  if (!body || !body.url) return sendJson(res, 400, { ok: false, error: 'нет url' });
  const url = String(body.url).replace(/\/+$/, '');
  peersRegistry.set(url, {
    seen: now(),
    card: {
      name: String(body.name || 'Сервер'), url,
      desc: String(body.desc || ''), mode: String(body.mode || ''),
      map: String(body.map || 'kordon'),
      online: body.online | 0, max: body.max | 0, rules: body.rules | 0,
    },
  });
  sendJson(res, 200, { ok: true });
}

async function handleJoin(req, res) {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'нечитаемый запрос' });
  if ((body.proto | 0) !== PROTO) {
    return sendJson(res, 200, { ok: false, error: 'Другая версия игры' });
  }
  if (alivePlayers().length >= CFG.max) {
    return sendJson(res, 200, { ok: false, error: 'Сервер заполнен' });
  }

  const token = makeToken();
  const p = {
    id: nextId++, token,
    name: String(body.name || 'Сталкер').slice(0, 18),
    x: 0, y: 0, z: 0, yaw: 0, move: 0, hp: 100, flags: 0, gun: -1,
    lastSeen: now(),
    chat: [], pays: [], npcHits: [],
  };
  players.set(token, p);
  broadcastChat(`${p.name} вошёл в игру`, p.id);
  console.log(`join: ${p.name} (#${p.id}), онлайн ${alivePlayers().length}`);

  sendJson(res, 200, {
    ok: true, id: p.id, token, leader: leaderId() === p.id,
    rules: CFG.rules, seed: WORLD_SEED, name: CFG.name, map: CFG.map,
  });
}

function broadcastChat(line, exceptId) {
  for (const p of alivePlayers()) {
    if (p.id === exceptId) continue;
    p.chat.push(line);
    if (p.chat.length > 20) p.chat.shift();   // не копим бесконечно у молчащего
  }
}

async function handleState(req, res) {
  const body = await readBody(req);
  if (!body || !body.token) return sendJson(res, 400, { ok: false, error: 'нет токена' });
  const me = players.get(body.token);
  if (!me) return sendJson(res, 401, { ok: false, error: 'Вы больше не в партии' });

  me.lastSeen = now();
  me.x = +body.x || 0; me.y = +body.y || 0; me.z = +body.z || 0;
  me.yaw = +body.yaw || 0;
  me.move = +body.move || 0;
  me.flags = body.flags | 0;
  me.gun = (body.gun === undefined) ? -1 : (body.gun | 0);
  // Здоровье клиент присылает своё, но авторитет - у сервера: чужие попадания уже могли
  // его уменьшить, и принимать более высокую цифру от самого игрока нельзя, иначе
  // достаточно не признавать урон, чтобы стать бессмертным.
  const claimed = +body.hp;
  if (Number.isFinite(claimed) && claimed < me.hp) me.hp = claimed;

  const isLeader = leaderId() === me.id;

  // ---- Попадания по людям ----
  if (Array.isArray(body.hits) && !pvpDisabled(CFG.rules)) {
    for (const h of body.hits) {
      const target = alivePlayers().find(p => p.id === (h.id | 0));
      if (!target || target.id === me.id) continue;
      const dmg = Math.max(0, Math.min(200, +h.dmg || 0));
      target.hp = Math.max(0, target.hp - dmg);
    }
  }

  // ---- Чат ----
  if (typeof body.chat === 'string' && body.chat.trim()) {
    broadcastChat(`${me.name}: ${body.chat.slice(0, 100)}`, me.id);
  }

  // ---- Переводы денег ----
  if (Array.isArray(body.pays)) {
    for (const pay of body.pays) {
      const sum = Math.max(0, pay.sum | 0);
      if (!sum) continue;
      const target = alivePlayers().find(p => p.name === String(pay.to));
      if (!target) { me.chat.push(`Игрок ${pay.to} не найден`); continue; }
      target.pays.push({ from: me.name, sum });
    }
  }

  // ---- Вещи на земле ----
  if (Array.isArray(body.drops)) {
    for (const d of body.drops) {
      const nid = d.nid >>> 0;
      if (!nid) continue;
      drops.set(nid, { nid, item: d.item | 0, n: d.n | 0, x: +d.x, y: +d.y, z: +d.z,
                       t: now(), from: me.id });
    }
  }
  if (Array.isArray(body.taken)) {
    for (const nid of body.taken) {
      const key = nid >>> 0;
      if (drops.delete(key)) {
        for (const p of alivePlayers()) if (p.id !== me.id) (p.taken ||= []).push(key);
      }
    }
  }

  // ---- Бойцы ----
  if (isLeader && Array.isArray(body.npcs)) {
    const t = now();
    for (const n of body.npcs) npcs.set(n.i | 0, { ...n, t });
  }
  if (!isLeader && Array.isArray(body.npchits)) {
    // Попадание ведомого по бойцу решает ведущий: он их считает. Складываем в очередь -
    // заберёт следующим своим тактом.
    const leader = alivePlayers().find(p => p.id === leaderId());
    if (leader) for (const h of body.npchits) {
      leader.npcHits.push({ i: h.i | 0, dmg: +h.dmg || 0, from: me.id });
    }
  }

  // ---- Ответ ----
  const t = now();
  const list = alivePlayers();
  const out = {
    ok: true,
    leader: isLeader,
    rules: CFG.rules,
    hp: me.hp,
    online: list.length,
    players: list.filter(p => p.id !== me.id).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, move: p.move, hp: p.hp, flags: p.flags, gun: p.gun,
    })),
  };

  if (me.chat.length) { out.chat = me.chat; me.chat = []; }
  if (me.pays.length) { out.pays = me.pays; me.pays = []; }
  if (isLeader && me.npcHits.length) { out.npchits = me.npcHits; me.npcHits = []; }
  if (me.taken && me.taken.length) { out.taken = me.taken; me.taken = []; }

  // Вещи на земле шлём только те, которых этот игрок ещё не видел: полный список каждый
  // такт - это лишние килобайты за то, что и так уже лежит у него в мире.
  {
    const since = me.dropsSince || 0;
    const fresh = [];
    for (const [nid, d] of drops) {
      if (t - d.t > DROP_LIFETIME_MS) { drops.delete(nid); continue; }
      if (d.t > since && d.from !== me.id) fresh.push(d);
    }
    me.dropsSince = t;
    if (fresh.length) out.drops = fresh;
  }

  // Бойцы - только ведомым и только те, что рядом с этим игроком: весь ростер в JSON
  // превратился бы в десятки килобайт на каждого за такт.
  if (!isLeader) {
    const near = [];
    for (const [i, n] of npcs) {
      if (t - n.t > NPC_LIFETIME_MS) { npcs.delete(i); continue; }
      const dx = n.x - me.x, dz = n.z - me.z;
      if (dx * dx + dz * dz > 90 * 90) continue;
      near.push({ i: n.i, x: n.x, y: n.y, z: n.z, r: n.r, m: n.m, h: n.h, f: n.f });
      if (near.length >= 40) break;
    }
    if (near.length) out.npcs = near;
  }

  sendJson(res, 200, out);
}

async function handleLeave(req, res) {
  const body = await readBody(req);
  const p = body && body.token ? players.get(body.token) : null;
  if (p) {
    players.delete(body.token);
    broadcastChat(`${p.name} вышел`, p.id);
    console.log(`leave: ${p.name} (#${p.id}), онлайн ${alivePlayers().length}`);
  }
  sendJson(res, 200, { ok: true });
}

// ==================== МАРШРУТИЗАЦИЯ ====================
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    return sendJson(res, 200, { ok: true, name: CFG.name, online: alivePlayers().length });
  }
  if (req.method === 'GET' && url === '/servers') return handleServers(res);
  if (req.method === 'GET' && url === '/info') return sendJson(res, 200, selfEntry());
  if (req.method === 'POST' && url === '/register') return handleRegister(req, res);
  if (req.method === 'POST' && url === '/join') return handleJoin(req, res);
  if (req.method === 'POST' && url === '/state') return handleState(req, res);
  if (req.method === 'POST' && url === '/leave') return handleLeave(req, res);
  sendJson(res, 404, { ok: false, error: 'нет такой ручки' });
});

// ==================== РЕГИСТРАЦИЯ В ЧУЖОМ СПИСКЕ ====================
// Если сервер не единственный, он раз в минуту сообщает о себе мастеру. Мастером может
// быть такой же сервер - тот, чей адрес игроки вбили в игре.
function registerAtMaster() {
  if (!CFG.masterUrl || !CFG.publicUrl) return;
  const payload = JSON.stringify(selfEntry());
  const target = new URL(CFG.masterUrl + '/register');
  const mod = target.protocol === 'https:' ? require('https') : http;
  const req = mod.request({
    hostname: target.hostname, port: target.port,
    path: target.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 8000,
  }, (r) => { r.resume(); });
  req.on('error', (e) => console.log('register: ' + e.message));
  req.on('timeout', () => req.destroy());
  req.end(payload);
}

server.listen(CFG.port, () => {
  console.log(`A.N.O.D.E: «${CFG.name}» слушает порт ${CFG.port}`);
  console.log(`  карта: ${CFG.map}, мест: ${CFG.max}, режим: ${modeText(CFG.rules)} (rules=${CFG.rules})`);
  console.log(`  адрес в списке: ${CFG.publicUrl || '(PUBLIC_URL не задан - в список себя не отдам)'}`);
  if (CFG.masterUrl) {
    registerAtMaster();
    setInterval(registerAtMaster, 60000);
  }
});
