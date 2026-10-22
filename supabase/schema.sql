-- =====================================================================
--  UH Hikayat — Skema Supabase
--  Jalankan SELURUH file ini sekali di: Supabase → SQL Editor → New query → Run
--  Setelah itu jalankan supabase/seed_keys.sql (kunci jawaban).
--  Aman dijalankan ulang (memakai "if not exists" / "drop ... if exists").
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. TABEL
-- ---------------------------------------------------------------

-- Profil: satu baris per akun login (siswa atau guru).
-- Dibuat OTOMATIS oleh trigger saat akun baru mendaftar.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nama        text not null check (char_length(nama)  between 1 and 80),
  kelas       text not null check (char_length(kelas) between 1 and 30),
  role        text not null default 'siswa' check (role in ('siswa','guru')),
  created_at  timestamptz not null default now()
);

-- Percobaan kuis (sekaligus catatan absensi: started_at + foto absen).
-- Jawaban disimpan sebagai array JSON [0,2,null,...] (null = kosong).
create table if not exists public.attempts (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'berjalan' check (status in ('berjalan','selesai')),
  consent_at    timestamptz not null,               -- waktu siswa menyetujui kamera
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  skor          int check (skor between 0 and 100),
  benar         int,
  salah         int,
  kosong        int,
  total         int,
  durasi_detik  int,
  answers       jsonb
);
create index if not exists attempts_student_idx on public.attempts (student_id, started_at desc);
create index if not exists attempts_status_idx  on public.attempts (status, started_at desc);

-- Metadata foto (file aslinya ada di Storage bucket "photos").
--   kind = 'absen' (foto absen, maks. 1 per percobaan) atau 'live' (snapshot).
create table if not exists public.snapshots (
  id             uuid primary key default gen_random_uuid(),
  attempt_id     uuid not null references public.attempts(id) on delete cascade,
  student_id     uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('absen','live')),
  storage_path   text not null unique,
  elapsed_label  text,
  taken_at       timestamptz not null default now()
);
create index if not exists snapshots_attempt_idx on public.snapshots (attempt_id);
create index if not exists snapshots_taken_idx   on public.snapshots (taken_at desc);
create unique index if not exists snapshots_one_absen_idx
  on public.snapshots (attempt_id) where kind = 'absen';

-- Kunci jawaban + pembahasan. TIDAK bisa dibaca langsung dari aplikasi
-- (RLS aktif tanpa policy). Hanya dibaca oleh fungsi di bawah.
create table if not exists public.quiz_keys (
  no          int primary key check (no > 0),
  correct     int not null check (correct between 0 and 3),
  penjelasan  text not null
);

-- Batas jumlah foto per percobaan (cegah penyalahgunaan penyimpanan)
create or replace function public.limit_snapshots() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.snapshots where attempt_id = new.attempt_id) >= 60 then
    raise exception 'Batas foto per percobaan tercapai';
  end if;
  return new;
end $$;
drop trigger if exists trg_limit_snapshots on public.snapshots;
create trigger trg_limit_snapshots before insert on public.snapshots
  for each row execute function public.limit_snapshots();

-- ---------------------------------------------------------------
-- 2. PROFIL OTOMATIS SAAT DAFTAR (role selalu 'siswa')
-- ---------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nama, kelas, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'nama'),''),  split_part(new.email,'@',1), 'Siswa'), 80),
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'kelas'),''), '-'), 30),
    'siswa'
  );
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------
-- 3. FUNGSI BANTU & RPC
-- ---------------------------------------------------------------
create or replace function public.is_guru() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'guru');
$$;

