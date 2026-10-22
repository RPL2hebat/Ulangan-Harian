/* Absen kamera, kuis, snapshot LIVE, hasil. Alur & tampilan asli dipertahankan;
   data kini disimpan ke Supabase (tabel attempts/snapshots + Storage foto). */

let state = {
  answers: new Array(QUESTIONS.length).fill(null),
  index: 0, timerId: null, elapsed: 0, passageCollapsed: false,
  attemptId: null, consentAt: null, fotoAbsenTmp: null,
  liveTimerId: null, liveClockId: null, liveStartTime: null,
  liveSnapshotCount: 0, liveSnapshotList: [], absenClockId: null,
  uploadWarned: false
};
let absenStream = null;
let kuisStream = null;
let uploadChain = Promise.resolve();   // unggahan foto berjalan satu per satu

/* ---------- unggah foto ke Storage + metadata ke database ---------- */
async function uploadPhoto(kind, dataUrl, label){
  const id = uuid();
  const path = currentUser.id + '/' + state.attemptId + '/' + kind + '_' + id + '.jpg';
  // 1) metadata dulu (RLS memastikan hanya sesi milik sendiri yang berjalan)
  const { error: e1 } = await sb.from('snapshots').insert({
    id, attempt_id: state.attemptId, student_id: currentUser.id,
    kind, storage_path: path, elapsed_label: label || null
  });
  if(e1) throw e1;
  // 2) lalu file; bila gagal, batalkan metadata supaya tidak ada baris yatim
  const blob = await dataUrlToBlob(dataUrl);
  const { error: e2 } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if(e2){
    await sb.from('snapshots').delete().eq('id', id);
    throw e2;
  }
}
function queueUpload(kind, dataUrl, label){
  const p = uploadChain.then(() => uploadPhoto(kind, dataUrl, label));
  uploadChain = p.catch(() => {});
  return p;
}

/* ---------- membersihkan kamera ---------- */
function releaseAllCamera(){
  clearInterval(state.timerId);
  clearInterval(state.absenClockId);
  stopLiveMonitoring();
  stopStream(absenStream); absenStream = null;
  stopStream(kuisStream);  kuisStream = null;
  $('camFloat').classList.remove('on');
}
window.addEventListener('pagehide', releaseAllCamera);

/* ---------- LIVE MONITORING ---------- */
function startLiveMonitoring(reset){
  if(reset || !state.liveStartTime){
    state.liveStartTime = Date.now();
    state.liveSnapshotCount = 0;
    state.liveSnapshotList = [];
    state.uploadWarned = false;
  }
  clearInterval(state.liveClockId);
  state.liveClockId = setInterval(()=>{
    const flTimer = $('flTimer');
    if(flTimer) flTimer.textContent = fmtTime((Date.now() - state.liveStartTime) / 1000);
  }, 1000);

  clearInterval(state.liveTimerId);
  state.liveTimerId = setInterval(()=>{ takeLiveSnapshot(); }, LIVE_SNAPSHOT_INTERVAL_MS);
  if(reset) setTimeout(()=>takeLiveSnapshot(), 1500);   // snapshot pertama
}

function takeLiveSnapshot(){
  if(!kuisStream || !kuisStream.active || !state.attemptId) return Promise.resolve();
  if(state.liveSnapshotCount >= LIVE_SNAPSHOT_MAX) return Promise.resolve();
  const v = $('videoKuis');
  if(!v || v.readyState < 2) return Promise.resolve();

  let data;
  try{ data = capturePhoto(v, IS_MOBILE ? 180 : 220, 0.5); }
  catch(e){ console.warn('Snapshot gagal:', e); return Promise.resolve(); }

  const label = fmtTime((Date.now() - state.liveStartTime) / 1000);
  const snap = { time: label, data, ts: new Date().toISOString() };
  state.liveSnapshotList.push(snap);
  state.liveSnapshotCount++;
  const counter = $('flCounter');
  if(counter) counter.textContent = state.liveSnapshotCount + ' 📸';

  return queueUpload('live', data, label).catch(err=>{
    console.warn('Unggah snapshot gagal:', err);
    state.liveSnapshotCount = Math.max(0, state.liveSnapshotCount - 1);
    const i = state.liveSnapshotList.indexOf(snap);
    if(i >= 0) state.liveSnapshotList.splice(i, 1);
    if(counter) counter.textContent = state.liveSnapshotCount + ' 📸';
    if(!state.uploadWarned){
      state.uploadWarned = true;
      toast('Snapshot belum terunggah (koneksi?). Kuis tetap berjalan.', 'warn', 5000);
    }
  });
}

