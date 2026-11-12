// Admin Panel Controller

let setupModalInstance = null;
let importModalInstance = null;
let pesertaFormModalInstance = null;
let soalFormModalInstance = null;
let paketFormModalInstance = null;
let jurusanModalInstance = null;
let kelasModalInstance = null;
let cetakKartuModalInstance = null;
let aiGeneratorModalInstance = null;
let guruFormModalInstance = null;
let aiGeneratedQuestions = [];

let currentAdminUser = null;
let allPeserta = [];
let allGuru = [];
let allSoal = [];
let allHasil = [];
let allPaket = [];
let allPaketUnfiltered = [];
let allJurusan = [];
let allKelas = [];
let activePaketId = null;
let examSettings = {};

let activeTab = 'dashboard';
let importMode = 'peserta'; // 'peserta' or 'soal'
let importedDataCache = []; // stores parsed rows for Excel import preview

// Chart instances
let scoreDistChart = null;
let passRateChart = null;

// Live Monitoring state
let autoRefreshTimer = null;
let selectedMonitoringKelas = "";

document.addEventListener("DOMContentLoaded", async () => {
  // Initialize Modals
  setupModalInstance = new bootstrap.Modal(document.getElementById('setupModal'));
  importModalInstance = new bootstrap.Modal(document.getElementById('importModal'));
  pesertaFormModalInstance = new bootstrap.Modal(document.getElementById('pesertaFormModal'));
  soalFormModalInstance = new bootstrap.Modal(document.getElementById('soalFormModal'));
  paketFormModalInstance = new bootstrap.Modal(document.getElementById('paketFormModal'));
  jurusanModalInstance = new bootstrap.Modal(document.getElementById('jurusanModal'));
  kelasModalInstance = new bootstrap.Modal(document.getElementById('kelasModal'));
  cetakKartuModalInstance = new bootstrap.Modal(document.getElementById('cetakKartuModal'));
  const aiModalEl = document.getElementById('aiGeneratorModal');
  if (aiModalEl) aiGeneratorModalInstance = new bootstrap.Modal(aiModalEl);
  const guruModalEl = document.getElementById('guruFormModal');
  if (guruModalEl) guruFormModalInstance = new bootstrap.Modal(guruModalEl);

  // Form Handlers
  document.getElementById('form-setup-supabase').addEventListener('submit', handleSupabaseSetup);
  document.getElementById('form-update-supabase').addEventListener('submit', handleSupabaseUpdate);
  document.getElementById('form-settings-exam').addEventListener('submit', handleSettingsUpdate);
  document.getElementById('form-peserta-crud').addEventListener('submit', handlePesertaCrudSubmit);
  const formGuruEl = document.getElementById('form-guru-crud');
  if (formGuruEl) formGuruEl.addEventListener('submit', handleGuruCrudSubmit);
  document.getElementById('form-soal-crud').addEventListener('submit', handleSoalCrudSubmit);
  document.getElementById('form-paket-crud').addEventListener('submit', handlePaketCrudSubmit);
  document.getElementById('form-jurusan-quick').addEventListener('submit', handleQuickJurusanSubmit);
  document.getElementById('form-jurusan-modal').addEventListener('submit', handleModalJurusanSubmit);
  document.getElementById('form-kelas-quick').addEventListener('submit', handleQuickKelasSubmit);
  document.getElementById('form-kelas-modal').addEventListener('submit', handleModalKelasSubmit);
  document.getElementById('crud-soal-gambar').addEventListener('change', handleImageUpload);

  // Check URL parameters for explicit setup request
  const urlParams = new URLSearchParams(window.location.search);
  const forceSetup = urlParams.get('setup');

  if (forceSetup === 'true') {
    // Show credentials modal
    if (window.CBT_CONFIG.url) document.getElementById('setup-url').value = window.CBT_CONFIG.url;
    if (window.CBT_CONFIG.key) document.getElementById('setup-key').value = window.CBT_CONFIG.key;
    setupModalInstance.show();
    return;
  }

  // Authenticate Admin / Guru Session (supports local mock, PHP, and Supabase auth)
  currentAdminUser = await DB.checkSession('admin');
  if (!currentAdminUser) return;

  if (isGuruMode()) {
    applyGuruRoleUI();
    await refreshAllData();
    switchTab('soal');
  } else {
    document.getElementById('admin-display-name').innerText = currentAdminUser.email || 'Administrator';
    const topEmailEl = document.getElementById('admin-email');
    if (topEmailEl) topEmailEl.innerText = currentAdminUser.email || 'Administrator';
    initAdminShardSelector();
    await refreshAllData();
    toggleAutoRefresh(true);
  }
});

// Helper: Cek apakah sesi saat ini adalah Guru Mata Pelajaran
function isGuruMode() {
  return Boolean(currentAdminUser && currentAdminUser.role === 'guru');
}

function getGuruMapelKeywords() {
  if (!isGuruMode()) return [];
  const raw = String(currentAdminUser.mapel_diampu || '');
  return raw
    .split(/[,;/|]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function getGuruJurusanList() {
  if (!isGuruMode()) return [];
  const raw = String(currentAdminUser.jurusan_diampu || '');
  return raw
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s && s !== 'SEMUA');
}

function getGuruKelasList() {
  if (!isGuruMode()) return [];
  const raw = String(currentAdminUser.kelas_diampu || '');
  return raw
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s && s !== 'SEMUA');
}

function getGuruAllowedPaketIds() {
  if (!isGuruMode()) return [];
  const raw = currentAdminUser.paket_ids;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (e) {}
  }
  return [];
}

function isPaketAllowedForGuru(paket) {
  if (!isGuruMode()) return true;
  if (!paket) return false;
  const allowedIds = getGuruAllowedPaketIds();
  if (paket.id && allowedIds.includes(String(paket.id))) {
    return true;
  }
  const namaPaket = String(paket.nama_paket || '').toLowerCase().trim();
  if (!namaPaket) return false;
  const keywords = getGuruMapelKeywords();
  const mapelMatch = keywords.some(kw => kw && (namaPaket.includes(kw) || kw.includes(namaPaket)));
  if (!mapelMatch) return false;

  // Jika Guru memiliki batas Jurusan yang diampu, cocokkan dengan jurusan paket soal
  const guruJurusans = getGuruJurusanList();
  if (guruJurusans.length > 0) {
    const pkJurusan = String(paket.jurusan || '').trim().toUpperCase();
    // Hanya izinkan paket yang jurusannya termasuk dalam jurusan yang diampu guru
    if (!pkJurusan || pkJurusan === 'SEMUA' || !guruJurusans.includes(pkJurusan)) {
      return false;
    }
  }

  // Jika Guru memiliki batas Kelas/Tingkat yang diampu, cocokkan dengan kelas paket soal
  const guruKelas = getGuruKelasList();
  if (guruKelas.length > 0) {
    const pkKelas = String(paket.kelas || '').trim().toUpperCase();
    if (!pkKelas || pkKelas === 'SEMUA') return false;
    const kelasMatch = guruKelas.some(gk => {
      if (gk === pkKelas) return true;
      if (gk.startsWith('TINGKAT:')) {
        const tVal = gk.replace('TINGKAT:', '').trim();
        return checkKelasMatch(pkKelas, tVal).match || checkKelasMatch(pkKelas, `Kelas ${tVal}`).match || checkKelasMatch(gk, pkKelas).match;
      }
      return checkKelasMatch(gk, pkKelas).match || checkKelasMatch(pkKelas, gk).match;
    });
    if (!kelasMatch) return false;
  }

  return true;
}

function isHasilAllowedForGuru(hasil) {
  if (!isGuruMode()) return true;
  if (!hasil) return false;

  // 1. Cek kecocokan Mapel / Paket Soal
  const allowedIds = getGuruAllowedPaketIds();
  let mapelOrPaketMatch = false;
  if (hasil.paket_soal_id && allowedIds.includes(String(hasil.paket_soal_id))) {
    mapelOrPaketMatch = true;
  } else if (hasil.paket_soal_id && Array.isArray(allPaket) && allPaket.some(pk => String(pk.id) === String(hasil.paket_soal_id))) {
    mapelOrPaketMatch = true;
  } else {
    const namaMapel = String(hasil.nama_mapel || '').toLowerCase().trim();
    const keywords = getGuruMapelKeywords();
    if (namaMapel && keywords.some(kw => kw && (namaMapel.includes(kw) || kw.includes(namaMapel)))) {
      mapelOrPaketMatch = true;
    }
  }
  if (!mapelOrPaketMatch) return false;

  // 2. Cek kecocokan Jurusan Peserta (jika Guru ditugaskan ke jurusan spesifik)
  const guruJurusans = getGuruJurusanList();
  if (guruJurusans.length > 0) {
    const studentJurusan = String((hasil.peserta && hasil.peserta.jurusan) || '').trim().toUpperCase();
    if (studentJurusan && !guruJurusans.includes(studentJurusan)) {
      return false;
    }
  }

  // 3. Cek kecocokan Kelas / Tingkat Peserta (jika Guru ditugaskan ke kelas/tingkat spesifik)
  const guruKelas = getGuruKelasList();
  if (guruKelas.length > 0) {
    const studentKelas = String((hasil.peserta && hasil.peserta.kelas) || '').trim().toUpperCase();
    if (studentKelas) {
      const kMatch = guruKelas.some(gk => checkKelasMatch(gk, studentKelas).match || gk === studentKelas);
      if (!kMatch) return false;
    }
  }

  return true;
}

function formatGuruKelasLabel(rawKelas) {
  if (!rawKelas) return 'Semua Kelas';
  return String(rawKelas)
    .split(',')
    .map(k => {
      const clean = k.trim();
      if (clean.toUpperCase().startsWith('TINGKAT:')) {
        return `Tingkat ${clean.split(':')[1]}`;
      }
      return clean;
    })
    .filter(Boolean)
    .join(', ') || 'Semua Kelas';
}

function applyGuruRoleUI() {
  const guruName = currentAdminUser.nama_lengkap || currentAdminUser.username || 'Guru Mapel';
  const guruMapel = currentAdminUser.mapel_diampu || 'Mata Pelajaran';
  const guruJurusan = currentAdminUser.jurusan_diampu ? currentAdminUser.jurusan_diampu : 'Semua Jurusan';
  const guruKelas = formatGuruKelasLabel(currentAdminUser.kelas_diampu);
  const fullScopeLabel = `${guruMapel} (${guruJurusan} • ${guruKelas})`;

  const displayEl = document.getElementById('admin-display-name');
  if (displayEl) displayEl.innerText = guruName;

  const subEl = document.getElementById('admin-role-subtitle');
  if (subEl) subEl.innerText = 'Guru Mata Pelajaran';

  const topEmailEl = document.getElementById('admin-email');
  if (topEmailEl) topEmailEl.innerHTML = `<i class="bi bi-person-workspace me-1"></i>${escapeHtml(guruName)} <span class="badge bg-success ms-1">${escapeHtml(fullScopeLabel)}</span>`;

  const badgeWrap = document.getElementById('guru-mapel-badge-sidebar');
  const badgeText = document.getElementById('guru-mapel-badge-text');
  if (badgeWrap && badgeText) {
    badgeWrap.classList.remove('d-none');
    badgeText.innerText = fullScopeLabel;
  }

  // Sembunyikan menu yang khusus Admin
  ['nav-item-dashboard', 'nav-item-peserta', 'nav-item-guru', 'nav-item-jurusan', 'nav-item-pengaturan'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('d-none');
  });

  const shardWrap = document.getElementById('admin-shard-selector-wrapper');
  if (shardWrap) shardWrap.style.display = 'none';

  const btnGroupMaster = document.getElementById('btn-group-master-jurusan-kelas');
  if (btnGroupMaster) btnGroupMaster.classList.add('d-none');

  // Sesuaikan label menu untuk Guru
  const lblSoal = document.getElementById('nav-label-soal');
  if (lblSoal) lblSoal.innerText = 'Bank Soal Saya';
  const lblNilai = document.getElementById('nav-label-nilai');
  if (lblNilai) lblNilai.innerText = 'Nilai & Download';

  // Tampilkan banner informasi Mapel, Jurusan & Kelas di halaman Soal & Nilai
  const bannerSoal = document.getElementById('guru-scope-banner-soal');
  const bannerSoalMapel = document.getElementById('guru-banner-mapel-soal');
  if (bannerSoal && bannerSoalMapel) {
    bannerSoal.classList.remove('d-none');
    bannerSoal.classList.add('d-flex');
    bannerSoalMapel.innerText = fullScopeLabel;
  }

  const bannerNilai = document.getElementById('guru-scope-banner-nilai');
  const bannerNilaiMapel = document.getElementById('guru-banner-mapel-nilai');
  if (bannerNilai && bannerNilaiMapel) {
    bannerNilai.classList.remove('d-none');
    bannerNilai.classList.add('d-flex');
    bannerNilaiMapel.innerText = fullScopeLabel;
  }
}

// Refresh all database cache (dioptimasi: 1 batch paralel tanpa duplikasi request)
async function refreshAllData() {
  if (isGuruMode()) {
    await Promise.all([
      loadPaket(),
      loadJurusan(),
      loadKelas(),
      loadHasil()
    ]);
    return;
  }

  try {
    const [pesertaRes, hasilRes, guruRes, paketRes, jurRes, klsRes] = await Promise.all([
      DB.getPesertaList(),
      DB.getHasilList(),
      DB.getGuruList(),
      DB.getPaketList(),
      DB.getJurusanList(),
      DB.getKelasList()
    ]);

    allPeserta = pesertaRes || [];
    allHasil = hasilRes || [];
    allGuru = guruRes || [];
    allPaketUnfiltered = paketRes || [];
    allPaket = allPaketUnfiltered;
    allJurusan = jurRes || [];
    allKelas = klsRes || [];

    // Render komponen langsung dari memory cache secara instan
    renderDashboardStatsView();
    populateJurusanDropdowns();
    populateKelasDropdowns();
    populateHasilFilterDropdowns();
    renderPesertaTable(allPeserta);
    renderGuruTable(allGuru);
    renderPaketList(allPaket);
    renderJurusanTable();
    renderKelasTable();
    renderHasilTable(allHasil);

    // Ambil pengaturan ujian
    await loadSettings();
  } catch (err) {
    console.error("Gagal refreshAllData:", err);
  }
}

async function refreshJurusanDanKelas() {
  await Promise.all([loadJurusan(), loadKelas()]);
}

// Inisialisasi selector server jika menggunakan Multi-Shard Supabase
function initAdminShardSelector() {
  const wrapper = document.getElementById('admin-shard-selector-wrapper');
  const selector = document.getElementById('admin-shard-selector');
  if (!wrapper || !selector) return;

  const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
  if (shards.length > 1) {
    wrapper.style.display = 'block';
    const activeId = window.getActiveSupabaseShardId() || 'all';
    let opts = `<option value="all" ${activeId === 'all' ? 'selected' : ''}>🌐 Semua Server (Gabungan - 5 Server)</option>`;
    opts += shards.map(s => `
      <option value="${s.id}" ${String(s.id) === String(activeId) ? 'selected' : ''}>
        ⚡ ${s.name}
      </option>
    `).join('');
    selector.innerHTML = opts;
  } else {
    wrapper.style.display = 'none';
  }
}

// Handler ketika admin mengganti server database aktif
window.handleAdminShardSwitch = async function(shardId) {
  if (window.setActiveSupabaseShard) {
    const target = window.setActiveSupabaseShard(shardId);
    if (target) {
      // Pastikan shard target memiliki sesi admin aktif agar tidak terkena RLS
      if (target.client && target.client.auth && target.id !== 'all') {
        try {
          const { data } = await target.client.auth.getSession();
          if (!data || !data.session) {
            let syncCreds = null;
            try { syncCreds = JSON.parse(sessionStorage.getItem('CBT_ADMIN_AUTH_SYNC') || 'null'); } catch (e) {}
            const email = (syncCreds && syncCreds.email) || 'admin@smkn1lempuing.sch.id';
            const pass = (syncCreds && syncCreds.password) || 'admin123';
            await target.client.auth.signInWithPassword({ email, password: pass });
          }
        } catch (e) {
          console.warn(`[Shard ${target.id}] Gagal auto-reauth saat switch:`, e.message);
        }
      }

      if (typeof Swal !== 'undefined') {
        Swal.fire({
          toast: true,
          position: 'top-end',
          icon: 'info',
          title: `Tampilan: ${target.name}`,
          showConfirmButton: false,
          timer: 1500
        });
      }
      await refreshAllData();
    }
  }
};

// Tab switcher
function switchTab(tabId) {
  if (isGuruMode() && !['soal', 'nilai'].includes(tabId)) {
    tabId = 'soal';
  }
  activeTab = tabId;
  const sections = ['dashboard', 'peserta', 'guru', 'soal', 'jurusan', 'nilai', 'pengaturan'];
  
  sections.forEach(sec => {
    const el = document.getElementById(`sec-${sec}`);
    if (el) {
      if (sec === tabId) {
        el.classList.remove('d-none');
      } else {
        el.classList.add('d-none');
      }
    }
  });

  // Sidebar link highlight
  const links = document.querySelectorAll('.admin-nav-link');
  links.forEach(link => {
    const onclickAttr = link.getAttribute('onclick') || '';
    if (onclickAttr.includes(`'${tabId}'`)) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });

  if (tabId === 'dashboard' && !isGuruMode()) {
    loadDashboardStats();
    const autoSw = document.getElementById('switch-auto-refresh');
    if (autoSw && autoSw.checked) toggleAutoRefresh(true);
  } else {
    toggleAutoRefresh(false);
    if (tabId === 'guru' && !isGuruMode()) {
      loadGuru();
    } else if (tabId === 'jurusan') {
      renderJurusanTable();
      renderKelasTable();
    }
  }
}

// -------------------------------------------------------------
// CONNECTION SETUPS
// -------------------------------------------------------------

function handleSupabaseSetup(e) {
  e.preventDefault();
  const url = document.getElementById('setup-url').value.trim();
  const key = document.getElementById('setup-key').value.trim();

  localStorage.setItem('CBT_SUPABASE_URL', url);
  localStorage.setItem('CBT_SUPABASE_ANON_KEY', key);

  Swal.fire({
    icon: 'success',
    title: 'Koneksi Disimpan',
    text: 'Menghubungkan ulang...',
    timer: 1500,
    showConfirmButton: false
  }).then(() => {
    window.location.href = 'login.html';
  });
}

function handleSupabaseUpdate(e) {
  e.preventDefault();
  const url = document.getElementById('settings-supabase-url').value.trim();
  const key = document.getElementById('settings-supabase-key').value.trim();

  localStorage.setItem('CBT_SUPABASE_URL', url);
  localStorage.setItem('CBT_SUPABASE_ANON_KEY', key);

  Swal.fire('Koneksi Diperbarui', 'Sistem akan dimuat ulang.', 'success').then(() => {
    window.location.reload();
  });
}

// Load settings from DB Adapter
async function loadSettings() {
  if (DB.isPhp()) {
    renderPhpConnectionCard();
  } else {
    document.getElementById('settings-supabase-url').value = window.CBT_CONFIG.url || "";
    document.getElementById('settings-supabase-key').value = window.CBT_CONFIG.key || "";
  }

  try {
    const data = await DB.getSettings();
    if (data) {
      examSettings = data;
      document.getElementById('settings-exam-duration').value = data.durasi_menit;
      const passingInput = document.getElementById('settings-exam-passing');
      if (passingInput) passingInput.value = data.passing_grade || 0;
      if (data.tampilkan_nilai !== undefined) {
        document.getElementById('settings-exam-show-score').checked = data.tampilkan_nilai;
      }
      const tokenState = DB.getActiveTokenState ? DB.getActiveTokenState(data) : { token: data.token_ujian || 'CBT123', remainingMs: 180000 };
      document.getElementById('settings-exam-token').value = tokenState.token;
      const dashTokenEl = document.getElementById('dash-active-token');
      if (dashTokenEl) dashTokenEl.innerText = tokenState.token;
      if (data.token_aktif !== undefined) {
        document.getElementById('settings-exam-use-token').checked = data.token_aktif;
      }
      if (data.acak_soal !== undefined) {
        document.getElementById('settings-exam-randomize').checked = data.acak_soal;
      }
      startTokenAutoRotateLoop();
    }
  } catch (err) {
    console.error("Gagal memuat pengaturan:", err);
  }
}

async function handleSettingsUpdate(e) {
  e.preventDefault();
  const duration = parseInt(document.getElementById('settings-exam-duration').value);
  const passingInput = document.getElementById('settings-exam-passing');
  const passing = passingInput ? parseFloat(passingInput.value) : 0;
  const showScore = document.getElementById('settings-exam-show-score').checked;
  const token = document.getElementById('settings-exam-token').value;
  const useToken = document.getElementById('settings-exam-use-token').checked;
  const randomize = document.getElementById('settings-exam-randomize').checked;

  try {
    await DB.saveSettings(duration, passing, showScore, token, useToken, randomize);
    Swal.fire('Berhasil', 'Pengaturan Ujian disimpan.', 'success');
    await loadSettings();
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  }
}

// Mode PHP + MySQL: ganti kartu "Koneksi Supabase" dengan info server & ganti password admin
function renderPhpConnectionCard() {
  const card = document.getElementById('card-koneksi-db');
  if (!card || card.dataset.php === '1') return;
  card.dataset.php = '1';
  card.innerHTML = `
    <h5 class="fw-bold mb-3 text-primary"><i class="bi bi-hdd-network-fill me-2"></i>Database Server (PHP + MySQL)</h5>
    <p class="small text-muted mb-3">
      Aplikasi terhubung ke database MySQL melalui <code>api/index.php</code>.
      Pengaturan koneksi database diubah di berkas <code>api/config.php</code> pada hosting.
    </p>
    <form id="form-change-admin-pass">
      <h6 class="fw-semibold mb-2"><i class="bi bi-key-fill me-1"></i>Ganti Password Admin</h6>
      <div class="mb-2">
        <input type="password" class="form-control form-control-sm" id="admin-old-pass" placeholder="Password lama" required autocomplete="current-password">
      </div>
      <div class="mb-2">
        <input type="password" class="form-control form-control-sm" id="admin-new-pass" placeholder="Password baru (min. 6 karakter)" minlength="6" required autocomplete="new-password">
      </div>
      <div class="d-grid mt-3">
        <button type="submit" class="btn btn-primary-custom text-white btn-sm">Simpan Password Baru <i class="bi bi-save ms-1"></i></button>
      </div>
    </form>
  `;

  document.getElementById('form-change-admin-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPass = document.getElementById('admin-old-pass').value;
    const newPass = document.getElementById('admin-new-pass').value;
    try {
      await DB.api('changeAdminPassword', { old_password: oldPass, new_password: newPass });
      e.target.reset();
      Swal.fire('Berhasil', 'Password admin berhasil diubah.', 'success');
    } catch (err) {
      Swal.fire('Gagal', err.message || 'Terjadi kesalahan.', 'error');
    }
  });
}

