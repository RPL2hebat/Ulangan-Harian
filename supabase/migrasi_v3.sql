-- =====================================================================
--  UH Hikayat — MIGRASI v3 (tahap 2: bank soal, ujian, kelas tujuan, izin siswa)
--  Urutan: schema.sql → seed_keys.sql → migrasi_v2.sql → migrasi_v3.sql → migrasi_v3_seed_soal_lama.sql
--  Aman dijalankan ulang. Tabel & data lama tidak diubah/dihapus.
-- =====================================================================

create table if not exists public.passages (
  id uuid primary key default gen_random_uuid(),
  judul text not null, teks text not null,
  created_by uuid default auth.uid(), created_at timestamptz not null default now());

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  passage_id uuid references public.passages(id) on delete set null,
  topik text, pertanyaan text not null,
  opsi jsonb not null check (jsonb_typeof(opsi) = 'array' and jsonb_array_length(opsi) between 2 and 5),
  kunci smallint check (kunci is null or (kunci >= 0 and kunci < jsonb_array_length(opsi))),  -- null = belum ada kunci
  pembahasan text, created_by uuid default auth.uid(), created_at timestamptz not null default now());

create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  nama text not null check (char_length(trim(nama)) between 1 and 120),
  mapel text, instruksi text,
  durasi_menit int not null default 90 check (durasi_menit between 1 and 600),
  mulai timestamptz, selesai timestamptz,
  status text not null default 'draf' check (status in ('draf','dijadwalkan','dibuka','ditutup')),
  created_by uuid default auth.uid(), created_at timestamptz not null default now());

create table if not exists public.exam_questions (          -- satu soal bisa dipakai banyak ujian
  exam_id uuid not null references public.exams(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete restrict,
  urutan int not null, primary key (exam_id, question_id));

create table if not exists public.exam_classes (            -- satu ujian → banyak kelas, tanpa salin soal
  exam_id uuid not null references public.exams(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete restrict,
  mode text not null default 'opsional' check (mode in ('wajib','opsional')),
  primary key (exam_id, class_id));

create table if not exists public.exam_access (             -- izin per siswa (lintas kelas / pengecualian)
  exam_id uuid not null references public.exams(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  izin text not null check (izin in ('wajib','opsional','tidak')),
  primary key (exam_id, student_id));

alter table public.attempts add column if not exists exam_id uuid references public.exams(id) on delete restrict;
create index if not exists attempts_exam_idx on public.attempts (exam_id);

-- ---- izin: dihitung di database ----
create or replace function public.exam_izin(p_exam uuid, p_student uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select izin from public.exam_access where exam_id = p_exam and student_id = p_student),
    (select ec.mode from public.exam_classes ec join public.profiles p on p.class_id = ec.class_id
      where ec.exam_id = p_exam and p.id = p_student limit 1),
    'tidak');
$$;

create or replace function public.can_take_exam(p_exam uuid, p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.exams e where e.id = p_exam
           and (e.status = 'dibuka' or (e.status = 'dijadwalkan' and e.mulai is not null))
           and (e.mulai is null or e.mulai <= now()) and (e.selesai is null or e.selesai >= now()))
     and public.exam_izin(p_exam, p_student) <> 'tidak'
     and exists (select 1 from public.profiles where id = p_student and aktif);
$$;

-- Siswa hanya bisa memulai percobaan untuk ujian yang diizinkan & sedang dibuka
drop policy if exists attempts_insert on public.attempts;
create policy attempts_insert on public.attempts for insert to authenticated
  with check (student_id = auth.uid() and status = 'berjalan' and skor is null
              and finished_at is null and answers is null
              and exists (select 1 from public.profiles where id = auth.uid() and aktif)
              and (exam_id is null or public.can_take_exam(exam_id, auth.uid())));

-- ---- RPC siswa (tanpa kunci jawaban) ----
create or replace function public.list_my_exams()
returns table (id uuid, nama text, mapel text, instruksi text, durasi_menit int, mulai timestamptz,
               selesai timestamptz, status text, izin text, kelas text, bisa_mulai boolean)
language sql stable security definer set search_path = public as $$
  select e.id, e.nama, e.mapel, e.instruksi, e.durasi_menit, e.mulai, e.selesai, e.status, x.izin,
    (select string_agg(c.nama, ', ' order by c.nama) from public.exam_classes ec
       join public.classes c on c.id = ec.class_id where ec.exam_id = e.id),
    public.can_take_exam(e.id, auth.uid())
  from public.exams e cross join lateral (select public.exam_izin(e.id, auth.uid()) as izin) x
  where e.status <> 'draf' and x.izin <> 'tidak'
  order by (x.izin = 'wajib') desc, e.mulai nulls last;
$$;

create or replace function public.get_exam_content(p_exam uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_guru() or public.can_take_exam(p_exam, auth.uid())) then raise exception 'Tidak diizinkan'; end if;
  return jsonb_build_object(
    'exam', (select jsonb_build_object('nama', nama, 'durasi_menit', durasi_menit) from public.exams where id = p_exam),
    'passages', coalesce((select jsonb_object_agg(p.id, jsonb_build_object('title', p.judul, 'text', p.teks))
        from public.passages p where p.id in (select q.passage_id from public.exam_questions eq
          join public.questions q on q.id = eq.question_id where eq.exam_id = p_exam)), '{}'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('pid', q.passage_id, 't', coalesce(q.topik, ''),
          'q', q.pertanyaan, 'o', q.opsi) order by eq.urutan)
        from public.exam_questions eq join public.questions q on q.id = eq.question_id
        where eq.exam_id = p_exam), '[]'::jsonb));