function stopLiveMonitoring(){
  clearInterval(state.liveTimerId);
  clearInterval(state.liveClockId);
  state.liveTimerId = null;
  state.liveClockId = null;
}

function watchTrack(stream){
  const track = stream.getVideoTracks()[0];
  if(!track) return;
  track.addEventListener('ended',  ()=>$('flStop').classList.add('show'));
  track.addEventListener('mute',   ()=>$('flStop').classList.add('show'));
  track.addEventListener('unmute', ()=>$('flStop').classList.remove('show'));
}

/* ---------- INFO KEAMANAN (HTTPS) ---------- */
(function checkSecure(){
  const el = $('secureInfo');
  if(!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
    el.className = 'info-bar info-warn mt';
    el.innerHTML = '⚠️ <b>Perhatian:</b> Kamera LIVE hanya berjalan di <b>HTTPS</b> atau <b>localhost</b>. ' +
      'Saat ini: <b>' + location.protocol + '</b>. Jika kamera gagal, gunakan tombol <b>Upload Foto</b>.';
  } else {
    el.innerHTML = '✅ Kamera depan siap <b>LIVE streaming</b>. Snapshot otomatis tiap 30 detik.';
  }
})();

/* ---------- ABSEN ---------- */
$('btnLanjut').addEventListener('click', ()=> runBusy($('btnLanjut'), async ()=>{
  if(!$('chkConsent').checked){
    toast('Centang persetujuan kamera terlebih dahulu.', 'warn');
    $('chkConsent').focus();
    return;
  }
  state.consentAt = new Date().toISOString();
  state.fotoAbsenTmp = null;

  $('absenNama').textContent = currentProfile.nama;
  $('absenKelas').textContent = currentProfile.kelas;
  $('camBoxAbsen').classList.remove('captured');
  $('camError').classList.remove('show');
  $('btnAmbilFoto').style.display = 'block';
  $('btnUlangFoto').style.display = 'none';
  $('btnKonfirmasiAbsen').disabled = true;
  $('btnKonfirmasiAbsen').textContent = '✓ Konfirmasi Absen & Mulai LIVE';
  showScreen('absen');

  clearInterval(state.absenClockId);
  const absenStart = Date.now();
  $('absenLiveTimer').textContent = '00:00';
  state.absenClockId = setInterval(()=>{
    $('absenLiveTimer').textContent = fmtTime((Date.now() - absenStart) / 1000);
  }, 1000);

  stopStream(absenStream);
  const res = await startFrontCamera($('videoAbsen'));
  if(res.ok){
    absenStream = res.stream;
    $('btnAmbilFoto').disabled = false;
    $('btnUploadFoto').style.display = 'none';
    $('btnKonfirmasiAbsen').disabled = true;
  } else {
    absenStream = null;
    $('camError').classList.add('show');
    $('camErrorMsg').textContent = res.reason;
    $('btnAmbilFoto').disabled = true;
    $('btnUploadFoto').style.display = 'block';
    $('btnKonfirmasiAbsen').disabled = false;
    $('btnKonfirmasiAbsen').textContent = '✓ Lanjut Tanpa Foto';
  }
}));

