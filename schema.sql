-- ==================== ТАБЛИЦА ПРОФИЛЕЙ ====================
-- Выполнить ОДИН РАЗ в SQL-редакторе Supabase (или в любом Postgres).
-- Нужна, только если профили должны переживать перезапуск сервиса: без неё сервер
-- держит их в JSON-файле, а на бесплатном тарифе Render диск эфемерный.
--
-- nick_key - ник в нижнем регистре и он же первичный ключ. Именно он делает имя
-- уникальным: «Вова» и «вова» для человека одно имя, и позволить войти обоим значило бы
-- обмануть его. Настоящее написание хранится отдельно, в nick.
create table if not exists players (
  nick_key   text primary key,
  nick       text not null,
  money      integer default 0,
  kills      integer default 0,
  hp         real    default 100,
  x          real    default 0,
  y          real    default 0,
  z          real    default 0,
  -- Рюкзак и надетое лежат как есть, списком объектов:
  --   inventory: [{"item":1000,"n":1,"cond":0.7}, ...]
  --   equipment: [{"slot":1,"item":9,"n":1,"cond":0.5}, ...]
  -- Разбирать их в отдельные таблицы незачем: сервер их не ищет и не считает, он их
  -- только хранит и отдаёт целиком тому, кому они принадлежат.
  inventory  jsonb   default '[]'::jsonb,
  equipment  jsonb   default '[]'::jsonb,
  seen_at    bigint  default 0
);

-- Кто заходил недавно - по этому удобно смотреть живых игроков.
create index if not exists players_seen_at_idx on players (seen_at desc);
