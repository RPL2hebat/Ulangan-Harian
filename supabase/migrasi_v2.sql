-- =====================================================================
--  UH Hikayat — MIGRASI v2 (tahap 1). Jalankan SETELAH schema.sql & seed_keys.sql.
--  Aman dijalankan ulang. Data lama (profil, nilai, foto) TIDAK dihapus.
--  Isi: kelas dinamis, role admin, nilai disembunyikan dari siswa, audit log.
-- =====================================================================

-- 1. PROFIL: role admin + status akun
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('siswa','guru','admin'));
alter table public.profiles add column if not exists aktif boolean not null default true;

-- 2. KELAS (dikelola guru). Nama kelas boleh diubah; riwayat tetap karena terikat class_id.
create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  nama text not null check (char_length(trim(nama)) between 1 and 30),
  aktif boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists classes_nama_uq on public.classes (lower(trim(nama)));
alter table public.profiles add column if not exists class_id uuid references public.classes(id) on delete restrict;

-- Migrasi aman: kelas yang sudah dipakai siswa otomatis menjadi daftar kelas
insert into public.classes (nama)
  select distinct trim(kelas) from public.profiles where trim(kelas) not in ('', '-')
  on conflict do nothing;
update public.profiles p set class_id = c.id
  from public.classes c where p.class_id is null and lower(trim(p.kelas)) = lower(trim(c.nama));

-- Validasi kelas DI DATABASE: hanya kelas aktif yang boleh dipilih/diubah
create or replace function public.profiles_sync_class() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.classes;
begin
  if coalesce(current_setting('app.class_rename', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' or new.kelas is distinct from old.kelas then
    select * into c from public.classes where lower(trim(nama)) = lower(trim(new.kelas)) and aktif;
    if not found then raise exception 'Kelas tidak valid atau tidak aktif'; end if;
    new.class_id := c.id; new.kelas := c.nama;
  end if;
  return new;
end $$;
drop trigger if exists trg_profiles_sync_class on public.profiles;
create trigger trg_profiles_sync_class before insert or update on public.profiles
  for each row execute function public.profiles_sync_class();

-- Ganti nama kelas → nama di profil ikut berubah (riwayat absensi/nilai tetap utuh)
create or replace function public.classes_after_rename() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.nama is distinct from old.nama then
    perform set_config('app.class_rename', '1', true);
    update public.profiles set kelas = new.nama where class_id = new.id;
    perform set_config('app.class_rename', '', true);
  end if;
  return new;
end $$;
drop trigger if exists trg_classes_rename on public.classes;
create trigger trg_classes_rename after update on public.classes
  for each row execute function public.classes_after_rename();

-- Pendaftaran: kelas dari kelas_id (atau nama) harus ada & aktif; role SELALU 'siswa'
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kelas text; v_id text := new.raw_user_meta_data->>'kelas_id';
begin
  if v_id ~* '^[0-9a-f-]{36}$' then
    select nama into v_kelas from public.classes where id = v_id::uuid and aktif;
  end if;
  v_kelas := coalesce(v_kelas, trim(new.raw_user_meta_data->>'kelas'), '');
  insert into public.profiles (id, nama, kelas, role)
  values (new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'nama'),''), split_part(new.email,'@',1), 'Siswa'), 80),
    left(v_kelas, 30), 'siswa');   -- trigger profiles_sync_class menolak kelas tidak valid
  return new;
end $$;

alter table public.classes enable row level security;
revoke all on public.classes from anon;
revoke all on public.classes from authenticated;
grant select, insert, update on public.classes to authenticated;   -- tidak ada DELETE: nonaktifkan saja
drop policy if exists classes_select on public.classes;
create policy classes_select on public.classes for select to authenticated using (true);
drop policy if exists classes_guru_ins on public.classes;
create policy classes_guru_ins on public.classes for insert to authenticated with check (public.is_guru());
drop policy if exists classes_guru_upd on public.classes;
create policy classes_guru_upd on public.classes for update to authenticated
  using (public.is_guru()) with check (public.is_guru());

-- Daftar kelas aktif untuk formulir pendaftaran (boleh dipanggil sebelum login)
create or replace function public.list_active_classes() returns table (id uuid, nama text)
language sql stable security definer set search_path = public as $$
  select c.id, c.nama from public.classes c where c.aktif order by c.nama;
$$;
grant execute on function public.list_active_classes() to anon, authenticated;

-- 3. ROLE ADMIN (terpisah dari guru) + perlindungan ubah role
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and aktif);
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.protect_role() returns trigger language plpgsql as $$
begin
  if (new.role is distinct from old.role or new.aktif is distinct from old.aktif)
     and auth.uid() is not null and coalesce(current_setting('app.role_change', true), '') <> '1' then
    raise exception 'Role/status akun tidak boleh diubah dari aplikasi';
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_role on public.profiles;
create trigger trg_protect_role before update on public.profiles
  for each row execute function public.protect_role();

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_guru() or public.is_admin());

-- 4. AUDIT LOG (hanya admin yang bisa membaca; ditulis oleh fungsi server)
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid, aksi text not null, target uuid, detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());

create or replace function public.catat_audit(p_aksi text, p_target uuid, p_detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, aksi, target, detail) values (auth.uid(), p_aksi, p_target, p_detail);
$$;
revoke all on function public.catat_audit(text, uuid, jsonb) from public, anon, authenticated;