$('btnAmbilFoto').addEventListener('click', ()=>{
  const v = $('videoAbsen');
  if(v.readyState < 2){ toast('Kamera belum siap. Tunggu sebentar.', 'warn'); return; }
  const data = capturePhoto(v, IS_MOBILE ? 240 : 320, 0.6);
  state.fotoAbsenTmp = data;
  $('fotoAbsenPreview').src = data;
  $('camBoxAbsen').classList.add('captured');
  $('btnAmbilFoto').style.display = 'none';
  $('btnUlangFoto').style.display = 'block';
  $('btnKonfirmasiAbsen').disabled = false;
});

$('btnUlangFoto').addEventListener('click', async ()=>{
  state.fotoAbsenTmp = null;
  $('camBoxAbsen').classList.remove('captured');
  $('btnAmbilFoto').style.display = 'block';
  $('btnUlangFoto').style.display = 'none';
  $('btnKonfirmasiAbsen').disabled = true;

  if(!absenStream || !absenStream.active){
    stopStream(absenStream);
    const res = await startFrontCamera($('videoAbsen'));
    if(res.ok){ absenStream = res.stream; $('btnAmbilFoto').disabled = false; }
    else {
      $('camError').classList.add('show');
      $('camErrorMsg').textContent = res.reason;
      $('btnUploadFoto').style.display = 'block';
    }
  }
});

$('btnUploadFoto').addEventListener('click', ()=>$('fileFallback').click());

$('fileFallback').addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  if(!file.type.startsWith('image/')){ toast('File harus berupa gambar.', 'warn'); return; }
  if(file.size > 8*1024*1024){ toast('Ukuran file maksimal 8MB.', 'warn'); return; }
  let data = await readFileAsDataURL(file);
  data = await compressDataURL(data, IS_MOBILE ? 260 : 340, 0.65);
  state.fotoAbsenTmp = data;
  $('fotoAbsenPreview').src = data;
  $('camBoxAbsen').classList.add('captured');
  $('btnAmbilFoto').style.display = 'none';
  $('btnUploadFoto').style.display = 'none';
  $('btnUlangFoto').style.display = 'block';
  $('btnKonfirmasiAbsen').disabled = false;
  $('camError').classList.remove('show');
  e.target.value = '';
});

$('btnBatalAbsen').addEventListener('click', ()=>{
  stopStream(absenStream); absenStream = null;
  clearInterval(state.absenClockId);
  showScreen('home');
  refreshActiveList();
});

/* Membuat percobaan baru di database & menyiapkan state */
async function beginAttempt(){
  needOnline();
  const { data, error } = await sb.from('attempts')
    .insert({ student_id: currentUser.id, consent_at: state.consentAt, exam_id: state.examId || null })
    .select('id').single();
  if(error) throw error;
  state.attemptId = data.id;
  state.answers = new Array(QUESTIONS.length).fill(null);
  state.index = 0;
  state.elapsed = 0;
  state.passageCollapsed = false;
  state.liveStartTime = null;
  state.liveSnapshotList = [];
  state.liveSnapshotCount = 0;
  $('tbNama').textContent = currentProfile.nama;
  $('tbKelas').textContent = currentProfile.kelas;
  $('flInfo').textContent = currentProfile.nama + ' · ' + currentProfile.kelas;
  $('flCounter').textContent = '0 📸';
}

/* Menyalakan kamera LIVE + timer lalu membuka layar kuis */
async function startQuizUI(){
  const camRes = await startFrontCamera($('videoKuis'));
  if(camRes.ok){
    kuisStream = camRes.stream;
    $('camFloat').classList.add('on');
    $('flStop').classList.remove('show');
    watchTrack(kuisStream);
    startLiveMonitoring(true);
  } else {
    $('camFloat').classList.remove('on');
    toast('Kamera LIVE tidak aktif: ' + camRes.reason, 'warn', 7000);
  }
  startTimer();
  renderQuestion();
  updateProgress();
  showScreen('quiz');
}

