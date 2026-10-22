/* Galeri foto (khusus guru): lihat, hapus satu foto, hapus massal, retensi. */
const GAL = { rows: [], page: 0, size: 60, total: 0 };

async function loadGallery(reset){
  if(!isGuru()) return;
  if(reset){ GAL.rows = []; GAL.page = 0; }
  const kind = $('galFilter').value;
  let q = sb.from('snapshots')
    .select('id,attempt_id,kind,storage_path,elapsed_label,taken_at,profiles(nama,kelas)', { count: 'exact' })
    .order('taken_at', { ascending: false }).order('id')
    .range(GAL.page * GAL.size, GAL.page * GAL.size + GAL.size - 1);
  if(kind) q = q.eq('kind', kind);
  const { data, count, error } = await q;
  if(error) throw error;
  GAL.rows = GAL.rows.concat(data || []);
  GAL.total = count || 0;
  GAL.page++;
  paintGallery();
}

function paintGallery(){
  const el = $('fotoGallery');
  $('fotoEmpty').style.display = GAL.rows.length ? 'none' : 'block';
  $('btnMoreFoto').hidden = GAL.rows.length >= GAL.total;
  el.innerHTML = GAL.rows.map(s => {
    const who = s.profiles ? s.profiles.nama : '—';
    return '<div class="photo-card">' +
      '<img data-path="'+escapeHtml(s.storage_path)+'" data-open="'+s.id+'" alt="Foto '+escapeHtml(who)+'">' +
      '<span class="kind">'+(s.kind === 'absen' ? 'ABSEN' : 'LIVE')+'</span>' +
      '<button class="x" data-del-snap="'+s.id+'" aria-label="Hapus foto" title="Hapus foto">✕</button>' +
      '<div class="cap">'+escapeHtml(who)+'</div>' +
      '<div class="cap">'+escapeHtml(s.elapsed_label || '')+' · '+fmtDate(s.taken_at)+'</div></div>';
  }).join('');
  hydrateImages(el);
}

function snapCaption(s){
  const who = s.profiles ? s.profiles.nama + ' · ' + s.profiles.kelas : '';
  return (s.kind === 'absen' ? 'Foto absen' : 'LIVE @ ' + (s.elapsed_label || '-')) + (who ? ' — ' + who : '') + ' — ' + fmtDate(s.taken_at);
}

/* Foto besar + tombol hapus (guru) */
async function openPhotoModal(snap, afterDelete){
  openModal('🤳 Foto Kamera LIVE', '<div class="center" style="text-align:center"><img class="photo-big" data-path="'+escapeHtml(snap.storage_path)+'" alt="Foto"></div>' +
    '<p class="hint" style="text-align:center;margin:8px 0">'+escapeHtml(snapCaption(snap))+'</p>' +
    (isGuru() ? '<button class="btn-delete" id="btnDelPhotoModal" style="width:100%;margin-top:6px">🗑 Hapus foto ini</button>' : ''));
  hydrateImages($('modalBody'));
  const b = $('btnDelPhotoModal');
  if(b) b.onclick = () => deleteSnapshotFlow(snap, b, () => { closeModal(); if(afterDelete) afterDelete(); });
}

/* Hapus satu foto dengan konfirmasi */
async function deleteSnapshotFlow(snap, btn, after){
  const ok = await confirmDialog({
    title: 'Hapus foto ini?',
    message: snapCaption(snap) + '\n\nFile di penyimpanan dan datanya dihapus permanen.'
  });
  if(!ok) return;
  await runBusy(btn, async () => {
    await deleteSnapshotRow(snap);
    toast('Foto dihapus.', 'ok');
    if(after) await after();
    else await refreshReport();
  });
}

$('fotoGallery').addEventListener('click', e => {
  const del = e.target.closest('[data-del-snap]');
  if(del){
    const s = GAL.rows.find(r => r.id === del.dataset.delSnap);
    if(s) deleteSnapshotFlow(s, del);
    return;
  }
  const img = e.target.closest('img[data-open]');
  if(img){
    const s = GAL.rows.find(r => r.id === img.dataset.open);
    if(s) openPhotoModal(s, refreshReport);
  }
});
$('galFilter').addEventListener('change', () => runBusy(null, () => loadGallery(true)));
$('btnMoreFoto').addEventListener('click', () => runBusy($('btnMoreFoto'), () => loadGallery(false)));

