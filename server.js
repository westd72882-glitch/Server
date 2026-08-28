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
//   SUZHET        сюжет в партии: enable / disable        (disable)
//   MIN_NICK      минимальная длина ника                 (5)
//   MASTER_URL    если задан, сервер регистрируется в чужом списке ("")
//   PORT          порт (Render задаёт сам)
//
// ==================== ХРАНИЛИЩЕ ====================
//   DATA_DIR      куда класть players.json                (./data)
//   SUPABASE_URL  адрес проекта Supabase - тогда профили лежат в настоящей базе ("")
//   SUPABASE_KEY  сервисный ключ ("")
//   SUPABASE_TABLE имя таблицы                            (players)
// Подробности и схема таблицы - в db.js и README.
'use strict';

const http = require('http');
const { dbInit, dbGet, dbTouch, dbFlush, dbRelease } = require('./db');
const { buildRoster, makeRng } = require('./world');
const { aiTick, initNpc, npcDie, TICK } = require('./ai');

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
  // Сюжет в сетевой партии. По умолчанию его НЕТ: цепочка заданий рассчитана на одного,
  // и десять человек, берущих у Монгола одно и то же задание, - очередь, а не игра.
  // Владелец сервера вправе решить иначе - тогда на карте появляются торговец,
  // квестодатели и вся цепочка (SUZHET=enable).
  story:        1 << 7,
};
const RULE_NAMES_RU = {
  no_bots: 'Без ботов', no_pvp: 'Без PvP', all_friendly: 'Все дружелюбны',
  all_zombies: 'Все зомби', no_traders: 'Без торговцев',
  army_hold: 'Армия: всё захвачено', roleplay: 'Служба по РП',
  story: 'Сюжет включён',
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
  rules: parseRules(process.env.RULES) |
         (/^(1|on|yes|true|enable|enabled)$/i.test(process.env.SUZHET || '') ? RULE.story : 0),
  minNick: Math.max(1, parseInt(process.env.MIN_NICK || '5', 10)),
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

// ==================== БОЙЦЫ ====================
// Живут ЗДЕСЬ и считаются здесь (см. ai.js). Ведущего-клиента больше нет: раньше мир
// водил один из телефонов, у него боты шли без задержки, а у остальных с опозданием, и
// его выход перекидывал всю карту на другого. Теперь мир один и он серверный.
let npcs = [];                 // состояния бойцов, индекс = номер в ростере
let roster = [];               // описание состава: его получает каждый входящий
const npcRnd = makeRng(0);     // общий генератор для ИИ: разброс, хабар, маршруты
let worldClock = 0;            // секунды с запуска мира - по ним живут таймеры ИИ
const drops = new Map();       // netId -> вещь на земле
const peersRegistry = new Map(); // url -> чужой сервер, зарегистрировавшийся у нас

function now() { return Date.now(); }

function alivePlayers() {
  const t = now();
  const out = [];
  for (const [token, p] of players) {
    if (t - p.lastSeen > PLAYER_TIMEOUT_MS) {
      players.delete(token);
      // Связь оборвалась, а не человек нажал «выйти»: профиль надо сохранить тем же
      // порядком, иначе потерянная сеть означала бы потерянный рюкзак.
      if (p.name) { dbTouch(p.name); dbFlush().catch(() => {}); }
      console.log(`timeout: ${p.name} (#${p.id})`);
      continue;
    }
    out.push(p);
  }
  return out;
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

// Ник - это ИМЯ УЧЁТНОЙ ЗАПИСИ, а не подпись под сообщением: к нему привязаны деньги,
// рюкзак и всё нажитое. Отсюда два требования.
//
// НЕ КОРОЧЕ ПЯТИ СИМВОЛОВ - чтобы «ы» и «12» не растащили нормальные имена в первый же
// день, и чтобы ник было видно с трёх метров на карточке трупа.
//
// НЕ СОВПАДАЕТ С ЧУЖИМ, КТО СЕЙЧАС В ИГРЕ - иначе двое делят один профиль, и чей-то
// рюкзак перезапишется чужим. Сравнение регистронезависимое: «Вова» и «вова» для
// человека одно и то же имя, и позволить войти обоим значило бы обмануть его.
function nickProblem(raw) {
  const name = String(raw || '').trim();
  // Длину считаем в СИМВОЛАХ, а не в байтах: кириллица в UTF-8 двухбайтовая, и по
  // байтам «Вова» оказалось бы длиной восемь.
  const len = [...name].length;
  if (len < CFG.minNick) return `Имя должно быть от ${CFG.minNick} символов`;
  if (len > 18) return 'Имя длиннее 18 символов';
  if (/[\s]/.test(name)) return 'В имени не должно быть пробелов';
  for (const p of alivePlayers()) {
    if (p.name.toLowerCase() === name.toLowerCase()) return 'Это имя уже занято';
  }
  return null;
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
  const name = String(body.name || '').trim();
  const bad = nickProblem(name);
  if (bad) return sendJson(res, 200, { ok: false, error: bad });

  // ПРОФИЛЬ ПОДНИМАЕТСЯ ИЗ ХРАНИЛИЩА. Всё, что у человека было в прошлый заход, - его
  // деньги, рюкзак, надетое - лежит на сервере под этим ником и возвращается ему.
  const prof = await dbGet(name);
  prof.nick = name;             // регистр берём из последнего входа
  prof.seenAt = now();

  const token = makeToken();
  const p = {
    id: nextId++, token, name,
    prof,
    x: prof.x, y: prof.y, z: prof.z, yaw: 0, move: 0,
    hp: prof.hp > 0 ? prof.hp : 100,
    flags: 0, gun: -1,
    lastSeen: now(),
    chat: [], pays: [],
  };
  players.set(token, p);
  dbTouch(name);
  broadcastChat(`${p.name} вошёл в игру`, p.id);
  console.log(`join: ${p.name} (#${p.id}), онлайн ${alivePlayers().length}, ` +
              `денег ${prof.money}, вещей ${prof.inventory.length}`);

  sendJson(res, 200, {
    ok: true, id: p.id, token,
    rules: CFG.rules, seed: WORLD_SEED, name: CFG.name, map: CFG.map,
    // СОСТАВ МИРА ЦЕЛИКОМ. Клиент строит по нему свой ростер и ничего не разыгрывает:
    // общее зерно требовало бы, чтобы обе стороны считали одним генератором, и любая
    // правка таблицы отрядов молча расходилась бы с сервером.
    // Клиенту нужно только то, по чему он строит бойца: номер, имя, сторона, модель,
    // ствол, роль и где он стоит. Маршруты, отряды и таймеры возрождения - дело сервера,
    // и возить их по сети незачем.
    roster: roster.map(r => ({
      i: r.i, name: r.name, f: r.f, model: r.model, gun: r.gun,
      role: r.role, st: r.stationary ? 1 : 0,
      x: +r.x.toFixed(2), z: +r.z.toFixed(2),
    })),
    // Имущество отдаём ЦЕЛИКОМ и только здесь: в такте оно не меняется настолько часто,
    // чтобы гонять его десять раз в секунду.
    profile: {
      money: prof.money, kills: prof.kills, hp: p.hp,
      x: prof.x, y: prof.y, z: prof.z,
      inventory: prof.inventory, equipment: prof.equipment,
      fresh: prof.seenAt === 0 || (!prof.inventory.length && !prof.equipment.length),
    },
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

  // ---- ИМУЩЕСТВО ----
  // Рюкзак, надетое и деньги живут в профиле на сервере. Клиент присылает их, когда они
  // у него изменились (он ставит "inv":1), а не каждый такт: содержимое рюкзака меняется
  // раз в минуту, а тактов десять в секунду.
  //
  // Сервер здесь ДОВЕРЯЕТ клиенту содержимое: разбирать, законно ли у человека появился
  // экзоскелет, значило бы перенести на сервер весь подбор лута, торговлю и крафт - то
  // есть всю игру. Это осознанная граница: сервер отвечает за то, чтобы имущество не
  // терялось и не путалось между людьми, а не за то, чтобы никто не жульничал.
  if (body.inv) {
    if (Array.isArray(body.inventory)) me.prof.inventory = body.inventory.slice(0, 64);
    if (Array.isArray(body.equipment)) me.prof.equipment = body.equipment.slice(0, 8);
    if (Number.isFinite(+body.money)) me.prof.money = Math.max(0, +body.money | 0);
    if (Number.isFinite(+body.kills)) me.prof.kills = Math.max(0, +body.kills | 0);
    dbTouch(me.name);
  }
  // Место и здоровье пишем в профиль всегда: по ним человек и вернётся туда, где вышел.
  me.prof.x = me.x; me.prof.y = me.y; me.prof.z = me.z;
  me.prof.hp = me.hp;
  me.prof.seenAt = now();

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
      const target = alivePlayers().find(
        p => p.name.toLowerCase() === String(pay.to).trim().toLowerCase());
      if (!target) { me.chat.push(`Игрок ${pay.to} не найден`); continue; }
      // Деньги переезжают В ПРОФИЛЯХ, а не только в чужом кошельке на экране: иначе
      // перевод пропадал бы при следующей записи профиля отправителя.
      if (me.prof.money < sum) { me.chat.push('Столько денег нет'); continue; }
      me.prof.money -= sum;
      target.prof.money += sum;
      dbTouch(me.name); dbTouch(target.name);
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
  // ---- Попадания по бойцам ----
  // Решает СЕРВЕР, и только он: раньше это письмо шло ведущему-клиенту, и убитым боец
  // считался только у него. Здоровье бойца - такое же общее знание, как и здоровье
  // человека, и хранить его в чужом телефоне значило бы спорить о том, кто жив.
  if (Array.isArray(body.npchits)) {
    for (const h of body.npchits) {
      const n = npcs[h.i | 0];
      if (!n || !n.alive) continue;
      const dmg = Math.max(0, Math.min(500, +h.dmg || 0));
      n.hp -= dmg;
      n.lastHitBy = me.id;
      // Валим НА МЕСТЕ, а не ждём такта ИИ. Между двумя тактами помещается сколько
      // угодно запросов, и мёртвый боец успевал принять ещё пять очередей - а стрелявший
      // всё это время видел живого.
      if (n.hp <= 0) { npcKill(n, me); me.prof.kills = (me.prof.kills | 0) + 1; dbTouch(me.name); }
    }
  }

  // ---- Ответ ----
  const t = now();
  const list = alivePlayers();
  const out = {
    ok: true,
    rules: CFG.rules,
    hp: me.hp,
    // Деньги - слово сервера: их меняют переводы от других людей, и клиент обязан
    // услышать об этом, а не только о своих тратах.
    money: me.prof.money,
    online: list.length,
    players: list.filter(p => p.id !== me.id).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, move: p.move, hp: p.hp, flags: p.flags, gun: p.gun,
    })),
  };

  if (me.chat.length) { out.chat = me.chat; me.chat = []; }
  if (me.pays.length) { out.pays = me.pays; me.pays = []; }
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

  // ---- Бойцы ----
  // Отдаём тех, кто рядом с ЭТИМ игроком: весь ростер в JSON превратился бы в десятки
  // килобайт на каждого за такт. Сортируем по дистанции, а не берём первых попавшихся:
  // при упоре в предел ближние важнее - именно их человек видит.
  //
  // Y не шлём вовсе: высоту земли клиент считает сам той же функцией рельефа, что и в
  // одиночной игре. Она чистая - от x и z, - поэтому у всех совпадает до последнего бита,
  // а в эфире это четверть объёма записи о бойце.
  {
    const near = [];
    for (const n of npcs) {
      if (!n.alive && worldClock > n.corpseAt) continue;   // тело уже ушло в землю
      const dx = n.x - me.x, dz = n.z - me.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 140 * 140) continue;
      near.push({ d2, n });
    }
    near.sort((a, b) => a.d2 - b.d2);
    const outNpcs = [];
    for (const { n } of near) {
      const e = {
        i: n.i, x: +n.x.toFixed(2), z: +n.z.toFixed(2),
        r: +n.rotY.toFixed(2), m: n.move,
        h: Math.round(n.hp),
        f: (n.firing ? 1 : 0) | (n.alive ? 2 : 0),
      };
      // Хабар отдаём только по мёртвым и только тому, кто ещё его не получал: он весит
      // больше, чем всё остальное про бойца вместе взятое.
      if (n.loot && !n.alive) {
        me.lootSent ||= new Set();
        if (!me.lootSent.has(n.i)) { e.loot = n.loot; me.lootSent.add(n.i); }
      }
      // Ожил - забываем, что хабар был отдан: в следующий раз он будет другой.
      if (n.alive && me.lootSent) me.lootSent.delete(n.i);
      outNpcs.push(e);
      if (outNpcs.length >= 64) break;
    }
    if (outNpcs.length) out.npcs = outNpcs;
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
    // Дописываем профиль НЕМЕДЛЕННО: следующая плановая запись через полминуты, а
    // человек, вышедший и тут же вошедший обратно, за эти полминуты потерял бы всё
    // нажитое за последний заход.
    await dbRelease(p.name);
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

// ==================== МИР ЗАПУСКАЕТСЯ ЗДЕСЬ ====================
// Убит человеком. Хабар и таймеры - общим путём смерти (ai.js), чтобы они не разошлись с
// тем, что происходит, когда бойца добивают другие боты.
function npcKill(n, byPlayer) {
  npcDie(n, npcRnd, worldClock);
  console.log(`${byPlayer.name} убил бойца #${n.i} (${n.name})`);
}

function worldInit() {
  roster = buildRoster(WORLD_SEED, CFG.rules);
  npcs = roster.map(initNpc);
  console.log(`Мир: собрано бойцов ${npcs.length} (зерно ${WORLD_SEED})`);
}

// ==================== ТАКТ ИИ ====================
// Идёт ВСЕГДА, а не только когда кто-то в игре: мир должен жить своей жизнью, чтобы
// вошедший попадал в идущий бой, а не в застывшую картинку. Когда сервер пуст, это
// десять проходов в секунду по сотне записей - меньше, чем стоит один HTTP-запрос.
function worldTick() {
  worldClock += TICK;
  // Игроки для ИИ: только то, что ему нужно, плюс способ нанести урон. Отдавать сюда сам
  // объект игрока значило бы позволить ИИ трогать его токен и профиль.
  const people = alivePlayers().map(p => ({
    id: p.id, x: p.x, z: p.z, alive: p.hp > 0,
    // Правило «без PvP» - про стрельбу МЕЖДУ ЛЮДЬМИ; боты стреляют по-прежнему.
    // Мир без ботов задаётся отдельным правилом, и путать эти два незачем.
    damage: (d) => {
      p.hp = Math.max(0, p.hp - d);
      p.prof.hp = p.hp;
    },
  }));
  aiTick(npcs, people, CFG.rules, npcRnd, worldClock);
}

worldInit();
setInterval(worldTick, Math.round(TICK * 1000));

dbInit().catch(e => console.log('БД: ' + e.message));

server.listen(CFG.port, () => {
  console.log(`A.N.O.D.E: «${CFG.name}» слушает порт ${CFG.port}`);
  console.log(`  карта: ${CFG.map}, мест: ${CFG.max}, режим: ${modeText(CFG.rules)} (rules=${CFG.rules})`);
  console.log(`  сюжет: ${(CFG.rules & RULE.story) ? 'включён' : 'выключен'}, ник от ${CFG.minNick} символов`);
  console.log(`  бойцов в мире: ${npcs.length} - считает СЕРВЕР, ведущего-клиента нет`);
  console.log(`  адрес в списке: ${CFG.publicUrl || '(PUBLIC_URL не задан - в список себя не отдам)'}`);
  if (CFG.masterUrl) {
    registerAtMaster();
    setInterval(registerAtMaster, 60000);
  }
});