$('btnKonfirmasiAbsen').addEventListener('click', ()=> runBusy($('btnKonfirmasiAbsen'), async ()=>{
  await beginAttempt();
  stopStream(absenStream); absenStream = null;
  clearInterval(state.absenClockId);
  if(state.fotoAbsenTmp){
    try{ await uploadPhoto('absen', state.fotoAbsenTmp, 'Absen'); }
    catch(e){ toast('Foto absen gagal diunggah: ' + friendlyError(e), 'warn', 6000); }
  }
  await startQuizUI();
}));

/* Restart kamera dari tombol di kamera mengambang (tidak mereset penghitung snapshot) */
$('btnRestartCam').addEventListener('click', async ()=>{
  stopStream(kuisStream);
  $('flStop').classList.remove('show');
  const res = await startFrontCamera($('videoKuis'));
  if(res.ok){
    kuisStream = res.stream;
    watchTrack(kuisStream);
    startLiveMonitoring(false);
  } else {
    $('flStop').classList.add('show');
    toast('Kamera gagal dinyalakan ulang: ' + res.reason, 'err', 6000);
  }
});

function startTimer(){
  clearInterval(state.timerId);
  state.elapsed = 0;
  $('timer').textContent = '⏱ 00:00';
  state.timerId = setInterval(()=>{
    state.elapsed++;
    $('timer').textContent = '⏱ '+fmtTime(state.elapsed);
  }, 1000);
}
function stopTimer(){ clearInterval(state.timerId); }

/* =========================================================
   TOGGLE BACAAN
   ========================================================= */
$('btnCollapse').addEventListener('click', ()=>{
  state.passageCollapsed = !state.passageCollapsed;
  $('passageText').classList.toggle('collapsed', state.passageCollapsed);
  $('btnCollapse').textContent = state.passageCollapsed ? 'Tampilkan' : 'Sembunyikan';
});

/* =========================================================
   RENDER SOAL
   ========================================================= */
function renderQuestion(){
  const i = state.index;
  const q = QUESTIONS[i];
  const p = PASSAGES[q.pid];

  $('passageTitle').textContent = p.title;
  $('passageText').textContent = p.text;
  $('passageText').classList.toggle('collapsed', state.passageCollapsed);
  $('btnCollapse').textContent = state.passageCollapsed ? 'Tampilkan' : 'Sembunyikan';

  $('qNum').textContent = i+1;
  $('qTopic').textContent = q.t;
  $('qText').textContent = q.q;

  const box = $('qOptions');
  box.innerHTML = '';
  q.o.forEach((opt, oi)=>{
    const btn = document.createElement('button');
    btn.className = 'opt' + (state.answers[i]===oi ? ' sel' : '');
    btn.innerHTML = '<span class="letter">'+LETTERS[oi]+'</span><span>'+escapeHtml(opt)+'</span>';
    btn.addEventListener('click', ()=>{
      state.answers[i] = oi;
      renderQuestion(); updateProgress();
    });
    box.appendChild(btn);
  });

  $('btnPrev').disabled = (i===0);
  $('btnNext').disabled = (i===QUESTIONS.length-1);
  renderPalette();
}

function renderPalette(){
  const p = $('palette');
  p.innerHTML = '';
  QUESTIONS.forEach((_, i)=>{
    const b = document.createElement('button');
    b.className = 'pbtn';
    if(state.answers[i]!==null) b.classList.add('done');
    if(i===state.index) b.classList.add('now');
    b.textContent = i+1;
    b.addEventListener('click', ()=>{
      state.index = i; renderQuestion();
      window.scrollTo({top:0,behavior:'smooth'});
    });
    p.appendChild(b);
  });
}

function updateProgress(){
  const done = state.answers.filter(a=>a!==null).length;
  $('progFill').style.width = (done/QUESTIONS.length)*100 + '%';
  $('progTxt').textContent = done+' / '+QUESTIONS.length+' terjawab';
}