-- 5. FUNGSI ADMIN (tanpa password; email dibaca server-side hanya untuk admin)
create or replace function public.admin_list_accounts(p_cari text default null, p_role text default null, p_kelas text default null)
returns table (id uuid, nama text, email text, role text, kelas text, aktif boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Tidak diizinkan'; end if;
  return query
    select p.id, p.nama, u.email::text, p.role, p.kelas, p.aktif, p.created_at
    from public.profiles p join auth.users u on u.id = p.id
    where (p_role is null or p.role = p_role) and (p_kelas is null or p.kelas = p_kelas)
      and (p_cari is null or p.nama ilike '%' || p_cari || '%' or u.email ilike '%' || p_cari || '%')
    order by p.created_at desc limit 1000;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Tidak diizinkan'; end if;
  if p_role not in ('siswa','guru','admin') then raise exception 'Role tidak valid'; end if;
  if p_user = auth.uid() then raise exception 'Tidak bisa mengubah role akun sendiri'; end if;
  perform set_config('app.role_change', '1', true);
  update public.profiles set role = p_role where id = p_user;
  perform public.catat_audit('ubah_role', p_user, jsonb_build_object('role', p_role));
end $$;

create or replace function public.admin_set_active(p_user uuid, p_aktif boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Tidak diizinkan'; end if;
  if p_user = auth.uid() then raise exception 'Tidak bisa menonaktifkan akun sendiri'; end if;
  perform set_config('app.role_change', '1', true);
  update public.profiles set aktif = p_aktif where id = p_user;
  perform public.catat_audit('ubah_status', p_user, jsonb_build_object('aktif', p_aktif));
end $$;

revoke all on function public.admin_list_accounts(text, text, text) from public, anon;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
revoke all on function public.admin_set_active(uuid, boolean) from public, anon;
grant execute on function public.admin_list_accounts(text, text, text) to authenticated;
grant execute on function public.admin_set_role(uuid, text) to authenticated;
grant execute on function public.admin_set_active(uuid, boolean) to authenticated;

-- 6. NILAI TIDAK TAMPAK UNTUK SISWA (dijaga di database, bukan hanya di tampilan)
create table if not exists public.app_settings (key text primary key, value jsonb not null);
alter table public.app_settings enable row level security;          -- tanpa policy = tertutup
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings (key, value) values ('nilai_dirilis', 'false'::jsonb) on conflict do nothing;

create or replace function public.nilai_dirilis() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::boolean from public.app_settings where key = 'nilai_dirilis'), false);
$$;
grant execute on function public.nilai_dirilis() to authenticated;

-- Siswa hanya melihat percobaan yang BERJALAN; yang selesai hanya setelah guru merilis nilai
drop policy if exists attempts_select on public.attempts;
create policy attempts_select on public.attempts for select to authenticated
  using (public.is_guru() or (student_id = auth.uid() and (status = 'berjalan' or public.nilai_dirilis())));

-- Akun nonaktif tidak bisa memulai ulangan baru
drop policy if exists attempts_insert on public.attempts;
create policy attempts_insert on public.attempts for insert to authenticated
  with check (student_id = auth.uid() and status = 'berjalan' and skor is null
              and finished_at is null and answers is null
              and exists (select 1 from public.profiles where id = auth.uid() and aktif));

-- Kunci + pembahasan: siswa hanya setelah nilai dirilis
create or replace function public.get_answer_key(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.attempts where id = p_attempt and status = 'selesai'
                 and (public.is_guru() or (student_id = auth.uid() and public.nilai_dirilis()))) then
    raise exception 'Tidak diizinkan';
  end if;
  return (select jsonb_agg(jsonb_build_object('no', no, 'kunci', correct, 'penjelasan', penjelasan) order by no)
          from public.quiz_keys);
end $$;

-- submit_attempt: penilaian tetap di server; skor/kunci dikembalikan hanya bila nilai dirilis
do $$ begin
  if to_regprocedure('public.submit_attempt_core(uuid,jsonb,int)') is null then
    alter function public.submit_attempt(uuid, jsonb, int) rename to submit_attempt_core;
  end if;
end $$;
revoke all on function public.submit_attempt_core(uuid, jsonb, int) from public, anon, authenticated;

create or replace function public.submit_attempt(p_attempt uuid, p_answers jsonb, p_durasi int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  r := public.submit_attempt_core(p_attempt, p_answers, p_durasi);
  if public.nilai_dirilis() then return r; end if;
  return jsonb_build_object('terkirim', true, 'durasi_detik', r -> 'durasi_detik');
end $$;
revoke all on function public.submit_attempt(uuid, jsonb, int) from public, anon;
grant execute on function public.submit_attempt(uuid, jsonb, int) to authenticated;

-- =====================================================================
--  LANGKAH MANUAL (SQL Editor, bukan dari browser):
--  a) Jadikan admin pertama (ganti email):
--     update public.profiles set role = 'admin'
--      where id = (select id from auth.users where email = 'EMAIL_ADMIN@contoh.com');
--  b) Rilis / tutup nilai untuk siswa:
--     update public.app_settings set value = 'true'::jsonb  where key = 'nilai_dirilis';  -- rilis
--     update public.app_settings set value = 'false'::jsonb where key = 'nilai_dirilis';  -- tutup
-- =====================================================================
