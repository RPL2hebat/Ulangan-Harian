/* Kamera depan — fungsi asli dipertahankan (izin, fallback constraint, penghentian stream). */
const IS_MOBILE = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent);

function supportsCamera(){
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function buildFrontConstraints(){
  return [
    {video:{facingMode:{ideal:'user'}, width:{ideal:1280}, height:{ideal:720}}, audio:false},
    {video:{facingMode:'user', width:{ideal:640}, height:{ideal:480}}, audio:false},
    {video:{facingMode:'user'}, audio:false},
    {video:{facingMode:{exact:'user'}}, audio:false},
    {video:{width:{ideal:640}, height:{ideal:480}}, audio:false},
    {video:true, audio:false}
  ];
}

async function startFrontCamera(videoEl){
  if(!supportsCamera()){
    return {ok:false, reason:'Browser/perangkat ini tidak mendukung kamera. Gunakan Chrome, Safari, Edge, atau Firefox terbaru.'};
  }
  if(!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
    return {ok:false, reason:'Kamera membutuhkan HTTPS. Buka lewat https:// atau http://localhost, bukan file:/// langsung.'};
  }

  const constraints = buildFrontConstraints();
  let lastErr = null;

  for(let i=0; i<constraints.length; i++){
    try{
      const stream = await navigator.mediaDevices.getUserMedia(constraints[i]);
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', '');
      videoEl.setAttribute('autoplay', '');
      videoEl.setAttribute('muted', '');
      videoEl.muted = true;
      videoEl.srcObject = stream;
      await new Promise((resolve)=>{
        if(videoEl.readyState >= 2){ resolve(); return; }
        const onLoaded = () => { videoEl.removeEventListener('loadedmetadata', onLoaded); resolve(); };
        videoEl.addEventListener('loadedmetadata', onLoaded);
        setTimeout(resolve, 1500);
      });
      try{ await videoEl.play(); }catch(e){}
      return {ok:true, stream};
    }catch(err){
      lastErr = err;
      if(err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError'){
        return {ok:false, reason:'Izin kamera ditolak. Buka pengaturan browser → izin situs → kamera → izinkan, lalu muat ulang halaman.'};
      }
    }
  }

  let reason = 'Kamera depan tidak dapat diakses.';
  if(lastErr){
    const n = lastErr.name;
    if(n === 'NotFoundError'){ reason = 'Tidak ada kamera terdeteksi di perangkat ini.'; }
    else if(n === 'NotReadableError'){ reason = 'Kamera dipakai aplikasi lain. Tutup aplikasi lain lalu coba lagi.'; }
    else if(n === 'OverconstrainedError'){ reason = 'Kamera depan tidak mendukung pengaturan default. Coba Upload Foto.'; }
    else if(n === 'AbortError'){ reason = 'Akses kamera dibatalkan. Coba lagi.'; }
    else { reason = 'Error kamera: ' + n + '. ' + (lastErr.message || ''); }
  }
  return {ok:false, reason};
}

function stopStream(stream){ if(stream) stream.getTracks().forEach(t=>t.stop()); }

function capturePhoto(videoEl, maxW=320, quality=0.6){
  const vw = videoEl.videoWidth || 640;
  const vh = videoEl.videoHeight || 480;
  const ratio = Math.min(1, maxW / vw);
  const w = Math.round(vw * ratio);
  const h = Math.round(vh * ratio);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

function readFileAsDataURL(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function compressDataURL(dataURL, maxW=320, quality=0.6){
  return new Promise((resolve)=>{
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}


/* Tambahan: ubah data URL (hasil kamera) menjadi Blob untuk diunggah ke Storage */
async function dataUrlToBlob(dataUrl){
  const res = await fetch(dataUrl);
  return await res.blob();
}
