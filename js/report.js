/* Laporan: statistik, tabel, detail, ekspor CSV, edit & hapus per data. */
const RP = { attempts: [], snaps: [], snapsByAttempt: {}, students: [] };

async function loadReport(){
  needOnline();
  const guru = isGuru();
  const jobs = [
    fetchAll(() => sb.from('attempts')
      .select('id,student_id,started_at,finished_at,skor,benar,salah,kosong,total,durasi_detik,profiles(nama,kelas)')
      .eq('status', 'selesai').order('finished_at', { ascending: false }).order('id')),
    fetchAll(() => sb.from('snapshots')
      .select('id,attempt_id,kind,storage_path,elapsed_label,taken_at').order('taken_at', { ascending: true }).order('id'))
  ];
  if(guru) jobs.push(fetchAll(() => sb.from('profiles').select('id,nama,kelas,role').eq('role', 'siswa').order('nama').order('id')));
  const [attempts, snaps, students] = await Promise.all(jobs);
  RP.attempts = attempts;
  RP.snaps = snaps;
  RP.students = students || [];
  RP.snapsByAttempt = {};
  snaps.forEach(s => { (RP.snapsByAttempt[s.attempt_id] = RP.snapsByAttempt[s.attempt_id] || []).push(s); });
}

/* Muat ulang semua bagian laporan (dipanggil setelah tambah/ubah/hapus) */
async function refreshReport(){
  await loadReport();
  paintReport();
  if(isGuru()) await loadGallery(true);
}

async function openReport(){
  const guru = isGuru();
  $('cardSiswa').hidden = !guru;
  $('cardGallery').hidden = !guru;
  $('rpSub').textContent = guru ? 'Database Supabase · Guru' : 'Riwayat nilai Anda';
  showScreen('report');
  await runBusy(null, refreshReport);
}