/* ---------- Penghapusan massal (hanya guru; dijaga RLS di server) ---------- */

// Hapus foto lebih lama dari RETENTION_DAYS
$('btnPurgeOld').addEventListener('click', async () => {
  if(!isGuru()) return;
  const ok = await confirmDialog({
    title: 'Hapus foto lama?',
    message: 'Semua foto (absen & snapshot) yang lebih dari ' + RETENTION_DAYS + ' hari akan dihapus permanen. Nilai tetap ada.',
    yes: 'Hapus foto lama'
  });
  if(!ok) return;
  await runBusy($('btnPurgeOld'), async () => {
    needOnline();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
    const rows = await fetchAll(() => sb.from('snapshots').select('id,storage_path').lt('taken_at', cutoff).order('id'));
    if(!rows.length){ toast('Tidak ada foto yang lebih lama dari ' + RETENTION_DAYS + ' hari.', 'ok'); return; }
    showLoading('Menghapus ' + rows.length + ' foto…');
    try{
      for(let i = 0; i < rows.length; i += 100){
        const chunk = rows.slice(i, i + 100);
        await removeFiles(chunk.map(r => r.storage_path));
        const { error } = await sb.from('snapshots').delete().in('id', chunk.map(r => r.id));
        if(error) throw error;
        setLoadingText('Menghapus foto… ' + Math.min(i + 100, rows.length) + '/' + rows.length);
      }
    } finally { hideLoading(); }
    toast(rows.length + ' foto lama dihapus.', 'ok');
    await refreshReport();
  });
});

// Hapus sesi yang tidak pernah selesai (> 3 jam) beserta fotonya
$('btnPurgeStale').addEventListener('click', async () => {
  if(!isGuru()) return;
  const ok = await confirmDialog({
    title: 'Bersihkan sesi tidak selesai?',
    message: 'Sesi yang dimulai lebih dari 3 jam lalu dan tidak pernah diselesaikan akan dihapus beserta fotonya.',
    yes: 'Bersihkan'
  });
  if(!ok) return;
  await runBusy($('btnPurgeStale'), async () => {
    needOnline();
    const cutoff = new Date(Date.now() - 3 * 3600000).toISOString();
    const rows = await fetchAll(() => sb.from('attempts').select('id').eq('status', 'berjalan').lt('started_at', cutoff).order('id'));
    if(!rows.length){ toast('Tidak ada sesi tidak selesai.', 'ok'); return; }
    showLoading('Membersihkan ' + rows.length + ' sesi…');
    try{ await purgeAttempts(rows.map(r => r.id), (d, t) => setLoadingText('Membersihkan… ' + d + '/' + t)); }
    finally{ hideLoading(); }
    toast(rows.length + ' sesi dibersihkan.', 'ok');
    await refreshReport();
  });
});

// Hapus SEMUA data (dua konfirmasi: dialog + ketik HAPUS)
$('btnHapusSemua').addEventListener('click', async () => {
  if(!isGuru()) return;
  const ok1 = await confirmDialog({
    title: 'Hapus SEMUA data?',
    message: 'Semua nilai, absensi, dan foto LIVE (database + penyimpanan) akan dihapus permanen.\nAkun login siswa tetap ada.\n\nTindakan ini TIDAK bisa dibatalkan.',
    yes: 'Lanjutkan'
  });
  if(!ok1) return;
  const ok2 = await confirmDialog({
    title: 'Konfirmasi terakhir',
    message: 'Untuk memastikan, ketik kata di bawah.',
    yes: 'Hapus semua sekarang', typeWord: 'HAPUS'
  });
  if(!ok2) return;
  await runBusy($('btnHapusSemua'), async () => {
    needOnline();
    const rows = await fetchAll(() => sb.from('attempts').select('id').order('id'));
    if(!rows.length){ toast('Tidak ada data untuk dihapus.', 'ok'); return; }
    showLoading('Menghapus semua data…');
    try{ await purgeAttempts(rows.map(r => r.id), (d, t) => setLoadingText('Menghapus… ' + d + '/' + t)); }
    finally{ hideLoading(); }
    toast('Semua data berhasil dihapus.', 'ok');
    await refreshReport();
  });
});