let tokenAutoRotateTimer = null;
let lastSyncedTokenValue = null;

function formatTokenCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function startTokenAutoRotateLoop() {
  if (tokenAutoRotateTimer) clearInterval(tokenAutoRotateTimer);

  const tick = async () => {
    if (!DB.getActiveTokenState) return;
    const state = DB.getActiveTokenState(examSettings);
    const timeStr = formatTokenCountdown(state.remainingMs);

    const dashTokenEl = document.getElementById('dash-active-token');
    if (dashTokenEl && dashTokenEl.innerText !== state.token) {
      dashTokenEl.innerText = state.token;
    }
    const setTokenEl = document.getElementById('settings-exam-token');
    if (setTokenEl && setTokenEl.value !== state.token) {
      setTokenEl.value = state.token;
    }

    const dashCdEl = document.getElementById('dash-token-countdown');
    if (dashCdEl) dashCdEl.innerText = timeStr;
    const setCdEl = document.getElementById('settings-token-countdown');
    if (setCdEl) setCdEl.innerText = `⏱️ ${timeStr}`;

    // Jika token slot 3 menit baru saja berganti, sinkronkan ke database di latar belakang
    if (lastSyncedTokenValue !== state.token && !state.isCustomRecent) {
      lastSyncedTokenValue = state.token;
      try {
        const duration = (examSettings && examSettings.durasi_menit) || 60;
        const passing = (examSettings && examSettings.passing_grade) || 60;
        const showScore = examSettings && examSettings.tampilkan_nilai !== undefined ? examSettings.tampilkan_nilai : true;
        const useToken = examSettings && examSettings.token_aktif !== undefined ? examSettings.token_aktif : false;
        const randomize = examSettings && examSettings.acak_soal !== undefined ? examSettings.acak_soal : true;
        await DB.saveSettings(duration, passing, showScore, state.token, useToken, randomize);
      } catch (e) {}
    }
  };

  tick();
  tokenAutoRotateTimer = setInterval(tick, 1000);
}

function generateNewToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 6; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  document.getElementById('settings-exam-token').value = token;
  return token;
}

async function quickRotateTokenPembebas() {
  const newToken = generateNewToken();
  try {
    const duration = parseInt(document.getElementById('settings-exam-duration').value) || 60;
    const passingInput = document.getElementById('settings-exam-passing');
    const passing = passingInput ? (parseFloat(passingInput.value) || 60) : 60;
    const showScore = document.getElementById('settings-exam-show-score').checked;
    const useToken = document.getElementById('settings-exam-use-token').checked;
    const randomize = document.getElementById('settings-exam-randomize').checked;

    await DB.saveSettings(duration, passing, showScore, newToken, useToken, randomize);
    examSettings = {
      ...(examSettings || {}),
      durasi_menit: duration,
      passing_grade: passing,
      tampilkan_nilai: showScore,
      token_ujian: newToken,
      token_aktif: useToken,
      acak_soal: randomize,
      updated_at: new Date().toISOString()
    };
    lastSyncedTokenValue = newToken;
    const dashTokenEl = document.getElementById('dash-active-token');
    if (dashTokenEl) dashTokenEl.innerText = newToken;
    Swal.fire({
      toast: true,
      position: 'top-end',
      icon: 'success',
      title: `Token Pembebas baru: ${newToken} (Aktif 3 menit)`,
      showConfirmButton: false,
      timer: 2000
    });
  } catch (err) {
    Swal.fire('Gagal Memperbarui Token', err.message || 'Terjadi kesalahan.', 'error');
  }
}

// -------------------------------------------------------------
// LIVE MONITORING & DASHBOARD STATISTICS
// -------------------------------------------------------------

let isDashboardStatsLoading = false;

function toggleAutoRefresh(enabled) {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (enabled && activeTab === 'dashboard') {
    autoRefreshTimer = setInterval(() => {
      if (activeTab === 'dashboard') {
        loadDashboardStats(false);
      }
    }, 15000);
  }
}

async function loadDashboardStats(showIndicator = false) {
  if (isDashboardStatsLoading) return;
  isDashboardStatsLoading = true;

  const icon = document.getElementById('icon-refresh-dashboard');
  if (showIndicator && icon) icon.classList.add('spin-animation');

  try {
    const [pesertaList, hasilList] = await Promise.all([
      DB.getPesertaList(),
      DB.getHasilList()
    ]);
    allPeserta = pesertaList || [];
    allHasil = hasilList || [];

    renderDashboardStatsView();
  } catch (err) {
    console.error("Gagal memuat dashboard stats:", err);
  } finally {
    isDashboardStatsLoading = false;
    if (icon) {
      setTimeout(() => icon.classList.remove('spin-animation'), 600);
    }
  }
}

function renderDashboardStatsView() {
  const totalPeserta = (allPeserta || []).length;
  const sudahUjian = (allPeserta || []).filter(p => p.status_ujian === 'Sudah Ujian').length;
  const sedangUjian = (allPeserta || []).filter(p => p.status_ujian === 'Sedang Ujian').length;
  const belumUjian = totalPeserta - sudahUjian - sedangUjian;
  const terkunciOrWarning = (allPeserta || []).filter(p => Boolean(p.is_locked) || (parseInt(p.pelanggaran || 0) > 0)).length;

  // Update KPI counters
  const elTotal = document.getElementById('stat-total-peserta');
  const elSedang = document.getElementById('stat-sedang-ujian');
  const elSudah = document.getElementById('stat-sudah-ujian');
  const elBelum = document.getElementById('stat-belum-ujian');
  const elTerkunci = document.getElementById('stat-terkunci-count');

  if (elTotal) elTotal.innerText = totalPeserta;
  if (elSedang) elSedang.innerText = sedangUjian;
  if (elSudah) elSudah.innerText = sudahUjian;
  if (elBelum) elBelum.innerText = belumUjian;
  if (elTerkunci) elTerkunci.innerText = terkunciOrWarning;

  // Populate filter dropdowns
  populateMonitoringFilterDropdowns();

  // Render Live Monitoring Cards & Table
  renderMonitoringKelasCards();
  filterMonitoringTable();

  // Calculate score analytics
  let maxVal = 0;
  let avgVal = 0;
  let lulusCount = 0;
  let tidakLulusCount = 0;
  const bins = [0, 0, 0, 0, 0]; // 0-20, 21-40, 41-60, 61-80, 81-100

  if (allHasil && allHasil.length > 0) {
    let sum = 0;
    allHasil.forEach(h => {
      const val = parseFloat(h.nilai) || 0;
      sum += val;
      if (val > maxVal) maxVal = val;
      if (h.status_kelulusan === 'Lulus') lulusCount++;
      else tidakLulusCount++;

      if (val <= 20) bins[0]++;
      else if (val <= 40) bins[1]++;
      else if (val <= 60) bins[2]++;
      else if (val <= 80) bins[3]++;
      else bins[4]++;
    });
    avgVal = (sum / allHasil.length).toFixed(1);
  }

  const elMax = document.getElementById('stat-nilai-tertinggi');
  const elAvg = document.getElementById('stat-nilai-rata');
  const elLulus = document.getElementById('stat-lulus-count');
  const elTdkLulus = document.getElementById('stat-tidak-lulus-count');

  if (elMax) elMax.innerText = maxVal.toFixed(1);
  if (elAvg) elAvg.innerText = avgVal;
  if (elLulus) elLulus.innerText = lulusCount;
  if (elTdkLulus) elTdkLulus.innerText = tidakLulusCount;

  renderCharts(bins, lulusCount, tidakLulusCount);
}

function populateMonitoringFilterDropdowns() {
  const jurusanSet = new Set((allJurusan || []).map(j => (j.nama_jurusan || j.nama || '').toUpperCase()).filter(Boolean));
  const kelasSet = new Set((allKelas || []).map(k => (k.nama_kelas || k.nama || '').toUpperCase()).filter(Boolean));

  (allPeserta || []).forEach(p => {
    if (p.jurusan) jurusanSet.add(p.jurusan.toUpperCase());
    if (p.kelas) kelasSet.add(p.kelas.toUpperCase());
  });

  const sortedJurusan = Array.from(jurusanSet).sort();
  const sortedKelas = Array.from(kelasSet).sort();

  // 1. Dropdown Jurusan di atas Card Kelas
  const selCardJur = document.getElementById('monitor-card-filter-jurusan');
  if (selCardJur) {
    const cur = selCardJur.value;
    const jurOpts = ['<option value="">Semua Jurusan</option>'];
    sortedJurusan.forEach(j => {
      jurOpts.push(`<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`);
    });
    selCardJur.innerHTML = jurOpts.join('');
    if (cur && sortedJurusan.includes(cur)) selCardJur.value = cur;
  }

  // 2. Dropdown Jurusan di atas Tabel
  const selTblJur = document.getElementById('monitor-table-filter-jurusan');
  if (selTblJur) {
    const cur = selTblJur.value;
    const jurOpts = ['<option value="">Semua Jurusan</option>'];
    sortedJurusan.forEach(j => {
      jurOpts.push(`<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`);
    });
    selTblJur.innerHTML = jurOpts.join('');
    if (cur && sortedJurusan.includes(cur)) selTblJur.value = cur;
  }

  // 3. Dropdown Kelas di atas Tabel
  const selTblKls = document.getElementById('monitor-table-filter-kelas');
  if (selTblKls) {
    const cur = selTblKls.value;
    const klsOpts = ['<option value="">Semua Kelas</option>'];
    sortedKelas.forEach(k => {
      klsOpts.push(`<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`);
    });
    selTblKls.innerHTML = klsOpts.join('');
    if (cur && sortedKelas.includes(cur)) selTblKls.value = cur;
  }
}

