/* Ujian: siswa memilih ujian yang diizinkan; guru mengelola kelas & ujian.
   Semua izin divalidasi di database (RLS + RPC); tampilan hanya mengikuti hasilnya. */
const LEGACY_CONTENT = { q: QUESTIONS, p: PASSAGES };
function useLegacyContent(){ QUESTIONS = LEGACY_CONTENT.q; PASSAGES = LEGACY_CONTENT.p; }
async function useExamContent(examId){
  const { data, error } = await sb.rpc('get_exam_content', { p_exam: examId });
  if(error) throw error;
  const p = data.passages || {}; p._ = { title: 'Soal', text: '' };
  PASSAGES = p;
  QUESTIONS = (data.questions || []).map(q => Object.assign({}, q, { pid: q.pid || '_' }));
  return data.exam;
}
function resetExamPick(){
  state.examId = null; useLegacyContent();
  $('examPicked').textContent = 'Latihan umum (50 soal hikayat)';
}
const fmtMaybe = v => v ? fmtDate(v) : '—';

/* ---------- SISWA: daftar ujian ---------- */
async function openExamList(){
  needOnline();
  const { data, error } = await sb.rpc('list_my_exams');
  if(error) throw error;
  const box = $('examList');
  box.innerHTML = (data && data.length) ? data.map(e =>
    '<div class="exam-item"><div><b>' + escapeHtml(e.nama) + '</b> ' +
    '<span class="chip ' + (e.izin === 'wajib' ? 'wajib' : '') + '">' + (e.izin === 'wajib' ? 'Wajib' : 'Opsional') + '</span> ' +
    '<span class="chip">' + escapeHtml(e.status) + '</span></div>' +
    '<div class="hint">' + escapeHtml(e.mapel || '') + ' · Kelas: ' + escapeHtml(e.kelas || '—') + ' · ' + e.durasi_menit + ' menit</div>' +
    '<div class="hint">Mulai: ' + fmtMaybe(e.mulai) + ' · Selesai: ' + fmtMaybe(e.selesai) + '</div>' +
    (e.instruksi ? '<div class="hint">' + escapeHtml(e.instruksi) + '</div>' : '') +
    '<button class="btn-sm" data-pick="' + escapeHtml(e.id) + '" data-nama="' + escapeHtml(e.nama) + '"' + (e.bisa_mulai ? '' : ' disabled') + '>' +
    (e.bisa_mulai ? 'Pilih ujian ini' : 'Belum/tidak dibuka') + '</button></div>').join('')
    : '<p class="hint">Belum ada ujian yang tersedia untuk Anda.</p>';
  box.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => runBusy(b, async () => {
    await useExamContent(b.dataset.pick);
    state.examId = b.dataset.pick;
    $('examPicked').textContent = b.dataset.nama;
    toast('Ujian dipilih. Centang persetujuan kamera lalu lanjut.', 'ok');
    showScreen('home');
  })));
  showScreen('exams');
}

/* ---------- GURU: kelola kelas & ujian ---------- */
const MG = { classes: [], exams: [], bank: [], prog: [], editStatus: null };

async function openManage(){
  needOnline();
  const rs = await Promise.all([
    sb.from('classes').select('*').order('nama'),
    sb.from('exams').select('*, exam_classes(class_id, mode), exam_questions(question_id, urutan)').order('created_at', { ascending: false }),
    sb.from('questions').select('id, topik, pertanyaan, kunci').order('created_at').order('id'),
    sb.rpc('exam_progress_all')
  ]);
  rs.forEach(r => { if(r.error) throw r.error; });
  MG.classes = rs[0].data; MG.exams = rs[1].data; MG.bank = rs[2].data; MG.prog = rs[3].data || [];
  renderManage(); showScreen('manage');
}

