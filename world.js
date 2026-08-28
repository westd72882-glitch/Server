// ==================== МИР: СОСТАВ БОЙЦОВ ====================
// Кто стоит на карте и где. Раньше это разыгрывал один из телефонов - тот, кого сервер
// назначил ведущим, - а остальные принимали его слово. Теперь состав собирает СЕРВЕР и
// рассылает готовым: клиент получает список «номер, имя, сторона, модель, ствол» и
// строит по нему свой ростер, ничего не разыгрывая.
//
// ПОЧЕМУ ТАК, А НЕ ОБЩЕЕ ЗЕРНО. Общее зерно требует, чтобы обе стороны считали одним и
// тем же генератором: любая правка таблицы отрядов в игре молча расходится с сервером, и
// боец номер семнадцать становится у них разными людьми. Список, присланный целиком, от
// этого избавляет: правится он в одном месте, а клиент его только читает.
//
// ЧИСЛА ЗДЕСЬ - КОПИЯ ИГРОВЫХ. Ориентиры Кордона и таблица отрядов повторяют
// src/Game/World/Kordon.cpp и src/Game/AI/NPC.cpp. Расходиться им нельзя: отряд,
// поставленный сервером в чистое поле, у игрока окажется в стене.
'use strict';

// ==================== СТОРОНЫ И МОДЕЛИ ====================
// Значения обязаны совпадать с FactionId (Game/AI/Faction.h) и NpcModelKind (NPC.cpp).
const FACTION = { MILITARY: 0, MERCS: 1, ECOLOGISTS: 2, ZOMBIED: 3 };
const MODEL = { SOLDIER: 0, MERC: 1, MONGOL: 2, ECOLOG: 3, ZOMBIE: 4 };
// NpcRole в NPC.h
const ROLE = { ORDINARY: 0, TRADER: 1, QUESTGIVER: 2, SCIENTIST: 3, PREACHER: 4 };

// ==================== ОРИЕНТИРЫ ====================
// Порядок и координаты - копия KordonLandmark и LANDMARK_DEFAULT_XZ.
const LM = {
  VILLAGE: 0, SIDOROVICH: 1, SOUTH_POST: 2, NORTH_POST: 3, RAIL_BRIDGE: 4,
  PIG_FARM: 5, ATP: 6, TUNNEL: 7, GRANARY: 8, MERC_CAMP: 9, CONVOY: 10,
  SCIENCE: 11, DEAD_VILLAGE: 12,
};
const LANDMARK_XZ = [
  [-38, -65], [-51, -55], [4, -101], [15, 95],
  [-87, 11], [68, -42], [84, 30], [-87, 63], [51, 84],
  [-42, 52], [-14, -84], [34, -12], [118, 8],
];

// ==================== ОТРЯДЫ ====================
// Копия SQUADS из NPC.cpp: ярлык, сторона, ориентир-тыл, смещение якоря, радиус кольца
// патрулирования, состав, ствол (-1 = безоружные), «держит точку».
const SQUADS = [
  // Военные: тыл на западе и юге
  { label: 'Отделение у костра',      f: FACTION.MILITARY, lm: LM.VILLAGE,     ox: 0,   oz: 2,   r: 9,  n: 3, gun: 0 },
  { label: 'Караул блокпоста',        f: FACTION.MILITARY, lm: LM.SIDOROVICH,  ox: 12,  oz: 13,  r: 6,  n: 3, gun: 0, hold: true },
  { label: 'Пост у моста',            f: FACTION.MILITARY, lm: LM.RAIL_BRIDGE, ox: 4,   oz: 0,   r: 8,  n: 3, gun: 0 },
  { label: 'Дозор южного блокпоста',  f: FACTION.MILITARY, lm: LM.SOUTH_POST,  ox: 0,   oz: 5,   r: 8,  n: 3, gun: 0 },
  { label: 'Штурмовая группа',        f: FACTION.MILITARY, lm: LM.VILLAGE,     ox: 10,  oz: -6,  r: 8,  n: 4, gun: 1 },
  // Наёмники: тыл на востоке и севере
  { label: 'Наёмники на свиноферме',  f: FACTION.MERCS,    lm: LM.PIG_FARM,    ox: 0,   oz: 0,   r: 11, n: 3, gun: 0 },
  { label: 'Наёмники на АТП',         f: FACTION.MERCS,    lm: LM.ATP,         ox: 0,   oz: 6,   r: 10, n: 3, gun: 0 },
  { label: 'Наёмники в хранилище',    f: FACTION.MERCS,    lm: LM.GRANARY,     ox: 0,   oz: 0,   r: 8,  n: 3, gun: 0 },
  { label: 'Наёмники на севпосту',    f: FACTION.MERCS,    lm: LM.NORTH_POST,  ox: 0,   oz: 6,   r: 8,  n: 3, gun: 0 },
  { label: 'Ударная группа наёмников',f: FACTION.MERCS,    lm: LM.PIG_FARM,    ox: -10, oz: 6,   r: 8,  n: 4, gun: 1 },
  { label: 'Лагерь наёмников',        f: FACTION.MERCS,    lm: LM.MERC_CAMP,   ox: 0,   oz: 4,   r: 9,  n: 4, gun: 0 },
  { label: 'Дозор лагеря',            f: FACTION.MERCS,    lm: LM.MERC_CAMP,   ox: -7,  oz: -6,  r: 7,  n: 3, gun: 0 },
  // Зомбированные: заброшенная деревня. Их много и они не отступают.
  { label: 'Зомби у часовни',   f: FACTION.ZOMBIED, lm: LM.DEAD_VILLAGE, ox: 0,   oz: 4,   r: 10, n: 5, gun: -1, hold: true },
  { label: 'Зомби на околице',  f: FACTION.ZOMBIED, lm: LM.DEAD_VILLAGE, ox: -8,  oz: -7,  r: 9,  n: 5, gun: -1, hold: true },
  { label: 'Зомби у колодца',   f: FACTION.ZOMBIED, lm: LM.DEAD_VILLAGE, ox: 8,   oz: -3,  r: 8,  n: 4, gun: -1, hold: true },
  { label: 'Зомби за домами',   f: FACTION.ZOMBIED, lm: LM.DEAD_VILLAGE, ox: -11, oz: 6,   r: 10, n: 5, gun: -1, hold: true },
  { label: 'Зомби у дороги',    f: FACTION.ZOMBIED, lm: LM.DEAD_VILLAGE, ox: 12,  oz: 7,   r: 9,  n: 4, gun: -1, hold: true },
  { label: 'Зомби на пустыре',  f: FACTION.ZOMBIED, lm: LM.DEAD_VILLAGE, ox: 2,   oz: -11, r: 11, n: 5, gun: -1, hold: true },
];