function renderMonitoringKelasCards() {
  const container = document.getElementById('monitor-kelas-cards-container');
  if (!container) return;

  const selJurusan = (document.getElementById('monitor-card-filter-jurusan')?.value || '').toUpperCase();

  // Kumpulkan semua kelas unik
  const masterNames = (allKelas || []).map(k => (k.nama_kelas || k.nama || '').toUpperCase()).filter(Boolean);
  const classNamesSet = new Set(masterNames);
  (allPeserta || []).forEach(p => { if (p.kelas) classNamesSet.add(p.kelas.toUpperCase()); });

  const classList = Array.from(classNamesSet).sort().map(className => {
    const students = (allPeserta || []).filter(p => (p.kelas || '').toUpperCase() === className);
    const total = students.length;
    const sedang = students.filter(p => p.status_ujian === 'Sedang Ujian').length;
    const sudah = students.filter(p => p.status_ujian === 'Sudah Ujian').length;
    const belum = total - sedang - sudah;
    const terkunci = students.filter(p => Boolean(p.is_locked) || (parseInt(p.pelanggaran || 0) > 0)).length;

    // Deteksi jurusan mayoritas siswa di kelas ini
    let detectedJurusan = "";
    if (students.length > 0 && students[0].jurusan) {
      detectedJurusan = students[0].jurusan.toUpperCase();
    } else {
      for (const j of allJurusan) {
        const jName = (j.nama_jurusan || j.nama || '').toUpperCase();
        if (jName && className.includes(jName)) {
          detectedJurusan = jName;
          break;
        }
      }
      if (!detectedJurusan && (className.includes('AKL') || className.includes('AKUNTANSI'))) {
        detectedJurusan = 'AKL';
      }
    }

    return {
      nama: className,
      jurusan: detectedJurusan,
      total,
      sedang,
      sudah,
      belum,
      terkunci
    };
  });

  // Filter berdasarkan Jurusan jika dipilih
  let filtered = classList;
  if (selJurusan) {
    filtered = filtered.filter(k => k.jurusan === selJurusan || k.nama.includes(selJurusan));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="col-12 text-center py-4 text-muted">
        <i class="bi bi-inbox fs-2 d-block mb-2 text-muted"></i>
        Tidak ada data kelas yang cocok dengan jurusan yang dipilih.
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(k => {
    const isSelected = selectedMonitoringKelas && selectedMonitoringKelas.toUpperCase() === k.nama.toUpperCase();
    const borderStyle = isSelected ? 'border-primary shadow' : 'border';
    const bgHeader = isSelected ? 'bg-primary-subtle' : '';

    const pctSedang = k.total > 0 ? ((k.sedang / k.total) * 100).toFixed(0) : 0;
    const pctSudah = k.total > 0 ? ((k.sudah / k.total) * 100).toFixed(0) : 0;
    const pctBelum = k.total > 0 ? (100 - pctSedang - pctSudah) : 100;

    return `
      <div class="col-sm-6 col-lg-4 col-xl-3">
        <div class="glass-card p-3 h-100 ${borderStyle} position-relative" style="${isSelected ? 'transform: translateY(-2px); border-width: 2px !important;' : ''}">
          <div class="d-flex justify-content-between align-items-start mb-2 ${bgHeader} p-1 rounded">
            <div>
              <h6 class="fw-bold mb-0 text-dark">${escapeHtml(k.nama)}</h6>
              <span class="badge bg-light text-secondary border small">${escapeHtml(k.jurusan || 'Semua')}</span>
            </div>
            <span class="badge ${k.total > 0 ? 'bg-primary' : 'bg-secondary'} rounded-pill">${k.total} Siswa</span>
          </div>

          <!-- Progress Bar Multi-Segment -->
          <div class="progress mb-2" style="height: 10px;" title="Sedang: ${k.sedang}, Selesai: ${k.sudah}, Belum: ${k.belum}">
            <div class="progress-bar bg-success" style="width: ${pctSedang}%" title="Sedang Mengerjakan: ${k.sedang}"></div>
            <div class="progress-bar bg-primary" style="width: ${pctSudah}%" title="Selesai: ${k.sudah}"></div>
            <div class="progress-bar bg-secondary-subtle" style="width: ${pctBelum}%" title="Belum Masuk: ${k.belum}"></div>
          </div>

          <!-- Quick breakdown stats -->
          <div class="d-flex justify-content-around text-center small mb-3 py-1 px-1 rounded bg-light">
            <div>
              <span class="text-success fw-bold d-block">${k.sedang}</span>
              <span class="text-muted" style="font-size: 0.68rem;">Mengerjakan</span>
            </div>
            <div>
              <span class="text-primary fw-bold d-block">${k.sudah}</span>
              <span class="text-muted" style="font-size: 0.68rem;">Selesai</span>
            </div>
            <div>
              <span class="text-secondary fw-bold d-block">${k.belum}</span>
              <span class="text-muted" style="font-size: 0.68rem;">Belum</span>
            </div>
            ${k.terkunci > 0 ? `
            <div>
              <span class="text-danger fw-bold d-block">${k.terkunci}</span>
              <span class="text-muted" style="font-size: 0.68rem;">Terkunci</span>
            </div>` : ''}
          </div>

          <!-- Action Button -->
          <button class="btn ${isSelected ? 'btn-primary' : 'btn-outline-primary'} btn-sm w-100 py-1" onclick="filterMonitoringByKelas('${escapeAttr(k.nama)}')">
            <i class="bi ${isSelected ? 'bi-check-circle-fill' : 'bi-eye-fill'} me-1"></i> ${isSelected ? 'Sedang Dipantau' : 'Pantau Kelas Ini'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterMonitoringByKelas(className) {
  if (selectedMonitoringKelas === className) {
    clearMonitoringClassFilter();
    return;
  }
  selectedMonitoringKelas = className;
  const sel = document.getElementById('monitor-table-filter-kelas');
  if (sel) sel.value = className;

  const pill = document.getElementById('monitor-active-class-pill');
  const nameEl = document.getElementById('monitor-active-class-name');
  if (pill && nameEl) {
    nameEl.innerText = className;
    pill.classList.remove('d-none');
  }

  renderMonitoringKelasCards();
  filterMonitoringTable();

  // Scroll to table smoothly
  const tableSec = document.getElementById('section-live-peserta');
  if (tableSec) tableSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearMonitoringClassFilter() {
  selectedMonitoringKelas = "";
  const sel = document.getElementById('monitor-table-filter-kelas');
  if (sel) sel.value = "";

  const pill = document.getElementById('monitor-active-class-pill');
  if (pill) pill.classList.add('d-none');

  renderMonitoringKelasCards();
  filterMonitoringTable();
}

function resetMonitoringKelasFilter() {
  const sel = document.getElementById('monitor-card-filter-jurusan');
  if (sel) sel.value = "";
  renderMonitoringKelasCards();
}

function onMonitorFilterJurusanChange() {
  const jur = document.getElementById('monitor-table-filter-jurusan')?.value || "";
  const cardJur = document.getElementById('monitor-card-filter-jurusan');
  if (cardJur) {
    cardJur.value = jur;
    renderMonitoringKelasCards();
  }
  filterMonitoringTable();
}

function resetMonitoringFullFilter() {
  const q = document.getElementById('monitor-search-input');
  const jur = document.getElementById('monitor-table-filter-jurusan');
  const kls = document.getElementById('monitor-table-filter-kelas');
  const st = document.getElementById('monitor-table-filter-status');
  const cardJur = document.getElementById('monitor-card-filter-jurusan');

  if (q) q.value = "";
  if (jur) jur.value = "";
  if (kls) kls.value = "";
  if (st) st.value = "Sedang Ujian";
  if (cardJur) cardJur.value = "";

  selectedMonitoringKelas = "";
  const pill = document.getElementById('monitor-active-class-pill');
  if (pill) pill.classList.add('d-none');

  renderMonitoringKelasCards();
  filterMonitoringTable();
}

function filterMonitoringTable() {
  const tbody = document.getElementById('table-live-monitoring-body');
  const badgeCount = document.getElementById('badge-live-table-count');
  if (!tbody) return;

  const q = (document.getElementById('monitor-search-input')?.value || '').toLowerCase().trim();
  const jur = (document.getElementById('monitor-table-filter-jurusan')?.value || '').toUpperCase();
  const kls = (document.getElementById('monitor-table-filter-kelas')?.value || '').toUpperCase();
  const st = document.getElementById('monitor-table-filter-status')?.value || '';

  const filtered = (allPeserta || []).filter(p => {
    const nameMatch = !q ||
      (p.nama_lengkap || '').toLowerCase().includes(q) ||
      (p.username || '').toLowerCase().includes(q);

    const pJur = (p.jurusan || '').toUpperCase();
    const jurMatch = !jur || pJur === jur;

    const pKls = (p.kelas || '').toUpperCase();
    const klsMatch = !kls || pKls === kls;

    let stMatch = true;
    if (st === 'PELANGGARAN') {
      stMatch = Boolean(p.is_locked) || (parseInt(p.pelanggaran || 0) > 0);
    } else if (st) {
      stMatch = (p.status_ujian === st);
    }

    return nameMatch && jurMatch && klsMatch && stMatch;
  });

  if (badgeCount) badgeCount.innerText = `${filtered.length} Peserta`;

  if (filtered.length === 0) {
    let emptyMsg = "Tidak ada peserta yang sedang ujian saat ini.";
    if (st === 'Belum Ujian') emptyMsg = "Tidak ada peserta yang berstatus Belum Ujian.";
    else if (st === 'Sudah Ujian') emptyMsg = "Tidak ada peserta yang berstatus Sudah Ujian.";
    else if (st === 'PELANGGARAN') emptyMsg = "Aman! Tidak ada peserta yang terkunci atau melanggar aturan.";
    else if (q || jur || kls) emptyMsg = "Tidak ada data peserta yang cocok dengan filter yang diterapkan.";

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-4 text-muted">
          <i class="bi bi-info-circle fs-3 d-block mb-2 text-muted"></i>
          ${emptyMsg}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map((p, idx) => {
    // Status Badge
    let statusBadge = `<span class="badge bg-secondary-subtle text-secondary border px-2 py-1"><i class="bi bi-clock me-1"></i>Belum Ujian</span>`;
    if (p.status_ujian === 'Sedang Ujian') {
      statusBadge = `<span class="badge bg-success-subtle text-success border border-success px-2 py-1"><span class="spinner-grow spinner-grow-sm me-1 text-success" style="width: 0.4rem; height: 0.4rem;"></span>Mengerjakan</span>`;
    } else if (p.status_ujian === 'Sudah Ujian') {
      statusBadge = `<span class="badge bg-primary-subtle text-primary border border-primary px-2 py-1"><i class="bi bi-check-circle-fill me-1"></i>Selesai</span>`;
    }

    // Security & Violation Badge
    let securityBadge = `<span class="badge bg-light text-success border"><i class="bi bi-shield-check me-1"></i>Aman</span>`;
    const pelanggaranCount = parseInt(p.pelanggaran || 0);
    if (p.is_locked) {
      securityBadge = `<span class="badge bg-danger text-white"><i class="bi bi-lock-fill me-1"></i>TERKUNCI</span>`;
    } else if (pelanggaranCount > 0) {
      securityBadge = `<span class="badge bg-warning text-dark"><i class="bi bi-exclamation-triangle-fill me-1"></i>${pelanggaranCount}x Peringatan</span>`;
    }

    // Proctor Actions
    const isExamRunning = p.status_ujian === 'Sedang Ujian';
    const forceFinishBtn = isExamRunning ? `
      <button class="btn btn-outline-danger btn-sm py-0 px-2" title="Paksa Selesaikan Ujian" onclick="paksaSelesaiUjian('${p.id}', '${escapeAttr(p.nama_lengkap)}')">
        <i class="bi bi-stop-circle me-1"></i>Selesai
      </button>
    ` : '';

    const lockBtn = `
      <button class="btn ${p.is_locked ? 'btn-warning' : 'btn-outline-warning'} btn-sm py-0 px-2" title="${p.is_locked ? 'Buka Kunci Akses Ujian' : 'Kunci / Blokir Akses'}" onclick="togglePesertaLock('${p.id}', ${!p.is_locked})">
        <i class="bi ${p.is_locked ? 'bi-unlock-fill' : 'bi-lock-fill'}"></i>
      </button>
    `;

    const resetBtn = `
      <button class="btn btn-outline-secondary btn-sm py-0 px-2" title="Reset Sesi Ujian" onclick="handleProctorResetSesi('${p.id}', '${escapeAttr(p.nama_lengkap)}')">
        <i class="bi bi-arrow-counterclockwise"></i>
      </button>
    `;

    return `
      <tr>
        <td class="fw-semibold text-muted">${idx + 1}</td>
        <td>
          <div class="fw-bold text-dark">${escapeHtml(p.nama_lengkap)}</div>
          <small class="text-muted"><i class="bi bi-person me-1"></i>${escapeHtml(p.username)}</small>
        </td>
        <td>
          <span class="badge bg-success-subtle text-success border border-success-subtle me-1">${escapeHtml(p.kelas || '-')}</span>
          <span class="badge bg-info-subtle text-dark border border-info-subtle">${escapeHtml(p.jurusan || '-')}</span>
        </td>
        <td>
          <span class="badge bg-light text-dark border me-1">${escapeHtml(p.ruang || 'R. Default')}</span>
          <small class="text-muted">Sesi ${escapeHtml(p.sesi || '1')}</small>
        </td>
        <td>${statusBadge}</td>
        <td>${securityBadge}</td>
        <td class="text-center">
          <div class="btn-group btn-group-sm" role="group">
            ${forceFinishBtn}
            ${lockBtn}
            ${resetBtn}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleProctorResetSesi(pesertaId, nama) {
  const result = await Swal.fire({
    title: 'Reset Sesi Peserta?',
    text: `Ujian atas nama "${nama}" akan direset. Semua jawaban dan status pelanggaran akan dibersihkan agar siswa dapat login kembali.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Reset Sesi',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      await DB.resetPesertaSesi(pesertaId);
      Swal.fire('Berhasil', `Sesi ujian "${nama}" telah berhasil direset.`, 'success');
      await loadDashboardStats();
    } catch (err) {
      Swal.fire('Gagal Reset', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

function renderCharts(distributionData, lulus, tidakLulus) {
  const canvas1 = document.getElementById('scoreDistributionChart');
  if (canvas1) {
    if (scoreDistChart) {
      scoreDistChart.data.datasets[0].data = distributionData;
      scoreDistChart.update('none');
    } else {
      const ctx1 = canvas1.getContext('2d');
      scoreDistChart = new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: ['0 - 20', '21 - 40', '41 - 60', '61 - 80', '81 - 100'],
          datasets: [{
            label: 'Jumlah Peserta',
            data: distributionData,
            backgroundColor: 'rgba(13, 110, 253, 0.7)',
            borderColor: '#0d6efd',
            borderWidth: 1,
            borderRadius: 5
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              ticks: { stepSize: 1 }
            }
          }
        }
      });
    }
  }

  const canvas2 = document.getElementById('passingRateChart');
  if (canvas2) {
    if (passRateChart) {
      passRateChart.data.datasets[0].data = [lulus, tidakLulus];
      passRateChart.update('none');
    } else {
      const ctx2 = canvas2.getContext('2d');
      passRateChart = new Chart(ctx2, {
        type: 'doughnut',
        data: {
          labels: ['Lulus', 'Tidak Lulus'],
          datasets: [{
            data: [lulus, tidakLulus],
            backgroundColor: ['#198754', '#dc3545'],
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom' }
          }
        }
      });
    }
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// -------------------------------------------------------------
// MASTER DATA JURUSAN MANAGEMENT
// -------------------------------------------------------------

async function loadJurusan() {
  try {
    const list = await DB.getJurusanList();
    allJurusan = Array.isArray(list) ? list : [];

    renderJurusanTable();
    populateJurusanDropdowns();
    populateMonitoringFilterDropdowns();
    renderMonitoringKelasCards();
    const curCheckedJ = Array.from(document.querySelectorAll('.chk-guru-jurusan:checked')).map(el => el.value).join(', ');
    renderGuruJurusanChecklist(curCheckedJ);
  } catch (err) {
    console.error("Gagal memuat master jurusan:", err);
  }
}

function renderJurusanTable() {
  const tbody = document.getElementById('jurusan-table-body');
  const badgeTotal = document.getElementById('badge-total-jurusan');
  if (badgeTotal) badgeTotal.innerText = `${allJurusan.length} Jurusan`;
  if (!tbody) return;

  if (allJurusan.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">Belum ada jurusan yang ditambahkan. Silakan tambahkan jurusan baru.</td></tr>`;
    return;
  }

  tbody.innerHTML = allJurusan.map((j, idx) => {
    const jName = (j.nama_jurusan || '').toUpperCase().trim();
    const countPeserta = (allPeserta || []).filter(p => (p.jurusan || '').toUpperCase().trim() === jName).length;
    
    // Paket khusus jurusan ini + paket umum yang berlaku untuk semua jurusan
    const khususPaket = (allPaket || []).filter(p => (p.jurusan || '').toUpperCase().trim() === jName).length;
    const umumPaket = (allPaket || []).filter(p => {
      const pj = (p.jurusan || '').toUpperCase().trim();
      return !pj || pj === 'SEMUA';
    }).length;
    const totalPaket = khususPaket + umumPaket;

    return `
      <tr>
        <td class="fw-semibold text-muted">${idx + 1}</td>
        <td>
          <span class="badge bg-primary-subtle text-primary border border-primary-subtle fs-6 px-3 py-2">
            <i class="bi bi-mortarboard-fill me-2"></i>${escapeHtml(j.nama_jurusan)}
          </span>
        </td>
        <td><span class="badge bg-info text-dark px-2 py-1"><i class="bi bi-people-fill me-1"></i>${countPeserta} Siswa</span></td>
        <td>
          <span class="badge ${totalPaket > 0 ? 'bg-primary text-white' : 'bg-secondary'} px-2 py-1">
            <i class="bi bi-collection-fill me-1"></i>${totalPaket} Paket
          </span>
          ${umumPaket > 0 && khususPaket > 0 ? `<small class="text-muted d-block mt-1" style="font-size: 0.72rem;">(${khususPaket} khusus, ${umumPaket} umum)</small>` : ''}
          ${umumPaket > 0 && khususPaket === 0 ? `<small class="text-muted d-block mt-1" style="font-size: 0.72rem;">(${umumPaket} paket umum)</small>` : ''}
        </td>
        <td class="text-center">
          <button class="btn btn-outline-danger btn-sm" onclick="deleteJurusan('${j.id}', '${escapeHtml(j.nama_jurusan)}')" title="Hapus Jurusan">
            <i class="bi bi-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderJurusanModalList() {
  const container = document.getElementById('modal-jurusan-list');
  if (!container) return;

  if (allJurusan.length === 0) {
    container.innerHTML = `<div class="text-center py-3 text-muted small">Belum ada jurusan.</div>`;
    return;
  }

  container.innerHTML = allJurusan.map(j => `
    <div class="list-group-item d-flex justify-content-between align-items-center py-2 px-3">
      <span class="fw-semibold text-primary"><i class="bi bi-mortarboard-fill me-2"></i>${escapeHtml(j.nama_jurusan)}</span>
      <button class="btn btn-sm btn-outline-danger py-0 px-2" onclick="deleteJurusan('${j.id}', '${escapeHtml(j.nama_jurusan)}', true)">
        <i class="bi bi-trash"></i>
      </button>
    </div>
  `).join('');
}

function openJurusanModal() {
  renderJurusanModalList();
  if (jurusanModalInstance) {
    jurusanModalInstance.show();
  }
}

async function handleQuickJurusanSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('quick-nama-jurusan');
  const btn = document.getElementById('btn-save-jurusan-quick');
  const nama = input.value.trim().toUpperCase();
  if (!nama) return;

  btn.disabled = true;
  try {
    await DB.saveJurusan(null, nama);
    input.value = "";
    Swal.fire({
      icon: 'success',
      title: 'Jurusan Ditambahkan',
      text: `Jurusan ${nama} berhasil disimpan ke sistem.`,
      timer: 1300,
      showConfirmButton: false
    });
    await loadJurusan();
  } catch (err) {
    Swal.fire('Gagal Menambah Jurusan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleModalJurusanSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('modal-input-jurusan');
  const nama = input.value.trim().toUpperCase();
  if (!nama) return;

  try {
    await DB.saveJurusan(null, nama);
    input.value = "";
    await loadJurusan();
    renderJurusanModalList();
  } catch (err) {
    Swal.fire('Gagal', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function deleteJurusan(id, nama, fromModal = false) {
  const result = await Swal.fire({
    title: `Hapus Jurusan ${nama}?`,
    text: "Jurusan ini tidak akan muncul lagi di pilihan dropdown. Data siswa dan soal lama tetap tersimpan.",
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      await DB.deleteJurusan(id, nama);
      await loadJurusan();
      if (fromModal) renderJurusanModalList();
      Swal.fire('Dihapus', `Jurusan ${nama} telah dihapus.`, 'success');
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

function populateJurusanDropdowns() {
  const masterNames = (allJurusan || []).map(j => (j.nama_jurusan || '').toUpperCase()).filter(Boolean);

  // Kumpulkan juga jika ada peserta/paket dengan jurusan kustom
  const allNamesSet = new Set(masterNames);
  (allPeserta || []).forEach(p => { if (p.jurusan) allNamesSet.add(p.jurusan.toUpperCase()); });
  (allPaket || []).forEach(pk => {
    if (pk.jurusan && pk.jurusan.toLowerCase() !== 'semua') allNamesSet.add(pk.jurusan.toUpperCase());
  });
  const sortedList = Array.from(allNamesSet).sort();
  const optionsHtml = sortedList.map(j => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`).join('');

  // 1. Dropdown Form Peserta (crud-peserta-jurusan)
  const selPeserta = document.getElementById('crud-peserta-jurusan');
  if (selPeserta) {
    const cur = selPeserta.value;
    selPeserta.innerHTML = '<option value="">Pilih Jurusan...</option>' + optionsHtml;
    if (cur) selPeserta.value = cur;
  }

  // 2. Dropdown Form Paket Soal (crud-paket-jurusan)
  const selPaket = document.getElementById('crud-paket-jurusan');
  if (selPaket) {
    const cur = selPaket.value;
    selPaket.innerHTML = '<option value="">Semua Jurusan (Umum)</option>' + optionsHtml;
    if (cur) selPaket.value = cur;
  }

  // 3. Filter Jurusan Paket Soal (filter-jurusan-paket)
  const fPaket = document.getElementById('filter-jurusan-paket');
  if (fPaket) {
    const cur = fPaket.value;
    fPaket.innerHTML = '<option value="">Semua Jurusan</option>' + optionsHtml;
    if (cur) fPaket.value = cur;
  }

  // 4. Filter Jurusan Peserta (filter-jurusan-peserta)
  const fPeserta = document.getElementById('filter-jurusan-peserta');
  if (fPeserta) {
    const cur = fPeserta.value;
    fPeserta.innerHTML = '<option value="">Semua Jurusan</option>' + optionsHtml;
    if (cur) fPeserta.value = cur;
  }

  // 5. Filter Jurusan Hasil (filter-jurusan-hasil)
  const fHasil = document.getElementById('filter-jurusan-hasil');
  if (fHasil) {
    const cur = fHasil.value;
    fHasil.innerHTML = '<option value="">Semua Jurusan</option>' + optionsHtml;
    if (cur) fHasil.value = cur;
  }
}

// -------------------------------------------------------------
// MASTER DATA KELAS MANAGEMENT
// -------------------------------------------------------------

async function loadKelas() {
  try {
    const list = await DB.getKelasList();
    allKelas = Array.isArray(list) ? list : [];

    renderKelasTable();
    populateKelasDropdowns();
    populateMonitoringFilterDropdowns();
    renderMonitoringKelasCards();
    const curCheckedK = Array.from(document.querySelectorAll('.chk-guru-kelas:checked')).map(el => el.value).join(', ');
    renderGuruKelasChecklist(curCheckedK);
  } catch (err) {
    console.error("Gagal memuat master kelas:", err);
  }
}

function renderKelasTable() {
  const tbody = document.getElementById('kelas-table-body');
  const badgeTotal = document.getElementById('badge-total-kelas');
  if (badgeTotal) badgeTotal.innerText = `${allKelas.length} Kelas`;
  if (!tbody) return;

  if (allKelas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">Belum ada kelas yang ditambahkan. Silakan tambahkan kelas baru.</td></tr>`;
    return;
  }

  tbody.innerHTML = allKelas.map((k, idx) => {
    const kName = (k.nama_kelas || '').toUpperCase().trim();
    const countPeserta = (allPeserta || []).filter(p => (p.kelas || '').toUpperCase().trim() === kName).length;
    
    // Hitung paket yang terhubung dengan kelas ini (cocok rombel, cocok tingkat X/XI/XII, atau paket umum semua kelas)
    const matchedPaket = (allPaket || []).filter(p => checkKelasMatch(p.kelas, kName).match);
    const countPaket = matchedPaket.length;

    return `
      <tr>
        <td class="fw-semibold text-muted">${idx + 1}</td>
        <td>
          <span class="badge bg-success-subtle text-success border border-success-subtle fs-6 px-3 py-2">
            <i class="bi bi-collection-fill me-2"></i>${escapeHtml(k.nama_kelas)}
          </span>
        </td>
        <td><span class="badge bg-info text-dark px-2 py-1"><i class="bi bi-people-fill me-1"></i>${countPeserta} Siswa</span></td>
        <td>
          <span class="badge ${countPaket > 0 ? 'bg-primary text-white' : 'bg-secondary'} px-2 py-1">
            <i class="bi bi-collection-fill me-1"></i>${countPaket} Paket
          </span>
        </td>
        <td class="text-center">
          <button class="btn btn-outline-danger btn-sm" onclick="deleteKelas('${k.id}', '${escapeHtml(k.nama_kelas)}')" title="Hapus Kelas">
            <i class="bi bi-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderKelasModalList() {
  const container = document.getElementById('modal-kelas-list');
  if (!container) return;

  if (allKelas.length === 0) {
    container.innerHTML = `<div class="text-center py-3 text-muted small">Belum ada kelas.</div>`;
    return;
  }

  container.innerHTML = allKelas.map(k => `
    <div class="list-group-item d-flex justify-content-between align-items-center py-2 px-3">
      <span class="fw-semibold text-success"><i class="bi bi-collection-fill me-2"></i>${escapeHtml(k.nama_kelas)}</span>
      <button class="btn btn-sm btn-outline-danger py-0 px-2" onclick="deleteKelas('${k.id}', '${escapeHtml(k.nama_kelas)}', true)">
        <i class="bi bi-trash"></i>
      </button>
    </div>
  `).join('');
}

function openKelasModal() {
  renderKelasModalList();
  if (kelasModalInstance) {
    kelasModalInstance.show();
  }
}

async function handleQuickKelasSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('quick-nama-kelas');
  const btn = document.getElementById('btn-save-kelas-quick');
  const nama = input.value.trim().toUpperCase();
  if (!nama) return;

  btn.disabled = true;
  try {
    await DB.saveKelas(null, nama);
    input.value = "";
    Swal.fire({
      icon: 'success',
      title: 'Kelas Ditambahkan',
      text: `Kelas ${nama} berhasil disimpan ke sistem.`,
      timer: 1300,
      showConfirmButton: false
    });
    await loadKelas();
  } catch (err) {
    Swal.fire('Gagal Menambah Kelas', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleModalKelasSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('modal-input-kelas');
  const nama = input.value.trim().toUpperCase();
  if (!nama) return;

  try {
    await DB.saveKelas(null, nama);
    input.value = "";
    await loadKelas();
    renderKelasModalList();
  } catch (err) {
    Swal.fire('Gagal', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function deleteKelas(id, nama, fromModal = false) {
  const result = await Swal.fire({
    title: `Hapus Kelas ${nama}?`,
    text: "Kelas ini tidak akan muncul lagi di pilihan dropdown. Data siswa dan paket soal lama tetap tersimpan.",
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      await DB.deleteKelas(id, nama);
      await loadKelas();
      if (fromModal) renderKelasModalList();
      Swal.fire('Dihapus', `Kelas ${nama} telah dihapus.`, 'success');
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

// Helper: Mengecek kecocokan kelas (mendukung Tingkat X, XI, XII, daftar kelas, atau rombel spesifik)
function checkKelasMatch(pKelas, studentKelas) {
  if (!pKelas || pKelas === "" || pKelas.toLowerCase() === "semua") {
    return { match: true, specificity: 0 };
  }
  if (!studentKelas) return { match: false, specificity: 0 };

  const p = pKelas.toLowerCase().trim();
  const s = studentKelas.toLowerCase().trim();

  // 1. Cocok persis
  if (p === s) return { match: true, specificity: 3 };

  // 2. Daftar rombel dipisah koma
  const parts = p.split(',').map(x => x.trim());
  if (parts.includes(s)) return { match: true, specificity: 3 };

  // 3. Cocok Tingkat Kelas (Tingkat X, XI, XII)
  let targetTingkat = "";
  if (p.startsWith("tingkat:")) {
    targetTingkat = p.replace("tingkat:", "").trim();
  } else if (['x', 'xi', 'xii', '10', '11', '12'].includes(p)) {
    targetTingkat = p;
  }

  if (targetTingkat) {
    const sTokens = s.split(/[\s\-_]+/);
    let sTingkat = sTokens[0] || "";
    if (sTingkat === "kelas" && sTokens.length > 1) sTingkat = sTokens[1];
    if (sTingkat === targetTingkat) return { match: true, specificity: 2 };
  }

  return { match: false, specificity: 0 };
}

function populateKelasDropdowns() {
  const masterNames = (allKelas || []).map(k => (k.nama_kelas || '').toUpperCase()).filter(Boolean);

  const allNamesSet = new Set(masterNames);
  (allPeserta || []).forEach(p => { if (p.kelas) allNamesSet.add(p.kelas.toUpperCase()); });
  (allPaket || []).forEach(pk => {
    if (pk.kelas && pk.kelas.toLowerCase() !== 'semua' && !pk.kelas.toUpperCase().startsWith('TINGKAT:')) {
      allNamesSet.add(pk.kelas.toUpperCase());
    }
  });
  const sortedList = Array.from(allNamesSet).sort();
  const rawOptionsHtml = sortedList.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');

  // 1. Dropdown Form Peserta (crud-peserta-kelas)
  const selPeserta = document.getElementById('crud-peserta-kelas');
  if (selPeserta) {
    const cur = selPeserta.value;
    selPeserta.innerHTML = '<option value="">Pilih Kelas...</option>' + rawOptionsHtml;
    if (cur) selPeserta.value = cur;
  }

  // 2. Dropdown Form Paket Soal (crud-paket-kelas)
  const selPaket = document.getElementById('crud-paket-kelas');
  if (selPaket) {
    const cur = selPaket.value;
    selPaket.innerHTML = `
      <option value="">Semua Kelas (Umum)</option>
      <optgroup label="Tingkat / Angkatan (Otomatis Semua Rombel)">
        <option value="TINGKAT:X">Tingkat X (Semua Kelas X: X TKJ 1, X TKJ 2, dll)</option>
        <option value="TINGKAT:XI">Tingkat XI (Semua Kelas XI: XI TKJ 1, XI TKJ 2, dll)</option>
        <option value="TINGKAT:XII">Tingkat XII (Semua Kelas XII: XII TKJ 1, XII TKJ 2, dll)</option>
      </optgroup>
      <optgroup label="Rombel Spesifik (Hanya Kelas Tertentu Saja)">
        ${rawOptionsHtml}
      </optgroup>
    `;
    if (cur) selPaket.value = cur;
  }

  // 3. Filter Kelas Paket Soal (filter-kelas-paket)
  const fPaket = document.getElementById('filter-kelas-paket');
  if (fPaket) {
    const cur = fPaket.value;
    fPaket.innerHTML = `
      <option value="">Semua Kelas</option>
      <optgroup label="Tingkat / Angkatan">
        <option value="TINGKAT:X">Tingkat X</option>
        <option value="TINGKAT:XI">Tingkat XI</option>
        <option value="TINGKAT:XII">Tingkat XII</option>
      </optgroup>
      <optgroup label="Rombel Spesifik">
        ${rawOptionsHtml}
      </optgroup>
    `;
    if (cur) fPaket.value = cur;
  }

  // 4. Filter Kelas Peserta (filter-kelas-peserta)
  const fPeserta = document.getElementById('filter-kelas-peserta');
  if (fPeserta) {
    const cur = fPeserta.value;
    fPeserta.innerHTML = '<option value="">Semua Kelas</option>' + rawOptionsHtml;
    if (cur) fPeserta.value = cur;
  }

  // 5. Filter Kelas Hasil (filter-kelas-hasil)
  const fHasil = document.getElementById('filter-kelas-hasil');
  if (fHasil) {
    const cur = fHasil.value;
    fHasil.innerHTML = '<option value="">Semua Kelas</option>' + rawOptionsHtml;
    if (cur) fHasil.value = cur;
  }
}

// -------------------------------------------------------------
// CRUD: DATA PESERTA
// -------------------------------------------------------------

async function loadPeserta() {
  try {
    allPeserta = await DB.getPesertaList();
    populateJurusanDropdowns();
    populateKelasDropdowns();
    renderPesertaTable(allPeserta);
  } catch (err) {
    console.error("Gagal memuat peserta:", err);
  }
}

let pesertaCurrentPage = 1;
let pesertaPageSize = 50;
let currentFilteredPeserta = [];

function changePesertaPageSize(size) {
  pesertaPageSize = size === 'all' ? 'all' : (parseInt(size, 10) || 50);
  pesertaCurrentPage = 1;
  renderPesertaTable(currentFilteredPeserta, true);
}

function goToPesertaPage(page) {
  pesertaCurrentPage = Math.max(1, parseInt(page, 10) || 1);
  renderPesertaTable(currentFilteredPeserta, true);
}

function renderPaginationNav(navEl, currentPage, totalPages, goToFuncName) {
  if (!navEl) return;
  if (totalPages <= 1) {
    navEl.innerHTML = '';
    return;
  }
  const pages = [];
  const maxButtons = 7;
  if (totalPages <= maxButtons) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (currentPage > 3) pages.push('...');
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);
    for (let i = start; i <= end; i++) {
      if (!pages.includes(i)) pages.push(i);
    }
    if (currentPage < totalPages - 2) pages.push('...');
    if (!pages.includes(totalPages)) pages.push(totalPages);
  }

  const items = [];
  items.push(`
    <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
      <button class="page-link" type="button" onclick="${goToFuncName}(${currentPage - 1})" aria-label="Sebelumnya">
        <i class="bi bi-chevron-left"></i>
      </button>
    </li>
  `);

  pages.forEach(p => {
    if (p === '...') {
      items.push(`<li class="page-item disabled"><span class="page-link">&hellip;</span></li>`);
    } else {
      items.push(`
        <li class="page-item ${p === currentPage ? 'active' : ''}">
          <button class="page-link" type="button" onclick="${goToFuncName}(${p})">${p}</button>
        </li>
      `);
    }
  });

  items.push(`
    <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
      <button class="page-link" type="button" onclick="${goToFuncName}(${currentPage + 1})" aria-label="Selanjutnya">
        <i class="bi bi-chevron-right"></i>
      </button>
    </li>
  `);

  navEl.innerHTML = items.join('');
}

function renderPesertaTable(list, keepPage = false) {
  currentFilteredPeserta = list || [];
  const tbody = document.getElementById('table-peserta-body');
  const infoEl = document.getElementById('peserta-pagination-info');
  const navEl = document.getElementById('peserta-pagination-nav');
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">Data peserta kosong atau tidak ditemukan.</td></tr>`;
    if (infoEl) infoEl.innerText = 'Menampilkan 0 dari 0 peserta';
    if (navEl) navEl.innerHTML = '';
    return;
  }

  // Sort list by Jurusan first, then Name
  const sortedList = [...list].sort((a, b) => {
    const jA = (a.jurusan || 'Tanpa Jurusan').toUpperCase();
    const jB = (b.jurusan || 'Tanpa Jurusan').toUpperCase();
    if (jA < jB) return -1;
    if (jA > jB) return 1;
    return (a.nama_lengkap || '').localeCompare(b.nama_lengkap || '');
  });

  const totalItems = sortedList.length;
  let pagedItems = sortedList;
  let totalPages = 1;
  let startIdx = 0;
  let endIdx = totalItems;

  if (pesertaPageSize !== 'all') {
    const pageSizeNum = parseInt(pesertaPageSize, 10) || 50;
    totalPages = Math.max(1, Math.ceil(totalItems / pageSizeNum));
    if (!keepPage) pesertaCurrentPage = 1;
    if (pesertaCurrentPage > totalPages) pesertaCurrentPage = totalPages;
    if (pesertaCurrentPage < 1) pesertaCurrentPage = 1;

    startIdx = (pesertaCurrentPage - 1) * pageSizeNum;
    endIdx = Math.min(startIdx + pageSizeNum, totalItems);
    pagedItems = sortedList.slice(startIdx, endIdx);
  } else {
    pesertaCurrentPage = 1;
  }

  if (infoEl) {
    infoEl.innerText = `Menampilkan ${startIdx + 1} - ${endIdx} dari total ${totalItems} peserta`;
  }
  if (navEl) {
    renderPaginationNav(navEl, pesertaCurrentPage, totalPages, 'goToPesertaPage');
  }

  let currentJurusan = null;
  const rows = [];

  pagedItems.forEach(p => {
    let statusClass = "bg-secondary";
    if (p.status_ujian === 'Sedang Ujian') statusClass = "bg-warning text-dark";
    if (p.status_ujian === 'Sudah Ujian') statusClass = "bg-success";
    
    const pJurusan = (p.jurusan || 'Tanpa Jurusan').toUpperCase();

    // Group Header Row
    if (currentJurusan !== pJurusan) {
      rows.push(`
        <tr class="table-light">
          <td colspan="9" class="fw-bold text-primary py-2" style="background-color: #f8f9fa;">
            <i class="bi bi-bookmark-fill me-2"></i>JURUSAN: ${escapeHtml(pJurusan)}
          </td>
        </tr>
      `);
      currentJurusan = pJurusan;
    }

    rows.push(`
      <tr>
        <td class="font-monospace text-primary"><strong>${escapeHtml(p.username)}</strong></td>
        <td class="cell-wrap fw-semibold">${escapeHtml(p.nama_lengkap)}</td>
        <td class="cell-wrap">${escapeHtml(p.jurusan || '-')}${p._shardName ? `<br><span class="badge bg-secondary-subtle text-secondary border mt-1" style="font-size: 0.65rem;"><i class="bi bi-hdd-network me-1"></i>${escapeHtml(p._shardName.split(' ')[0] + ' ' + (p._shardName.split(' ')[1] || ''))}</span>` : ''}</td>
        <td><span class="badge bg-light text-dark border">${escapeHtml(p.kelas || '-')}</span></td>
        <td>${escapeHtml(p.ruang || '-')}</td>
        <td>${escapeHtml(p.sesi || '-')}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(p.status_ujian)}</span></td>
        <td class="text-center">
          ${p.pelanggaran > 0 ? `<span class="badge bg-danger">${p.pelanggaran} Kali</span>` : `<span class="badge bg-success">Aman</span>`}
        </td>
        <td class="text-center">
          <div class="d-inline-flex gap-1 align-items-center">
            <button class="btn btn-outline-primary btn-sm py-1 px-2" title="Cetak Kartu Ujian Siswa Ini" onclick="cetakKartuSiswa('${escapeAttr(p.id)}')">
              <i class="bi bi-printer-fill"></i>
            </button>
            <div class="dropdown">
              <button class="btn btn-outline-secondary btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" data-bs-boundary="window">
                Aksi
              </button>
              <ul class="dropdown-menu dropdown-menu-end shadow-sm">
                <li><a class="dropdown-item text-success fw-semibold" href="#" onclick="cetakKartuSiswa('${escapeAttr(p.id)}'); return false;"><i class="bi bi-printer-fill me-2 text-success"></i> Cetak Kartu Ujian</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item" href="#" onclick="editPeserta('${p.id}')"><i class="bi bi-pencil me-2 text-primary"></i> Edit Profile</a></li>
                <li><a class="dropdown-item" href="#" onclick="togglePesertaLock('${p.id}', ${!p.is_locked})"><i class="bi bi-${p.is_locked ? 'unlock-fill text-success' : 'lock-fill text-warning'} me-2"></i> ${p.is_locked ? 'Buka Kunci' : 'Kunci Akses (Lock)'}</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item text-warning" href="#" onclick="resetPesertaSesi('${p.id}', '${escapeAttr(p.nama_lengkap)}')"><i class="bi bi-arrow-counterclockwise me-2"></i> Reset Sesi Ujian</a></li>
                <li><a class="dropdown-item text-primary" href="#" onclick="paksaSelesaiUjian('${p.id}', '${escapeAttr(p.nama_lengkap)}')"><i class="bi bi-check2-all me-2"></i> Paksa Selesai</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item text-danger" href="#" onclick="deletePeserta('${p.id}', '${escapeAttr(p.nama_lengkap)}')"><i class="bi bi-trash me-2"></i> Hapus Peserta</a></li>
              </ul>
            </div>
          </div>
        </td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join('');
}

function filterPesertaList() {
  const q = document.getElementById('search-peserta').value.toLowerCase().trim();
  const jurusan = document.getElementById('filter-jurusan-peserta').value.toUpperCase();
  const filterKelasEl = document.getElementById('filter-kelas-peserta');
  const kelas = filterKelasEl ? filterKelasEl.value.toUpperCase() : '';
  const sesi = document.getElementById('filter-sesi-peserta').value;
  const status = document.getElementById('filter-status-peserta').value;

  const filtered = allPeserta.filter(p => {
    const matchesSearch = p.nama_lengkap.toLowerCase().includes(q) || 
                          p.username.toLowerCase().includes(q) || 
                          (p.jurusan && p.jurusan.toLowerCase().includes(q)) || 
                          (p.kelas && p.kelas.toLowerCase().includes(q));
    
    const pJurusan = (p.jurusan || '').toUpperCase();
    const matchesJurusan = !jurusan || pJurusan === jurusan;

    const pKelas = (p.kelas || '').toUpperCase();
    const matchesKelas = !kelas || pKelas === kelas;
    
    const matchesSesi = !sesi || p.sesi === sesi;
    const matchesStatus = !status || p.status_ujian === status;

    return matchesSearch && matchesJurusan && matchesKelas && matchesSesi && matchesStatus;
  });

  renderPesertaTable(filtered, false);
}

function openPesertaForm() {
  document.getElementById('pesertaFormTitle').innerText = "Tambah Peserta Baru";
  document.getElementById('form-peserta-crud').reset();
  document.getElementById('peserta-id').value = "";
  populateJurusanDropdowns();
  populateKelasDropdowns();
  document.getElementById('crud-peserta-jurusan').value = "";
  document.getElementById('crud-peserta-kelas').value = "";
  
  document.getElementById('crud-peserta-pass').required = true;
  document.getElementById('crud-peserta-pass-help').classList.add('d-none');
  
  pesertaFormModalInstance.show();
}

function editPeserta(id) {
  const p = allPeserta.find(item => item.id === id);
  if (!p) return;

  populateJurusanDropdowns();
  populateKelasDropdowns();

  const selJurusan = document.getElementById('crud-peserta-jurusan');
  const targetJurusan = (p.jurusan || '').toUpperCase();
  if (targetJurusan && !Array.from(selJurusan.options).some(o => o.value.toUpperCase() === targetJurusan)) {
    selJurusan.innerHTML += `<option value="${escapeHtml(p.jurusan)}">${escapeHtml(p.jurusan)}</option>`;
  }

  const selKelas = document.getElementById('crud-peserta-kelas');
  const targetKelas = (p.kelas || '').toUpperCase();
  if (targetKelas && !Array.from(selKelas.options).some(o => o.value.toUpperCase() === targetKelas)) {
    selKelas.innerHTML += `<option value="${escapeHtml(p.kelas)}">${escapeHtml(p.kelas)}</option>`;
  }

  document.getElementById('pesertaFormTitle').innerText = "Edit Data Peserta";
  document.getElementById('peserta-id').value = p.id;
  document.getElementById('crud-peserta-username').value = p.username;
  document.getElementById('crud-peserta-nama').value = p.nama_lengkap;
  document.getElementById('crud-peserta-jurusan').value = p.jurusan || "";
  document.getElementById('crud-peserta-kelas').value = p.kelas || "";
  document.getElementById('crud-peserta-ruang').value = p.ruang || "";
  document.getElementById('crud-peserta-sesi').value = p.sesi || "";

  document.getElementById('crud-peserta-pass').required = false;
  document.getElementById('crud-peserta-pass').value = "";
  document.getElementById('crud-peserta-pass-help').classList.remove('d-none');

  pesertaFormModalInstance.show();
}

async function handlePesertaCrudSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('peserta-id').value;
  const user = document.getElementById('crud-peserta-username').value.trim().replace(/\s+/g, '').toLowerCase();
  const nama = document.getElementById('crud-peserta-nama').value.trim();
  const jurusan = document.getElementById('crud-peserta-jurusan').value.trim();
  const kelas = document.getElementById('crud-peserta-kelas').value.trim();
  const ruang = document.getElementById('crud-peserta-ruang').value.trim();
  const sesi = document.getElementById('crud-peserta-sesi').value.trim();
  const pass = document.getElementById('crud-peserta-pass').value.trim();

  const submitBtn = document.getElementById('btn-save-peserta-crud');
  submitBtn.disabled = true;

  try {
    if (id) {
      // Edit mode
      const payload = {
        username: user,
        nama_lengkap: nama,
        jurusan: jurusan,
        kelas: kelas,
        ruang: ruang,
        sesi: sesi
      };
      const pTarget = allPeserta.find(item => item.id === id);
      await DB.editPesertaProfile(id, payload, pass, pTarget ? pTarget._shardId : null);
      Swal.fire('Berhasil', 'Data Peserta berhasil diperbarui.', 'success');
    } else {
      // Add mode
      await DB.registerPeserta(user, pass, nama, jurusan, kelas, ruang, sesi);
      Swal.fire('Berhasil', 'Peserta baru berhasil ditambahkan.', 'success');
    }

    pesertaFormModalInstance.hide();
    await loadPeserta();
    await loadDashboardStats();
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function deletePeserta(id, name) {
  const result = await Swal.fire({
    title: 'Hapus Peserta?',
    text: `Anda akan menghapus "${name}". Tindakan ini juga akan menghapus hasil ujian & riwayat pengerjaannya secara permanen.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus!',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    Swal.fire({
      title: 'Menghapus data...',
      allowOutsideClick: false,
      didOpen: () => { Swal.showLoading(); }
    });

    try {
      const pTarget = allPeserta.find(item => item.id === id);
      await DB.deletePeserta(id, pTarget ? pTarget._shardId : null);
      Swal.fire('Dihapus!', 'Data Peserta telah berhasil dihapus.', 'success');
      await loadPeserta();
      await loadHasil();
      await loadDashboardStats();
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

async function deleteAllPeserta() {
  if (allPeserta.length === 0) {
    Swal.fire('Info', 'Data peserta sudah kosong.', 'info');
    return;
  }

  const result = await Swal.fire({
    title: 'Kosongkan Semua Data?',
    text: `PERINGATAN: Anda akan menghapus seluruh data peserta (${allPeserta.length} orang) beserta hasil ujian dan jawaban mereka secara permanen. Tindakan ini tidak dapat dibatalkan!`,
    icon: 'error',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Kosongkan Semua!',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    Swal.fire({
      title: 'Menghapus data...',
      html: 'Proses ini mungkin memakan waktu beberapa saat.',
      allowOutsideClick: false,
      didOpen: () => { Swal.showLoading(); }
    });

    try {
      await DB.deleteAllPeserta(allPeserta);
      
      Swal.fire('Dihapus!', 'Seluruh data peserta telah berhasil dikosongkan.', 'success');
      await loadPeserta();
      await loadHasil();
      await loadDashboardStats();
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan saat menghapus data.', 'error');
    }
  }
}

async function togglePesertaLock(id, isLocked) {
  const p = allPeserta.find(item => item.id === id);
  const actionText = isLocked ? 'Memblokir' : 'Membuka Blokir';
  const result = await Swal.fire({
    title: `${actionText} Peserta?`,
    text: `Anda akan ${isLocked ? 'mengunci (blokir)' : 'membuka kunci'} akses ujian untuk "${p.nama_lengkap}".`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: isLocked ? '#ffc107' : '#198754',
    cancelButtonColor: '#6c757d',
    confirmButtonText: `Ya, ${isLocked ? 'Kunci!' : 'Buka Kunci!'}`,
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      const pTarget = allPeserta.find(item => item.id === id);
      await DB.toggleLockPeserta(id, isLocked, pTarget ? pTarget._shardId : null);
      Swal.fire('Berhasil!', `Akses ujian berhasil di${isLocked ? 'kunci' : 'buka'}.`, 'success');
      await loadPeserta();
    } catch (err) {
      Swal.fire('Gagal Mengubah Status', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

async function resetPesertaSesi(id, name) {
  const result = await Swal.fire({
    title: 'Reset Sesi Ujian?',
    text: `Anda akan menghapus seluruh jawaban dan nilai milik "${name}" dan mengembalikan statusnya ke "Belum Ujian".`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ffc107',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Reset Sesi!',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    Swal.fire({ title: 'Mereset...', didOpen: () => { Swal.showLoading(); } });
    try {
      const pTarget = allPeserta.find(item => item.id === id);
      await DB.resetPesertaSesi(id, pTarget ? pTarget._shardId : null);
      Swal.fire('Berhasil', 'Sesi ujian berhasil direset.', 'success');
      await loadPeserta();
      await loadHasil();
      await loadDashboardStats();
    } catch (err) {
      Swal.fire('Gagal Reset', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

async function paksaSelesaiUjian(id, name) {
  const result = await Swal.fire({
    title: 'Paksa Selesai Ujian?',
    text: `Ujian "${name}" akan langsung diakhiri. Nilai akan dihitung berdasarkan jawaban yang sudah tersimpan.`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#0d6efd',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Selesaikan!',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    Swal.fire({ title: 'Mengkalkulasi...', didOpen: () => { Swal.showLoading(); } });
    try {
      // Logic for force submit: we calculate the score on admin side and insert it to hasil
      const p = allPeserta.find(item => item.id === id);
      if (p.status_ujian === 'Sudah Ujian') throw new Error("Peserta ini sudah menyelesaikan ujian.");

      let activePaket = null;
      let bestScore = -1;
      const studentJurusan = (p.jurusan || "").toLowerCase().trim();
      const studentKelas = (p.kelas || "").toLowerCase().trim();

      for (const pk of allPaket) {
        let pkJurusan = (pk.jurusan || "").toLowerCase().trim();
        const jurusanMatch = (pkJurusan === "" || pkJurusan === "semua" || pkJurusan === studentJurusan);
        const kelasResult = checkKelasMatch(pk.kelas, studentKelas);

        if (jurusanMatch && kelasResult.match) {
          let score = 0;
          if (pkJurusan && pkJurusan !== "semua" && pkJurusan === studentJurusan) score += 4;
          score += kelasResult.specificity;
          if (score > bestScore) {
            bestScore = score;
            activePaket = pk;
          }
        }
      }
      if (!activePaket) throw new Error("Tidak ada paket soal yang sesuai dengan jurusan & kelas peserta ini.");

      const questions = await DB.getSoalByPaket(activePaket.id);
      const answers = await DB.getJawabanList(id);
      
      let correct = 0;
      let wrong = 0;
      
      questions.forEach(s => {
        const userAns = answers ? answers.find(a => a.soal_id === s.id) : null;
        if (userAns && userAns.jawaban === s.jawaban_benar) {
          correct++;
        } else {
          wrong++;
        }
      });
      
      const score = parseFloat(((correct / questions.length) * 100).toFixed(2));
      const status = '-';
      
      await DB.insertHasil(id, correct, wrong, score, status, new Date().toISOString(), new Date().toISOString());
      await DB.updateStatusUjian(id, 'Sudah Ujian');
      
      Swal.fire('Berhasil', 'Ujian berhasil diselesaikan secara paksa.', 'success');
      await loadPeserta();
      await loadHasil();
      await loadDashboardStats();
    } catch (err) {
      Swal.fire('Gagal Memaksa Selesai', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

function exportPesertaData() {
  if (allPeserta.length === 0) {
    Swal.fire('Ekspor Kosong', 'Tidak ada data peserta untuk diekspor.', 'warning');
    return;
  }

  const map = {
    username: 'Username',
    nama_lengkap: 'Nama Lengkap',
    jurusan: 'Jurusan',
    kelas: 'Kelas',
    ruang: 'Ruang',
    sesi: 'Sesi',
    status_ujian: 'Status Ujian'
  };

  ExcelHelpers.exportJSONToExcel(allPeserta, map, "Daftar_Peserta_CBT_PPDB", "Peserta");
}

// -------------------------------------------------------------
// CRUD: DATA GURU MATA PELAJARAN
// -------------------------------------------------------------

async function loadGuru() {
  if (isGuruMode()) return;
  try {
    allGuru = await DB.getGuruList();
    renderGuruTable(allGuru || []);
  } catch (err) {
    console.error("Gagal memuat data guru:", err);
  }
}

function renderGuruTable(list) {
  const tbody = document.getElementById('table-guru-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!list || list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-4 text-muted">
          Belum ada akun guru mata pelajaran. Klik tombol <strong>+ Tambah Akun Guru</strong> di kanan atas untuk membuat akun guru baru.
        </td>
      </tr>
    `;
    return;
  }

  const paketLookup = new Map();
  (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket).forEach(pk => {
    if (pk && pk.id) paketLookup.set(String(pk.id), pk);
  });

  const rows = list.map((g, idx) => {
    const mapelBadges = String(g.mapel_diampu || '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean)
      .map(m => `<span class="badge bg-success-subtle text-success border border-success-subtle me-1 mb-1">${escapeHtml(m)}</span>`)
      .join('') || '<span class="text-muted">-</span>';

    const jurusanBadges = String(g.jurusan_diampu || '')
      .split(',')
      .map(j => j.trim())
      .filter(Boolean)
      .map(j => `<span class="badge bg-info-subtle text-dark border me-1 mb-1"><i class="bi bi-diagram-3 me-1"></i>${escapeHtml(j)}</span>`)
      .join('') || `<span class="badge bg-secondary-subtle text-secondary border me-1 mb-1">Semua Jurusan</span>`;

    const kelasBadges = String(g.kelas_diampu || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean)
      .map(k => {
        const lbl = k.toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${k.split(':')[1]}` : k;
        return `<span class="badge bg-warning-subtle text-dark border border-warning-subtle me-1 mb-1"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(lbl)}</span>`;
      })
      .join('') || `<span class="badge bg-secondary-subtle text-secondary border me-1 mb-1">Semua Kelas</span>`;

    let paketIds = [];
    if (Array.isArray(g.paket_ids)) {
      paketIds = g.paket_ids;
    } else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try {
        const parsed = JSON.parse(g.paket_ids);
        if (Array.isArray(parsed)) paketIds = parsed;
      } catch (e) {}
    }

    const paketBadges = paketIds.length > 0
      ? paketIds.map(pid => {
          const pkObj = paketLookup.get(String(pid));
          const pName = pkObj ? pkObj.nama_paket : 'Paket Terkait';
          return `<span class="badge bg-primary-subtle text-primary border border-primary-subtle me-1 mb-1"><i class="bi bi-journal-check me-1"></i>${escapeHtml(pName)}</span>`;
        }).join('')
      : `<span class="text-muted small"><i class="bi bi-magic me-1"></i>Otomatis sesuai Mapel, Jurusan & Kelas</span>`;

    return `
      <tr>
        <td>${idx + 1}</td>
        <td class="font-monospace fw-bold text-primary">${escapeHtml(g.username)}</td>
        <td class="fw-semibold">${escapeHtml(g.nama_lengkap)}</td>
        <td>${mapelBadges}</td>
        <td>
          <div>${jurusanBadges}</div>
          <div class="mt-1">${kelasBadges}</div>
        </td>
        <td>${paketBadges}</td>
        <td class="text-center">
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-primary" onclick="editGuru('${escapeAttr(g.id)}')" title="Edit Akun & Mapel Guru">
              <i class="bi bi-pencil"></i> Edit
            </button>
            <button class="btn btn-outline-danger" onclick="deleteGuru('${escapeAttr(g.id)}', '${escapeAttr(g.nama_lengkap)}')" title="Hapus Akun Guru">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = rows.join('');
}

function getAllAvailableJurusanNames() {
  const set = new Set();
  (allJurusan || []).forEach(j => {
    const n = (j.nama_jurusan || '').trim().toUpperCase();
    if (n) set.add(n);
  });
  (allPeserta || []).forEach(p => {
    const n = (p.jurusan || '').trim().toUpperCase();
    if (n) set.add(n);
  });
  (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket).forEach(pk => {
    const n = (pk.jurusan || '').trim().toUpperCase();
    if (n && n !== 'SEMUA') set.add(n);
  });
  if (set.size === 0) {
    ['TKJ', 'AKL', 'TBSM', 'TKRO', 'ATP'].forEach(d => set.add(d));
  }
  return Array.from(set).sort();
}

function getAllAvailableKelasNames() {
  const set = new Set();
  (allKelas || []).forEach(k => {
    const n = (k.nama_kelas || '').trim().toUpperCase();
    if (n) set.add(n);
  });
  (allPeserta || []).forEach(p => {
    const n = (p.kelas || '').trim().toUpperCase();
    if (n) set.add(n);
  });
  (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket).forEach(pk => {
    const n = (pk.kelas || '').trim().toUpperCase();
    if (n && n !== 'SEMUA' && !n.startsWith('TINGKAT:')) set.add(n);
  });
  return Array.from(set).sort();
}

function renderGuruJurusanChecklist(selectedStr = '') {
  const container = document.getElementById('crud-guru-jurusan-checklist');
  if (!container) return;

  const selectedList = String(selectedStr || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s && s !== 'SEMUA');
  const selSet = new Set(selectedList);
  const isAll = selSet.size === 0;

  const jurusans = getAllAvailableJurusanNames();

  let html = `
    <div class="form-check mb-1 pb-1 border-bottom">
      <input class="form-check-input" type="checkbox" value="" id="chk-gj-all" ${isAll ? 'checked' : ''} onchange="onGuruJurusanAllToggle(this)">
      <label class="form-check-label small fw-bold text-primary" for="chk-gj-all">
        Semua Jurusan (Umum)
      </label>
    </div>
  `;

  html += jurusans.map((j, idx) => {
    const checked = selSet.has(j) ? 'checked' : '';
    return `
      <div class="form-check mb-1">
        <input class="form-check-input chk-guru-jurusan" type="checkbox" value="${escapeAttr(j)}" id="chk-gj-${idx}" ${checked} onchange="onGuruJurusanItemToggle()">
        <label class="form-check-label small fw-semibold" for="chk-gj-${idx}">
          Jurusan ${escapeHtml(j)}
        </label>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

function onGuruJurusanAllToggle(allChk) {
  if (allChk.checked) {
    document.querySelectorAll('.chk-guru-jurusan').forEach(el => { el.checked = false; });
  }
}

function onGuruJurusanItemToggle() {
  const anyChecked = Array.from(document.querySelectorAll('.chk-guru-jurusan')).some(el => el.checked);
  const allChk = document.getElementById('chk-gj-all');
  if (allChk) allChk.checked = !anyChecked;
}

function renderGuruKelasChecklist(selectedStr = '') {
  const container = document.getElementById('crud-guru-kelas-checklist');
  if (!container) return;

  const selectedList = String(selectedStr || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s && s !== 'SEMUA');
  const selSet = new Set(selectedList);
  const isAll = selSet.size === 0;

  const kelasList = getAllAvailableKelasNames();

  let html = `
    <div class="form-check mb-1 pb-1 border-bottom">
      <input class="form-check-input" type="checkbox" value="" id="chk-gk-all" ${isAll ? 'checked' : ''} onchange="onGuruKelasAllToggle(this)">
      <label class="form-check-label small fw-bold text-success" for="chk-gk-all">
        Semua Kelas / Semua Tingkat
      </label>
    </div>
    <div class="text-muted fw-bold mt-1 mb-1" style="font-size: 0.7rem; text-transform: uppercase;">Per Tingkat Angkatan:</div>
  `;

  const tingkats = [
    { val: 'TINGKAT:X', label: 'Tingkat X (Semua Kelas 10)' },
    { val: 'TINGKAT:XI', label: 'Tingkat XI (Semua Kelas 11)' },
    { val: 'TINGKAT:XII', label: 'Tingkat XII (Semua Kelas 12)' }
  ];

  html += tingkats.map((t, idx) => {
    const checked = selSet.has(t.val) ? 'checked' : '';
    return `
      <div class="form-check mb-1">
        <input class="form-check-input chk-guru-kelas" type="checkbox" value="${escapeAttr(t.val)}" id="chk-gk-t-${idx}" ${checked} onchange="onGuruKelasItemToggle()">
        <label class="form-check-label small fw-semibold text-dark" for="chk-gk-t-${idx}">
          ${escapeHtml(t.label)}
        </label>
      </div>
    `;
  }).join('');

  if (kelasList.length > 0) {
    html += `<div class="text-muted fw-bold mt-2 mb-1 pt-1 border-top" style="font-size: 0.7rem; text-transform: uppercase;">Atau Pilih Rombel Spesifik:</div>`;
    html += kelasList.map((k, idx) => {
      const checked = selSet.has(k) ? 'checked' : '';
      return `
        <div class="form-check mb-1">
          <input class="form-check-input chk-guru-kelas" type="checkbox" value="${escapeAttr(k)}" id="chk-gk-r-${idx}" ${checked} onchange="onGuruKelasItemToggle()">
          <label class="form-check-label small" for="chk-gk-r-${idx}">
            Kelas ${escapeHtml(k)}
          </label>
        </div>
      `;
    }).join('');
  }

  container.innerHTML = html;
}

function onGuruKelasAllToggle(allChk) {
  if (allChk.checked) {
    document.querySelectorAll('.chk-guru-kelas').forEach(el => { el.checked = false; });
  }
}

function onGuruKelasItemToggle() {
  const anyChecked = Array.from(document.querySelectorAll('.chk-guru-kelas')).some(el => el.checked);
  const allChk = document.getElementById('chk-gk-all');
  if (allChk) allChk.checked = !anyChecked;
}

function renderGuruPaketChecklist(selectedIds = []) {
  const container = document.getElementById('crud-guru-paket-checklist');
  if (!container) return;

  const sourcePaket = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  if (sourcePaket.length === 0) {
    container.innerHTML = `<div class="text-muted small py-2 text-center">Belum ada paket soal. Guru nantinya dapat membuat paket soal sendiri sesuai Mapel, Jurusan & Kelas yang diampu.</div>`;
    return;
  }

  const selSet = new Set((selectedIds || []).map(String));
  container.innerHTML = sourcePaket.map(pk => {
    const checked = selSet.has(String(pk.id)) ? 'checked' : '';
    const jurusanText = (pk.jurusan && pk.jurusan.toLowerCase() !== 'semua') ? pk.jurusan : 'Semua Jurusan';
    let kelasText = 'Semua Kelas';
    if (pk.kelas && pk.kelas.toLowerCase() !== 'semua') {
      kelasText = pk.kelas.toUpperCase().startsWith('TINGKAT:')
        ? `Tingkat ${pk.kelas.split(':')[1]}`
        : pk.kelas;
    }
    return `
      <div class="form-check mb-1 d-flex align-items-center flex-wrap gap-1">
        <input class="form-check-input chk-guru-paket me-1" type="checkbox" value="${escapeAttr(pk.id)}" id="chk-gp-${escapeAttr(pk.id)}" ${checked}>
        <label class="form-check-label small fw-semibold" for="chk-gp-${escapeAttr(pk.id)}">
          ${escapeHtml(pk.nama_paket)}
          <span class="badge bg-info-subtle text-dark border ms-1" style="font-size: 0.7rem;">Jurusan: ${escapeHtml(jurusanText)}</span>
          <span class="badge bg-primary-subtle text-primary border ms-1" style="font-size: 0.7rem;">Kelas: ${escapeHtml(kelasText)}</span>
        </label>
      </div>
    `;
  }).join('');
}

function appendGuruMapelPreset(mapelName) {
  const input = document.getElementById('crud-guru-mapel');
  if (!input) return;
  const current = input.value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!current.some(x => x.toLowerCase() === mapelName.toLowerCase())) {
    current.push(mapelName);
  }
  input.value = current.join(', ');
}

function openGuruForm() {
  document.getElementById('guruFormTitle').innerHTML = `<i class="bi bi-person-plus-fill me-2 text-primary"></i>Tambah Akun Guru Mapel`;
  document.getElementById('form-guru-crud').reset();
  document.getElementById('guru-id').value = "";
  document.getElementById('crud-guru-pass').required = true;
  document.getElementById('crud-guru-pass-help').innerText = "Wajib diisi untuk akun guru baru.";
  renderGuruJurusanChecklist('');
  renderGuruKelasChecklist('');
  renderGuruPaketChecklist([]);
  if (guruFormModalInstance) guruFormModalInstance.show();
}

function editGuru(id) {
  const g = (allGuru || []).find(item => String(item.id) === String(id));
  if (!g) return;

  document.getElementById('guruFormTitle').innerHTML = `<i class="bi bi-pencil-square me-2 text-primary"></i>Edit Akun Guru Mapel`;
  document.getElementById('guru-id').value = g.id;
  document.getElementById('crud-guru-username').value = g.username || '';
  document.getElementById('crud-guru-nama').value = g.nama_lengkap || '';
  document.getElementById('crud-guru-mapel').value = g.mapel_diampu || '';
  document.getElementById('crud-guru-pass').value = '';
  document.getElementById('crud-guru-pass').required = false;
  document.getElementById('crud-guru-pass-help').innerText = "Biarkan kosong jika tidak ingin mengubah password guru.";

  renderGuruJurusanChecklist(g.jurusan_diampu || '');
  renderGuruKelasChecklist(g.kelas_diampu || '');

  let selectedIds = [];
  if (Array.isArray(g.paket_ids)) {
    selectedIds = g.paket_ids;
  } else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
    try {
      const parsed = JSON.parse(g.paket_ids);
      if (Array.isArray(parsed)) selectedIds = parsed;
    } catch (e) {}
  }
  renderGuruPaketChecklist(selectedIds);
  if (guruFormModalInstance) guruFormModalInstance.show();
}

async function handleGuruCrudSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('guru-id').value;
  const username = document.getElementById('crud-guru-username').value.trim();
  const nama = document.getElementById('crud-guru-nama').value.trim();
  const mapel = document.getElementById('crud-guru-mapel').value.trim();
  const pass = document.getElementById('crud-guru-pass').value;

  const checkedJurusans = Array.from(document.querySelectorAll('.chk-guru-jurusan:checked')).map(el => el.value);
  const checkedKelas = Array.from(document.querySelectorAll('.chk-guru-kelas:checked')).map(el => el.value);
  const checkedPakets = Array.from(document.querySelectorAll('.chk-guru-paket:checked')).map(el => el.value);

  const btn = document.getElementById('btn-save-guru-crud');
  btn.disabled = true;

  try {
    await DB.saveGuru(id, {
      username,
      nama_lengkap: nama,
      mapel_diampu: mapel,
      jurusan_diampu: checkedJurusans.join(', '),
      kelas_diampu: checkedKelas.join(', '),
      paket_ids: checkedPakets
    }, pass);

    Swal.fire('Berhasil', `Akun guru "${nama}" berhasil disimpan.`, 'success');
    if (guruFormModalInstance) guruFormModalInstance.hide();
    await loadGuru();
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan saat menyimpan akun guru.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteGuru(id, name) {
  const res = await Swal.fire({
    title: 'Hapus Akun Guru?',
    text: `Anda yakin ingin menghapus akun guru "${name}"? Paket soal yang sudah dibuat tidak akan ikut terhapus.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus Akun',
    cancelButtonText: 'Batal'
  });

  if (res.isConfirmed) {
    try {
      await DB.deleteGuru(id);
      Swal.fire('Dihapus!', 'Akun guru berhasil dihapus.', 'success');
      await loadGuru();
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

// -------------------------------------------------------------
// CETAK KARTU PESERTA UJIAN (CBT EXAM CARDS)
// -------------------------------------------------------------

async function openCetakKartuModal() {
  if (!allPeserta || allPeserta.length === 0) {
    try {
      allPeserta = await DB.getPesertaList();
      populateJurusanDropdowns();
      populateKelasDropdowns();
    } catch (err) {
      console.warn("Gagal auto-fetch peserta untuk cetak kartu:", err);
    }
  }

  populateCetakJurusanAndKelasDropdowns();
  updateCetakPreviewCount();
  if (cetakKartuModalInstance) cetakKartuModalInstance.show();
}

function populateCetakJurusanAndKelasDropdowns() {
  const selJur = document.getElementById('cetak-filter-jurusan');
  const selKls = document.getElementById('cetak-filter-kelas');
  if (!selJur || !selKls) return;

  const currentJur = selJur.value;
  const currentKls = selKls.value;

  const jurSet = new Set();
  (allJurusan || []).forEach(j => { if (j.nama_jurusan) jurSet.add(j.nama_jurusan.toUpperCase().trim()); });
  (allPeserta || []).forEach(p => { if (p.jurusan) jurSet.add(p.jurusan.toUpperCase().trim()); });
  const sortedJur = Array.from(jurSet).sort();

  selJur.innerHTML = '<option value="">Semua Jurusan</option>' + sortedJur.map(j => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`).join('');
  if (currentJur && sortedJur.includes(currentJur)) {
    selJur.value = currentJur;
  }

  onCetakFilterJurusanChange(currentKls);
}

function onCetakFilterJurusanChange(selectedKls = '') {
  const selJur = document.getElementById('cetak-filter-jurusan');
  const selKls = document.getElementById('cetak-filter-kelas');
  if (!selKls) return;

  const jurVal = (selJur?.value || '').toUpperCase().trim();

  const klsSet = new Set();
  (allPeserta || []).forEach(p => {
    const pJur = (p.jurusan || '').toUpperCase().trim();
    if (!jurVal || pJur === jurVal) {
      if (p.kelas) klsSet.add(p.kelas.toUpperCase().trim());
    }
  });

  const sortedKls = Array.from(klsSet).sort();
  selKls.innerHTML = '<option value="">Semua Kelas</option>' + sortedKls.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
  if (selectedKls && sortedKls.includes(selectedKls)) {
    selKls.value = selectedKls;
  }

  updateCetakPreviewCount();
}

function getTargetCetakStudents() {
  const jur = (document.getElementById('cetak-filter-jurusan')?.value || '').toUpperCase().trim();
  const kls = (document.getElementById('cetak-filter-kelas')?.value || '').toUpperCase().trim();
  const sesi = (document.getElementById('cetak-filter-sesi')?.value || '').trim();

  return (allPeserta || []).filter(p => {
    const pJur = (p.jurusan || '').toUpperCase().trim();
    const pKls = (p.kelas || '').toUpperCase().trim();
    const pSesi = (p.sesi || '').trim();

    const matchJur = !jur || pJur === jur;
    const matchKls = !kls || pKls === kls;
    const matchSesi = !sesi || pSesi === sesi;

    return matchJur && matchKls && matchSesi;
  });
}

function updateCetakPreviewCount() {
  const list = getTargetCetakStudents();
  const count = list.length;
  const pisahKelas = document.getElementById('cetak-opt-pisah-kelas')?.checked ?? true;
  let pages = 0;

  if (pisahKelas && count > 0) {
    const classCountMap = new Map();
    list.forEach(p => {
      const k = `${(p.jurusan || 'UMUM').toUpperCase()}|||${(p.kelas || 'SEMUA KELAS').toUpperCase()}`;
      classCountMap.set(k, (classCountMap.get(k) || 0) + 1);
    });
    classCountMap.forEach(c => {
      pages += Math.ceil(c / 10);
    });
  } else {
    pages = Math.ceil(count / 10);
  }

  const elCount = document.getElementById('cetak-preview-count');
  const elPages = document.getElementById('cetak-preview-pages');
  if (elCount) elCount.innerText = count;
  if (elPages) elPages.innerText = pages;
}

function prosesCetakKartu(mode = 'direct') {
  const students = getTargetCetakStudents();
  if (!students || students.length === 0) {
    Swal.fire('Tidak Ada Peserta', 'Tidak ada data peserta yang cocok untuk dicetak kartu.', 'info');
    return;
  }

  const opt = {
    namaSekolah: document.getElementById('cetak-nama-sekolah')?.value || 'SMK NEGERI 1 LEMPUING',
    judulUjian: document.getElementById('cetak-judul-ujian')?.value || 'PENILAIAN AKHIR SEMESTER (PAS) CBT',
    subjudulUjian: document.getElementById('cetak-subjudul-ujian')?.value || 'TAHUN AJARAN 2025/2026',
    kotaTanggal: document.getElementById('cetak-kota-tanggal')?.value || 'Lempuing, November 2026',
    showQr: document.getElementById('cetak-opt-qr')?.checked ?? true,
    showTtd: document.getElementById('cetak-opt-ttd')?.checked ?? true,
    pisahKelas: document.getElementById('cetak-opt-pisah-kelas')?.checked ?? true
  };

  if (cetakKartuModalInstance) cetakKartuModalInstance.hide();
  renderAndPrintCards(students, opt, mode);
}

function cetakKartuSiswa(pesertaId, mode = 'direct') {
  const p = (allPeserta || []).find(item => String(item.id) === String(pesertaId));
  if (!p) {
    Swal.fire('Error', 'Data peserta tidak ditemukan.', 'error');
    return;
  }

  const todayStr = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const opt = {
    namaSekolah: 'SMK NEGERI 1 LEMPUING',
    judulUjian: 'KARTU PESERTA UJIAN BERBASIS KOMPUTER (CBT)',
    subjudulUjian: 'TAHUN AJARAN 2025/2026',
    kotaTanggal: `Lempuing, ${todayStr}`,
    showQr: true,
    showTtd: true,
    pisahKelas: false
  };

  renderAndPrintCards([p], opt, mode);
}

function generatePrintCardsHtml(students, opt) {
  // Urutkan siswa secara berjenjang: Jurusan ASC -> Kelas ASC -> Nama Lengkap ASC
  const sorted = [...students].sort((a, b) => {
    const jA = (a.jurusan || 'Tanpa Jurusan').toUpperCase();
    const jB = (b.jurusan || 'Tanpa Jurusan').toUpperCase();
    if (jA < jB) return -1;
    if (jA > jB) return 1;

    const kA = (a.kelas || 'Tanpa Kelas').toUpperCase();
    const kB = (b.kelas || 'Tanpa Kelas').toUpperCase();
    if (kA < kB) return -1;
    if (kA > kB) return 1;

    return (a.nama_lengkap || '').localeCompare(b.nama_lengkap || '');
  });

  const pages = [];
  if (opt.pisahKelas) {
    // Kelompokkan per Jurusan + Kelas agar kartu per rombel tidak tercampur di lembar yang sama
    const classGroups = new Map();
    sorted.forEach(p => {
      const groupKey = `${(p.jurusan || 'UMUM').toUpperCase()}|||${(p.kelas || 'SEMUA KELAS').toUpperCase()}`;
      if (!classGroups.has(groupKey)) classGroups.set(groupKey, []);
      classGroups.get(groupKey).push(p);
    });

    classGroups.forEach((groupStudents, key) => {
      const [jur, kls] = key.split('|||');
      const totalPagesForClass = Math.ceil(groupStudents.length / 10);
      for (let i = 0; i < groupStudents.length; i += 10) {
        pages.push({
          jurusan: jur,
          kelas: kls,
          pageInClass: Math.floor(i / 10) + 1,
          totalPageInClass: totalPagesForClass,
          totalStudentsInClass: groupStudents.length,
          students: groupStudents.slice(i, i + 10)
        });
      }
    });
  } else {
    const totalP = Math.max(1, Math.ceil(sorted.length / 10));
    for (let i = 0; i < sorted.length; i += 10) {
      pages.push({
        jurusan: 'SEMUA JURUSAN',
        kelas: 'SEMUA KELAS',
        pageInClass: Math.floor(i / 10) + 1,
        totalPageInClass: totalP,
        totalStudentsInClass: sorted.length,
        students: sorted.slice(i, i + 10)
      });
    }
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Cetak Kartu Ujian (8,56 x 5,4 cm) - ${escapeHtml(opt.namaSekolah)}</title>
  <style>
    @page {
      size: 210mm 297mm;
      margin: 0mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #e2e8f0;
      font-family: Arial, Helvetica, sans-serif;
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    .no-print-bar {
      background: #1e293b;
      color: #fff;
      padding: 10px 20px;
      position: sticky;
      top: 0;
      z-index: 9999;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    }
    .no-print-bar .title {
      font-size: 13px;
      font-weight: bold;
    }
    .btn-act {
      border: none;
      padding: 7px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-print { background: #0d6efd; color: #fff; }
    .btn-print:hover { background: #0b5ed7; }
    .btn-close { background: #64748b; color: #fff; margin-left: 8px; }
    .btn-close:hover { background: #475569; }

    /* Lembar A4 (210mm x 297mm) memuat Header Rombel + 10 Kartu (2 Kolom x 5 Baris) */
    .a4-sheet {
      width: 210mm;
      height: 297mm;
      margin: 10px auto;
      box-sizing: border-box;
      padding: 6.5mm 16.4mm 7.5mm 16.4mm;
      display: grid;
      grid-template-columns: 85.6mm 85.6mm;
      grid-template-rows: auto repeat(5, 54mm);
      column-gap: 6mm;
      row-gap: 2mm;
      background: #ffffff;
      box-shadow: 0 4px 15px rgba(0,0,0,0.15);
      page-break-after: always;
      break-after: page;
      overflow: hidden;
    }

    /* Header Rombel / Penanda Kelas di atas kertas */
    .sheet-rombel-header {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 6.5pt;
      font-weight: bold;
      color: #1e293b;
      border-bottom: 1.5px solid #0f172a;
      padding-bottom: 1mm;
      margin-bottom: 0.5mm;
      line-height: 1.2;
    }
    .sheet-rombel-header .rombel-info {
      display: flex;
      gap: 3mm;
      align-items: center;
    }
    .sheet-rombel-header .badge-jur {
      color: #0d6efd;
      text-transform: uppercase;
    }
    .sheet-rombel-header .badge-kls {
      color: #0f172a;
      text-transform: uppercase;
      font-size: 7pt;
    }
    .sheet-rombel-header .badge-count {
      color: #64748b;
      font-weight: normal;
    }
    .sheet-rombel-header .page-info {
      color: #475569;
      font-size: 6.2pt;
    }

    /* Kartu Ujian: Presisi Standar Landscape (8,56 cm x 5,4 cm) */
    .kartu-card {
      width: 85.6mm;
      height: 54mm;
      max-width: 85.6mm;
      max-height: 54mm;
      border: 1px dashed #64748b;
      border-radius: 4px;
      padding: 2mm 3.2mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
      background: #ffffff;
      box-sizing: border-box;
      overflow: hidden;
    }

    /* KOP KARTU */
    .kop-sekolah {
      display: flex;
      align-items: center;
      gap: 2mm;
      border-bottom: 1.5px solid #0f172a;
      padding-bottom: 1.2mm;
      margin-bottom: 1.2mm;
    }
    .kop-logo {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
    }
    .kop-text {
      text-align: center;
      flex-grow: 1;
      line-height: 1.1;
    }
    .kop-prov {
      font-size: 5.2pt;
      font-weight: 700;
      color: #334155;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      margin: 0;
    }
    .kop-nama {
      font-size: 7.2pt;
      font-weight: 800;
      color: #0d6efd;
      text-transform: uppercase;
      margin: 0.5px 0;
      letter-spacing: 0.2px;
    }
    .kop-judul {
      font-size: 5.6pt;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
      margin: 0;
    }

    /* BODY KARTU: DATA SISWA & QR */
    .body-content {
      display: flex;
      gap: 2mm;
      align-items: center;
      flex-grow: 1;
      min-height: 0;
    }
    .table-siswa {
      width: 100%;
      border-collapse: collapse;
      font-size: 6.8pt;
      line-height: 1.25;
      table-layout: fixed;
    }
    .table-siswa td {
      padding: 0.7px 0;
      vertical-align: middle;
    }
    .table-siswa td.lbl {
      width: 16mm;
      font-weight: 600;
      color: #475569;
      font-size: 6.4pt;
    }
    .table-siswa td.col {
      width: 2.5mm;
      text-align: center;
      color: #64748b;
    }
    .table-siswa td.val {
      color: #0f172a;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .val-nama {
      font-weight: 700;
      font-size: 7.2pt;
      color: #0f172a;
    }
    .val-kelas {
      font-weight: 700;
      color: #1e293b;
    }
    .badge-user {
      font-family: Consolas, monospace;
      font-size: 7.5pt;
      font-weight: 800;
      color: #0d6efd;
      letter-spacing: 0.3px;
    }
    .badge-pass {
      font-family: Consolas, monospace;
      font-size: 7.2pt;
      font-weight: 700;
      color: #0f172a;
      background: #f1f5f9;
      padding: 0.5px 3.5px;
      border: 1px solid #cbd5e1;
      border-radius: 3px;
      display: inline-block;
    }

    /* QR Code Box */
    .qr-box {
      width: 18mm;
      height: 18mm;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border: 1px solid #e2e8f0;
      border-radius: 3px;
      background: #fafafa;
      padding: 1px;
    }
    .qr-img {
      width: 16mm;
      height: 16mm;
      display: block;
    }

    /* FOOTER KARTU */
    .footer-kartu {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 1px solid #cbd5e1;
      padding-top: 0.8mm;
      margin-top: 0.8mm;
      font-size: 5pt;
      color: #64748b;
      line-height: 1.1;
    }
    .footer-kiri {
      max-width: 50mm;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .footer-kanan {
      text-align: right;
      font-weight: 600;
      color: #334155;
    }

    .cut-guide {
      position: absolute;
      bottom: 0.5px;
      right: 2px;
      font-size: 4.5pt;
      color: #94a3b8;
      pointer-events: none;
    }

    @media print {
      html, body {
        background: #fff !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .no-print-bar {
        display: none !important;
      }
      .a4-sheet {
        margin: 0 !important;
        padding: 6.5mm 16.4mm 7.5mm 16.4mm !important;
        box-shadow: none !important;
        width: 210mm !important;
        height: 297mm !important;
        page-break-after: always !important;
        break-after: page !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    }
  </style>
</head>
<body>
  <div class="no-print-bar">
    <div class="title">
      📄 Pratinjau Kartu Ujian (8,56 &times; 5,4 cm) &bull; Total: ${sorted.length} Peserta (${pages.length} Lembar A4)
    </div>
    <div>
      <button class="btn-act btn-print" onclick="window.print()">🖨️ Cetak / Simpan PDF</button>
      <button class="btn-act btn-close" onclick="window.close()">Tutup Tab</button>
    </div>
  </div>

  ${pages.map((pGroup) => `
    <div class="a4-sheet">
      <!-- Penanda Rombel / Header Lembar A4 -->
      <div class="sheet-rombel-header">
        <div class="rombel-info">
          <span class="badge-jur">JURUSAN: ${escapeHtml(pGroup.jurusan)}</span>
          <span class="badge-kls">KELAS: ${escapeHtml(pGroup.kelas)}</span>
          <span class="badge-count">(${pGroup.totalStudentsInClass} Siswa)</span>
        </div>
        <div class="page-info">
          Lembar ${pGroup.pageInClass} dari ${pGroup.totalPageInClass}
        </div>
      </div>

      ${pGroup.students.map(p => `
        <div class="kartu-card">
          <!-- Kop Kartu -->
          <div class="kop-sekolah">
            <svg class="kop-logo" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="50" r="45" fill="#0d6efd" stroke="#ffffff" stroke-width="4" />
              <path d="M50 20 L25 40 L35 40 L35 75 L65 75 L65 40 L75 40 Z" fill="#ffffff" />
              <circle cx="50" cy="50" r="8" fill="#ffc107" />
            </svg>
            <div class="kop-text">
              <div class="kop-prov">PEMERINTAH PROVINSI SUMATERA SELATAN &bull; DINAS PENDIDIKAN</div>
              <div class="kop-nama">${escapeHtml(opt.namaSekolah)}</div>
              <div class="kop-judul">${escapeHtml(opt.judulUjian)}</div>
            </div>
          </div>

          <!-- Body Siswa (Kop, Nama, Kelas, Username, Password) -->
          <div class="body-content">
            <table class="table-siswa">
              <tr>
                <td class="lbl">Nama</td>
                <td class="col">:</td>
                <td class="val val-nama" title="${escapeAttr(p.nama_lengkap)}">${escapeHtml(p.nama_lengkap)}</td>
              </tr>
              <tr>
                <td class="lbl">Kelas</td>
                <td class="col">:</td>
                <td class="val val-kelas">${escapeHtml(p.kelas || '-')}${p.jurusan ? ` (${escapeHtml(p.jurusan)})` : ''}</td>
              </tr>
              <tr>
                <td class="lbl">Username</td>
                <td class="col">:</td>
                <td class="val"><span class="badge-user">${escapeHtml(p.username)}</span></td>
              </tr>
              <tr>
                <td class="lbl">Password</td>
                <td class="col">:</td>
                <td class="val"><span class="badge-pass">${escapeHtml(p.password || 'Sesuai Akun')}</span></td>
              </tr>
            </table>

            ${opt.showQr ? `
            <div class="qr-box" title="Scan QR Login Peserta">
              <img class="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(p.username)}" alt="QR" onerror="this.parentElement.style.display='none'">
            </div>
            ` : ''}
          </div>

          <!-- Footer Kartu -->
          <div class="footer-kartu">
            <div class="footer-kiri">
              <span>Ruang: <strong>${escapeHtml(p.ruang || '1')}</strong> &bull; Sesi: <strong>${escapeHtml(p.sesi || '1')}</strong></span>
            </div>
            <div class="footer-kanan">
              <span>${escapeHtml(opt.kotaTanggal || 'Panitia CBT')}</span>
            </div>
          </div>

          <div class="cut-guide">✂️ 8,56 &times; 5,4 cm</div>
        </div>
      `).join('')}
      ${pGroup.students.length < 10 ? Array(10 - pGroup.students.length).fill('<div style="border: 1px dashed #e2e8f0; border-radius: 4px; height: 54mm;"></div>').join('') : ''}
    </div>
  `).join('')}

  <script>
    // Auto print when loaded in a new tab
    window.addEventListener('load', () => {
      setTimeout(() => {
        try { window.print(); } catch (e) {}
      }, 400);
    });
  <\/script>
</body>
</html>`;
}

function renderAndPrintCards(students, opt, mode = 'direct') {
  const html = generatePrintCardsHtml(students, opt);

  if (mode === 'tab') {
    openPrintInNewTab(html);
    return;
  }

  // Direct print via hidden iframe (no popup blocker, direct native print dialog)
  let iframe = document.getElementById('print-hidden-frame');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'print-hidden-frame';
    iframe.style.position = 'fixed';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    iframe.style.width = '210mm';
    iframe.style.height = '297mm';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);
  }

  Swal.fire({
    title: 'Menyiapkan Cetak...',
    text: `Menyiapkan ${students.length} kartu (${Math.ceil(students.length / 10)} lembar A4)...`,
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  try {
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    setTimeout(() => {
      Swal.close();
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    }, 600);
  } catch (err) {
    console.error("Direct print iframe failed, fallback to new tab:", err);
    Swal.close();
    openPrintInNewTab(html);
  }
}

function openPrintInNewTab(html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const printWin = window.open(blobUrl, '_blank');
  if (!printWin) {
    Swal.fire('Pop-up Diblokir', 'Browser memblokir tab baru. Silakan klik tombol "Cetak Sekarang (Print / PDF)" untuk cetak langsung atau izinkan pop-up.', 'warning');
  }
}

// -------------------------------------------------------------
// CRUD: DATA PAKET SOAL & SOAL
// -------------------------------------------------------------

async function loadPaket() {
  try {
    const rawPaket = await DB.getPaketList();
    allPaketUnfiltered = rawPaket || [];
    allPaket = isGuruMode()
      ? allPaketUnfiltered.filter(p => isPaketAllowedForGuru(p))
      : allPaketUnfiltered;

    renderPaketList(allPaket);
    populateHasilFilterDropdowns();
    if (allHasil && allHasil.length > 0) {
      filterHasilList();
    }
    
    if (allPaket.length > 0 && !activePaketId) {
      selectPaket(allPaket[0].id);
    } else if (activePaketId) {
      const exists = allPaket.find(p => p.id === activePaketId);
      if (exists) selectPaket(activePaketId);
      else {
        activePaketId = null;
        document.getElementById('paket-detail-container').classList.add('d-none');
        document.getElementById('paket-empty-state').classList.remove('d-none');
      }
    } else {
      document.getElementById('paket-detail-container').classList.add('d-none');
      document.getElementById('paket-empty-state').classList.remove('d-none');
    }
  } catch (err) {
    console.error("Gagal memuat paket:", err);
  }
}

function renderPaketList(list) {
  const container = document.getElementById('paket-list-container');
  container.innerHTML = '';

  const filterJurusanEl = document.getElementById('filter-jurusan-paket');
  const selJurusan = filterJurusanEl ? filterJurusanEl.value.toUpperCase().trim() : '';

  const filterKelasEl = document.getElementById('filter-kelas-paket');
  const selKelas = filterKelasEl ? filterKelasEl.value.toUpperCase().trim() : '';

  let filtered = list || allPaket || [];
  if (selJurusan) {
    filtered = filtered.filter(p => {
      const pj = (p.jurusan || '').toUpperCase().trim();
      return pj === selJurusan || pj === '' || pj === 'SEMUA';
    });
  }
  if (selKelas) {
    filtered = filtered.filter(p => {
      const pk = (p.kelas || '').toUpperCase().trim();
      if (!pk || pk === 'SEMUA') return true;
      if (pk === selKelas) return true;
      if (selKelas.startsWith('TINGKAT:')) {
        const tVal = selKelas.replace('TINGKAT:', '').trim();
        return checkKelasMatch(p.kelas, tVal).match || checkKelasMatch(p.kelas, `Kelas ${tVal}`).match;
      }
      return checkKelasMatch(p.kelas, selKelas).match;
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-4 text-muted">Belum ada paket soal yang cocok dengan filter.</div>`;
    return;
  }

  const items = filtered.map(p => {
    const isActive = p.id === activePaketId ? 'active' : '';
    const jurusanBadge = p.jurusan && p.jurusan.toLowerCase() !== 'semua' ? `<span class="badge bg-info text-dark ms-1">${escapeHtml(p.jurusan)}</span>` : `<span class="badge bg-secondary ms-1">Semua Jurusan</span>`;
    
    let kelasBadge = `<span class="badge bg-secondary-subtle text-dark border ms-1">Semua Kelas</span>`;
    if (p.kelas && p.kelas.toLowerCase() !== 'semua') {
      if (p.kelas.toUpperCase().startsWith('TINGKAT:')) {
        const tVal = p.kelas.split(':')[1];
        kelasBadge = `<span class="badge bg-primary text-white ms-1" title="Berlaku untuk semua rombel tingkat ${escapeHtml(tVal)}"><i class="bi bi-mortarboard-fill me-1"></i>Tingkat ${escapeHtml(tVal)}</span>`;
      } else {
        kelasBadge = `<span class="badge bg-success text-white ms-1">${escapeHtml(p.kelas)}</span>`;
      }
    }

    const soalCount = p.total_soal !== undefined ? p.total_soal : (p.soal_count || 0);
    const soalBadge = `<span class="badge ${soalCount > 0 ? 'bg-primary text-white' : 'bg-warning text-dark'} ms-1"><i class="bi bi-question-circle me-1"></i>${soalCount} Soal</span>`;

    return `
      <a href="#" class="list-group-item list-group-item-action ${isActive}" onclick="selectPaket('${p.id}'); return false;">
        <div class="d-flex justify-content-between align-items-center mb-1">
          <h6 class="mb-0 fw-bold">${escapeHtml(p.nama_paket)}</h6>
          ${soalBadge}
        </div>
        <div class="mb-1">${jurusanBadge} ${kelasBadge}</div>
        <small class="mb-0 d-block text-muted"><i class="bi bi-calendar-event me-1"></i>${p.jadwal_mulai ? new Date(p.jadwal_mulai).toLocaleString() : 'Belum diatur'}</small>
      </a>
    `;
  });

  container.innerHTML = items.join('');
}

function filterPaketList() {
  renderPaketList(allPaket);
}

function detectPaketAgamaHint(val) {
  const hintEl = document.getElementById('paket-agama-hint');
  if (!hintEl) return;
  const n = (val || '').toLowerCase();
  const isAgama = n.includes('agama') || n.includes('pai') || n.includes('paibp') || n.includes('kristen') || n.includes('katolik') || n.includes('hindu') || n.includes('buddha') || n.includes('konghucu');
  if (isAgama) {
    hintEl.classList.remove('d-none');
  } else {
    hintEl.classList.add('d-none');
  }
}

function setPaketNamaPreset(presetName) {
  const input = document.getElementById('crud-paket-nama');
  if (input) {
    input.value = presetName;
    detectPaketAgamaHint(presetName);
  }
}

function openPaketForm() {
  document.getElementById('paketFormTitle').innerText = "Buat Paket Soal Baru";
  document.getElementById('form-paket-crud').reset();
  document.getElementById('paket-id').value = "";
  const hintEl = document.getElementById('paket-agama-hint');
  if (hintEl) hintEl.classList.add('d-none');
  populateJurusanDropdowns();
  populateKelasDropdowns();
  document.getElementById('crud-paket-jurusan').value = "";
  document.getElementById('crud-paket-kelas').value = "";

  // Jika login sebagai Guru Mapel, isi otomatis nama paket, jurusan, dan kelas sesuai yang diampu
  if (isGuruMode()) {
    if (currentAdminUser.mapel_diampu) {
      const firstMapel = String(currentAdminUser.mapel_diampu).split(',')[0].trim();
      if (firstMapel) {
        document.getElementById('crud-paket-nama').value = firstMapel;
        detectPaketAgamaHint(firstMapel);
      }
    }
    const guruJurusans = getGuruJurusanList();
    if (guruJurusans.length > 0) {
      const selJ = document.getElementById('crud-paket-jurusan');
      if (selJ) {
        selJ.innerHTML = guruJurusans.map(j => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`).join('');
        selJ.value = guruJurusans[0];
      }
    }
    const guruKelas = getGuruKelasList();
    if (guruKelas.length > 0) {
      const selK = document.getElementById('crud-paket-kelas');
      if (selK) {
        if (!Array.from(selK.options).some(o => o.value.toUpperCase() === guruKelas[0])) {
          selK.innerHTML += `<option value="${escapeHtml(guruKelas[0])}">${escapeHtml(guruKelas[0])}</option>`;
        }
        selK.value = guruKelas[0];
      }
    }
  }

  paketFormModalInstance.show();
}

function editPaket() {
  if (!activePaketId) return;
  const p = allPaket.find(item => item.id === activePaketId);
  if (!p) return;

  populateJurusanDropdowns();
  populateKelasDropdowns();

  const selJurusan = document.getElementById('crud-paket-jurusan');
  const targetJurusan = (p.jurusan || '').toUpperCase();
  if (targetJurusan && targetJurusan !== 'SEMUA' && !Array.from(selJurusan.options).some(o => o.value.toUpperCase() === targetJurusan)) {
    selJurusan.innerHTML += `<option value="${escapeHtml(p.jurusan)}">${escapeHtml(p.jurusan)}</option>`;
  }

  const selKelas = document.getElementById('crud-paket-kelas');
  const targetKelas = (p.kelas || '').toUpperCase();
  if (targetKelas && targetKelas !== 'SEMUA' && !Array.from(selKelas.options).some(o => o.value.toUpperCase() === targetKelas)) {
    selKelas.innerHTML += `<option value="${escapeHtml(p.kelas)}">${escapeHtml(p.kelas)}</option>`;
  }

  document.getElementById('paketFormTitle').innerText = "Edit Paket Soal";
  document.getElementById('paket-id').value = p.id;
  document.getElementById('crud-paket-nama').value = p.nama_paket;
  detectPaketAgamaHint(p.nama_paket);
  document.getElementById('crud-paket-jurusan').value = p.jurusan || "";
  document.getElementById('crud-paket-kelas').value = p.kelas || "";
  
  // Konversi waktu ISO (UTC) dari database ke format input datetime-local (zona waktu lokal)
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  if (p.jadwal_mulai) {
    document.getElementById('crud-paket-mulai').value = toLocalInput(p.jadwal_mulai);
  } else {
    document.getElementById('crud-paket-mulai').value = "";
  }
  
  if (p.jadwal_selesai) {
    document.getElementById('crud-paket-selesai').value = toLocalInput(p.jadwal_selesai);
  } else {
    document.getElementById('crud-paket-selesai').value = "";
  }

  paketFormModalInstance.show();
}

async function handlePaketCrudSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('paket-id').value;
  const nama = document.getElementById('crud-paket-nama').value.trim();
  const jurusan = document.getElementById('crud-paket-jurusan').value.trim();
  const kelas = document.getElementById('crud-paket-kelas').value.trim();
  const start = document.getElementById('crud-paket-mulai').value;
  const end = document.getElementById('crud-paket-selesai').value;

  const payload = {
    nama_paket: nama,
    jurusan: jurusan || null,
    kelas: kelas || null,
    jadwal_mulai: start ? new Date(start).toISOString() : null,
    jadwal_selesai: end ? new Date(end).toISOString() : null
  };

  const btn = document.getElementById('btn-save-paket');
  btn.disabled = true;

  try {
    const res = await DB.savePaket(id, payload);
    
    // Jika dibuat oleh Guru, otomatis tambahkan ID paket baru ke daftar akses paket guru tersebut
    if (!id && res && res.id && isGuruMode()) {
      try {
        const currentIds = getGuruAllowedPaketIds();
        if (!currentIds.includes(String(res.id))) {
          currentIds.push(String(res.id));
          currentAdminUser.paket_ids = JSON.stringify(currentIds);
          sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(currentAdminUser));
          await DB.saveGuru(currentAdminUser.id, {
            username: currentAdminUser.username,
            nama_lengkap: currentAdminUser.nama_lengkap,
            mapel_diampu: currentAdminUser.mapel_diampu,
            jurusan_diampu: currentAdminUser.jurusan_diampu || '',
            kelas_diampu: currentAdminUser.kelas_diampu || '',
            paket_ids: currentIds
          });
        }
      } catch (e) {}
    }

    Swal.fire('Berhasil', 'Paket soal berhasil disimpan.', 'success');
    paketFormModalInstance.hide();
    
    if (!id && res && res.id) activePaketId = res.id;
    
    await loadPaket();
    await refreshJurusanDanKelas();
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deletePaket() {
  if (!activePaketId) return;
  const p = allPaket.find(item => item.id === activePaketId);

  const result = await Swal.fire({
    title: 'Hapus Paket Soal?',
    text: `Anda akan menghapus paket "${p.nama_paket}". Semua pertanyaan di dalamnya akan ikut terhapus.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus Paket!',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      await DB.deletePaket(activePaketId);
      Swal.fire('Dihapus!', 'Paket Soal telah berhasil dihapus.', 'success');
      activePaketId = null;
      await loadPaket();
      await refreshJurusanDanKelas();
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

async function selectPaket(id) {
  activePaketId = id;
  const p = allPaket.find(item => item.id === activePaketId);
  if (!p) return;

  renderPaketList(allPaket); // re-render to update active class

  document.getElementById('paket-detail-container').classList.remove('d-none');
  document.getElementById('paket-empty-state').classList.add('d-none');
  
  const jText = p.jurusan && p.jurusan.toLowerCase() !== 'semua' ? p.jurusan : 'Semua Jurusan';
  let kText = 'Semua Kelas';
  if (p.kelas && p.kelas.toLowerCase() !== 'semua') {
    if (p.kelas.toUpperCase().startsWith('TINGKAT:')) {
      kText = `Tingkat ${p.kelas.split(':')[1]}`;
    } else {
      kText = p.kelas;
    }
  }

  const soalCount = p.total_soal !== undefined ? p.total_soal : (p.soal_count || 0);

  document.getElementById('active-paket-title').innerHTML = `
    <span class="align-middle">${escapeHtml(p.nama_paket)}</span>
    <span class="badge ${soalCount > 0 ? 'bg-primary' : 'bg-warning text-dark'} fs-6 ms-2 align-middle" id="active-paket-soal-count"><i class="bi bi-question-circle me-1"></i>${soalCount} Soal</span>
    <span class="badge bg-info-subtle text-dark border ms-1 fs-6 align-middle"><i class="bi bi-briefcase me-1"></i>${escapeHtml(jText)}</span>
    <span class="badge bg-secondary-subtle text-dark border ms-1 fs-6 align-middle"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(kText)}</span>
  `;
  
  let jadwalStr = 'Jadwal belum diatur (Peserta tidak bisa mengakses)';
  if (p.jadwal_mulai && p.jadwal_selesai) {
    jadwalStr = `${new Date(p.jadwal_mulai).toLocaleString()} s/d ${new Date(p.jadwal_selesai).toLocaleString()}`;
  } else if (p.jadwal_mulai) {
    jadwalStr = `Mulai dari ${new Date(p.jadwal_mulai).toLocaleString()}`;
  } else if (p.jadwal_selesai) {
    jadwalStr = `Berakhir pada ${new Date(p.jadwal_selesai).toLocaleString()}`;
  }
  document.getElementById('active-paket-jadwal').innerHTML = `<i class="bi bi-clock"></i> ${jadwalStr}`;

  await loadSoal();
}

async function loadSoal() {
  if (!activePaketId) return;
  try {
    allSoal = await DB.getSoalByPaket(activePaketId);
    renderSoalList(allSoal);

    // Update active package total_soal count in memory and sync UI
    const p = allPaket.find(item => item.id === activePaketId);
    if (p) {
      p.total_soal = allSoal.length;
      const countEl = document.getElementById('active-paket-soal-count');
      if (countEl) {
        countEl.className = `badge ${allSoal.length > 0 ? 'bg-primary' : 'bg-warning text-dark'} fs-6 ms-2 align-middle`;
        countEl.innerHTML = `<i class="bi bi-question-circle me-1"></i>${allSoal.length} Soal`;
      }
      renderPaketList(allPaket);
    }
  } catch (err) {
    console.error("Gagal memuat soal:", err);
  }
}

function renderSoalList(list) {
  const container = document.getElementById('soal-list-container');
  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `<div class="text-center text-muted py-4">Bank soal masih kosong. Silakan tambah atau import soal dari Excel.</div>`;
    return;
  }

  const items = list.map((s, idx) => {
    const isBs = !s.opsi_c && !s.opsi_d;
    const hasImg = s.gambar ? `<span class="badge bg-warning text-dark mb-2 ms-1"><i class="bi bi-image"></i> Gambar</span>` : '';

    let optionsHtml = `
      <div class="row g-2 small mt-2">
        <div class="col-md-6"><strong>A.</strong> ${s.opsi_a}</div>
        <div class="col-md-6"><strong>B.</strong> ${s.opsi_b}</div>
    `;

    if (!isBs) {
      optionsHtml += `
        <div class="col-md-6"><strong>C.</strong> ${s.opsi_c || '-'}</div>
        <div class="col-md-6"><strong>D.</strong> ${s.opsi_d || '-'}</div>
      `;
      if (s.opsi_e) {
        optionsHtml += `
          <div class="col-md-6"><strong>E.</strong> ${s.opsi_e}</div>
        `;
      }
    }
    optionsHtml += `</div>`;

    return `
      <div class="card mb-3 border-0 bg-light p-3 shadow-sm rounded-3">
        <div class="d-flex justify-content-between align-items-start gap-3">
          <div class="flex-grow-1">
            <span class="badge bg-primary mb-2">Soal No. ${s.nomor || (idx + 1)}</span>
            <span class="badge bg-secondary mb-2">Bobot: ${s.bobot || 1}</span>
            ${isBs ? `<span class="badge bg-info mb-2 text-dark">Benar / Salah</span>` : ''}
            ${hasImg}
            <h6 class="fw-semibold text-dark mt-1" style="white-space: pre-wrap;">${s.pertanyaan}</h6>
            ${optionsHtml}
            <div class="text-success small mt-2 font-heading fw-bold">
              <i class="bi bi-check-circle-fill me-1"></i> Kunci Jawaban: Opsi ${s.jawaban_benar}
            </div>
          </div>
          <div class="btn-group">
            <button class="btn btn-sm btn-outline-primary" onclick="editSoal('${s.id}')">
              <i class="bi bi-pencil"></i> Edit
            </button>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteSoal('${s.id}', ${s.nomor})">
              <i class="bi bi-trash"></i> Hapus
            </button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = items.join('');
}

function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      // Compress using canvas
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 600;
      let width = img.width;
      let height = img.height;

      if (width > MAX_WIDTH) {
        height *= MAX_WIDTH / width;
        width = MAX_WIDTH;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      document.getElementById('crud-soal-gambar-preview').src = dataUrl;
      document.getElementById('crud-soal-gambar-preview').classList.remove('d-none');
      document.getElementById('crud-soal-gambar-base64').value = dataUrl;
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function openSoalForm() {
  document.getElementById('soalFormTitle').innerText = "Tambah Soal Baru";
  document.getElementById('form-soal-crud').reset();
  document.getElementById('soal-id').value = "";
  document.getElementById('crud-soal-nomor').value = allSoal.length + 1;
  document.getElementById('crud-soal-gambar-preview').src = "";
  document.getElementById('crud-soal-gambar-preview').classList.add('d-none');
  document.getElementById('crud-soal-gambar-base64').value = "";
  const elOpsiE = document.getElementById('crud-soal-opsie');
  if (elOpsiE) elOpsiE.value = "";

  const select = document.getElementById('crud-soal-jawaban');
  select.innerHTML = `
    <option value="">Pilih opsi benar...</option>
    <option value="A">Opsi A</option>
    <option value="B">Opsi B</option>
    <option value="C">Opsi C</option>
    <option value="D">Opsi D</option>
    <option value="E">Opsi E</option>
  `;

  soalFormModalInstance.show();
}

function editSoal(id) {
  const s = allSoal.find(item => item.id === id);
  if (!s) return;

  document.getElementById('soalFormTitle').innerText = "Edit Soal Ujian";
  document.getElementById('soal-id').value = s.id;
  document.getElementById('crud-soal-nomor').value = s.nomor;
  document.getElementById('crud-soal-bobot').value = s.bobot;
  document.getElementById('crud-soal-pertanyaan').value = s.pertanyaan;
  document.getElementById('crud-soal-opsia').value = s.opsi_a;
  document.getElementById('crud-soal-opsib').value = s.opsi_b;
  document.getElementById('crud-soal-opsic').value = s.opsi_c || "";
  document.getElementById('crud-soal-opsid').value = s.opsi_d || "";
  const elOpsiE = document.getElementById('crud-soal-opsie');
  if (elOpsiE) elOpsiE.value = s.opsi_e || "";
  
  if (s.gambar) {
    document.getElementById('crud-soal-gambar-preview').src = s.gambar;
    document.getElementById('crud-soal-gambar-preview').classList.remove('d-none');
    document.getElementById('crud-soal-gambar-base64').value = s.gambar;
  } else {
    document.getElementById('crud-soal-gambar-preview').src = "";
    document.getElementById('crud-soal-gambar-preview').classList.add('d-none');
    document.getElementById('crud-soal-gambar-base64').value = "";
  }
  
  // reset input file
  document.getElementById('crud-soal-gambar').value = "";
  
  const select = document.getElementById('crud-soal-jawaban');
  select.innerHTML = `
    <option value="">Pilih opsi benar...</option>
    <option value="A">Opsi A</option>
    <option value="B">Opsi B</option>
  `;

  if (s.opsi_c || s.opsi_d || s.opsi_e) {
    select.innerHTML += `
      <option value="C">Opsi C</option>
      <option value="D">Opsi D</option>
      <option value="E">Opsi E</option>
    `;
  }
  
  select.value = s.jawaban_benar;
  soalFormModalInstance.show();
}

async function handleSoalCrudSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('soal-id').value;
  const no = parseInt(document.getElementById('crud-soal-nomor').value);
  const bobot = parseInt(document.getElementById('crud-soal-bobot').value);
  const q = document.getElementById('crud-soal-pertanyaan').value.trim();
  const oa = document.getElementById('crud-soal-opsia').value.trim();
  const ob = document.getElementById('crud-soal-opsib').value.trim();
  const oc = document.getElementById('crud-soal-opsic').value.trim();
  const od = document.getElementById('crud-soal-opsid').value.trim();
  const oe = (document.getElementById('crud-soal-opsie')?.value || '').trim();
  const ans = document.getElementById('crud-soal-jawaban').value;
  const gambar = document.getElementById('crud-soal-gambar-base64').value;

  const payload = {
    paket_soal_id: activePaketId,
    nomor: no,
    bobot: bobot,
    pertanyaan: q,
    opsi_a: oa,
    opsi_b: ob,
    opsi_c: oc || null,
    opsi_d: od || null,
    opsi_e: oe || null,
    jawaban_benar: ans,
    gambar: gambar || null
  };

  const btn = document.getElementById('btn-save-soal-crud');
  btn.disabled = true;

  try {
    await DB.saveSoal(id, payload);
    Swal.fire('Berhasil', 'Soal berhasil disimpan.', 'success');
    soalFormModalInstance.hide();
    await loadSoal();
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteSoal(id, nomor) {
  const result = await Swal.fire({
    title: 'Hapus Soal?',
    text: `Hapus soal ujian nomor ${nomor}? Tindakan ini dapat mempengaruhi hasil koreksi jika ada peserta yang sedang/sudah ujian.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      await DB.deleteSoal(id);
      Swal.fire('Terhapus!', 'Soal berhasil dihapus.', 'success');
      await loadSoal();
    } catch (err) {
      Swal.fire('Gagal', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

function exportSoalData() {
  if (allSoal.length === 0) {
    Swal.fire('Ekspor Kosong', 'Tidak ada data soal untuk diekspor.', 'warning');
    return;
  }

  const map = {
    nomor: 'Nomor',
    pertanyaan: 'Pertanyaan',
    opsi_a: 'Opsi A',
    opsi_b: 'Opsi B',
    opsi_c: 'Opsi C',
    opsi_d: 'Opsi D',
    opsi_e: 'Opsi E',
    jawaban_benar: 'Jawaban Benar',
    bobot: 'Bobot'
  };

  ExcelHelpers.exportJSONToExcel(allSoal, map, "Bank_Soal_CBT_SMKN1Lempuing", "Soal");
}

// -------------------------------------------------------------
// RESULTS: HASIL & NILAI
// -------------------------------------------------------------

function populateHasilFilterDropdowns() {
  const mapelSet = new Set();
  const jurusanSet = new Set();
  const kelasSet = new Set();

  // Collect from allPaket
  (allPaket || []).forEach(pk => {
    if (pk.nama_paket) mapelSet.add(pk.nama_paket);
  });

  // Backfill nama_mapel from allPaket if needed and collect from actual results
  (allHasil || []).forEach(h => {
    if ((!h.nama_mapel || h.nama_mapel === 'Umum') && h.paket_soal_id && Array.isArray(allPaket)) {
      const matchedPaket = allPaket.find(pk => pk.id === h.paket_soal_id);
      if (matchedPaket && matchedPaket.nama_paket) {
        h.nama_mapel = matchedPaket.nama_paket;
      }
    }
    if (h.nama_mapel) mapelSet.add(h.nama_mapel);
    const p = h.peserta;
    if (p) {
      if (p.jurusan) jurusanSet.add(p.jurusan.toUpperCase());
      if (p.kelas) kelasSet.add(p.kelas.toUpperCase());
    }
  });

  const fMapel = document.getElementById('filter-mapel-hasil');
  if (fMapel) {
    const fMapelVal = fMapel.value;
    fMapel.innerHTML = '<option value="">📚 Semua Mata Pelajaran</option>' + 
      Array.from(mapelSet).sort().map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    fMapel.value = fMapelVal;
  }

  const fJurusan = document.getElementById('filter-jurusan-hasil');
  if (fJurusan) {
    const fJurusanVal = fJurusan.value;
    fJurusan.innerHTML = '<option value="">Semua Jurusan</option>' + 
      Array.from(jurusanSet).sort().map(j => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`).join('');
    fJurusan.value = fJurusanVal;
  }

  const fKelas = document.getElementById('filter-kelas-hasil');
  if (fKelas) {
    const fKelasVal = fKelas.value;
    fKelas.innerHTML = '<option value="">Semua Kelas</option>' + 
      Array.from(kelasSet).sort().map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
    fKelas.value = fKelasVal;
  }
}

async function loadHasil() {
  try {
    const rawHasil = await DB.getHasilList();
    // Backfill nama_mapel terlebih dahulu sebelum difilter untuk Guru
    (rawHasil || []).forEach(h => {
      if ((!h.nama_mapel || h.nama_mapel === 'Umum') && h.paket_soal_id && Array.isArray(allPaketUnfiltered)) {
        const matchedPaket = allPaketUnfiltered.find(pk => pk.id === h.paket_soal_id);
        if (matchedPaket && matchedPaket.nama_paket) {
          h.nama_mapel = matchedPaket.nama_paket;
        }
      }
    });
    allHasil = isGuruMode()
      ? (rawHasil || []).filter(h => isHasilAllowedForGuru(h))
      : (rawHasil || []);
    populateHasilFilterDropdowns();
    filterHasilList();
  } catch (err) {
    console.error("Gagal memuat hasil ujian:", err);
  }
}

let hasilCurrentPage = 1;
let hasilPageSize = 50;
let currentFilteredHasil = [];

function changeHasilPageSize(size) {
  hasilPageSize = size === 'all' ? 'all' : (parseInt(size, 10) || 50);
  hasilCurrentPage = 1;
  renderHasilTable(currentFilteredHasil, true);
}

function goToHasilPage(page) {
  hasilCurrentPage = Math.max(1, parseInt(page, 10) || 1);
  renderHasilTable(currentFilteredHasil, true);
}

function renderHasilTable(list, keepPage = false) {
  currentFilteredHasil = list || [];
  const tbody = document.getElementById('table-hasil-body');
  const infoEl = document.getElementById('hasil-pagination-info');
  const navEl = document.getElementById('hasil-pagination-nav');
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">Belum ada hasil ujian yang cocok atau tersimpan.</td></tr>`;
    if (infoEl) infoEl.innerText = 'Menampilkan 0 dari 0 nilai';
    if (navEl) navEl.innerHTML = '';
    return;
  }

  // Sort list by Mapel, then Jurusan, then Kelas, then Nilai (descending)
  const sortedList = [...list].sort((a, b) => {
    const mA = (a.nama_mapel || 'Umum').toUpperCase();
    const mB = (b.nama_mapel || 'Umum').toUpperCase();
    if (mA < mB) return -1;
    if (mA > mB) return 1;

    const pA = a.peserta || {};
    const pB = b.peserta || {};
    const jA = (pA.jurusan || 'Tanpa Jurusan').toUpperCase();
    const jB = (pB.jurusan || 'Tanpa Jurusan').toUpperCase();
    if (jA < jB) return -1;
    if (jA > jB) return 1;
    
    const kA = (pA.kelas || 'Tanpa Kelas').toUpperCase();
    const kB = (pB.kelas || 'Tanpa Kelas').toUpperCase();
    if (kA < kB) return -1;
    if (kA > kB) return 1;
    
    return (parseFloat(b.nilai) || 0) - (parseFloat(a.nilai) || 0);
  });

  const totalItems = sortedList.length;
  let pagedItems = sortedList;
  let totalPages = 1;
  let startIdx = 0;
  let endIdx = totalItems;

  if (hasilPageSize !== 'all') {
    const pageSizeNum = parseInt(hasilPageSize, 10) || 50;
    totalPages = Math.max(1, Math.ceil(totalItems / pageSizeNum));
    if (!keepPage) hasilCurrentPage = 1;
    if (hasilCurrentPage > totalPages) hasilCurrentPage = totalPages;
    if (hasilCurrentPage < 1) hasilCurrentPage = 1;

    startIdx = (hasilCurrentPage - 1) * pageSizeNum;
    endIdx = Math.min(startIdx + pageSizeNum, totalItems);
    pagedItems = sortedList.slice(startIdx, endIdx);
  } else {
    hasilCurrentPage = 1;
  }

  if (infoEl) {
    infoEl.innerText = `Menampilkan ${startIdx + 1} - ${endIdx} dari total ${totalItems} nilai`;
  }
  if (navEl) {
    renderPaginationNav(navEl, hasilCurrentPage, totalPages, 'goToHasilPage');
  }

  let currentGroup = null;
  const rows = [];

  pagedItems.forEach(h => {
    const p = h.peserta || { username: '-', nama_lengkap: 'Akun Terhapus', kelas: '-', jurusan: '-' };
    const pMapel = h.nama_mapel || 'Umum';
    const pJurusan = (p.jurusan || 'Tanpa Jurusan').toUpperCase();
    const pKelas = (p.kelas || 'Tanpa Kelas').toUpperCase();
    const groupKey = `${pMapel} - ${pJurusan} - ${pKelas}`;

    // Group Header Row
    if (currentGroup !== groupKey) {
      rows.push(`
        <tr class="table-light">
          <td colspan="9" class="fw-bold text-success py-2" style="background-color: #f8f9fa;">
            <i class="bi bi-book-half me-2 text-primary"></i>MAPEL: <span class="text-primary">${escapeHtml(pMapel)}</span>
            <span class="mx-2 text-muted">|</span>
            <i class="bi bi-collection-fill me-1"></i>JURUSAN: ${escapeHtml(pJurusan)}
            <span class="mx-2 text-muted">|</span>
            KELAS: ${escapeHtml(pKelas)}
          </td>
        </tr>
      `);
      currentGroup = groupKey;
    }

    rows.push(`
      <tr>
        <td class="font-monospace text-primary"><strong>${escapeHtml(p.username)}</strong></td>
        <td class="cell-wrap fw-semibold">${escapeHtml(p.nama_lengkap)}</td>
        <td class="cell-wrap"><span class="badge bg-primary-subtle text-primary border border-primary-subtle">${escapeHtml(pMapel)}</span></td>
        <td><span class="badge bg-light text-dark border">${escapeHtml(p.kelas || '-')}</span></td>
        <td class="cell-wrap">${escapeHtml(p.jurusan || '-')}</td>
        <td class="text-center text-success fw-bold">${h.jumlah_benar}</td>
        <td class="text-center text-danger">${h.jumlah_salah}</td>
        <td class="text-center fw-bold" style="font-size: 1.1rem; color: var(--primary-dark);">${(parseFloat(h.nilai) || 0).toFixed(1)}</td>
        <td class="text-center">
          ${isGuruMode() ? `
            <span class="badge bg-success-subtle text-success border border-success-subtle px-2 py-1"><i class="bi bi-check-circle-fill me-1"></i>Selesai</span>
          ` : `
            <button class="btn btn-outline-danger btn-sm rounded-pill px-3" onclick="resetUjianPeserta('${escapeAttr(h.id)}', '${escapeAttr(p.id)}', '${escapeAttr(p.nama_lengkap)}')">
              <i class="bi bi-arrow-counterclockwise"></i> Reset Ujian
            </button>
          `}
        </td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join('');
}

function getFilteredHasilList() {
  const q = (document.getElementById('search-nilai')?.value || '').toLowerCase().trim();
  const mapel = (document.getElementById('filter-mapel-hasil')?.value || '').toLowerCase().trim();
  const jurusan = (document.getElementById('filter-jurusan-hasil')?.value || '').toUpperCase().trim();
  const kelas = (document.getElementById('filter-kelas-hasil')?.value || '').toUpperCase().trim();

  return (allHasil || []).filter(h => {
    const p = h.peserta || { username: '', nama_lengkap: '', jurusan: '', kelas: '' };
    const matchesSearch = !q ||
                          (p.nama_lengkap || '').toLowerCase().includes(q) || 
                          (p.username || '').toLowerCase().includes(q);
                          
    const hMapel = (h.nama_mapel || '').toLowerCase().trim();
    const matchesMapel = !mapel || hMapel === mapel;

    const pJurusan = (p.jurusan || '').toUpperCase().trim();
    const matchesJurusan = !jurusan || pJurusan === jurusan;
    
    const pKelas = (p.kelas || '').toUpperCase().trim();
    const matchesKelas = !kelas || pKelas === kelas;

    return matchesSearch && matchesMapel && matchesJurusan && matchesKelas;
  });
}

function filterHasilList() {
  const filtered = getFilteredHasilList();
  renderHasilTable(filtered, false);
}

async function resetUjianPeserta(hasilId, pesertaId, name) {
  const confirmResult = await Swal.fire({
    title: 'Reset Ujian Peserta?',
    text: `Anda akan menghapus hasil ujian dan semua jawaban dari "${name}". Tindakan ini memungkinkan peserta untuk mengulang ujian dari awal.`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Reset Ujian',
    cancelButtonText: 'Batal'
  });

  if (confirmResult.isConfirmed) {
    Swal.fire({
      title: 'Mereset status ujian...',
      allowOutsideClick: false,
      didOpen: () => { Swal.showLoading(); }
    });

    try {
      const hTarget = allHasil.find(item => item.id === hasilId);
      await DB.resetHasilUjian(hasilId, pesertaId, hTarget ? hTarget._shardId : null);
      Swal.fire('Ujian Direset!', `Status ujian "${name}" berhasil direset.`, 'success');
      await refreshAllData();
    } catch (err) {
      Swal.fire('Reset Gagal', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

function exportHasilUjian() {
  const exportTarget = getFilteredHasilList();

  if (exportTarget.length === 0) {
    Swal.fire('Ekspor Kosong', 'Tidak ada data nilai ujian yang cocok dengan filter untuk diekspor.', 'warning');
    return;
  }

  const exportList = exportTarget.map(h => {
    const p = h.peserta || { username: '', nama_lengkap: '', kelas: '', jurusan: '' };
    return {
      nama_mapel: h.nama_mapel || 'Umum',
      username: p.username,
      nama_lengkap: p.nama_lengkap,
      kelas: p.kelas,
      jurusan: p.jurusan,
      jumlah_benar: h.jumlah_benar,
      jumlah_salah: h.jumlah_salah,
      nilai: parseFloat(h.nilai),
      waktu_selesai: h.waktu_selesai
    };
  });

  const map = {
    nama_mapel: 'Mata Pelajaran (Mapel)',
    username: 'Username / No. Peserta',
    nama_lengkap: 'Nama Lengkap',
    kelas: 'Kelas',
    jurusan: 'Jurusan',
    jumlah_benar: 'Jumlah Benar',
    jumlah_salah: 'Jumlah Salah',
    nilai: 'Nilai Akhir',
    waktu_selesai: 'Selesai Pada'
  };

  const selMapel = (document.getElementById('filter-mapel-hasil')?.value || '').trim();
  const selKelas = (document.getElementById('filter-kelas-hasil')?.value || '').trim();
  const selJurusan = (document.getElementById('filter-jurusan-hasil')?.value || '').trim();

  let fileSuffix = '';
  if (selMapel) fileSuffix += `_${selMapel.replace(/[^a-zA-Z0-9]/g, '_')}`;
  if (selJurusan) fileSuffix += `_${selJurusan.replace(/[^a-zA-Z0-9]/g, '_')}`;
  if (selKelas) fileSuffix += `_${selKelas.replace(/[^a-zA-Z0-9]/g, '_')}`;
  if (!fileSuffix) fileSuffix = '_Semua_Mapel';

  const fileName = `Rekap_Nilai_CBT${fileSuffix}`;
  ExcelHelpers.exportJSONToExcel(exportList, map, fileName, "Rekap Nilai");
}

// -------------------------------------------------------------
// EXCEL IMPORT WORKFLOWS
// -------------------------------------------------------------

function openImportModal(mode) {
  importMode = mode;
  importedDataCache = [];
  document.getElementById('excel-file-input').value = "";
  document.getElementById('excel-preview-area').classList.add('d-none');
  document.getElementById('btn-save-import').disabled = true;

  const btnTemplate = document.getElementById('btn-download-template');
  const title = document.getElementById('importModalTitle');

  if (mode === 'peserta') {
    title.innerText = "Import Data Peserta dari Excel";
    btnTemplate.setAttribute('onclick', 'ExcelTemplates.downloadPesertaTemplate()');
  } else {
    title.innerText = "Import Bank Soal dari Excel";
    btnTemplate.setAttribute('onclick', 'ExcelTemplates.downloadSoalTemplate()');
  }

  importModalInstance.show();
}

async function handleExcelUpload(input) {
  if (input.files.length === 0) return;

  const file = input.files[0];
  
  Swal.fire({
    title: 'Membaca Excel...',
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  try {
    if (importMode === 'peserta') {
      importedDataCache = await ExcelHelpers.parsePesertaExcel(file);
      renderImportPreviewPeserta(importedDataCache);
    } else {
      importedDataCache = await ExcelHelpers.parseSoalExcel(file);
      renderImportPreviewSoal(importedDataCache);
    }
    
    document.getElementById('excel-preview-count').innerText = importedDataCache.length;
    document.getElementById('excel-preview-area').classList.remove('d-none');
    document.getElementById('btn-save-import').disabled = false;
    Swal.close();
  } catch (err) {
    Swal.fire('Gagal Membaca File', err.message || 'Pastikan file Excel Anda menggunakan template yang disediakan.', 'error');
    document.getElementById('excel-preview-area').classList.add('d-none');
    document.getElementById('btn-save-import').disabled = true;
  }
}

function renderImportPreviewPeserta(data) {
  const table = document.getElementById('excel-preview-table');
  
  let html = `
    <thead>
      <tr>
        <th>Username</th>
        <th>Nama Lengkap</th>
        <th>Jurusan</th>
        <th>Kelas</th>
        <th>Ruang</th>
        <th>Sesi</th>
        <th>Password</th>
      </tr>
    </thead>
    <tbody>
  `;

  data.slice(0, 10).forEach(r => {
    html += `
      <tr>
        <td>${r.username}</td>
        <td>${r.nama_lengkap}</td>
        <td>${r.jurusan}</td>
        <td>${r.kelas}</td>
        <td>${r.ruang}</td>
        <td>${r.sesi}</td>
        <td><code>${r.password}</code></td>
      </tr>
    `;
  });

  if (data.length > 10) {
    html += `<tr><td colspan="7" class="text-center text-muted">...dan ${data.length - 10} data lainnya...</td></tr>`;
  }

  html += '</tbody>';
  table.innerHTML = html;
}

function renderImportPreviewSoal(data) {
  const table = document.getElementById('excel-preview-table');
  
  let html = `
    <thead>
      <tr>
        <th>No</th>
        <th>Pertanyaan</th>
        <th>Opsi A</th>
        <th>Opsi B</th>
        <th>Opsi C</th>
        <th>Opsi D</th>
        <th>Opsi E</th>
        <th>Jawaban</th>
        <th>Bobot</th>
      </tr>
    </thead>
    <tbody>
  `;

  data.slice(0, 10).forEach(r => {
    html += `
      <tr>
        <td>${r.nomor}</td>
        <td class="text-truncate" style="max-width: 150px;">${r.pertanyaan}</td>
        <td>${r.opsi_a}</td>
        <td>${r.opsi_b}</td>
        <td>${r.opsi_c || '-'}</td>
        <td>${r.opsi_d || '-'}</td>
        <td>${r.opsi_e || '-'}</td>
        <td class="text-center font-heading fw-bold">${r.jawaban_benar}</td>
        <td class="text-center">${r.bobot}</td>
      </tr>
    `;
  });

  if (data.length > 10) {
    html += `<tr><td colspan="9" class="text-center text-muted">...dan ${data.length - 10} data lainnya...</td></tr>`;
  }

  html += '</tbody>';
  table.innerHTML = html;
}

async function saveImportedData() {
  if (importedDataCache.length === 0) return;

  const btn = document.getElementById('btn-save-import');
  btn.disabled = true;

  Swal.fire({
    title: 'Menyimpan Data...',
    html: `Memulai import data...`,
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  try {
    if (importMode === 'peserta') {
      let success = 0;
      let fails = 0;
      const failedDetails = [];

      for (let i = 0; i < importedDataCache.length; i++) {
        const item = importedDataCache[i];
        Swal.update({
          html: `Mengimpor baris ${i + 1} dari ${importedDataCache.length}...<br>Berhasil: <strong>${success}</strong>, Gagal: <strong>${fails}</strong>`
        });

        try {
          await DB.registerPeserta(
            item.username,
            item.password,
            item.nama_lengkap,
            item.jurusan,
            item.kelas,
            item.ruang,
            item.sesi
          );
          success++;
        } catch (err) {
          console.error("Gagal mengimpor peserta:", item.username, err);
          fails++;
          if (failedDetails.length < 15) {
            failedDetails.push(`<li><code>${escapeHtml(item.username)}</code> (${escapeHtml(item.nama_lengkap)}): ${escapeHtml(err.message || 'Gagal disimpan')}</li>`);
          }
        }
      }

      let resultHtml = `Proses import peserta selesai.<br>Berhasil: <strong>${success}</strong>, Gagal: <strong>${fails}</strong>`;
      if (failedDetails.length > 0) {
        resultHtml += `<div class="text-start small mt-3 p-2 bg-light border rounded" style="max-height:160px;overflow-y:auto;"><strong>Daftar baris yang gagal:</strong><ul class="mb-0 ps-3 mt-1">${failedDetails.join('')}</ul></div>`;
      }

      Swal.fire({
        title: 'Import Selesai',
        html: resultHtml,
        icon: fails === 0 ? 'success' : 'warning'
      });
      await loadPeserta();
      await refreshJurusanDanKelas();
    } else {
      if (!activePaketId) {
        Swal.fire('Pilih Paket', 'Silakan pilih atau buat paket soal terlebih dahulu sebelum import.', 'warning');
        return;
      }
      
      const payloadSoal = importedDataCache.map(s => ({
        ...s,
        paket_soal_id: activePaketId
      }));

      await DB.bulkInsertSoal(payloadSoal);
      Swal.fire('Import Berhasil', `${importedDataCache.length} Soal baru berhasil disimpan ke bank soal.`, 'success');
      await loadSoal();
    }

    importModalInstance.hide();
    await loadDashboardStats();
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------
// BACKUP & RESTORE UTILITIES
// -------------------------------------------------------------

async function backupDatabaseData() {
  Swal.fire({
    title: 'Mempersiapkan Backup...',
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  try {
    const peserta = await DB.getPesertaList();
    const paket = await DB.getPaketList();
    const soal = await DB.getSoalList();
    const hasil = await DB.getHasilList();
    const settings = await DB.getSettings();
    const kelas = await DB.getKelasList();

    const backupObj = {
      version: "1.2",
      timestamp: new Date().toISOString(),
      school: "SMK Negeri 1 Lempuing",
      data: {
        peserta: peserta || [],
        paket_soal: paket || [],
        jurusan: allJurusan || [],
        kelas: kelas || [],
        soal: soal || [],
        hasil_ujian: hasil || [],
        pengaturan_ujian: settings ? [settings] : []
      }
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupObj, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    
    const formattedDate = new Date().toISOString().slice(0,10);
    dlAnchorElem.setAttribute("download", `Backup_CBT_SMKN1Lempuing_${formattedDate}.json`);
    dlAnchorElem.click();

    Swal.fire('Cadangan Berhasil', 'Berkas backup database JSON berhasil diunduh.', 'success');
  } catch (err) {
    Swal.fire('Gagal Backup', err.message || 'Terjadi kesalahan.', 'error');
  }
}

function triggerRestoreUpload() {
  document.getElementById('restore-file-input').click();
}

async function restoreDatabaseData(input) {
  if (input.files.length === 0) return;
  const file = input.files[0];

  const confirmRes = await Swal.fire({
    title: 'Pulihkan Data?',
    text: 'Tindakan ini akan menimpa data bank soal saat ini. Apakah Anda yakin ingin memulihkan data?',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ffc107',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Timpa & Pulihkan',
    cancelButtonText: 'Batal'
  });

  if (!confirmRes.isConfirmed) {
    input.value = "";
    return;
  }

  Swal.fire({
    title: 'Membaca Berkas Cadangan...',
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backupObj = JSON.parse(e.target.result);
      if (!backupObj.data || !backupObj.data.soal) {
        throw new Error("Format berkas backup JSON tidak valid.");
      }

      Swal.update({ title: 'Memulihkan data bank soal...' });

      // Clean old questions & load restore (Local / Supabase / PHP-MySQL)
      await DB.restoreBackup(backupObj.data);

      Swal.fire('Pemulihan Selesai', 'Data bank soal dan konfigurasi ujian berhasil dipulihkan.', 'success');
      await refreshAllData();
    } catch (err) {
      Swal.fire('Gagal Restorasi', err.message || 'Terjadi kesalahan saat parsing JSON.', 'error');
    } finally {
      input.value = "";
    }
  };
  reader.readAsText(file);
}

// -------------------------------------------------------------
// AI QUESTION GENERATOR (GOOGLE GEMINI AI)
// -------------------------------------------------------------

function togglePasswordVisibility(fieldId) {
  const input = document.getElementById(fieldId);
  const eye = document.getElementById(`${fieldId}-eye`);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (eye) eye.classList.replace('bi-eye', 'bi-eye-slash');
  } else {
    input.type = 'password';
    if (eye) eye.classList.replace('bi-eye-slash', 'bi-eye');
  }
}

function openAiGeneratorModal() {
  if (!activePaketId) {
    Swal.fire('Pilih Paket Soal', 'Silakan pilih atau buat paket soal terlebih dahulu di panel sebelah kiri.', 'warning');
    return;
  }
  const savedKey = localStorage.getItem('CBT_GEMINI_API_KEY') || '';
  const keyInput = document.getElementById('ai-api-key');
  if (keyInput) {
    keyInput.value = savedKey;
  }
  const p = allPaket.find(item => item.id === activePaketId);
  if (p && p.nama_paket) {
    const topikInput = document.getElementById('ai-topik-input');
    if (topikInput && !topikInput.value) {
      topikInput.value = p.nama_paket;
    }
  }
  if (!aiGeneratorModalInstance) {
    const el = document.getElementById('aiGeneratorModal');
    if (el) aiGeneratorModalInstance = new bootstrap.Modal(el);
  }
  if (aiGeneratorModalInstance) aiGeneratorModalInstance.show();
}

async function handleGenerateSoalAI() {
  const customKey = (document.getElementById('ai-api-key')?.value || '').trim();
  const savedKey = localStorage.getItem('CBT_GEMINI_API_KEY') || '';
  // Default system key (sekolah) terpasang otomatis: guru tidak perlu repot isi API key
  let defaultSystemKey = '';
  try {
    defaultSystemKey = atob("QVEuQWI4Uk42TFNHVEp2WEl0UDFEVmVIM2ZsRGFwZWNKSE9qRnBKaEJvQkJ2RFBwQ2hNMkE=");
  } catch (e) {}

  const apiKey = customKey || savedKey || defaultSystemKey;
  const customModel = document.getElementById('ai-model-select')?.value || 'gemini-3.5-flash';
  const modelCandidates = [customModel, 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-flash-lite-latest'].filter((v, i, a) => v && a.indexOf(v) === i);
  const topik = (document.getElementById('ai-topik-input')?.value || '').trim();
  const kesulitan = document.getElementById('ai-kesulitan-select')?.value || 'Campuran';
  const jumlah = parseInt(document.getElementById('ai-jumlah-select')?.value || '10');
  const materi = (document.getElementById('ai-materi-textarea')?.value || '').trim();

  if (!apiKey) {
    Swal.fire('API Key Diperlukan', 'Kunci AI sistem belum aktif. Silakan masukkan Google Gemini API Key.', 'warning');
    return;
  }
  if (!topik) {
    Swal.fire('Topik Masih Kosong', 'Silakan masukkan topik materi ujian yang ingin dibuatkan soal.', 'warning');
    return;
  }

  // Jika pengguna memasukkan kunci kustom, simpan di localStorage
  if (customKey) {
    localStorage.setItem('CBT_GEMINI_API_KEY', customKey);
  }

  const btn = document.getElementById('btn-generate-ai');
  const origBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>AI Sedang Menulis Soal...`;

  const promptText = `Anda adalah seorang guru SMK profesional dan pembuat soal ujian pilihan ganda berstandar nasional tingkat SLTA (SMA/SMK).
Tugas Anda adalah membuat tepat ${jumlah} butir soal pilihan ganda baru yang berkualitas tinggi, edukatif, dan relevan.

Panduan Pembuatan Soal:
1. Topik/Mata Pelajaran: "${topik}"
2. Tingkat Pendidikan: SLTA / SMA / SMK
3. Tingkat Kesulitan: ${kesulitan}
${materi ? `4. Gunakan materi/referensi berikut sebagai acuan utama:\n"""\n${materi}\n"""\n` : ''}
5. Setiap butir soal WAJIB memiliki 5 pilihan jawaban (Standar Tingkat SLTA sampai Opsi E):
   - opsi_a: Pilihan jawaban A
   - opsi_b: Pilihan jawaban B
   - opsi_c: Pilihan jawaban C
   - opsi_d: Pilihan jawaban D
   - opsi_e: Pilihan jawaban E
6. Pilihan jawaban harus masuk akal, logis, tidak ambigu, dan mendidik.
7. Tentukan kunci jawaban_benar secara akurat (pilih salah satu huruf: "A", "B", "C", "D", atau "E").
8. Bobot setiap butir soal bernilai 1.

PENTING:
Keluarkan output HANYA berupa JSON Array murni tanpa format markdown seperti \`\`\`json.
Setiap elemen array harus berupa objek JSON dengan struktur kunci berikut:
[
  {
    "pertanyaan": "Teks pertanyaan soal secara jelas dan lengkap...",
    "opsi_a": "Jawaban opsi A",
    "opsi_b": "Jawaban opsi B",
    "opsi_c": "Jawaban opsi C",
    "opsi_d": "Jawaban opsi D",
    "opsi_e": "Jawaban opsi E",
    "jawaban_benar": "A",
    "bobot": 1
  }
]`;

  try {
    let candidateText = null;
    let lastError = null;

    for (const curModel of modelCandidates) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${curModel}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: promptText }]
            }],
            generationConfig: {
              temperature: 0.7,
              responseMimeType: "application/json"
            }
          })
        });

        if (!response.ok) {
          const errJson = await response.json().catch(() => ({}));
          const errMsg = (errJson && errJson.error && errJson.error.message) || `HTTP error ${response.status}`;
          lastError = new Error(errMsg);
          console.warn(`[CBT AI] Model ${curModel} belum berhasil: ${errMsg}. Mencoba model alternatif...`);
          continue;
        }

        const resData = await response.json();
        candidateText = resData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          console.info(`[CBT AI] Sukses membuat soal dengan model: ${curModel}`);
          break;
        }
      } catch (callErr) {
        lastError = callErr;
        console.warn(`[CBT AI] Request error pada ${curModel}:`, callErr.message);
      }
    }

    if (!candidateText) {
      throw lastError || new Error("Respon dari Gemini AI kosong. Silakan coba lagi.");
    }

    let parsedQuestions = null;
    try {
      let cleanJson = candidateText.trim();
      if (cleanJson.startsWith('```json')) cleanJson = cleanJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      else if (cleanJson.startsWith('```')) cleanJson = cleanJson.replace(/^```\s*/, '').replace(/\s*```$/, '');
      parsedQuestions = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error("Gagal parse response JSON AI:", candidateText);
      throw new Error("Format JSON yang dikembalikan AI tidak valid. Silakan coba lagi.");
    }

    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
      throw new Error("AI tidak menghasilkan butir soal yang valid.");
    }

    aiGeneratedQuestions = parsedQuestions.map((q, idx) => ({
      selected: true,
      nomor: idx + 1,
      pertanyaan: q.pertanyaan || '',
      opsi_a: q.opsi_a || '',
      opsi_b: q.opsi_b || '',
      opsi_c: q.opsi_c || '',
      opsi_d: q.opsi_d || '',
      opsi_e: q.opsi_e || '',
      jawaban_benar: (q.jawaban_benar || 'A').toUpperCase().trim(),
      bobot: parseInt(q.bobot) || 1
    }));

    renderAiSoalPreview();

    Swal.fire({
      icon: 'success',
      title: 'Berhasil Generate Soal!',
      text: `${aiGeneratedQuestions.length} butir soal SLTA (5 Opsi: A-E) telah berhasil dibuat oleh AI. Silakan tinjau sebelum disimpan.`,
      timer: 2000,
      showConfirmButton: false
    });
  } catch (err) {
    console.error("AI Generation Error:", err);
    Swal.fire('Gagal Membuat Soal', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origBtnHtml;
  }
}

function renderAiSoalPreview() {
  const container = document.getElementById('ai-preview-container');
  const cardsList = document.getElementById('ai-soal-cards-list');
  const countBadge = document.getElementById('ai-preview-count');
  const saveBtn = document.getElementById('btn-save-ai-soal');

  if (!container || !cardsList) return;

  if (aiGeneratedQuestions.length === 0) {
    container.classList.add('d-none');
    if (saveBtn) saveBtn.disabled = true;
    return;
  }

  container.classList.remove('d-none');
  const selectedCount = aiGeneratedQuestions.filter(q => q.selected).length;
  if (countBadge) countBadge.innerText = `${selectedCount} / ${aiGeneratedQuestions.length}`;
  if (saveBtn) {
    saveBtn.disabled = selectedCount === 0;
    saveBtn.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-2"></i>Simpan ${selectedCount} Soal ke Bank Soal`;
  }

  const items = aiGeneratedQuestions.map((q, idx) => {
    const isChecked = q.selected ? 'checked' : '';
    return `
      <div class="card border rounded-3 p-3 ${q.selected ? 'bg-white shadow-sm' : 'bg-light opacity-75'}">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="ai-check-${idx}" ${isChecked} onchange="toggleAiQuestionSelected(${idx}, this.checked)">
            <label class="form-check-label fw-bold" for="ai-check-${idx}">Soal #${idx + 1}</label>
          </div>
          <div>
            <span class="badge bg-success">Kunci: ${escapeHtml(q.jawaban_benar)}</span>
            <button class="btn btn-outline-danger btn-sm py-0 px-2 ms-2" onclick="removeAiQuestion(${idx})" title="Hapus soal ini">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
        <p class="mb-2 fw-semibold text-dark" style="white-space: pre-wrap;">${escapeHtml(q.pertanyaan)}</p>
        <div class="row g-2 small">
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'A' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>A.</strong> ${escapeHtml(q.opsi_a)}
            </div>
          </div>
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'B' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>B.</strong> ${escapeHtml(q.opsi_b)}
            </div>
          </div>
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'C' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>C.</strong> ${escapeHtml(q.opsi_c)}
            </div>
          </div>
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'D' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>D.</strong> ${escapeHtml(q.opsi_d)}
            </div>
          </div>
          ${q.opsi_e ? `
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'E' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>E.</strong> ${escapeHtml(q.opsi_e)}
            </div>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  });
  cardsList.innerHTML = items.join('');
}

function toggleAiQuestionSelected(idx, isSelected) {
  if (aiGeneratedQuestions[idx]) {
    aiGeneratedQuestions[idx].selected = Boolean(isSelected);
    renderAiSoalPreview();
  }
}

function toggleSelectAllAiQuestions(selectAll) {
  aiGeneratedQuestions.forEach(q => { q.selected = Boolean(selectAll); });
  renderAiSoalPreview();
}

function removeAiQuestion(idx) {
  aiGeneratedQuestions.splice(idx, 1);
  renderAiSoalPreview();
}

async function saveAiGeneratedSoalToBank() {
  if (!activePaketId) {
    Swal.fire('Pilih Paket', 'Paket soal aktif tidak ditemukan.', 'warning');
    return;
  }
  const selectedQuestions = aiGeneratedQuestions.filter(q => q.selected);
  if (selectedQuestions.length === 0) {
    Swal.fire('Pilih Soal', 'Pilih minimal 1 butir soal untuk disimpan.', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btn-save-ai-soal');
  saveBtn.disabled = true;

  Swal.fire({
    title: 'Menyimpan ke Bank Soal...',
    text: `Menyimpan ${selectedQuestions.length} butir soal ke semua server database...`,
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  try {
    const currentSoalInPaket = allSoal || [];
    let startNomor = currentSoalInPaket.length > 0
      ? Math.max(...currentSoalInPaket.map(s => parseInt(s.nomor) || 0)) + 1
      : 1;

    const payloadSoal = selectedQuestions.map((q, i) => ({
      paket_soal_id: activePaketId,
      nomor: startNomor + i,
      pertanyaan: q.pertanyaan,
      opsi_a: q.opsi_a,
      opsi_b: q.opsi_b,
      opsi_c: q.opsi_c,
      opsi_d: q.opsi_d,
      opsi_e: q.opsi_e || null,
      jawaban_benar: q.jawaban_benar,
      bobot: q.bobot || 1
    }));

    await DB.bulkInsertSoal(payloadSoal);

    if (aiGeneratorModalInstance) {
      aiGeneratorModalInstance.hide();
    }
    aiGeneratedQuestions = [];

    Swal.fire({
      icon: 'success',
      title: 'Soal Berhasil Disimpan!',
      text: `${payloadSoal.length} butir soal dari AI telah tersimpan ke dalam bank soal dan disinkronkan ke seluruh server.`,
      timer: 2000
    });

    await loadSoal();
    await loadPaket();
  } catch (err) {
    console.error("Gagal simpan soal AI:", err);
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan saat menyimpan soal.', 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

// Bind to window
window.switchTab = switchTab;
window.loadDashboardStats = loadDashboardStats;
window.exportPesertaData = exportPesertaData;
window.exportSoalData = exportSoalData;
window.exportHasilUjian = exportHasilUjian;
window.openPesertaForm = openPesertaForm;
window.openSoalForm = openSoalForm;
window.openPaketForm = openPaketForm;
window.detectPaketAgamaHint = detectPaketAgamaHint;
window.setPaketNamaPreset = setPaketNamaPreset;
window.editPeserta = editPeserta;
window.deletePeserta = deletePeserta;
window.editPaket = editPaket;
window.deletePaket = deletePaket;
window.selectPaket = selectPaket;
window.editSoal = editSoal;
window.deleteSoal = deleteSoal;
window.resetUjianPeserta = resetUjianPeserta;
window.openImportModal = openImportModal;
window.handleExcelUpload = handleExcelUpload;
window.saveImportedData = saveImportedData;
window.backupDatabaseData = backupDatabaseData;
window.triggerRestoreUpload = triggerRestoreUpload;
window.restoreDatabaseData = restoreDatabaseData;
window.filterPesertaList = filterPesertaList;
window.filterPaketList = filterPaketList;
window.openJurusanModal = openJurusanModal;
window.loadJurusan = loadJurusan;
window.deleteJurusan = deleteJurusan;
window.openKelasModal = openKelasModal;
window.loadKelas = loadKelas;
window.deleteKelas = deleteKelas;
window.refreshJurusanDanKelas = refreshJurusanDanKelas;
window.toggleAutoRefresh = toggleAutoRefresh;
window.renderMonitoringKelasCards = renderMonitoringKelasCards;
window.resetMonitoringKelasFilter = resetMonitoringKelasFilter;
window.filterMonitoringByKelas = filterMonitoringByKelas;
window.clearMonitoringClassFilter = clearMonitoringClassFilter;
window.filterMonitoringTable = filterMonitoringTable;
window.onMonitorFilterJurusanChange = onMonitorFilterJurusanChange;
window.resetMonitoringFullFilter = resetMonitoringFullFilter;
window.handleProctorResetSesi = handleProctorResetSesi;
window.openCetakKartuModal = openCetakKartuModal;
window.onCetakFilterJurusanChange = onCetakFilterJurusanChange;
window.populateCetakJurusanAndKelasDropdowns = populateCetakJurusanAndKelasDropdowns;
window.updateCetakPreviewCount = updateCetakPreviewCount;
window.prosesCetakKartu = prosesCetakKartu;
window.cetakKartuSiswa = cetakKartuSiswa;
window.filterSoalList = () => {};
window.filterHasilList = filterHasilList;
window.generateNewToken = generateNewToken;
window.quickRotateTokenPembebas = quickRotateTokenPembebas;
window.openAiGeneratorModal = openAiGeneratorModal;
window.handleGenerateSoalAI = handleGenerateSoalAI;
window.renderAiSoalPreview = renderAiSoalPreview;
window.toggleAiQuestionSelected = toggleAiQuestionSelected;
window.toggleSelectAllAiQuestions = toggleSelectAllAiQuestions;
window.removeAiQuestion = removeAiQuestion;
window.saveAiGeneratedSoalToBank = saveAiGeneratedSoalToBank;
window.changePesertaPageSize = changePesertaPageSize;
window.goToPesertaPage = goToPesertaPage;
window.changeHasilPageSize = changeHasilPageSize;
window.goToHasilPage = goToHasilPage;
window.togglePasswordVisibility = togglePasswordVisibility;
