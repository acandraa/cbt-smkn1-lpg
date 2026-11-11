// Default Configuration File for CBT SMK Negeri 1 Lempuing
// Mendukung Mode Dual-Engine (PHP + MySQL atau Supabase Cloud)
// Mendukung Multi-Shard Supabase hingga 5 Akun / Proyek

// =====================================================================
// 1. PILIH MODE BACKEND / DATABASE
// ---------------------------------------------------------------------
//  "auto"     : Otomatis mendeteksi:
//               - Jika di GitHub Pages (github.io) -> otomatis "supabase"
//               - Jika di Laragon / cPanel (ada PHP) -> otomatis "php"
//  "supabase" : Paksa gunakan Cloud Supabase (Multi-Account / Shard)
//  "php"      : Paksa gunakan PHP + MySQL lokal / hosting
//  "local"    : Mode Demo Offline (localStorage browser)
// =====================================================================
window.CBT_BACKEND = "auto";

// Lokasi endpoint API PHP (relatif terhadap file HTML)
window.CBT_PHP_API_URL = "api/index.php";

// =====================================================================
// 2. KONFIGURASI MULTI-SHARD SUPABASE (HINGGA 5 AKUN / PROJECT)
// ---------------------------------------------------------------------
// Untuk menampung 700 peserta secara serentak tanpa terkena limit Free Tier,
// bagi data peserta ke 5 akun / project Supabase (misal ~140 siswa per akun).
// 
// Sistem CBT ini memiliki fitur "Auto-Routing":
// Saat siswa login, sistem akan mencari akun siswa di ke-5 server secara
// simultan dalam hitungan milidetik. Siswa langsung terhubung ke server miliknya!
// 
// Isi URL dan Anon Public Key dari masing-masing project Supabase Anda:
// (Project Settings -> API -> Project URL & Project API Keys 'anon' 'public')
// =====================================================================
window.CBT_SUPABASE_SHARDS = [
  {
    id: 1,
    name: "Server 1 (TKJ / Sesi 1)",
    url: "https://qozeuewusvoefcmofkgt.supabase.co",
    key: "sb_publishable_-CQYa2bUEs9JOE586-yejg_Q0OqQoD7"
  },
  {
    id: 2,
    name: "Server 2 (RPL / Sesi 2)",
    url: "",
    key: ""
  },
  {
    id: 3,
    name: "Server 3 (Multimedia / Sesi 3)",
    url: "",
    key: ""
  },
  {
    id: 4,
    name: "Server 4 (TBSM / Sesi 4)",
    url: "",
    key: ""
  },
  {
    id: 5,
    name: "Server 5 (Akuntansi / Sesi 5)",
    url: "",
    key: ""
  }
];

// Fallback jika CBT_SUPABASE_SHARDS di atas tidak diisi
window.CBT_DEFAULT_SUPABASE_URL = "https://qozeuewusvoefcmofkgt.supabase.co";
window.CBT_DEFAULT_SUPABASE_KEY = "sb_publishable_-CQYa2bUEs9JOE586-yejg_Q0OqQoD7";
