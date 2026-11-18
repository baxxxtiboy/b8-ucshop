-- =====================================================
--  UC Do'kon — Supabase (PostgreSQL) sxemasi
--  Supabase > SQL Editor ga qo'yib "Run" bosing
-- =====================================================
create extension if not exists pgcrypto;

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  username    text default '',
  pubg_id     text default '',
  balance     int  not null default 0 check (balance >= 0),     -- yutilgan UC
  spins_left  int  not null default 1 check (spins_left >= 0),  -- bepul urinish bilan boshlanadi
  created_at  timestamptz default now()
);

create table if not exists admins (
  telegram_id bigint primary key,
  name        text default 'Admin',
  role        text default 'manager' check (role in ('owner','manager'))
);

create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  pubg_id        text not null,
  uc             int  not null,
  bonus          int  not null default 0,
  amount         bigint not null,                                -- so'mda
  payment_method text not null check (payment_method in ('Click','Payme','Uzum','Uzcard')),
  status         text not null default 'pending' check (status in ('pending','done','cancelled')),
  created_at     timestamptz default now()
);

create table if not exists spins (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  prize      text not null,
  uc         int  not null default 0,
  created_at timestamptz default now()
);

create table if not exists contests (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  prize            text not null,
  description      text default '',
  icon             text default '🏆',
  end_time         timestamptz not null,
  max_participants int  not null default 2000,
  status           text not null default 'active' check (status in ('active','ended')),
  winner_pubg_id   text,
  winner_telegram  text,
  created_at       timestamptz default now()
);

create table if not exists contest_participants (
  id         uuid primary key default gen_random_uuid(),
  contest_id uuid not null references contests(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  pubg_id    text not null,
  telegram   text not null,
  joined_at  timestamptz default now(),
  unique (contest_id, user_id)                                   -- bir kishi bir marta
);

create index if not exists orders_created_idx on orders (created_at desc);

-- Xavfsizlik: RLS yoqiladi, siyosat yo'q => faqat server (service_role kaliti) kira oladi
alter table users                enable row level security;
alter table admins               enable row level security;
alter table orders               enable row level security;
alter table spins                enable row level security;
alter table contests             enable row level security;
alter table contest_participants enable row level security;

-- ---------- Atomik funksiyalar (poyga holatlaridan himoya) ----------
-- Urinish bor bo'lsagina 1 ta ayiradi; UC yutuq va "yana urinish"ni qo'shadi
create or replace function spin_user(p_user uuid, p_uc int, p_retry boolean)
returns setof users language sql as $$
  update users
     set spins_left = spins_left - 1 + (case when p_retry then 1 else 0 end),
         balance    = balance + p_uc
   where id = p_user and spins_left > 0
  returning *;
$$;

-- Balansdan urinish sotib olish
create or replace function buy_spin(p_user uuid, p_cost int)
returns setof users language sql as $$
  update users set balance = balance - p_cost, spins_left = spins_left + 1
   where id = p_user and balance >= p_cost
  returning *;
$$;

-- Konkursga qo'shilish: muvaffaqiyatda ishtirokchilar soni, aks holda -1
create or replace function join_contest(p_contest uuid, p_user uuid, p_pubg text, p_tg text)
returns int language plpgsql as $$
declare c contests; n int;
begin
  select * into c from contests where id = p_contest for update;
  if not found or c.status <> 'active' or c.end_time <= now() then return -1; end if;
  select count(*) into n from contest_participants where contest_id = p_contest;
  if n >= c.max_participants then return -1; end if;
  insert into contest_participants (contest_id, user_id, pubg_id, telegram)
  values (p_contest, p_user, p_pubg, p_tg) on conflict do nothing;
  if not found then return -1; end if;
  return n + 1;
end $$;

-- Admin statistikasi
create or replace function admin_stats() returns json language sql as $$
  select json_build_object(
    'users',          (select count(*) from users),
    'soldUC',         coalesce((select sum(uc + bonus) from orders where status = 'done'), 0),
    'revenue',        coalesce((select sum(amount)     from orders where status = 'done'), 0),
    'activeContests', (select count(*) from contests where status = 'active'));
$$;

-- Funksiyalarni ochiq (anon) kalitdan yashirish
revoke execute on function spin_user(uuid,int,boolean), buy_spin(uuid,int),
  join_contest(uuid,uuid,text,text), admin_stats() from anon, authenticated;