function renderManage(){
  $('mgKelas').innerHTML = MG.classes.map(c =>
    '<div class="exam-item"><b>' + escapeHtml(c.nama) + '</b>' + (c.aktif ? '' : ' <span class="chip">nonaktif</span>') +
    ' <button class="btn-sm" data-ren="' + c.id + '">Ubah nama</button>' +
    ' <button class="btn-sm" data-tog="' + c.id + '">' + (c.aktif ? 'Nonaktifkan' : 'Aktifkan') + '</button></div>').join('')
    || '<p class="hint">Belum ada kelas.</p>';
  const cari = $('mgCari').value.trim().toLowerCase();
  const cname = id => (MG.classes.find(c => c.id === id) || {}).nama || '?';
  const list = MG.exams.filter(e => {
    const kls = e.exam_classes.map(x => cname(x.class_id)).join(' ');
    return !cari || (e.nama + ' ' + (e.mapel || '') + ' ' + e.status + ' ' + kls).toLowerCase().includes(cari);
  });
  $('mgUjian').innerHTML = list.map(e => {
    const kls = e.exam_classes.map(x => {
      const p = MG.prog.find(r => r.exam_id === e.id && r.class_id === x.class_id);
      return escapeHtml(cname(x.class_id)) + (x.mode === 'wajib' ? ' (wajib)' : '') + (p ? ' ' + p.selesai + '/' + p.total + ' selesai' : '');
    }).join('; ') || 'belum ada kelas';
    return '<div class="exam-item"><b>' + escapeHtml(e.nama) + '</b> <span class="chip">' + escapeHtml(e.status) + '</span>' +
      '<div class="hint">' + escapeHtml(e.mapel || '') + ' · ' + e.exam_questions.length + ' soal · ' + e.durasi_menit + ' menit</div>' +
      '<div class="hint">Kelas: ' + kls + '</div>' +
      '<button class="btn-sm" data-edit="' + e.id + '">Edit</button> <button class="btn-sm" data-copy="' + e.id + '">Salin</button></div>';
  }).join('') || '<p class="hint">Tidak ada ujian.</p>';
}

