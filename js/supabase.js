/* Lapisan data Supabase: klien, URL foto, penghapusan file + data yang aman. */
const CONFIGURED = typeof SUPABASE_URL === 'string' && /^https:\/\/[a-z0-9-]+\.supabase\.co/i.test(SUPABASE_URL)
  && typeof SUPABASE_KEY === 'string' && SUPABASE_KEY.length > 20 && !/GANTI/.test(SUPABASE_URL + SUPABASE_KEY);

const sb = (CONFIGURED && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    })
  : null;

const BUCKET = 'photos';

function needOnline(){
  if(!navigator.onLine) throw new Error('Tidak ada koneksi internet.');
}

function uuid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0; return (c === 'x' ? r : (r&0x3|0x8)).toString(16);
  });
}

/* Ambil SEMUA baris (PostgREST membatasi 1000 baris per permintaan) */
async function fetchAll(build){
  let all = [], from = 0;
  for(;;){
    const { data, error } = await build().range(from, from + 999);
    if(error) throw error;
    all = all.concat(data || []);
    if(!data || data.length < 1000 || from > 20000) break;
    from += 1000;
  }
  return all;
}

/* ---- URL foto (bucket privat → URL bertanda tangan, berlaku 1 jam) ---- */
const urlCache = new Map();
async function signedUrls(paths){
  const now = Date.now();
  const need = [...new Set(paths)].filter(p => { const c = urlCache.get(p); return !(c && c.exp > now); });
  for(let i = 0; i < need.length; i += 100){
    const chunk = need.slice(i, i + 100);
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(chunk, 3600);
    if(error) throw error;
    (data || []).forEach(d => urlCache.set(d.path, { url: d.signedUrl || null, exp: now + (d.signedUrl ? 3500000 : 60000) }));
  }
  return p => { const c = urlCache.get(p); return c ? c.url : null; };
}

/* Isi src semua <img data-path> di dalam sebuah elemen */
async function hydrateImages(root){
  const imgs = [...root.querySelectorAll('img[data-path]')];
  if(!imgs.length) return;
  try{
    const getUrl = await signedUrls(imgs.map(i => i.dataset.path));
    imgs.forEach(img => {
      const u = getUrl(img.dataset.path);
      if(u){ img.onerror = () => markMissing(img); img.src = u; } else markMissing(img);
    });
  }catch(e){ console.warn('Gagal memuat foto', e); imgs.forEach(markMissing); }
}
function markMissing(img){
  const d = document.createElement('div');
  d.className = 'photo-missing'; d.textContent = 'Foto tidak tersedia';
  img.replaceWith(d);
}

/* ---- penghapusan ---- */

// Hapus file dari Storage. Melempar error bila gagal (data DB TIDAK dihapus → tidak ada data yatim).
async function removeFiles(paths){
  paths = [...new Set(paths.filter(Boolean))];
  for(let i = 0; i < paths.length; i += 100){
    const chunk = paths.slice(i, i + 100);
    const { error } = await sb.storage.from(BUCKET).remove(chunk);
    if(error) throw error;
    chunk.forEach(p => urlCache.delete(p));
  }
}

// Hapus SATU foto: file dulu, baru barisnya.
async function deleteSnapshotRow(snap){
  needOnline();
  await removeFiles([snap.storage_path]);
  const { data, error } = await sb.from('snapshots').delete().eq('id', snap.id).select('id');
  if(error) throw error;
  if(!data || !data.length) throw new Error('Foto tidak terhapus (tidak diizinkan atau sudah tidak ada).');
}

// Hapus percobaan (nilai + absensi + semua fotonya). Urutan: file → baris database.
// Jika penghapusan file gagal, database tidak disentuh (tidak ada baris yatim).
async function purgeAttempts(ids, onProgress){
  needOnline();
  const STEP = 15; // 15 percobaan × maks 60 foto < batas 1000 baris
  let done = 0;
  for(let i = 0; i < ids.length; i += STEP){
    const chunk = ids.slice(i, i + STEP);
    const { data: rows, error: e0 } = await sb.from('snapshots').select('storage_path').in('attempt_id', chunk).limit(1000);
    if(e0) throw e0;
    await removeFiles((rows || []).map(r => r.storage_path));
    const { data: del, error: e1 } = await sb.from('attempts').delete().in('id', chunk).select('id');
    if(e1) throw e1;
    if(!del || !del.length) throw new Error('Data tidak terhapus (tidak diizinkan atau sudah tidak ada). Muat ulang laporan.');
    done += chunk.length;
    if(onProgress) onProgress(done, ids.length);
  }
}
