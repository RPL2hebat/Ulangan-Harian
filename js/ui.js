/* Pembantu tampilan: elemen, layar, notifikasi, dialog konfirmasi, loading. */
const $ = id => document.getElementById(id);
const LETTERS = ['A','B','C','D','E'];

function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec||0));
  return String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}
function fmtDate(iso){
  const d = new Date(iso); const pad = n => String(n).padStart(2,'0');
  return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad(d.getHours())+':'+pad(d.getMinutes());
}

let currentScreen = 'auth';
function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  $('screen-'+name).classList.add('active');
  currentScreen = name;
  window.scrollTo({top:0, behavior:'smooth'});
}

/* ---- pesan error yang mudah dipahami ---- */
function friendlyError(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || '');
  if(!navigator.onLine || /failed to fetch|networkerror|load failed|network request failed/i.test(m))
    return 'Koneksi internet bermasalah. Periksa jaringan lalu coba lagi.';
  if(/database error saving new user/i.test(m)) return 'Pendaftaran gagal. Pastikan kelas yang dipilih masih aktif.';
  if(/invalid login credentials/i.test(m)) return 'Email atau kata sandi salah.';
  if(/already registered|already been registered/i.test(m)) return 'Email ini sudah terdaftar. Silakan masuk.';
  if(/email not confirmed/i.test(m)) return 'Email belum dikonfirmasi. Cek kotak masuk email Anda.';
  if(/password should be at least/i.test(m)) return 'Kata sandi minimal 6 karakter.';
  if(/rate limit|too many/i.test(m)) return 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.';
  if(/row-level security|permission denied|tidak diizinkan/i.test(m)) return 'Anda tidak punya izin untuk tindakan ini.';
  if(/jwt|token.*expired/i.test(m)) return 'Sesi login berakhir. Silakan masuk lagi.';
  return m || 'Terjadi kesalahan. Coba lagi.';
}

/* ---- notifikasi ---- */
function toast(msg, type, ms){
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(()=>t.remove(), ms || 4000);
}

/* ---- loading: tombol (cegah klik berulang) & layar penuh ---- */
async function runBusy(btn, fn){
  if(btn){
    if(btn.dataset.busy === '1') return;      // sedang diproses → abaikan klik berikutnya
    btn.dataset.busy = '1'; btn.classList.add('busy'); btn.disabled = true;
  }
  try{ return await fn(); }
  catch(e){ console.error(e); toast(friendlyError(e), 'err', 6000); }
  finally{
    if(btn){ btn.dataset.busy = '0'; btn.classList.remove('busy'); btn.disabled = false; }
  }
}
function showLoading(text){ $('loadingText').textContent = text || 'Memproses…'; $('loading').classList.add('show'); }
function setLoadingText(text){ $('loadingText').textContent = text; }
function hideLoading(){ $('loading').classList.remove('show'); }

/* ---- dialog konfirmasi (pengganti confirm() bawaan) ----
   opts: {title, message, yes, danger=true, typeWord}  → Promise<boolean>
   typeWord: pengguna harus mengetik kata itu (untuk penghapusan massal) */
function confirmDialog(opts){
  opts = opts || {};
  return new Promise(resolve=>{
    const box = $('confirm'), yesBtn = $('cfYes'), noBtn = $('cfNo'), inp = $('cfType');
    const word = opts.typeWord || null;
    $('cfTitle').textContent = opts.title || 'Konfirmasi';
    $('cfMsg').textContent = opts.message || '';
    yesBtn.textContent = opts.yes || 'Ya, hapus';
    yesBtn.className = (opts.danger === false) ? 'btn-green' : 'btn-delete';
    $('cfTypeWrap').hidden = !word;
    if(word){ $('cfTypeLbl').textContent = 'Ketik ' + word + ' untuk melanjutkan'; inp.value = ''; yesBtn.disabled = true; }
    else yesBtn.disabled = false;

    const onInput = () => { yesBtn.disabled = inp.value.trim().toUpperCase() !== word; };
    const onKey = e => { if(e.key === 'Escape') done(false); };
    function done(v){
      box.classList.remove('show');
      yesBtn.onclick = noBtn.onclick = box.onclick = null;
      inp.removeEventListener('input', onInput);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    }
    if(word) inp.addEventListener('input', onInput);
    document.addEventListener('keydown', onKey);
    yesBtn.onclick = () => done(true);
    noBtn.onclick = () => done(false);
    box.onclick = e => { if(e.target === box) done(false); };
    box.classList.add('show');
    (word ? inp : noBtn).focus();
  });
}

/* ---- modal umum ---- */
function openModal(title, html){
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modal').classList.add('show');
}
function closeModal(){ $('modal').classList.remove('show'); $('modalBody').innerHTML = ''; }
