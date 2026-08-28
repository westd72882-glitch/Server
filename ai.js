// ==================== ИИ БОЙЦОВ НА СЕРВЕРЕ ====================
// Боты живут ЗДЕСЬ. Раньше их считал один из телефонов - тот, кого сервер назначил
// ведущим, - и у него они шли без задержки, а у остальных с опозданием; выход ведущего
// перекидывал весь мир на другого. Теперь их водит сервер, и для всех, включая
// «первого», мир одинаков.
//
// ЧТО СЕРВЕР СЧИТАЕТ, А ЧТО ОСТАВЛЯЕТ КЛИЕНТУ:
//   сервер  - кто где стоит, куда идёт, в кого целится, кто кого убил, что осталось в теле;
//   клиент  - высота земли под ногами, выталкивание из стен, поза, анимация, звук.
// Разделение не произвольное: высота и выталкивание - ЧИСТЫЕ ФУНКЦИИ от координат
// (terrainHeight и kordonResolveCollisions), одинаковые у всех до последнего бита.
// Считать их ещё и здесь значило бы портировать на сервер рельеф и всю планировку
// Кордона - тысячи строк ради результата, который и так совпадает.
//
// ЧТО ИЗ-ЗА ЭТОГО УПРОЩЕНО. Сервер не знает про стены, поэтому его боты ходят по прямой к
// цели, а от построек их отводят «запретные круги» вокруг ориентиров с постройками
// (OBSTACLES ниже) - грубее, чем ведение стены на клиенте, но в одну сторону у всех.
// Клиентское выталкивание довершает дело: в стену боец не войдёт ни у кого.
'use strict';

const { FACTION, LANDMARK_XZ, LM, makeRng } = require('./world');

const TICK = 0.1;                 // шаг ИИ в секундах: тот же такт, что и обмен
const SIGHT = 45;                 // дальность обнаружения
const SHOOT_RANGE = 38;
const MELEE_RANGE = 1.75;
const MELEE_DAMAGE = 14;
const MELEE_INTERVAL = 1.35;
const RESPAWN_MIN = 60, RESPAWN_MAX = 90;
const ZOMBIE_RESPAWN_MIN = 25, ZOMBIE_RESPAWN_MAX = 45;
const CORPSE_TOTAL = 180;         // сколько тело лежит, прежде чем уйти в землю
const WORLD_BOUND = 145;

// ==================== ЗАПРЕТНЫЕ КРУГИ ====================
// Грубая карта того, куда боту заходить незачем: пятна построек. Радиусы с запасом -
// задача не «пройти впритирку», а «не упереться носом в стену и не встать там навсегда».
const OBSTACLES = [
  { x: LANDMARK_XZ[LM.SIDOROVICH][0], z: LANDMARK_XZ[LM.SIDOROVICH][1], r: 7 },  // бугор бункера
  { x: LANDMARK_XZ[LM.SCIENCE][0],    z: LANDMARK_XZ[LM.SCIENCE][1],    r: 6 },
  { x: LANDMARK_XZ[LM.GRANARY][0],    z: LANDMARK_XZ[LM.GRANARY][1],    r: 7 },
  { x: LANDMARK_XZ[LM.ATP][0],        z: LANDMARK_XZ[LM.ATP][1],        r: 8 },
  { x: LANDMARK_XZ[LM.PIG_FARM][0],   z: LANDMARK_XZ[LM.PIG_FARM][1],   r: 7 },
];

// ==================== ОТНОШЕНИЯ ====================
// Копия factionRelation из Game/AI/Faction.cpp. Расходиться нельзя: клиент по этим же
// правилам красит метки на карте, и «враг у сервера, свой у клиента» - худший случай.
const RULE_ALL_FRIENDLY = 1 << 2, RULE_ROLEPLAY = 1 << 6;
function hostile(a, b, rules) {
  if ((rules & RULE_ALL_FRIENDLY) || (rules & RULE_ROLEPLAY)) return false;
  if (a === b) return false;
  if (a === FACTION.ZOMBIED || b === FACTION.ZOMBIED) return true;
  if (a === FACTION.ECOLOGISTS || b === FACTION.ECOLOGISTS) return false;
  return true;   // военные против наёмников
}
// Игрок числится военным - тем же, чем он и в одиночной игре.
const PLAYER_FACTION = FACTION.MILITARY;

// ==================== ХАБАР ====================
// Копия того, что раньше разыгрывал клиент (NPC.cpp): ствол редко, патроны часто, броня
// по стороне. Идентификаторы предметов - из Game/Items/Items.h.
// НОМЕРА - ИЗ enum ItemId В src/Game/Player/Player.h, буква в букву. Раньше они были
// переписаны по памяти и разъехались с игрой на две-три позиции: сервер клал в тело
// «патроны 3», игра читала это как КПК, а вместо хлеба выпадал бронекостюм ПСЗ. Ошибка
// такого рода не падает и не пишет в лог - она просто выдаёт не тот предмет.
const ITEM = {
  MEDKIT: 2, ARMOR: 4, AMMO_545: 5, AMMO_9x18: 6,
  SUIT_JACKET: 7, SUIT_PSZ: 8, SUIT_BERILL: 9, SUIT_ECO: 13,
  WEAPON_BASE: 1000,
};
function ammoFor(gun) { return gun === 1 ? ITEM.AMMO_9x18 : ITEM.AMMO_545; }