end $$;

-- ---- penilaian ujian (di server) ----
create or replace function public.exam_key_json(p_exam uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_agg(jsonb_build_object('no', n, 'kunci', kunci, 'penjelasan', coalesce(pembahasan, '')) order by n)
  from (select row_number() over (order by eq.urutan) n, q.kunci, q.pembahasan
        from public.exam_questions eq join public.questions q on q.id = eq.question_id
        where eq.exam_id = p_exam) t;
$$;
revoke all on function public.exam_key_json(uuid) from public, anon, authenticated;

create or replace function public.submit_attempt_exam(p_attempt uuid, p_answers jsonb, p_durasi int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.attempts; v_total int; b int := 0; s int := 0; k int := 0; v_i int := 0;
        v_skor int; v_dur int; r record; v_item jsonb; v_txt text;
begin
  select * into a from public.attempts where id = p_attempt and student_id = auth.uid() for update;
  if not found then raise exception 'Percobaan tidak ditemukan'; end if;
  if a.status <> 'berjalan' then raise exception 'Percobaan ini sudah selesai'; end if;
  select count(*) into v_total from public.exam_questions where exam_id = a.exam_id;
  if v_total = 0 or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> v_total then
    raise exception 'Jumlah jawaban tidak sesuai'; end if;
  for r in select q.kunci from public.exam_questions eq join public.questions q on q.id = eq.question_id
           where eq.exam_id = a.exam_id order by eq.urutan loop
    v_item := p_answers -> v_i; v_i := v_i + 1;
    if v_item is null or jsonb_typeof(v_item) = 'null' then k := k + 1;
    else
      v_txt := v_item #>> '{}';
      if v_txt !~ '^[0-4]$' then raise exception 'Jawaban tidak valid'; end if;
      if v_txt::int = r.kunci then b := b + 1; else s := s + 1; end if;
    end if;
  end loop;
  v_skor := round(b::numeric / v_total * 100);
  v_dur := greatest(0, least(coalesce(p_durasi, 0), extract(epoch from (now() - a.started_at))::int + 10));
  update public.attempts set status = 'selesai', finished_at = now(), skor = v_skor, benar = b, salah = s,
    kosong = k, total = v_total, durasi_detik = v_dur, answers = p_answers where id = a.id;
  return jsonb_build_object('skor', v_skor, 'benar', b, 'salah', s, 'kosong', k, 'total', v_total,
                            'durasi_detik', v_dur, 'kunci', public.exam_key_json(a.exam_id));
end $$;
revoke all on function public.submit_attempt_exam(uuid, jsonb, int) from public, anon, authenticated;

create or replace function public.submit_attempt(p_attempt uuid, p_answers jsonb, p_durasi int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_exam uuid;
begin
  select exam_id into v_exam from public.attempts where id = p_attempt and student_id = auth.uid();
  if v_exam is null then r := public.submit_attempt_core(p_attempt, p_answers, p_durasi);
  else r := public.submit_attempt_exam(p_attempt, p_answers, p_durasi); end if;
  if public.nilai_dirilis() then return r; end if;
  return jsonb_build_object('terkirim', true, 'durasi_detik', r -> 'durasi_detik');
end $$;

create or replace function public.get_answer_key(p_attempt uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_exam uuid;
begin
  select exam_id into v_exam from public.attempts where id = p_attempt and status = 'selesai'
    and (public.is_guru() or (student_id = auth.uid() and public.nilai_dirilis()));
  if not found then raise exception 'Tidak diizinkan'; end if;
  if v_exam is not null then return public.exam_key_json(v_exam); end if;
  return (select jsonb_agg(jsonb_build_object('no', no, 'kunci', correct, 'penjelasan', penjelasan) order by no)
          from public.quiz_keys);
end $$;

-- ---- soal/ujian yang sudah dikerjakan tidak boleh berubah (jawaban & nilai aman) ----
create or replace function public.lock_used_question() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.exam_questions eq join public.attempts a on a.exam_id = eq.exam_id
             where eq.question_id = old.id) then
    raise exception 'Soal sudah dipakai ujian yang pernah dikerjakan. Buat soal baru atau salin ujian.';
  end if;
  if tg_op = 'DELETE' then return old; end if; return new;
end $$;
drop trigger if exists trg_lock_question on public.questions;
create trigger trg_lock_question before update or delete on public.questions
  for each row execute function public.lock_used_question();

create or replace function public.lock_used_passage() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.questions q join public.exam_questions eq on eq.question_id = q.id
             join public.attempts a on a.exam_id = eq.exam_id where q.passage_id = old.id) then
    raise exception 'Bacaan sudah dipakai ujian yang pernah dikerjakan.';
  end if;
  if tg_op = 'DELETE' then return old; end if; return new;
end $$;
drop trigger if exists trg_lock_passage on public.passages;
create trigger trg_lock_passage before update or delete on public.passages
  for each row execute function public.lock_used_passage();

create or replace function public.lock_exam_questions() returns trigger language plpgsql as $$
declare v uuid := case when tg_op = 'DELETE' then old.exam_id else new.exam_id end;
begin
  if exists (select 1 from public.attempts where exam_id = v) then
    raise exception 'Ujian ini sudah dikerjakan; daftar soalnya tidak bisa diubah. Gunakan Salin Ujian.';
  end if;
  if tg_op = 'DELETE' then return old; end if; return new;
end $$;
drop trigger if exists trg_lock_exam_q on public.exam_questions;
create trigger trg_lock_exam_q before insert or update or delete on public.exam_questions
  for each row execute function public.lock_exam_questions();

-- ---- RPC guru: simpan ujian sekaligus (kelas + soal) dalam satu transaksi ----
create or replace function public.guru_save_exam(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_status text := coalesce(p->>'status', 'draf');
  v_mulai timestamptz := nullif(p->>'mulai', '')::timestamptz; v_selesai timestamptz := nullif(p->>'selesai', '')::timestamptz;
  v_soal uuid[]; v_old uuid[];
begin
  if not public.is_guru() then raise exception 'Tidak diizinkan'; end if;
  if char_length(trim(coalesce(p->>'nama', ''))) < 1 then raise exception 'Nama ujian wajib diisi'; end if;
  if v_status not in ('draf','dijadwalkan','dibuka','ditutup') then raise exception 'Status tidak valid'; end if;
  if v_mulai is not null and v_selesai is not null and v_selesai <= v_mulai then
    raise exception 'Waktu selesai harus setelah waktu mulai'; end if;
  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_soal from jsonb_array_elements_text(coalesce(p->'soal', '[]'::jsonb)) x;
  if v_status in ('dijadwalkan','dibuka') then
    if coalesce(array_length(v_soal, 1), 0) = 0 then raise exception 'Pilih minimal 1 soal'; end if;
    if exists (select 1 from public.questions where id = any(v_soal) and kunci is null) then
      raise exception 'Ada soal tanpa kunci jawaban. Lengkapi dulu sebelum ujian dibuka/dijadwalkan.'; end if;
    if jsonb_array_length(coalesce(p->'kelas', '[]'::jsonb)) = 0 then raise exception 'Pilih minimal 1 kelas tujuan'; end if;
  end if;
  if v_id is null then
    insert into public.exams (nama, mapel, instruksi, durasi_menit, mulai, selesai, status)
    values (trim(p->>'nama'), p->>'mapel', p->>'instruksi', coalesce((p->>'durasi_menit')::int, 90), v_mulai, v_selesai, v_status)
    returning id into v_id;
  else
    update public.exams set nama = trim(p->>'nama'), mapel = p->>'mapel', instruksi = p->>'instruksi',
      durasi_menit = coalesce((p->>'durasi_menit')::int, 90), mulai = v_mulai, selesai = v_selesai, status = v_status
    where id = v_id;
    if not found then raise exception 'Ujian tidak ditemukan'; end if;
  end if;
  delete from public.exam_classes where exam_id = v_id;
  insert into public.exam_classes (exam_id, class_id, mode)
    select v_id, (x->>'class_id')::uuid, case when x->>'mode' = 'wajib' then 'wajib' else 'opsional' end
    from jsonb_array_elements(coalesce(p->'kelas', '[]'::jsonb)) x;
  select coalesce(array_agg(question_id order by urutan), '{}'::uuid[]) into v_old from public.exam_questions where exam_id = v_id;
  if v_old is distinct from v_soal then
    delete from public.exam_questions where exam_id = v_id;
    insert into public.exam_questions (exam_id, question_id, urutan)
      select v_id, s, o from unnest(v_soal) with ordinality as t(s, o);
  end if;
  return v_id;
end $$;

create or replace function public.guru_copy_exam(p_exam uuid, p_nama text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_new uuid;
begin
  if not public.is_guru() then raise exception 'Tidak diizinkan'; end if;
  insert into public.exams (nama, mapel, instruksi, durasi_menit)
    select left(coalesce(nullif(trim(p_nama), ''), nama || ' (salinan)'), 120), mapel, instruksi, durasi_menit
    from public.exams where id = p_exam returning id into v_new;
  if v_new is null then raise exception 'Ujian tidak ditemukan'; end if;
  insert into public.exam_questions (exam_id, question_id, urutan)
    select v_new, question_id, urutan from public.exam_questions where exam_id = p_exam;   -- soal dipakai bersama, tidak digandakan
  return v_new;
end $$;

create or replace function public.exam_progress_all() returns table (exam_id uuid, class_id uuid, total int, selesai int)
language sql stable security definer set search_path = public as $$
  select ec.exam_id, ec.class_id,
    (select count(*) from public.profiles p where p.class_id = ec.class_id and p.role = 'siswa')::int,
    (select count(distinct a.student_id) from public.attempts a join public.profiles p on p.id = a.student_id
      where a.exam_id = ec.exam_id and a.status = 'selesai' and p.class_id = ec.class_id)::int
  from public.exam_classes ec where public.is_guru();
$$;

-- ---- RLS: tabel bank soal/ujian hanya untuk guru; siswa lewat RPC di atas ----
do $$ declare t text; begin
  foreach t in array array['passages','questions','exams','exam_questions','exam_classes','exam_access'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_guru', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_guru()) with check (public.is_guru())', t || '_guru', t);
  end loop;
end $$;

do $$ declare f text; begin
  foreach f in array array['exam_izin(uuid,uuid)','can_take_exam(uuid,uuid)','list_my_exams()','get_exam_content(uuid)',
      'guru_save_exam(jsonb)','guru_copy_exam(uuid,text)','exam_progress_all()','submit_attempt(uuid,jsonb,int)','get_answer_key(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
