/* Penghubung & inisialisasi aplikasi. */
(function init(){
  // Tombol navigasi
  $('tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('tabRegister').addEventListener('click', () => setAuthMode('register'));
  $('formAuth').addEventListener('submit', onAuthSubmit);
  $('btnLogout').addEventListener('click', doLogout);
  $('btnKeLaporan').addEventListener('click', () => runBusy($('btnKeLaporan'), openReport));
  $('btnHasilLaporan').addEventListener('click', () => runBusy($('btnHasilLaporan'), openReport));
  $('btnBackLogin').addEventListener('click', () => { showScreen('home'); refreshActiveList(); });
  $('btnSelesai').addEventListener('click', () => { resetExamPick(); showScreen('home'); refreshActiveList(); });

  // Status koneksi
  const net = () => { $('netBanner').hidden = navigator.onLine; };
  window.addEventListener('online', () => { net(); toast('Koneksi kembali tersambung.', 'ok'); });
  window.addEventListener('offline', net);
  net();

  if(!supportsCamera()) console.warn('⚠️ Browser tidak mendukung getUserMedia.');

  if(!CONFIGURED || !sb){
    $('setupWarn').hidden = false;
    $('btnAuth').disabled = true;
    return;
  }

  loadClasses();

  // Keluar dari akun di tab lain / sesi habis → kembali ke layar masuk
  sb.auth.onAuthStateChange(event => {
    if(event === 'SIGNED_OUT' && currentUser){
      currentUser = null; currentProfile = null;
      releaseAllCamera();
      showScreen('auth');
    }
  });

  // Lanjutkan sesi login yang sudah ada
  sb.auth.getSession().then(({ data }) => {
    if(data && data.session) return runBusy(null, () => enterApp(data.session.user));
  }).catch(e => console.warn(e));

  setInterval(refreshActiveList, 15000);
})();