function rollLoot(n, rnd) {
  const loot = [];
  const push = (item, cnt, cond) => {
    if (loot.length < 8) loot.push({ item, n: cnt, cond: cond === undefined ? 1 : cond });
  };
  if (n.gun >= 0 && rnd() < 0.10) {
    push(ITEM.WEAPON_BASE + n.gun, 1, 0.35 + rnd() * 0.5);
    push(ammoFor(n.gun), 6 + Math.floor(rnd() * 10));
  } else if (n.gun >= 0 && rnd() < 0.70) {
    push(ammoFor(n.gun), 3 + Math.floor(rnd() * 8));
  }
  // Броня: то, что было надето, то и снимается.
  {
    let suit = 0, lo = 0.45, hi = 0.85;
    const roll = rnd();
    if (n.f === FACTION.ZOMBIED) {
      if (roll < 0.35) suit = ITEM.SUIT_JACKET;
      lo = 0.08; hi = 0.30;                     // на них живого места нет
    } else if (n.f === FACTION.MILITARY) {
      if (roll < 0.05) suit = ITEM.SUIT_BERILL;
      else if (roll < 0.16) suit = ITEM.ARMOR;
      else if (roll < 0.26) suit = ITEM.SUIT_JACKET;
    } else if (n.f === FACTION.MERCS) {
      if (roll < 0.04) suit = ITEM.SUIT_PSZ;
      else if (roll < 0.15) suit = ITEM.ARMOR;
      else if (roll < 0.25) suit = ITEM.SUIT_JACKET;
    } else if (roll < 0.10) suit = ITEM.SUIT_ECO;
    if (suit) push(suit, 1, lo + rnd() * (hi - lo));
  }
  // Аптечка - единственная расходная мелочь, которая в игре есть. Бинтов, хлеба и водки в
  // таблице предметов нет вовсе, и класть их в тело значило бы класть туда чужие номера.
  if (rnd() < 0.20) push(ITEM.MEDKIT, 1);
  return loot;
}

// ==================== СОСТОЯНИЕ БОЙЦА ====================
// Поля короткие: они же уходят в эфир (см. packNpc в server.js), и каждая лишняя буква
// умножается на число ботов и на десять тактов в секунду.
function initNpc(def) {
  return {
    ...def,
    hp: def.f === FACTION.ZOMBIED ? 95 : (def.f === FACTION.MERCS ? 60 : 45),
    maxHp: def.f === FACTION.ZOMBIED ? 95 : (def.f === FACTION.MERCS ? 60 : 45),
    alive: true,
    rotY: 0,
    move: 0,          // 0 стоит, 1 идёт - клиент по этому анимирует шаг
    firing: false,
    target: null,     // {kind:'player'|'npc', id}
    fireCd: 0,
    meleeCd: 0,
    respawnAt: 0,
    corpseAt: 0,
    loot: null,
    wpX: def.x, wpZ: def.z,   // текущая путевая точка
    wpCd: 0,
    speed: (def.f === FACTION.ZOMBIED ? 0.6 : 1.05) + Math.random() * 0.25,
  };
}

