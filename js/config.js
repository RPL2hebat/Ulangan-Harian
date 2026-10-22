/* =====================================================================
   KONFIGURASI SUPABASE — ISI DUA BARIS INI
   Ambil di Supabase → Project Settings → API:
     • Project URL           → SUPABASE_URL
     • anon / publishable key → SUPABASE_KEY
   JANGAN PERNAH menaruh "service_role" atau "secret" key di file ini.
   (Publishable/anon key memang boleh di sini, karena data dilindungi RLS.)
   ===================================================================== */
const SUPABASE_URL = 'https://eakfyolkyycxscnkcmxm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9644jWKCYKPunk15e4TJzA_Cw6w6Mfa';

// Pengaturan aplikasi
const LIVE_SNAPSHOT_INTERVAL_MS = 30000; // snapshot otomatis tiap 30 detik
const LIVE_SNAPSHOT_MAX = 40;            // maksimal snapshot per sesi
const RETENTION_DAYS = 30;               // tombol "hapus foto lama" memakai angka ini