$('btnPrev').addEventListener('click', ()=>{ if(state.index>0){ state.index--; renderQuestion(); window.scrollTo({top:0,behavior:'smooth'}); }});
$('btnNext').addEventListener('click', ()=>{ if(state.index<QUESTIONS.length-1){ state.index++; renderQuestion(); window.scrollTo({top:0,behavior:'smooth'}); }});


/* ---------- SELESAI: penilaian dilakukan di server (fungsi submit_attempt) ---------- */
$('btnFinish').addEventListener('click', async ()=>{
  const kosong = state.answers.filter(a=>a===null).length;
  const ok = await confirmDialog({
    title: 'Selesaikan latihan?',
    message: kosong > 0 ? ('Masih ada ' + kosong + ' soal belum dijawab. Yakin selesai?') : 'Selesaikan latihan dan lihat hasil?',
    yes: 'Ya, selesai', danger: false
  });
  if(!ok) return;
  await runBusy($('btnFinish'), finishQuiz);
});

async function finishQuiz(){
  needOnline();
  await takeLiveSnapshot();   // snapshot terakhir
  await uploadChain;          // tunggu unggahan foto selesai
  const { data, error } = await sb.rpc('submit_attempt', {
    p_attempt: state.attemptId, p_answers: state.answers, p_durasi: state.elapsed
  });
  if(error) throw error;      // gagal (mis. offline) → tetap di kuis, jawaban aman, bisa coba lagi

  stopTimer();
  stopLiveMonitoring();
  stopStream(kuisStream); kuisStream = null;
  $('camFloat').classList.remove('on');
  renderResult(data);
  showScreen('result');
}

/* ---------- HASIL ---------- */
function renderResult(res){
  const circle = document.querySelector('#screen-result .score-circle');
  const stats = document.querySelector('#screen-result .stat-grid');
  const dirilis = res.skor != null;
  circle.style.display = stats.style.display = dirilis ? '' : 'none';
  if(!dirilis){            // nilai belum dirilis guru: hanya konfirmasi pengiriman
    $('resultTitle').textContent = '✅ Jawaban berhasil dikirim';
    $('resultSub').textContent = currentProfile.nama + ' · ' + currentProfile.kelas + ' — Nilai akan disampaikan oleh guru.';
    $('reviewList').innerHTML = '<p class="hint">Pembahasan tersedia setelah guru mengizinkannya.</p>';
    $('resultSnapshots').innerHTML = ''; $('resultSnapEmpty').style.display = 'block';
    return;
  }
  const skor = res.skor;
  $('scoreNum').textContent = skor;
  const deg = (skor/100)*360;
  const color = skor>=75 ? '#16a34a' : skor>=55 ? '#f59e0b' : '#dc2626';
  $('scoreCircle').style.background = 'conic-gradient('+color+' 0deg, '+color+' '+deg+'deg, #e5e7eb '+deg+'deg)';

  let judul, sub;
  if(skor>=85){ judul='🌟 Luar Biasa!'; sub='Pemahamanmu tentang hikayat sangat baik.'; }
  else if(skor>=70){ judul='👍 Bagus!'; sub='Tingkatkan lagi bagian yang masih salah.'; }
  else if(skor>=55){ judul='📘 Cukup'; sub='Perlu lebih banyak berlatih.'; }
  else { judul='📕 Perlu Belajar Lagi'; sub='Baca ulang materi hikayat dan coba lagi.'; }
  $('resultTitle').textContent = judul;
  $('resultSub').textContent = currentProfile.nama+' · '+currentProfile.kelas+' — '+sub;

  $('stBenar').textContent = res.benar;
  $('stSalah').textContent = res.salah;
  $('stKosong').textContent = res.kosong;
  $('stDurasi').textContent = fmtTime(res.durasi_detik);
  $('stSnapshot').textContent = state.liveSnapshotCount;

  // Pratinjau snapshot (dari memori; salinan permanennya ada di Supabase Storage)
  const grid = $('resultSnapshots');
  const emptyEl = $('resultSnapEmpty');
  const snaps = state.liveSnapshotList;
  if(!snaps.length){ grid.innerHTML = ''; emptyEl.style.display = 'block'; }
  else {
    emptyEl.style.display = 'none';
    grid.innerHTML = snaps.map((s,i)=>
      '<div style="text-align:center"><img src="'+s.data+'" class="photo-thumb" data-live-snap="'+i+'" alt="Snapshot">' +
      '<div class="cap" style="font-size:.65rem;color:#6b7280;margin-top:2px">'+escapeHtml(s.time)+'</div></div>').join('');
    grid.querySelectorAll('[data-live-snap]').forEach(img=>{
      img.addEventListener('click', ()=>{
        const s = snaps[parseInt(img.getAttribute('data-live-snap'), 10)];
        if(s) openModal('🤳 Snapshot LIVE', '<img class="photo-big" src="'+s.data+'" alt="Snapshot">' +
          '<p class="hint" style="text-align:center;margin-top:8px">LIVE @ '+escapeHtml(s.time)+'</p>');
      });
    });
  }
  $('reviewList').innerHTML = reviewHtml(state.answers, res.kunci);
}