function toLocalInput(iso){
  if(!iso) return '';
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function showForm(ex){
  const mode = new Map(ex ? ex.exam_classes.map(x => [x.class_id, x.mode]) : []);
  const order = new Map(ex ? ex.exam_questions.map(x => [x.question_id, x.urutan]) : []);
  MG.editStatus = ex ? ex.status : null;
  $('fmJudul').textContent = ex ? 'Edit Ujian' : 'Ujian Baru';
  $('fmId').value = ex ? ex.id : '';
  $('fmNama').value = ex ? ex.nama : ''; $('fmMapel').value = ex ? (ex.mapel || '') : '';
  $('fmDurasi').value = ex ? ex.durasi_menit : 90;
  $('fmMulai').value = ex ? toLocalInput(ex.mulai) : ''; $('fmSelesai').value = ex ? toLocalInput(ex.selesai) : '';
  $('fmStatus').value = ex ? ex.status : 'draf'; $('fmInstruksi').value = ex ? (ex.instruksi || '') : '';
  $('fmKelas').innerHTML = MG.classes.filter(c => c.aktif || mode.has(c.id)).map(c =>
    '<label class="chk"><input type="checkbox" data-cls="' + c.id + '"' + (mode.has(c.id) ? ' checked' : '') + '> ' + escapeHtml(c.nama) +
    ' <select data-mode="' + c.id + '"><option value="opsional">Opsional</option><option value="wajib"' +
    (mode.get(c.id) === 'wajib' ? ' selected' : '') + '>Wajib</option></select></label>').join('');
  const bank = MG.bank.slice().sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
  $('fmSoal').innerHTML = bank.map((q, i) =>
    '<label class="chk"><input type="checkbox" data-soal="' + q.id + '"' + (order.has(q.id) ? ' checked' : '') + '> ' + (i + 1) + '. ' +
    escapeHtml(q.pertanyaan.slice(0, 90)) + (q.kunci == null ? ' <span class="chip wajib">tanpa kunci</span>' : '') + '</label>').join('')
    || '<p class="hint">Bank soal kosong.</p>';
  $('mgForm').hidden = false; $('mgForm').scrollIntoView({ behavior: 'smooth' });
}

async function saveForm(){
  const nama = $('fmNama').value.trim();
  const durasi = parseInt($('fmDurasi').value, 10);
  const iso = v => v ? new Date(v).toISOString() : null;
  if(!nama){ toast('Nama ujian wajib diisi.', 'warn'); return; }
  if(!(durasi >= 1 && durasi <= 600)){ toast('Durasi harus 1–600 menit.', 'warn'); return; }
  const mulai = iso($('fmMulai').value), selesai = iso($('fmSelesai').value);
  if(mulai && selesai && new Date(selesai) <= new Date(mulai)){ toast('Waktu selesai harus setelah waktu mulai.', 'warn'); return; }
  if(MG.editStatus === 'dibuka'){
    const ok = await confirmDialog({ title: 'Ujian sedang dibuka', yes: 'Lanjut simpan', danger: false,
      message: 'Mengubah kelas tujuan/jadwal tidak menghapus jawaban atau nilai yang sudah tersimpan, tetapi kelas yang dicabut tidak bisa memulai ujian baru.' });
    if(!ok) return;
  }
  const fk = $('fmKelas');
  const p = { id: $('fmId').value || null, nama, mapel: $('fmMapel').value.trim(), instruksi: $('fmInstruksi').value.trim(),
    durasi_menit: durasi, mulai, selesai, status: $('fmStatus').value,
    kelas: [...fk.querySelectorAll('input[data-cls]:checked')].map(i => ({ class_id: i.dataset.cls, mode: fk.querySelector('select[data-mode="' + i.dataset.cls + '"]').value })),
    soal: [...$('fmSoal').querySelectorAll('input[data-soal]:checked')].map(i => i.dataset.soal) };
  const { error } = await sb.rpc('guru_save_exam', { p });
  if(error) throw error;
  toast('Ujian tersimpan.', 'ok'); $('mgForm').hidden = true; await openManage();
}

const setAll = (box, attr, v) => $(box).querySelectorAll('input[' + attr + ']').forEach(i => { i.checked = v; });

(function wireUjian(){
  $('btnKeUjian').addEventListener('click', () => runBusy($('btnKeUjian'), openExamList));
  $('btnKelola').addEventListener('click', () => runBusy($('btnKelola'), openManage));
  $('btnExamBack').addEventListener('click', () => showScreen('home'));
  $('btnManageBack').addEventListener('click', () => { $('mgForm').hidden = true; showScreen('home'); });
  $('mgCari').addEventListener('input', renderManage);
  $('btnUjianBaru').addEventListener('click', () => showForm(null));
  $('fmBatal').addEventListener('click', () => { $('mgForm').hidden = true; });
  $('fmSimpan').addEventListener('click', () => runBusy($('fmSimpan'), saveForm));
  $('fmKelasAll').addEventListener('click', () => setAll('fmKelas', 'data-cls', true));
  $('fmKelasNone').addEventListener('click', () => setAll('fmKelas', 'data-cls', false));
  $('fmSoalAll').addEventListener('click', () => setAll('fmSoal', 'data-soal', true));
  $('fmSoalNone').addEventListener('click', () => setAll('fmSoal', 'data-soal', false));

  $('btnKelasTambah').addEventListener('click', () => runBusy($('btnKelasTambah'), async () => {
    const nama = $('inpKelasBaru').value.trim();
    if(!nama || nama.length > 30){ toast('Nama kelas 1–30 karakter.', 'warn'); return; }
    const { error } = await sb.from('classes').insert({ nama });
    if(error) throw (error.code === '23505' ? new Error('Nama kelas sudah ada.') : error);
    $('inpKelasBaru').value = ''; toast('Kelas ditambahkan.', 'ok'); await openManage();
  }));
  $('mgKelas').addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b) return;
    const c = MG.classes.find(x => x.id === (b.dataset.ren || b.dataset.tog)); if(!c) return;
    runBusy(b, async () => {
      let patch;
      if(b.dataset.ren){
        const nama = (prompt('Nama kelas baru:', c.nama) || '').trim();
        if(!nama || nama === c.nama) return;
        patch = { nama };
      } else patch = { aktif: !c.aktif };
      const { error } = await sb.from('classes').update(patch).eq('id', c.id);
      if(error) throw (error.code === '23505' ? new Error('Nama kelas sudah ada.') : error);
      toast('Kelas diperbarui.', 'ok'); await openManage();
    });
  });
  $('mgUjian').addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b) return;
    if(b.dataset.edit) showForm(MG.exams.find(x => x.id === b.dataset.edit));
    if(b.dataset.copy) runBusy(b, async () => {
      const src = MG.exams.find(x => x.id === b.dataset.copy);
      const nama = prompt('Nama ujian salinan:', src.nama + ' (salinan)');
      if(nama === null) return;
      const { error } = await sb.rpc('guru_copy_exam', { p_exam: src.id, p_nama: nama });
      if(error) throw error;
      toast('Ujian disalin (soal dipakai bersama). Pilih kelas tujuannya.', 'ok'); await openManage();
    });
  });
})();
