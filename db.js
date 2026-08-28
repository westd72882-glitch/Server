// ==================== ХРАНИЛИЩЕ ПРОФИЛЕЙ ====================
// Всё, что у игрока есть, живёт ЗДЕСЬ, а не в его телефоне: ник, деньги, рюкзак,
// надетое, убийства, последнее место. Телефон это только показывает и просит изменить.
//
// ПОЧЕМУ. Пока инвентарь считался на клиенте, любой мог дописать себе экзоскелет и
// миллион рублей правкой одного файла - и остальные обязаны были это принять. Сервер,
// который «просто пересылает координаты», ничем от такого не защищает. Раз мир общий,
// имущество в нём тоже общее знание, и держать его должен тот, кто в нём один.
//
// ДВА ХРАНИЛИЩА, ОДИН ИНТЕРФЕЙС:
//   file      - JSON-файл в DATA_DIR. Работает всегда и сразу, ничего не требует.
//               На бесплатном тарифе Render диск эфемерный: файл переживает работу
//               сервиса, но не его перезапуск. Для постоянства нужен либо диск,
//               примонтированный в DATA_DIR, либо второй вариант.
//   supabase  - настоящая база через её REST. Выбран он потому, что это ЕДИНСТВЕННЫЙ
//               способ дотянуться до Postgres, не ставя ни одного npm-пакета: у Node
//               есть встроенный fetch, а у Supabase - HTTP поверх таблицы. Драйвер
//               Postgres потребовал бы сборки, а вся затея этого сервера - "git push и
//               работает".
//
// Выбор автоматический: заданы SUPABASE_URL и SUPABASE_KEY - берётся база, иначе файл.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'players.json');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_KEY || '';
const SUPA_TABLE = process.env.SUPABASE_TABLE || 'players';
const useSupabase = !!(SUPA_URL && SUPA_KEY);

// ==================== ОБЩЕЕ ====================
// Профиль в памяти - зеркало записи в хранилище. Читать из базы на каждый такт нельзя:
// тактов десять в секунду на игрока. Поэтому читаем при входе, пишем при выходе и раз в
// SAVE_EVERY_MS, пока человек играет.
const cache = new Map();     // ник (в нижнем регистре) -> профиль
const dirty = new Set();     // чьи профили изменились с прошлой записи
const SAVE_EVERY_MS = 30000;

function emptyProfile(nick) {
  return {
    nick,                    // как игрок его написал, с регистром
    money: 0,
    kills: 0,
    hp: 100,
    x: 0, y: 0, z: 0,
    inventory: [],           // [{item, n, cond}]
    equipment: [],           // [{slot, item, n, cond}]
    seenAt: 0,
  };
}

function key(nick) { return String(nick || '').trim().toLowerCase(); }

// ==================== ФАЙЛ ====================
function fileLoadAll() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const p of raw.players || []) cache.set(key(p.nick), p);
    console.log(`БД(файл): поднято профилей ${cache.size} из ${FILE}`);
  } catch (e) {
    console.log('БД(файл): не читается - ' + e.message);
  }
}

function fileSaveAll() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const body = JSON.stringify({ players: [...cache.values()] });
    // Пишем во временный файл и переименовываем: перезапуск ровно посреди записи
    // оставил бы обрезанный JSON, и все профили пропали бы разом.
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.log('БД(файл): не пишется - ' + e.message);
  }
}

// ==================== SUPABASE ====================
async function supaFetch(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function supaLoad(nick) {
  const rows = await supaFetch(`${SUPA_TABLE}?nick_key=eq.${encodeURIComponent(key(nick))}&select=*`);
  if (!rows || !rows.length) return null;
  const r = rows[0];
  return {
    nick: r.nick, money: r.money | 0, kills: r.kills | 0, hp: +r.hp || 100,
    x: +r.x || 0, y: +r.y || 0, z: +r.z || 0,
    inventory: r.inventory || [], equipment: r.equipment || [],
    seenAt: r.seen_at || 0,
  };
}

async function supaSave(p) {
  await supaFetch(`${SUPA_TABLE}?on_conflict=nick_key`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      nick_key: key(p.nick), nick: p.nick,
      money: p.money | 0, kills: p.kills | 0, hp: p.hp,
      x: p.x, y: p.y, z: p.z,
      inventory: p.inventory, equipment: p.equipment,
      seen_at: p.seenAt,
    }),
  });
}

// ==================== ПУБЛИЧНОЕ ====================
async function dbInit() {
  if (useSupabase) {
    console.log(`БД: Supabase, таблица ${SUPA_TABLE}`);
    // Проверяем связь сразу: узнать о неправильном ключе в момент первого входа игрока -
    // худшее время из возможных.
    try {
      await supaFetch(`${SUPA_TABLE}?select=nick_key&limit=1`);
      console.log('БД: связь с Supabase есть');
    } catch (e) {
      console.log('БД: Supabase не отвечает - ' + e.message);
      console.log('БД: профили будут жить только в памяти до конца работы сервиса');
    }
  } else {
    console.log(`БД: файл ${FILE}`);
    fileLoadAll();
  }
  setInterval(dbFlush, SAVE_EVERY_MS);
}

// Профиль по нику. Нет такого - заводится новый, пустой. Именно ЗДЕСЬ и решается, что
// значит «зарегистрироваться»: отдельной регистрации нет, первый вход и есть она.
async function dbGet(nick) {
  const k = key(nick);
  if (cache.has(k)) return cache.get(k);
  let p = null;
  if (useSupabase) {
    try { p = await supaLoad(nick); } catch (e) { console.log('БД: чтение - ' + e.message); }
  }
  if (!p) p = emptyProfile(String(nick));
  cache.set(k, p);
  return p;
}

// Профиль занят кем-то, кто сейчас в игре? Проверку «ник уже используется» делает сам
// сервер по списку подключённых - хранилищу про это знать незачем.
function dbTouch(nick) { dirty.add(key(nick)); }

async function dbFlush() {
  if (!dirty.size) return;
  const list = [...dirty];
  dirty.clear();
  if (useSupabase) {
    for (const k of list) {
      const p = cache.get(k);
      if (!p) continue;
      try { await supaSave(p); } catch (e) { console.log('БД: запись - ' + e.message); }
    }
  } else {
    fileSaveAll();
  }
}

// Забыть профиль из памяти, дописав его на диск. Зовётся при выходе игрока: держать в
// памяти всех, кто когда-либо заходил, незачем.
async function dbRelease(nick) {
  dbTouch(nick);
  await dbFlush();
  if (useSupabase) cache.delete(key(nick));
}

module.exports = { dbInit, dbGet, dbTouch, dbFlush, dbRelease, emptyProfile };