// ==================== ШАГ ====================
// npcs   - массив состояний
// people - [{id, x, z, hp, alive, damage(n)}] - живые игроки
// rules  - маска правил
function aiTick(npcs, people, rules, rnd, clock) {
  for (const n of npcs) {
    // ---- Смерть и возрождение ----
    if (!n.alive) {
      if (n.respawnAt > 0 && clock >= n.respawnAt && n.respawns) {
        n.alive = true;
        n.hp = n.maxHp;
        n.x = n.home.x; n.z = n.home.z;
        n.wpX = n.home.x; n.wpZ = n.home.z;
        n.target = null; n.firing = false; n.move = 0;
        n.loot = null;
        n.respawnAt = 0; n.corpseAt = 0;
      }
      continue;
    }
    if (n.stationary) { n.move = 0; n.firing = false; continue; }

    // ---- Кого видим ----
    n.fireCd -= TICK;
    n.meleeCd -= TICK;
    let best = null, bestD2 = SIGHT * SIGHT;
    for (const p of people) {
      if (!p.alive) continue;
      if (!hostile(n.f, PLAYER_FACTION, rules)) break;   // с людьми не воюем вовсе
      const dx = p.x - n.x, dz = p.z - n.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = { kind: 'player', ref: p }; }
    }
    for (const o of npcs) {
      if (o === n || !o.alive) continue;
      if (!hostile(n.f, o.f, rules)) continue;
      const dx = o.x - n.x, dz = o.z - n.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = { kind: 'npc', ref: o }; }
    }

    let tx, tz, dist = 0;
    if (best) {
      tx = best.ref.x; tz = best.ref.z;
      dist = Math.sqrt(bestD2);
      n.target = best.kind;
    } else {
      n.target = null;
      // ---- Патруль ----
      // Кольцо вокруг домашней точки. Новая точка берётся, когда дошли или когда вышло
      // время: боец, упёршийся в невидимое препятствие, должен сам себя отпустить.
      n.wpCd -= TICK;
      const wdx = n.wpX - n.x, wdz = n.wpZ - n.z;
      if (wdx * wdx + wdz * wdz < 1.5 || n.wpCd <= 0) {
        const a = 2 * Math.PI * rnd();
        const r = n.radius * (0.35 + rnd() * 0.6);
        n.wpX = n.home.x + Math.cos(a) * r;
        n.wpZ = n.home.z + Math.sin(a) * r;
        n.wpCd = 6 + rnd() * 8;
      }
      tx = n.wpX; tz = n.wpZ;
    }

    // ---- Огонь ----
    n.firing = false;
    if (best) {
      const zombie = n.f === FACTION.ZOMBIED;
      if (zombie || n.gun < 0) {
        // Безоружные дерутся вплотную. Урон прилетает только людям: драку ботов между
        // собой считаем тем же выстрелом, чтобы не плодить второй путь.
        if (dist <= MELEE_RANGE && n.meleeCd <= 0) {
          n.meleeCd = MELEE_INTERVAL;
          if (best.kind === 'player') best.ref.damage(MELEE_DAMAGE);
          else best.ref.hp -= MELEE_DAMAGE;
        }
      } else if (dist <= SHOOT_RANGE && n.fireCd <= 0) {
        n.fireCd = 0.9 + rnd() * 0.7;
        n.firing = true;
        // Попадание не гарантировано: чем дальше, тем реже. Иначе бой на сорока метрах
        // превращался бы в мгновенную смерть с обеих сторон.
        const chance = Math.max(0.12, 0.75 - dist * 0.014);
        if (rnd() < chance) {
          const dmg = 8 + rnd() * 7;
          if (best.kind === 'player') best.ref.damage(dmg);
          else best.ref.hp -= dmg;
        }
      }
    }

    // ---- Движение ----
    const dx = tx - n.x, dz = tz - n.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    n.rotY = Math.atan2(dx, dz);
    // К стрелковой цели не подходим вплотную - останавливаемся на дистанции огня;
    // к добыче в ближнем бою, наоборот, идём до упора.
    const wantClose = (n.f === FACTION.ZOMBIED || n.gun < 0) ? MELEE_RANGE * 0.8 : 14;
    const stop = best ? wantClose : 0.8;
    if (d > stop) {
      let speed = n.speed;
      if (best) speed *= (n.f === FACTION.ZOMBIED && n.hp < n.maxHp * 0.35) ? 1.85 : 1.5;
      let nx = n.x + (dx / d) * speed * TICK;
      let nz = n.z + (dz / d) * speed * TICK;
      // Запретные круги: не входим в пятно постройки, а скользим по его краю.
      for (const ob of OBSTACLES) {
        const ox = nx - ob.x, oz = nz - ob.z;
        const od = Math.sqrt(ox * ox + oz * oz);
        if (od > 0.001 && od < ob.r) {
          nx = ob.x + (ox / od) * ob.r;
          nz = ob.z + (oz / od) * ob.r;
        }
      }
      if (nx > WORLD_BOUND) nx = WORLD_BOUND; if (nx < -WORLD_BOUND) nx = -WORLD_BOUND;
      if (nz > WORLD_BOUND) nz = WORLD_BOUND; if (nz < -WORLD_BOUND) nz = -WORLD_BOUND;
      n.x = nx; n.z = nz;
      n.move = 1;
    } else {
      n.move = 0;
    }

    // ---- Смерть ----
    // Здесь ловятся только те, кого добили боты: попадание игрока валит бойца сразу, в
    // обработчике такта (см. npcKill в server.js), - иначе между двумя тактами ИИ в него
    // успевали всадить ещё несколько очередей.
    if (n.hp <= 0) npcDie(n, rnd, clock);
  }
}

// Один путь смерти на всех: и для добитых ботами, и для убитых людьми. Разойдись эти два
// места - и хабар с одного из них однажды пропал бы.
function npcDie(n, rnd, clock) {
  if (!n.alive) return;
  n.alive = false;
  n.hp = 0;
  n.move = 0;
  n.firing = false;
  n.target = null;
  n.loot = rollLoot(n, rnd);
  n.corpseAt = clock + CORPSE_TOTAL;
  const zombie = n.f === FACTION.ZOMBIED;
  const lo = zombie ? ZOMBIE_RESPAWN_MIN : RESPAWN_MIN;
  const hi = zombie ? ZOMBIE_RESPAWN_MAX : RESPAWN_MAX;
  n.respawnAt = clock + lo + rnd() * (hi - lo);
}

module.exports = { aiTick, initNpc, npcDie, hostile, rollLoot, TICK, PLAYER_FACTION };