/* Daftar pembahasan — dipakai di hasil siswa dan detail guru */
function reviewHtml(answers, kunci){
  return kunci.map(k=>{
    const i = k.no - 1, q = QUESTIONS[i], p = PASSAGES[q.pid];
    const jawab = answers[i] === undefined ? null : answers[i];
    const st = jawab===null ? 'kosong' : jawab===k.kunci ? 'benar' : 'salah';
    const cls = st==='benar' ? 'correct' : 'wrong';
    const badge = st==='benar' ? '<span class="badge ok">✓ BENAR</span>'
      : st==='salah' ? '<span class="badge bad">✕ SALAH</span>'
      : '<span class="badge bad">— TIDAK DIJAWAB</span>';
    const jawabTxt = jawab===null ? '<i>tidak dijawab</i>' : LETTERS[jawab]+'. '+escapeHtml(q.o[jawab]);
    return '<div class="review-item '+cls+'">' + badge +
      '<div class="review-line" style="font-size:.75rem;color:#6b7280;margin-bottom:5px">'+escapeHtml(p.title)+'</div>' +
      '<div class="review-q"><b>'+k.no+'.</b> '+escapeHtml(q.q)+'</div>' +
      '<div class="review-line"><b>Jawaban:</b> '+jawabTxt+'</div>' +
      '<div class="review-line"><b>Kunci:</b> '+LETTERS[k.kunci]+'. '+escapeHtml(q.o[k.kunci])+'</div>' +
      '<div class="explain"><b>Pembahasan:</b> '+escapeHtml(k.penjelasan)+'</div></div>';
  }).join('');
}

$('btnUlangi').addEventListener('click', async ()=>{
  const ok = await confirmDialog({ title:'Mulai ulang latihan?', message:'Nilai sebelumnya tetap tersimpan di laporan.', yes:'Ya, mulai ulang', danger:false });
  if(!ok) return;
  await runBusy($('btnUlangi'), async ()=>{
    await beginAttempt();
    await startQuizUI();
  });
});

/* ---------- KELUAR di tengah kuis: sesi dibatalkan & dihapus (termasuk fotonya) ---------- */
$('btnKeluar').addEventListener('click', async ()=>{
  const ok = await confirmDialog({
    title: 'Keluar dari latihan?',
    message: 'Jawaban akan hilang dan tidak dinilai. Foto sesi ini ikut dihapus.',
    yes: 'Ya, keluar'
  });
  if(!ok) return;
  await runBusy($('btnKeluar'), async ()=>{
    releaseAllCamera();
    const id = state.attemptId;
    state.attemptId = null;
    try{
      await uploadChain;
      if(id) await purgeAttempts([id]);
    }catch(e){ toast('Sesi dibatalkan, tetapi data belum terhapus: ' + friendlyError(e), 'warn', 7000); }
    showScreen('home');
    refreshActiveList();
  });
});