// ==================== ИМЕНА ====================
// Копия NPC_FIRST/NPC_NICK. Имя уникально: пара выдаётся по порядковому номеру, а не
// случайно, поэтому двух одинаковых на карте не бывает.
const FIRST = [
  'Иван','Петя','Жека','Лёха','Толян','Серёга','Митяй','Костян','Санёк','Гриша',
  'Витёк','Колян','Стас','Юрок','Дэн','Артём','Захар','Родя','Тимоха','Влад',
  'Гоша','Марат','Славик','Егор','Никита','Паша','Рома','Федя','Борян','Кирюха',
];
const NICK = [
  'Котовоз','Ракета','Банан','Воздухан','Кабан','Тихий','Шуруп','Мотыль','Гвоздь','Чиж',
  'Компас','Валенок','Прапор','Сухарь','Кувалда','Лещ','Ушан','Штык','Пильщик','Балкон',
  'Дрозд','Тапок','Сверчок','Морж','Кипяток','Бинокль','Пятак','Хомяк','Рубанок','Циркуль',
];

// ==================== ГЕНЕРАТОР ====================
// Свой, а не Math.random: состав должен быть воспроизводим по зерну - это помогает
// разобраться в жалобе «у меня на посту стояло четверо» через сутки после того, как она
// пришла.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

// ==================== СБОРКА СОСТАВА ====================
// rules - маска правил (см. GameRules.h): она решает, кого вообще заводить.
const RULE_NO_BOTS = 1 << 0, RULE_ALL_ZOMBIES = 1 << 3, RULE_NO_TRADERS = 1 << 4;
const RULE_ARMY_HOLD = 1 << 5, RULE_STORY = 1 << 7;

