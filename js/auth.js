/* Login / daftar / keluar memakai Supabase Auth. Peran (siswa/guru) dibaca dari tabel profiles. */
let currentUser = null;
let currentProfile = null;
let authMode = 'login';
const isGuru = () => !!(currentProfile && currentProfile.role === 'guru');

function showAuthMsg(text, ok){
  const el = $('authMsg');
  if(!text){ el.hidden = true; return; }
  el.textContent = text; el.className = 'msg' + (ok ? ' ok' : ''); el.hidden = false;
}

function setAuthMode(mode){
  authMode = mode;
  const reg = mode === 'register';
  $('tabLogin').classList.toggle('active', !reg);
  $('tabRegister').classList.toggle('active', reg);
  $('fldNama').hidden = !reg;
  $('fldKelas').hidden = !reg;
  $('btnAuth').textContent = reg ? 'Daftar & Masuk' : 'Masuk';
  $('inpPass').autocomplete = reg ? 'new-password' : 'current-password';
  showAuthMsg('');
}

async function onAuthSubmit(e){
  e.preventDefault();
  if(!sb){ showAuthMsg('Supabase belum dikonfigurasi. Isi js/config.js.'); return; }
  const email = $('inpEmail').value.trim();
  const pass = $('inpPass').value;
  const nama = $('inpNama').value.trim();
  const kelasId = $('inpKelas').value;
  const kelas = kelasId ? $('inpKelas').selectedOptions[0].textContent : '';

  if(!/^\S+@\S+\.\S+$/.test(email)){ showAuthMsg('Format email belum benar.'); $('inpEmail').focus(); return; }
  if(pass.length < 6){ showAuthMsg('Kata sandi minimal 6 karakter.'); $('inpPass').focus(); return; }
  if(authMode === 'register'){
    if(nama.length < 3){ showAuthMsg('Nama minimal 3 karakter.'); $('inpNama').focus(); return; }
    if(kelas.length < 1){ showAuthMsg('Pilih kelas dari daftar.'); $('inpKelas').focus(); return; }
  }
  showAuthMsg('');

  await runBusy($('btnAuth'), async ()=>{
    needOnline();
    let res;
    if(authMode === 'register'){
      res = await sb.auth.signUp({ email, password: pass, options: { data: { nama, kelas, kelas_id: kelasId } } });
    } else {
      res = await sb.auth.signInWithPassword({ email, password: pass });
    }
    if(res.error){ showAuthMsg(friendlyError(res.error)); return; }
    if(!res.data.session){
      showAuthMsg('Pendaftaran berhasil. Buka email Anda untuk konfirmasi, lalu masuk.', true);
      setAuthMode('login');
      return;
    }
    $('inpPass').value = '';
    await enterApp(res.data.session.user);
  });
}

async function fetchProfile(){
  const { data, error } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  if(error) throw error;
  if(!data) throw new Error('Profil tidak ditemukan. Pastikan schema.sql sudah dijalankan.');
  return data;
}

async function enterApp(user){
  currentUser = user;
  currentProfile = await fetchProfile();
  $('homeNama').textContent = currentProfile.nama;
  $('homeKelas').textContent = currentProfile.kelas;
  $('homeRole').textContent = currentProfile.role;
  $('chkConsent').checked = false;
  $('btnKelola').hidden = !isGuru();
  resetExamPick();
  $('btnKeLaporan').hidden = !isGuru();            // siswa tidak punya rekap nilai
  $('btnHasilLaporan').hidden = !isGuru();
  $('btnKeLaporan').textContent = isGuru() ? '📊 Laporan Siswa (Guru)' : '📊 Riwayat Nilai Saya';
  showScreen('home');
  refreshActiveList();
}

async function doLogout(){
  await runBusy($('btnLogout'), async ()=>{
    releaseAllCamera();
    await sb.auth.signOut();
    currentUser = null; currentProfile = null;
    showScreen('auth');
  });
}

/* Daftar siswa yang sedang mengerjakan (hanya nama & kelas) */
async function refreshActiveList(){
  if(!sb || !currentUser || currentScreen !== 'home') return;
  const el = $('activeList');
  try{
    const { data, error } = await sb.rpc('active_attempts');
    if(error) throw error;
    el.innerHTML = (data && data.length)
      ? data.map(s => '<span class="absen-item working"><span class="dot-live"></span>' +
          escapeHtml(s.nama) + ' · ' + escapeHtml(s.kelas) + '</span>').join('')
      : '<span class="hint">Tidak ada</span>';
  }catch(e){ console.warn('Daftar aktif gagal dimuat', e); }
}

/* Isi <select> kelas dengan kelas AKTIF dari database (juga divalidasi ulang di database) */
async function loadClasses(){
  const sel = $('inpKelas');
  try{
    const { data, error } = await sb.rpc('list_active_classes');
    if(error) throw error;
    sel.innerHTML = '<option value="">— Pilih kelas —</option>' +
      (data || []).map(c => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.nama) + '</option>').join('');
  }catch(e){ sel.innerHTML = '<option value="">Gagal memuat kelas</option>'; console.warn(e); }
}