function paintReport(){
  const results = RP.attempts;
  $('rpSiswa').textContent = new Set(results.map(r => r.student_id)).size;
  $('rpPercobaan').textContent = results.length;
  $('rpFoto').textContent = RP.snaps.filter(s => s.kind === 'live').length;
  if(results.length){
    const skors = results.map(r => r.skor);
    $('rpRata').textContent = Math.round(skors.reduce((a, b) => a + b, 0) / skors.length);
    $('rpMax').textContent = Math.max(...skors);
    $('rpMin').textContent = Math.min(...skors);
  } else { $('rpRata').textContent = $('rpMax').textContent = $('rpMin').textContent = '0'; }

  const sel = $('rpFilterKelas'), cur = sel.value;
  const kelasSet = [...new Set(results.map(r => r.profiles && r.profiles.kelas).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Semua Kelas</option>' +
    kelasSet.map(k => '<option value="'+escapeHtml(k)+'">'+escapeHtml(k)+'</option>').join('');
  if(kelasSet.includes(cur)) sel.value = cur;

  paintReportTable();
  paintStudents();
}

function paintReportTable(){
  const q = $('rpSearch').value.toLowerCase().trim();
  const fk = $('rpFilterKelas').value;
  let rows = RP.attempts.slice();
  if(q) rows = rows.filter(r => (r.profiles ? r.profiles.nama : '').toLowerCase().includes(q));
  if(fk) rows = rows.filter(r => r.profiles && r.profiles.kelas === fk);

  const body = $('rpBody');
  $('rpEmpty').style.display = rows.length ? 'none' : 'block';
  const guru = isGuru();
  body.innerHTML = rows.map((r, idx) => {
    const kls = r.skor >= 75 ? 's-a' : r.skor >= 55 ? 's-b' : 's-c';
    const list = RP.snapsByAttempt[r.id] || [];
    const absen = list.find(s => s.kind === 'absen');
    const liveCount = list.filter(s => s.kind === 'live').length;
    const thumb = absen
      ? '<img class="photo-thumb" data-path="'+escapeHtml(absen.storage_path)+'" data-open-snap="'+absen.id+'" alt="Foto">'
      : '<span class="hint">—</span>';
    const nm = r.profiles ? r.profiles.nama : '—', kl = r.profiles ? r.profiles.kelas : '—';
    return '<tr><td>'+(idx+1)+'</td><td>'+thumb+'</td><td><b>'+escapeHtml(nm)+'</b></td><td>'+escapeHtml(kl)+'</td>' +
      '<td>'+fmtDate(r.finished_at)+'</td><td><span class="badge-skor '+kls+'">'+r.skor+'</span></td>' +
      '<td style="color:#16a34a;font-weight:700">'+r.benar+'</td><td style="color:#dc2626;font-weight:700">'+r.salah+'</td>' +
      '<td>'+fmtTime(r.durasi_detik)+'</td><td><span style="color:#dc2626;font-weight:700">🔴 '+liveCount+'</span></td>' +
      '<td class="td-actions"><button class="btn-sm" data-detail="'+r.id+'">Detail</button>' +
      (guru ? '<button class="btn-sm btn-delete" data-del-attempt="'+r.id+'" aria-label="Hapus laporan">🗑 Hapus</button>' : '') +
      '</td></tr>';
  }).join('');
  hydrateImages(body);
}

function paintStudents(){
  if(!isGuru()) return;
  const counts = {};
  RP.attempts.forEach(a => { counts[a.student_id] = (counts[a.student_id] || 0) + 1; });
  $('siswaBody').innerHTML = RP.students.length ? RP.students.map(s =>
    '<tr><td><b>'+escapeHtml(s.nama)+'</b></td><td>'+escapeHtml(s.kelas)+'</td><td>'+(counts[s.id] || 0)+'</td>' +
    '<td class="td-actions"><button class="btn-sm" data-edit-student="'+s.id+'">✏️ Edit</button>' +
    '<button class="btn-sm btn-delete" data-del-student="'+s.id+'">🗑 Hapus data</button></td></tr>'
  ).join('') : '<tr><td colspan="4" class="hint" style="padding:16px">Belum ada siswa terdaftar.</td></tr>';
}

$('rpSearch').addEventListener('input', paintReportTable);
$('rpFilterKelas').addEventListener('change', paintReportTable);
$('btnRefresh').addEventListener('click', () => runBusy($('btnRefresh'), refreshReport));

/* ---------- klik di tabel laporan ---------- */
$('rpBody').addEventListener('click', e => {
  const d = e.target.closest('[data-detail]');
  if(d) return openDetail(d.dataset.detail);
  const del = e.target.closest('[data-del-attempt]');
  if(del) return deleteAttemptFlow(del.dataset.delAttempt, del);
  const img = e.target.closest('[data-open-snap]');
  if(img){
    const s = RP.snaps.find(x => x.id === img.dataset.openSnap);
    if(s) openPhotoModal(s, refreshReport);
  }
});

/* Hapus SATU laporan berdasarkan ID (+ foto absen & snapshot-nya) */
async function deleteAttemptFlow(id, btn, after){
  const r = RP.attempts.find(x => x.id === id);
  if(!r) return;
  const n = (RP.snapsByAttempt[id] || []).length;
  const ok = await confirmDialog({
    title: 'Hapus laporan ini?',
    message: (r.profiles ? r.profiles.nama + ' · ' + r.profiles.kelas : '') + '\nSkor ' + r.skor + ' — ' + fmtDate(r.finished_at) +
      '\n\nNilai dan ' + n + ' foto (absen + snapshot) ikut dihapus permanen.'
  });
  if(!ok) return;
  await runBusy(btn, async () => {
    await purgeAttempts([id]);
    toast('Laporan dihapus.', 'ok');
    if(after) after();
    await refreshReport();
  });
}

/* ---------- detail laporan ---------- */
async function openDetail(id){
  const r = RP.attempts.find(x => x.id === id);
  if(!r) return;
  openModal((r.profiles ? r.profiles.nama + ' · ' + r.profiles.kelas : 'Detail'), '<div class="empty" style="padding:20px"><div class="spinner" style="margin:0 auto;border-color:#c7d2fe;border-top-color:#4c1d95"></div></div>');
  try{
    needOnline();
    const [{ data: att, error: e1 }, { data: kunci, error: e2 }] = await Promise.all([
      sb.from('attempts').select('answers, exam_id').eq('id', id).single(),
      sb.rpc('get_answer_key', { p_attempt: id })
    ]);
    if(e1) throw e1; if(e2) throw e2;

    const snaps = RP.snapsByAttempt[id] || [];
    let html = '<div class="info-bar"><b>Skor:</b> '+r.skor+' | <b>Benar:</b> '+r.benar+' | <b>Salah:</b> '+r.salah+
      ' | <b>Kosong:</b> '+r.kosong+' | <b>Durasi:</b> '+fmtTime(r.durasi_detik)+
      ' | <b>Foto:</b> '+snaps.length+' | <b>Tanggal:</b> '+fmtDate(r.finished_at)+'</div>';
    if(snaps.length){
      html += '<h3>🔴 Foto &amp; Snapshot LIVE ('+snaps.length+')</h3><div class="photo-grid" id="detailPhotos" style="margin-bottom:16px">' +
        snaps.map(s => '<div class="photo-card"><img data-path="'+escapeHtml(s.storage_path)+'" data-snap="'+s.id+'" alt="Foto">' +
          '<span class="kind">'+(s.kind === 'absen' ? 'ABSEN' : 'LIVE')+'</span>' +
          (isGuru() ? '<button class="x" data-del-snap="'+s.id+'" aria-label="Hapus foto">✕</button>' : '') +
          '<div class="cap">'+escapeHtml(s.elapsed_label || '')+'</div></div>').join('') + '</div>';
    }
    if(att.exam_id) await useExamContent(att.exam_id); else useLegacyContent();
    html += reviewHtml(att.answers || [], kunci);
    if(isGuru()) html += '<button class="btn-delete" id="btnDelFromDetail" style="width:100%;margin-top:10px">🗑 Hapus laporan ini</button>';
    $('modalBody').innerHTML = html;
    hydrateImages($('modalBody'));

    const dp = $('detailPhotos');
    if(dp) dp.addEventListener('click', ev => {
      const del = ev.target.closest('[data-del-snap]');
      const img = ev.target.closest('img[data-snap]');
      const sid = del ? del.dataset.delSnap : img ? img.dataset.snap : null;
      const s = snaps.find(x => x.id === sid);
      if(!s) return;
      if(del) deleteSnapshotFlow(s, del, async () => { closeModal(); await refreshReport(); openDetail(id); });
      else openPhotoModal(s, () => { refreshReport().then(() => openDetail(id)); });
    });
    const bd = $('btnDelFromDetail');
    if(bd) bd.onclick = () => deleteAttemptFlow(id, bd, closeModal);
  }catch(e){
    $('modalBody').innerHTML = '<div class="msg">'+escapeHtml(friendlyError(e))+'</div>';
  }
}

/* ---------- data siswa: edit & hapus data ---------- */
$('siswaBody').addEventListener('click', e => {
  const ed = e.target.closest('[data-edit-student]');
  if(ed) return openEditStudent(ed.dataset.editStudent);
  const del = e.target.closest('[data-del-student]');
  if(del) return deleteStudentDataFlow(del.dataset.delStudent, del);
});

function openEditStudent(id){
  const s = RP.students.find(x => x.id === id);
  if(!s) return;
  openModal('✏️ Edit Siswa',
    '<div class="field"><label for="edNama">Nama Lengkap</label><input id="edNama" maxlength="80" value="'+escapeHtml(s.nama)+'"></div>' +
    '<div class="field"><label for="edKelas">Kelas</label><input id="edKelas" maxlength="30" value="'+escapeHtml(s.kelas)+'"></div>' +
    '<div class="row"><button class="ghost" id="edCancel" style="margin:0">Batal</button>' +
    '<button class="btn-main" id="edSave" style="margin:0">Simpan</button></div>');
  $('edCancel').onclick = closeModal;
  $('edSave').onclick = () => {
    const nama = $('edNama').value.trim(), kelas = $('edKelas').value.trim();
    if(nama.length < 3){ toast('Nama minimal 3 karakter.', 'warn'); return; }
    if(!kelas){ toast('Kelas wajib diisi.', 'warn'); return; }
    runBusy($('edSave'), async () => {
      needOnline();
      const { data, error } = await sb.from('profiles').update({ nama, kelas }).eq('id', id).select('id');
      if(error) throw error;
      if(!data || !data.length) throw new Error('Data tidak berubah (tidak diizinkan).');
      toast('Data siswa disimpan.', 'ok');
      closeModal();
      await refreshReport();
    });
  };
}

/* Hapus semua nilai & foto SATU siswa (akun login tetap) */
async function deleteStudentDataFlow(id, btn){
  const s = RP.students.find(x => x.id === id);
  if(!s) return;
  const ok = await confirmDialog({
    title: 'Hapus data siswa ini?',
    message: s.nama + ' · ' + s.kelas + '\n\nSemua nilai, absensi, dan foto siswa ini dihapus permanen. Akun login tetap ada. Data siswa lain tidak terpengaruh.'
  });
  if(!ok) return;
  await runBusy(btn, async () => {
    needOnline();
    const rows = await fetchAll(() => sb.from('attempts').select('id').eq('student_id', id).order('id'));
    if(!rows.length){ toast('Siswa ini belum punya data.', 'ok'); return; }
    showLoading('Menghapus data ' + s.nama + '…');
    try{ await purgeAttempts(rows.map(r => r.id)); } finally{ hideLoading(); }
    toast('Data ' + s.nama + ' dihapus.', 'ok');
    await refreshReport();
  });
}

/* ---------- ekspor CSV ---------- */
$('btnExport').addEventListener('click', () => {
  if(!RP.attempts.length){ toast('Tidak ada data.', 'warn'); return; }
  const rows = [['No','Nama','Kelas','Tanggal','Skor','Benar','Salah','Kosong','Durasi (dtk)','Snapshot LIVE','Ada Foto Absen']];
  RP.attempts.forEach((r, i) => {
    const list = RP.snapsByAttempt[r.id] || [];
    rows.push([i+1, r.profiles ? r.profiles.nama : '', r.profiles ? r.profiles.kelas : '', fmtDate(r.finished_at),
      r.skor, r.benar, r.salah, r.kosong, r.durasi_detik,
      list.filter(s => s.kind === 'live').length, list.some(s => s.kind === 'absen') ? 'Ya' : 'Tidak']);
  });
  // tanda ' di depan sel yang diawali = + - @ mencegah rumus Excel berbahaya
  const safe = c => { const t = String(c); return /^[=+\-@]/.test(t) ? "'" + t : t; };
  const csv = rows.map(row => row.map(c => '"' + safe(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'laporan_hikayat_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if(e.target.id === 'modal') closeModal(); });
