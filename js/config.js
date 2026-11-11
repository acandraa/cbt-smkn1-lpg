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
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvemV1ZXd1c3ZvZWZjbW9ma2d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTI4NzQsImV4cCI6MjA5NzI2ODg3NH0.MiF4BYgPruvW8tlqZqn8_ZZ2IFNXPP1VsEqVSHNWB7E"
  },
  {
    id: 2,
    name: "Server 2 (ATP / Sesi 2)",
    url: "https://uecyjrkpjzajhutmhuld.supabase.co",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlY3lqcmtwanphamh1dG1odWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2NzkxMTcsImV4cCI6MjA5NzI1NTExN30.R4ZCEsS2neePedTTNR6Du3loBANkInfegJuQ-jLeKek"
  },
  {
    id: 3,
    name: "Server 3 (TKRO / Sesi 3)",
    url: "https://pevzqjpgdwjefysbqggy.supabase.co",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBldnpxanBnZHdqZWZ5c2JxZ2d5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzNzQyMTAsImV4cCI6MjEwOTk1MDIxMH0.4HKqxcFZZLhPb7CRi54Jfv4KI-kuH0JH6aHFWyzZo-s"
  },
  {
    id: 4,
    name: "Server 4 (TBSM / Sesi 4)",
    url: "https://llxnzfptosowlfzviyug.supabase.co",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxseG56ZnB0b3Nvd2xmenZpeXVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzNzMyNTQsImV4cCI6MjEwOTk0OTI1NH0.fOzMw8FfCwYTpuwpAz84NNYpTJ47vTgnBBiVAsEeidQ"
  },
  {
    id: 5,
    name: "Server 5 (Akuntansi / Sesi 5)",
    url: "https://yiiiynemqaosspxzbngd.supabase.co",
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaWl5bmVtcWFvc3NweHpibmdkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzNzcxNzEsImV4cCI6MjEwOTk1MzE3MX0.2oCkV30Xf4W99MRRucoMfLGxFLJRyMhLIGGHPeipGQw"
  }
];

// Fallback jika CBT_SUPABASE_SHARDS di atas tidak diisi
window.CBT_DEFAULT_SUPABASE_URL = "https://qozeuewusvoefcmofkgt.supabase.co";
window.CBT_DEFAULT_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvemV1ZXd1c3ZvZWZjbW9ma2d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTI4NzQsImV4cCI6MjA5NzI2ODg3NH0.MiF4BYgPruvW8tlqZqn8_ZZ2IFNXPP1VsEqVSHNWB7E";