function buildRoster(seed, rules) {
  const rnd = makeRng(seed);
  const out = [];
  let nameCounter = 0;
  const nameOffset = Math.floor(rnd() * 900);
  const nextName = () => {
    const i = nameCounter++ + nameOffset;
    return FIRST[(i * 7) % FIRST.length] + ' ' +
           NICK[(i * 11 + Math.floor(i / FIRST.length)) % NICK.length];
  };
  const lm = (id) => ({ x: LANDMARK_XZ[id][0], z: LANDMARK_XZ[id][1] });

  const add = (o) => {
    out.push({
      i: out.length,
      name: o.name,
      f: o.f,
      model: o.model,
      gun: o.gun === undefined ? 0 : o.gun,
      role: o.role || ROLE.ORDINARY,
      stationary: !!o.stationary,
      hold: !!o.hold,
      x: o.x, z: o.z,
      home: { x: o.x, z: o.z },
      radius: o.radius === undefined ? 8 : o.radius,
      squad: o.squad === undefined ? -1 : o.squad,
      respawns: !!o.respawns,
    });
  };

  // ---- Сюжетные ----
  // Их нет ни в режиме «все зомби», ни без правила story: цепочка заданий рассчитана на
  // одного, и десять человек у одного квестодателя - очередь, а не игра.
  if ((rules & RULE_ALL_ZOMBIES) === 0 && (rules & RULE_STORY) !== 0) {
    const bunker = lm(LM.SIDOROVICH);
    if ((rules & RULE_NO_TRADERS) === 0) {
      add({ name: 'Монгол', f: FACTION.MILITARY, model: MODEL.MONGOL, gun: 1,
            role: ROLE.TRADER, stationary: true, x: bunker.x, z: bunker.z - 1.5 });
    }
    const vil = lm(LM.VILLAGE);
    add({ name: 'Петька', f: FACTION.MILITARY, model: MODEL.SOLDIER, gun: 0,
          role: ROLE.QUESTGIVER, stationary: true, x: vil.x + 3.5, z: vil.z - 2 });
    const lab = lm(LM.SCIENCE);
    add({ name: 'Профессор Сахаров', f: FACTION.ECOLOGISTS, model: MODEL.ECOLOG, gun: -1,
          role: ROLE.SCIENTIST, stationary: true, x: lab.x - 1.2, z: lab.z - 1.6 });
    const ECO = ['Лаборант Пыжов', 'Техник Мельник', 'Дозиметрист Кац'];
    for (let i = 0; i < 3; i++) {
      const a = 2.094 * i;
      add({ name: ECO[i], f: FACTION.ECOLOGISTS, model: MODEL.ECOLOG, gun: 1,
            x: lab.x + Math.cos(a) * 7.5, z: lab.z + Math.sin(a) * 6.5, radius: 8 });
    }
    const dv = lm(LM.DEAD_VILLAGE);
    add({ name: 'Проповедник', f: FACTION.ECOLOGISTS, model: MODEL.ECOLOG, gun: -1,
          role: ROLE.PREACHER, stationary: true, x: dv.x - 0.5, z: dv.z + 4.4 });
    const farm = lm(LM.PIG_FARM);
    add({ name: 'Хантер, командир наёмников', f: FACTION.MERCS, model: MODEL.MERC, gun: 0,
          x: farm.x + 2, z: farm.z + 6.5, radius: 5 });
  }

  if (rules & RULE_NO_BOTS) return out;

  // ---- Отряды ----
  for (let s = 0; s < SQUADS.length; s++) {
    const sd = SQUADS[s];
    let f = sd.f;
    if (rules & RULE_ALL_ZOMBIES) f = FACTION.ZOMBIED;
    else if ((rules & RULE_ARMY_HOLD) && f === FACTION.MERCS) f = FACTION.MILITARY;

    const ax = LANDMARK_XZ[sd.lm][0] + sd.ox;
    const az = LANDMARK_XZ[sd.lm][1] + sd.oz;
    // Численность гуляет на человека в обе стороны: в одной партии на посту двое, в
    // другой четверо, и разведка перестаёт быть формальностью.
    let members = sd.n + Math.floor(rnd() * 3) - 1;
    if (members < 2) members = 2;
    for (let m = 0; m < members; m++) {
      const a = (2 * Math.PI * m) / members;
      const model = f === FACTION.ZOMBIED ? MODEL.ZOMBIE
                  : f === FACTION.MILITARY ? MODEL.SOLDIER : MODEL.MERC;
      const gun = f === FACTION.ZOMBIED ? -1 : (rnd() < 0.25 ? 1 : sd.gun);
      add({
        name: nextName(), f, model, gun,
        x: ax + Math.cos(a) * sd.r * 0.45,
        z: az + Math.sin(a) * sd.r * 0.45,
        radius: sd.r, squad: s, hold: !!sd.hold, respawns: true,
      });
    }
  }

  // ---- Жители деревни новичков ----
  {
    const vil = lm(LM.VILLAGE);
    const dwellers = 4 + Math.floor(rnd() * 4);
    for (let i = 0; i < dwellers; i++) {
      const a = 2 * Math.PI * rnd();
      const r = 4 + rnd() * 9;
      const zombies = (rules & RULE_ALL_ZOMBIES) !== 0;
      add({
        name: nextName(),
        f: zombies ? FACTION.ZOMBIED : FACTION.MILITARY,
        model: zombies ? MODEL.ZOMBIE : MODEL.SOLDIER,
        gun: zombies ? -1 : 1,
        x: vil.x + Math.cos(a) * r, z: vil.z + Math.sin(a) * r,
        radius: 11, respawns: true,
      });
    }
  }

  return out;
}

module.exports = { FACTION, MODEL, ROLE, LM, LANDMARK_XZ, SQUADS, buildRoster, makeRng };