-- Daftar siswa yang sedang mengerjakan (hanya nama & kelas, 3 jam terakhir)
create or replace function public.active_attempts()
returns table (nama text, kelas text, started_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.nama, p.kelas, a.started_at
  from public.attempts a join public.profiles p on p.id = a.student_id
  where a.status = 'berjalan' and a.started_at > now() - interval '3 hours'
  order by a.started_at;
$$;

-- Penilaian di SERVER: siswa tidak bisa mengubah skor / melihat kunci sebelum selesai.
create or replace function public.submit_attempt(p_attempt uuid, p_answers jsonb, p_durasi int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a public.attempts;
  v_total int; v_benar int := 0; v_salah int := 0; v_kosong int := 0;
  v_skor int; v_durasi int; v_server_sec int;
  r record; v_item jsonb; v_txt text;
begin
  select * into a from public.attempts
   where id = p_attempt and student_id = auth.uid() for update;
  if not found then raise exception 'Percobaan tidak ditemukan'; end if;
  if a.status <> 'berjalan' then raise exception 'Percobaan ini sudah selesai'; end if;

  select count(*) into v_total from public.quiz_keys;
  if v_total = 0 then raise exception 'Kunci jawaban belum diisi (jalankan seed_keys.sql)'; end if;
  if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> v_total then
    raise exception 'Jumlah jawaban tidak sesuai';
  end if;

  for r in select no, correct from public.quiz_keys order by no loop
    v_item := p_answers -> (r.no - 1);
    if v_item is null or jsonb_typeof(v_item) = 'null' then
      v_kosong := v_kosong + 1;
    else
      v_txt := v_item #>> '{}';
      if v_txt !~ '^[0-3]$' then raise exception 'Jawaban tidak valid'; end if;
      if v_txt::int = r.correct then v_benar := v_benar + 1; else v_salah := v_salah + 1; end if;
    end if;
  end loop;

  v_skor := round(v_benar::numeric / v_total * 100);
  v_server_sec := greatest(0, extract(epoch from (now() - a.started_at))::int);
  v_durasi := greatest(0, least(coalesce(p_durasi, 0), v_server_sec + 10));

  update public.attempts set
    status = 'selesai', finished_at = now(), skor = v_skor,
    benar = v_benar, salah = v_salah, kosong = v_kosong, total = v_total,
    durasi_detik = v_durasi, answers = p_answers
  where id = a.id;

  return jsonb_build_object(
    'skor', v_skor, 'benar', v_benar, 'salah', v_salah, 'kosong', v_kosong,
    'total', v_total, 'durasi_detik', v_durasi,
    'kunci', (select jsonb_agg(jsonb_build_object('no', no, 'kunci', correct, 'penjelasan', penjelasan) order by no)
              from public.quiz_keys)
  );
end $$;

-- Kunci + pembahasan: hanya untuk percobaan SELESAI milik sendiri, atau guru.
create or replace function public.get_answer_key(p_attempt uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.attempts
    where id = p_attempt and status = 'selesai' and (student_id = auth.uid() or public.is_guru())
  ) then
    raise exception 'Tidak diizinkan';
  end if;
  return (select jsonb_agg(jsonb_build_object('no', no, 'kunci', correct, 'penjelasan', penjelasan) order by no)
          from public.quiz_keys);
end $$;

-- Hanya pengguna yang login yang boleh memanggil fungsi (anon ditolak)
revoke all on function public.is_guru()                          from public, anon;
revoke all on function public.active_attempts()                  from public, anon;
revoke all on function public.submit_attempt(uuid, jsonb, int)   from public, anon;
revoke all on function public.get_answer_key(uuid)               from public, anon;
grant execute on function public.is_guru()                        to authenticated;
grant execute on function public.active_attempts()                to authenticated;
grant execute on function public.submit_attempt(uuid, jsonb, int) to authenticated;
grant execute on function public.get_answer_key(uuid)             to authenticated;

-- ---------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS)
-- ---------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.attempts   enable row level security;
alter table public.snapshots  enable row level security;
alter table public.quiz_keys  enable row level security;   -- tanpa policy = tertutup

revoke all on public.profiles, public.attempts, public.snapshots, public.quiz_keys from anon;
revoke all on public.quiz_keys from authenticated;

-- profiles: lihat diri sendiri / guru lihat semua. Ubah nama & kelas saja (role TIDAK bisa diubah dari aplikasi).
revoke update on public.profiles from authenticated;
grant  update (nama, kelas) on public.profiles to authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_guru());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_guru())
  with check (id = auth.uid() or public.is_guru());

-- attempts: siswa hanya miliknya; guru semua. Siswa hanya boleh MEMULAI (status berjalan, tanpa skor).
-- Mengisi skor hanya lewat submit_attempt(). Tidak ada policy UPDATE sama sekali.
drop policy if exists attempts_select on public.attempts;
create policy attempts_select on public.attempts for select to authenticated
  using (student_id = auth.uid() or public.is_guru());

drop policy if exists attempts_insert on public.attempts;
create policy attempts_insert on public.attempts for insert to authenticated
  with check (student_id = auth.uid() and status = 'berjalan'
              and skor is null and finished_at is null and answers is null);

drop policy if exists attempts_delete on public.attempts;
create policy attempts_delete on public.attempts for delete to authenticated
  using (public.is_guru() or (student_id = auth.uid() and status = 'berjalan'));  -- siswa hanya boleh membatalkan sesi yang belum selesai

-- snapshots
drop policy if exists snapshots_select on public.snapshots;
create policy snapshots_select on public.snapshots for select to authenticated
  using (student_id = auth.uid() or public.is_guru());

drop policy if exists snapshots_insert on public.snapshots;
create policy snapshots_insert on public.snapshots for insert to authenticated
  with check (
    student_id = auth.uid()
    and storage_path like auth.uid()::text || '/%'
    and exists (select 1 from public.attempts a
                where a.id = attempt_id and a.student_id = auth.uid() and a.status = 'berjalan')
  );

drop policy if exists snapshots_delete on public.snapshots;
create policy snapshots_delete on public.snapshots for delete to authenticated
  using (
    public.is_guru()
    or (student_id = auth.uid() and exists (
          select 1 from public.attempts a
          where a.id = attempt_id and a.student_id = auth.uid() and a.status = 'berjalan'))
  );

-- ---------------------------------------------------------------
-- 5. STORAGE (bucket privat "photos")
--    Path file: <id_siswa>/<id_percobaan>/<jenis>_<uuid>.jpg
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 1048576,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_select on storage.objects;
create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'photos'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_guru()));

-- Hapus file: guru kapan saja; siswa hanya foto dari sesi yang belum selesai (saat membatalkan)
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos'
    and (
      public.is_guru()
      or exists (
        select 1 from public.snapshots s join public.attempts a on a.id = s.attempt_id
        where s.storage_path = name and a.student_id = auth.uid() and a.status = 'berjalan')
    )
  );

-- =====================================================================
--  SELESAI. Langkah berikut (di README): jadikan akun guru:
--    update public.profiles set role = 'guru'
--    where id = (select id from auth.users where email = 'EMAIL_GURU@contoh.com');
-- =====================================================================
