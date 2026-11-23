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
let penugasanGuruModalInstance = null;
let importWordModalInstance = null;
let wordImportedDataCache = [];
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
  const penugasanGuruEl = document.getElementById('modal-penugasan-guru');
  if (penugasanGuruEl) penugasanGuruModalInstance = new bootstrap.Modal(penugasanGuruEl);
  const wordModalEl = document.getElementById('importWordModal');
  if (wordModalEl) importWordModalInstance = new bootstrap.Modal(wordModalEl);
  initWordDropZone();

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
    checkAndRenderGuruConflictAlert();
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

function getGuruPenugasanList() {
  if (!isGuruMode() || !currentAdminUser) return [];
  const raw = currentAdminUser.penugasan_mapel;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {}
  }
  return [];
}

function getOtherGuruOwnedPaketIds(excludeGuruId = null) {
  const ownedByOthers = new Set();
  const myId = excludeGuruId !== null
    ? String(excludeGuruId)
    : (currentAdminUser && currentAdminUser.id ? String(currentAdminUser.id) : '');
  const myUser = (!excludeGuruId && currentAdminUser && currentAdminUser.username)
    ? String(currentAdminUser.username).toLowerCase()
    : '';

  (allGuru || []).forEach(g => {
    if (!g) return;
    const gId = g.id ? String(g.id) : '';
    const gUser = g.username ? String(g.username).toLowerCase() : '';
    if ((myId && gId === myId) || (myUser && gUser === myUser)) return;

    let pids = [];
    if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
    else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try { pids = JSON.parse(g.paket_ids) || []; } catch (e) {}
    }
    pids.forEach(pid => { if (pid) ownedByOthers.add(String(pid)); });
  });
  return ownedByOthers;
}

function isPaketAllowedForGuru(paket) {
  if (!isGuruMode()) return true;
  if (!paket) return false;

  const pkId = String(paket.id || '');
  const allowedIds = getGuruAllowedPaketIds();

  // 1. ISOLASI KETAT PER AKUN GURU:
  //    Jika guru sudah memiliki daftar paket_ids khusus miliknya, HANYA paket tersebut yang ditampilkan.
  //    Mencegah soal bercampur dengan guru lain yang mengampu mata pelajaran sama (misal sama-sama Bahasa Indonesia).
  if (allowedIds.length > 0) {
    return allowedIds.includes(pkId);
  }

  // 2. Untuk akun lama (belum memiliki paket_ids), tetap TOLAK paket yang sudah dimiliki guru lain
  const otherOwned = getOtherGuruOwnedPaketIds();
  if (otherOwned.has(pkId)) {
    return false;
  }

  // 3. Cek apakah cocok dengan salah satu Penugasan Mapel (Multi-Mapel & Tingkat)
  const penugasanList = getGuruPenugasanList();
  if (penugasanList.length > 0) {
    const pkNama = String(paket.nama_paket || '').toLowerCase().trim();
    const pkJurusan = String(paket.jurusan || '').trim().toUpperCase();
    const pkKelas = String(paket.kelas || '').trim().toUpperCase();

    const matchAny = penugasanList.some(item => {
      const itemMapel = String(item.mapel || '').toLowerCase().trim();
      if (!itemMapel) return false;
      const mapelMatch = pkNama.includes(itemMapel) || itemMapel.includes(pkNama);
      if (!mapelMatch) return false;

      // Cek jurusan
      const itemJurusan = String(item.jurusan || '').trim().toUpperCase();
      if (itemJurusan && itemJurusan !== 'SEMUA') {
        const allowedJurusans = itemJurusan.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowedJurusans.length > 0 && pkJurusan && pkJurusan !== 'SEMUA') {
          const pkJurParts = pkJurusan.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
          const jurOverlap = pkJurParts.some(j => allowedJurusans.includes(j));
          if (!jurOverlap) return false;
        }
      }

      // Cek tingkat/kelas
      const itemTingkat = String(item.tingkat || '').trim().toUpperCase();
      if (itemTingkat && itemTingkat !== 'SEMUA') {
        if (pkKelas && pkKelas !== 'SEMUA') {
          const allowedTingkats = itemTingkat.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
          const kMatch = allowedTingkats.some(tk => {
            if (tk === pkKelas) return true;
            const tVal = tk.startsWith('TINGKAT:') ? tk.replace('TINGKAT:', '').trim() : tk;
            return checkKelasMatch(pkKelas, tVal).match || checkKelasMatch(pkKelas, `Kelas ${tVal}`).match || checkKelasMatch(tk, pkKelas).match;
          });
          if (!kMatch) return false;
        }
      }

      return true;
    });

    if (matchAny) return true;
    // Jika guru sudah punya daftar penugasan atau paket_ids spesifik dan paket ini tidak cocok, tolak
    return false;
  }

  // 3. Fallback jika penugasan_mapel belum dikonfigurasi: gunakan pencocokan nama mapel legacy
  const namaPaket = String(paket.nama_paket || '').toLowerCase().trim();
  if (!namaPaket) return false;
  const keywords = getGuruMapelKeywords();
  const mapelMatch = keywords.some(kw => kw && (namaPaket.includes(kw) || kw.includes(namaPaket)));
  if (!mapelMatch) return false;

  // Jika Guru memiliki batas Jurusan yang diampu, cocokkan dengan jurusan paket soal
  const guruJurusans = getGuruJurusanList();
  if (guruJurusans.length > 0) {
    const pkJurusan = String(paket.jurusan || '').trim().toUpperCase();
    if (pkJurusan && pkJurusan !== 'SEMUA') {
      const pkJurParts = pkJurusan.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const jurOverlap = pkJurParts.some(j => guruJurusans.includes(j));
      if (!jurOverlap) return false;
    }
  }

  // Jika Guru memiliki batas Kelas/Tingkat yang diampu, cocokkan dengan kelas paket soal
  const guruKelas = getGuruKelasList();
  if (guruKelas.length > 0) {
    const pkKelas = String(paket.kelas || '').trim().toUpperCase();
    if (pkKelas && pkKelas !== 'SEMUA') {
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
  }

  return true;
}

function isHasilAllowedForGuru(hasil) {
  if (!isGuruMode()) return true;
  if (!hasil) return false;

  // 1. ISOLASI KETAT: Jika guru sudah memiliki paket_ids khusus miliknya, hanya nilai dari paket tersebut yang tampil
  const allowedIds = getGuruAllowedPaketIds();
  if (allowedIds.length > 0) {
    return Boolean(hasil.paket_soal_id && allowedIds.includes(String(hasil.paket_soal_id)));
  }

  // Tolak nilai yang berasal dari paket milik guru lain
  const otherOwned = getOtherGuruOwnedPaketIds();
  if (hasil.paket_soal_id && otherOwned.has(String(hasil.paket_soal_id))) {
    return false;
  }

  // 2. Cek apakah paket soal hasil ujian cocok dengan penugasan_mapel guru
  const penugasanList = getGuruPenugasanList();
  if (penugasanList.length > 0) {
    const sourcePakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
    const pk = sourcePakets.find(p => String(p.id) === String(hasil.paket_soal_id));
    if (pk && isPaketAllowedForGuru(pk)) {
      return true;
    }
    return false;
  }

  // 3. Fallback jika tidak ada penugasan_mapel & allowedIds
  let mapelOrPaketMatch = false;
  if (hasil.paket_soal_id && Array.isArray(allPaket) && allPaket.some(pk => String(pk.id) === String(hasil.paket_soal_id))) {
    mapelOrPaketMatch = true;
  } else {
    const namaMapel = String(hasil.nama_mapel || '').toLowerCase().trim();
    const keywords = getGuruMapelKeywords();
    if (namaMapel && keywords.some(kw => kw && (namaMapel.includes(kw) || kw.includes(namaMapel)))) {
      mapelOrPaketMatch = true;
    }
  }
  if (!mapelOrPaketMatch) return false;

  // Cek kecocokan Jurusan Peserta
  const guruJurusans = getGuruJurusanList();
  if (guruJurusans.length > 0) {
    const studentJurusan = String((hasil.peserta && hasil.peserta.jurusan) || '').trim().toUpperCase();
    if (studentJurusan && !guruJurusans.includes(studentJurusan)) {
      return false;
    }
  }

  // Cek kecocokan Kelas / Tingkat Peserta
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

  // Summary ringkas untuk badge
  const jurList = (currentAdminUser.jurusan_diampu || '').split(',').map(s => s.trim()).filter(Boolean);
  const jurSummary = jurList.length === 0 ? 'Semua Jurusan' : (jurList.length <= 2 ? jurList.join(', ') : `${jurList.length} Jurusan`);

  const kList = (currentAdminUser.kelas_diampu || '').split(',').map(s => s.trim()).filter(Boolean);
  let kSummary = 'Semua Kelas';
  if (kList.length === 1) {
    kSummary = kList[0].toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${kList[0].split(':')[1]}` : kList[0];
  } else if (kList.length > 1) {
    const firstT = kList[0].split(/[\s\-_]+/)[0].toUpperCase();
    if (kList.every(k => k.split(/[\s\-_]+/)[0].toUpperCase() === firstT) && ['X', 'XI', 'XII', '10', '11', '12'].includes(firstT)) {
      kSummary = `Tingkat ${firstT} (${kList.length} Kelas)`;
    } else {
      kSummary = `${kList.length} Kelas`;
    }
  }

  const displayEl = document.getElementById('admin-display-name');
  if (displayEl) displayEl.innerText = guruName;

  const subEl = document.getElementById('admin-role-subtitle');
  if (subEl) subEl.innerText = 'Guru Mata Pelajaran';

  // 1. Top Navbar: tampilkan nama guru dan badge mapel ringkas (hover untuk detail lengkap)
  const topEmailEl = document.getElementById('admin-email');
  if (topEmailEl) {
    topEmailEl.innerHTML = `
      <i class="bi bi-person-workspace me-1"></i>${escapeHtml(guruName)}
      <span class="badge bg-success ms-1 px-2 py-1 shadow-sm" style="font-size: 0.75rem;" title="Mengampu: ${escapeAttr(fullScopeLabel)}" data-bs-toggle="tooltip">
        <i class="bi bi-book me-1"></i>${escapeHtml(guruMapel)}
      </span>
    `;
  }

  // 2. Sidebar: badge 2 tingkat yang proporsional dan tidak berantakan
  const badgeWrap = document.getElementById('guru-mapel-badge-sidebar');
  if (badgeWrap) {
    badgeWrap.classList.remove('d-none');
    badgeWrap.innerHTML = `
      <div class="d-flex flex-column align-items-center gap-1 w-100 px-1 mt-1">
        <span class="badge bg-success text-white w-100 text-truncate shadow-sm py-1" style="font-size: 0.78rem;" title="Mata Pelajaran: ${escapeAttr(guruMapel)}">
          <i class="bi bi-book-half me-1"></i>${escapeHtml(guruMapel)}
        </span>
        <span class="badge bg-secondary-subtle text-dark border w-100 text-truncate py-1" style="font-size: 0.68rem;" title="${escapeAttr(fullScopeLabel)}">
          <i class="bi bi-people me-1 text-primary"></i>${escapeHtml(kSummary)} • ${escapeHtml(jurSummary)}
        </span>
      </div>
    `;
  }

  // Sembunyikan menu yang khusus Admin
  ['nav-item-dashboard', 'nav-item-peserta', 'nav-item-guru', 'nav-item-kesiapan', 'nav-item-jurusan', 'nav-item-pengaturan'].forEach(id => {
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

  // Sembunyikan tombol Buat Paket Baru dan Hapus Paket untuk Guru (Wadah paket disiapkan oleh Admin)
  const btnCreatePaket = document.getElementById('btn-create-paket');
  if (btnCreatePaket) btnCreatePaket.classList.add('d-none');
  const btnCleanupBankSoal = document.getElementById('btn-cleanup-bank-soal');
  if (btnCleanupBankSoal) btnCleanupBankSoal.classList.add('d-none');

  // Guru diizinkan menghapus paket soal miliknya sendiri
  const btnDeletePaket = document.getElementById('btn-delete-paket');
  if (btnDeletePaket) btnDeletePaket.classList.remove('d-none');

  const groupToolbar = document.getElementById('paket-guru-group-toolbar');
  if (groupToolbar) groupToolbar.classList.add('d-none');

  const searchPaketInput = document.getElementById('filter-search-paket');
  if (searchPaketInput) searchPaketInput.placeholder = 'Cari nama mapel / paket...';

  const emptyHelp = document.getElementById('paket-empty-help');
  if (emptyHelp) emptyHelp.innerText = 'Silakan pilih paket soal di samping kiri untuk mengelola butir soal ujian.';

  // 3. Banner informasi di halaman Soal & Nilai: chip terstruktur rapi
  const bannerSoal = document.getElementById('guru-scope-banner-soal');
  const bannerSoalMapel = document.getElementById('guru-banner-mapel-soal');
  if (bannerSoal && bannerSoalMapel) {
    bannerSoal.classList.remove('d-none');
    bannerSoal.classList.add('d-flex');
    bannerSoalMapel.innerHTML = `
      <span class="fw-bold text-success">${escapeHtml(guruMapel)}</span>
      <span class="badge bg-success-subtle text-success border border-success-subtle ms-2 py-1 px-2" title="${escapeAttr(guruKelas)}"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(kSummary)}</span>
      <span class="badge bg-info-subtle text-dark border border-info-subtle ms-1 py-1 px-2" title="${escapeAttr(guruJurusan)}"><i class="bi bi-diagram-3 me-1"></i>${escapeHtml(jurSummary)}</span>
    `;
  }

  const bannerNilai = document.getElementById('guru-scope-banner-nilai');
  const bannerNilaiMapel = document.getElementById('guru-banner-mapel-nilai');
  if (bannerNilai && bannerNilaiMapel) {
    bannerNilai.classList.remove('d-none');
    bannerNilai.classList.add('d-flex');
    bannerNilaiMapel.innerHTML = `
      <span class="fw-bold text-primary">${escapeHtml(guruMapel)}</span>
      <span class="badge bg-primary-subtle text-primary border border-primary-subtle ms-2 py-1 px-2" title="${escapeAttr(guruKelas)}"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(kSummary)}</span>
      <span class="badge bg-info-subtle text-dark border border-info-subtle ms-1 py-1 px-2" title="${escapeAttr(guruJurusan)}"><i class="bi bi-diagram-3 me-1"></i>${escapeHtml(jurSummary)}</span>
    `;
  }
}

// Refresh all database cache (dioptimasi: 1 batch paralel tanpa duplikasi request)
async function refreshAllData() {
  if (isGuruMode()) {
    try {
      const guruRes = await DB.getGuruList();
      allGuru = Array.isArray(guruRes) ? guruRes : [];
      // Sinkronkan profil & paket_ids terbaru guru yang sedang login dari database
      const freshMe = allGuru.find(g =>
        (currentAdminUser.id && String(g.id) === String(currentAdminUser.id)) ||
        (currentAdminUser.username && String(g.username || '').toLowerCase() === String(currentAdminUser.username).toLowerCase())
      );
      if (freshMe) {
        currentAdminUser = {
          ...currentAdminUser,
          id: freshMe.id || currentAdminUser.id,
          nama_lengkap: freshMe.nama_lengkap || currentAdminUser.nama_lengkap,
          mapel_diampu: freshMe.mapel_diampu ?? currentAdminUser.mapel_diampu,
          jurusan_diampu: freshMe.jurusan_diampu ?? currentAdminUser.jurusan_diampu,
          kelas_diampu: freshMe.kelas_diampu ?? currentAdminUser.kelas_diampu,
          paket_ids: freshMe.paket_ids ?? currentAdminUser.paket_ids,
          penugasan_mapel: freshMe.penugasan_mapel ?? currentAdminUser.penugasan_mapel
        };
        try {
          sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(currentAdminUser));
        } catch (e) {}
      }
    } catch (e) {
      console.warn('Gagal menyegarkan daftar guru:', e);
    }

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
    if (typeof updateKesiapanSidebarBadge === 'function') {
      updateKesiapanSidebarBadge();
    }

    // Ambil pengaturan ujian
    await loadSettings();

    // Sinkronkan katalog master kelas & jurusan ke registri sistem agar daftar-guru.html selalu 100% seragam dengan Admin
    if (!isGuruMode() && typeof DB.syncMasterCatalog === 'function') {
      DB.syncMasterCatalog(getAllAvailableKelasNames(), getAllAvailableJurusanNames()).catch(() => {});
    }
  } catch (err) {
    console.error("Gagal refreshAllData:", err);
  }
}

async function refreshJurusanDanKelas() {
  await Promise.all([loadJurusan(), loadKelas()]);
  if (!isGuruMode() && typeof DB.syncMasterCatalog === 'function') {
    DB.syncMasterCatalog(getAllAvailableKelasNames(), getAllAvailableJurusanNames()).catch(() => {});
  }
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
  const sections = ['dashboard', 'peserta', 'guru', 'kesiapan', 'soal', 'jurusan', 'nilai', 'pengaturan'];
  
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
    } else if (tabId === 'kesiapan' && !isGuruMode()) {
      loadKesiapanMonitoring(false);
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
    const hasActiveDevice = Boolean(p.active_session_token);

    if (hasActiveDevice) {
      statusBadge += ` <span class="badge bg-info-subtle text-info border border-info-subtle" title="Sedang login aktif terkunci di 1 perangkat"><i class="bi bi-phone-fill"></i></span>`;
    }

    const forceFinishBtn = isExamRunning ? `
      <button class="btn btn-outline-danger btn-sm py-0 px-2" title="Paksa Selesaikan Ujian" onclick="paksaSelesaiUjian('${p.id}', '${escapeAttr(p.nama_lengkap)}')">
        <i class="bi bi-stop-circle me-1"></i>Selesai
      </button>
    ` : '';

    const resetLoginBtn = hasActiveDevice ? `
      <button class="btn btn-outline-info btn-sm py-0 px-2" title="Reset Login Perangkat (Izinkan Pindah HP tanpa menghapus jawaban)" onclick="handleProctorResetLogin('${p.id}', '${escapeAttr(p.nama_lengkap)}', '${escapeAttr(p._shard_id || '')}')">
        <i class="bi bi-phone-flip"></i>
      </button>
    ` : '';

    const lockBtn = `
      <button class="btn ${p.is_locked ? 'btn-warning' : 'btn-outline-warning'} btn-sm py-0 px-2" title="${p.is_locked ? 'Buka Kunci Akses Ujian' : 'Kunci / Blokir Akses'}" onclick="togglePesertaLock('${p.id}', ${!p.is_locked})">
        <i class="bi ${p.is_locked ? 'bi-unlock-fill' : 'bi-lock-fill'}"></i>
      </button>
    `;

    const resetBtn = `
      <button class="btn btn-outline-secondary btn-sm py-0 px-2" title="Reset Sesi Ujian (Hapus Jawaban)" onclick="handleProctorResetSesi('${p.id}', '${escapeAttr(p.nama_lengkap)}')">
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
            ${resetLoginBtn}
            ${lockBtn}
            ${resetBtn}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleProctorResetLogin(pesertaId, nama, shardId = '') {
  const result = await Swal.fire({
    title: 'Reset Login Perangkat?',
    html: `Kunci perangkat HP lama atas nama <strong>${escapeHtml(nama)}</strong> akan dilepas agar siswa bisa login di HP baru.<br><br><span class="text-success fw-semibold">Tenang: Semua jawaban yang sudah dikerjakan TIDAK akan terhapus.</span>`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#0d6efd',
    cancelButtonColor: '#6c757d',
    confirmButtonText: '<i class="bi bi-phone-flip me-1"></i> Ya, Izinkan Pindah HP',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    try {
      await DB.resetPesertaLoginSession(pesertaId, shardId || null);
      Swal.fire('Berhasil!', `Kunci login perangkat "${nama}" telah dilepas. Siswa kini dapat masuk dari HP baru dan melanjutkan ujiannya.`, 'success');
      await loadDashboardStats();
    } catch (err) {
      Swal.fire('Gagal Reset Login', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
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

async function bukaSesiMapelBaruModal() {
  const totalCount = (allPeserta || []).length;
  const result = await Swal.fire({
    title: 'Buka Sesi Mapel Berikutnya?',
    html: `
      <div class="text-start">
        <p class="mb-2">Gunakan fitur ini ketika seluruh siswa telah menyelesaikan <strong>Mata Pelajaran Sebelumnya</strong> dan siap melanjutkan ke <strong>Mata Pelajaran Berikutnya</strong>.</p>
        
        <div class="alert alert-success py-2 px-3 mb-3 border-success shadow-sm">
          <div class="d-flex align-items-center mb-1">
            <i class="bi bi-shield-check me-2 fs-5 text-success"></i>
            <strong class="text-success">Nilai Mapel Sebelumnya Tetap 100% AMAN!</strong>
          </div>
          <small class="text-muted d-block">Seluruh skor siswa di menu <em>Hasil Ujian</em> tetap tersimpan utuh dan tidak akan dihapus atau ditimpa.</small>
        </div>

        <div class="bg-light p-3 rounded-3 border mb-3 small">
          <div class="fw-bold text-dark mb-1"><i class="bi bi-arrow-repeat me-1 text-primary"></i> Penyesuaian yang Akan Dijalankan:</div>
          <ul class="mb-0 ps-3 text-secondary">
            <li>Status kehadiran <strong>${totalCount} siswa</strong> dikembalikan ke <strong>"Belum Ujian"</strong>.</li>
            <li>Akumulasi catatan pelanggaran seluruh siswa direset kembali ke <strong>0</strong>.</li>
            <li>Seluruh siswa yang sebelumnya terkunci akan <strong>dibuka kuncinya</strong> sehingga dapat langsung login di mapel baru.</li>
            <li>Dashboard Live Monitoring akan kembali bersih menampilkan progres Mapel Baru.</li>
          </ul>
        </div>
        <p class="small text-danger fw-semibold mb-0"><i class="bi bi-exclamation-triangle-fill me-1"></i>Pastikan seluruh siswa memang telah mengumpulkan jawaban mapel sebelumnya!</p>
      </div>
    `,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#ffc107',
    confirmButtonText: '<span class="text-dark fw-bold"><i class="bi bi-play-circle-fill me-1 text-danger"></i> Ya, Buka Sesi Mapel Baru</span>',
    cancelButtonColor: '#6c757d',
    cancelButtonText: 'Batal',
    reverseButtons: true
  });

  if (result.isConfirmed) {
    Swal.fire({
      title: 'Mempersiapkan Sesi Mapel Baru...',
      html: 'Mereset status kehadiran & membuka kunci seluruh peserta...',
      allowOutsideClick: false,
      didOpen: () => { Swal.showLoading(); }
    });

    try {
      await DB.bukaSesiMapelBaru();
      await loadDashboardStats(true);
      await loadPeserta();

      Swal.fire({
        icon: 'success',
        title: 'Sesi Mapel Baru Siap!',
        html: `
          <div class="text-center">
            <p class="mb-2">Status kehadiran seluruh siswa telah diatur kembali ke <strong>"Belum Ujian"</strong> dan catatan pelanggaran telah dibersihkan.</p>
            <p class="small text-muted mb-0">Siswa kini dapat login kembali untuk mengerjakan mata pelajaran berikutnya dengan tertib.</p>
          </div>
        `,
        confirmButtonColor: '#0d6efd',
        confirmButtonText: '<i class="bi bi-check2-circle me-1"></i> Selesai'
      });
    } catch (err) {
      console.error("Gagal buka sesi mapel baru:", err);
      Swal.fire('Gagal Membuka Sesi', err.message || 'Terjadi kesalahan saat membuka sesi mapel baru.', 'error');
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
    if (!isGuruMode() && typeof DB.syncMasterCatalog === 'function') {
      DB.syncMasterCatalog(getAllAvailableKelasNames(), getAllAvailableJurusanNames()).catch(() => {});
    }
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
    if (!isGuruMode() && typeof DB.syncMasterCatalog === 'function') {
      DB.syncMasterCatalog(getAllAvailableKelasNames(), getAllAvailableJurusanNames()).catch(() => {});
    }
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

  const s = studentKelas.toLowerCase().trim();
  const parts = pKelas.toLowerCase().split(',').map(x => x.trim()).filter(Boolean);

  // 1. Cocok persis (cth: "x tkj 1" === "x tkj 1" atau ada dalam daftar rombel)
  if (parts.includes(s)) return { match: true, specificity: 3 };

  // Pengaman Anti-Bocor: Jika suatu tingkat sudah memiliki rombel spesifik di daftar `parts`, abaikan TINGKAT:<g>
  const specificGrades = new Set();
  for (const part of parts) {
    if (part.startsWith("tingkat:") || part.startsWith("tingkat ")) continue;
    if (['x', 'xi', 'xii', '10', '11', '12'].includes(part)) continue;
    const pTokens = part.split(/[\s\-_]+/);
    let g = pTokens[0] || "";
    if (g === "kelas" && pTokens.length > 1) g = pTokens[1];
    if (['x', 'xi', 'xii', '10', '11', '12'].includes(g)) specificGrades.add(g);
  }

  // 2. Cocok per Tingkat / Jenjang Angkatan pada setiap token (cth: "tingkat:x", "tingkat:xi", "tingkat:xii", atau "x", "xi", "xii")
  const sTokens = s.split(/[\s\-_]+/);
  let sTingkat = sTokens[0] || "";
  if (sTingkat === "kelas" && sTokens.length > 1) sTingkat = sTokens[1];

  for (const part of parts) {
    let targetTingkat = "";
    if (part.startsWith("tingkat:")) {
      targetTingkat = part.replace("tingkat:", "").trim();
    } else if (part.startsWith("tingkat ")) {
      targetTingkat = part.replace("tingkat ", "").trim();
    } else if (['x', 'xi', 'xii', '10', '11', '12'].includes(part)) {
      targetTingkat = part;
    }

    if (targetTingkat && specificGrades.has(targetTingkat)) continue;

    if (targetTingkat && sTingkat === targetTingkat) {
      return { match: true, specificity: 2 };
    }
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
      const studentJurusan = normalizeJurAlias(p.jurusan);
      const studentKelas = (p.kelas || "").toLowerCase().trim();

      for (const pk of allPaket) {
        let pkJurusan = (pk.jurusan || "").toLowerCase().trim();
        const jurParts = pkJurusan.split(',').map(x => normalizeJurAlias(x)).filter(Boolean);
        const jurusanMatch = (pkJurusan === "" || pkJurusan === "semua" || jurParts.includes('semua') || jurParts.includes(studentJurusan));
        const kelasResult = checkKelasMatch(pk.kelas, studentKelas);

        if ((jurusanMatch || kelasResult.specificity === 3) && kelasResult.match) {
          let score = 0;
          if ((pkJurusan && pkJurusan !== "semua" && !jurParts.includes('semua') && jurParts.includes(studentJurusan)) || kelasResult.specificity === 3) {
            score += 4;
          }
          score += kelasResult.specificity;
          const soalCount = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
          if (soalCount > 0) score += 100; // utamakan paket yang sudah berisi soal
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

async function exportGuruData() {
  if (!allGuru || allGuru.length === 0) {
    Swal.fire('Ekspor Kosong', 'Tidak ada data guru mata pelajaran untuk diekspor.', 'warning');
    return;
  }

  let sourcePakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  if (sourcePakets.length === 0) {
    try {
      const fetchedPakets = await DB.getPaketList();
      if (Array.isArray(fetchedPakets) && fetchedPakets.length > 0) {
        allPaketUnfiltered = fetchedPakets;
        sourcePakets = fetchedPakets;
      }
    } catch (e) {
      console.warn('Gagal memuat paket saat export guru:', e);
    }
  }
  const paketMap = new Map();
  sourcePakets.forEach(pk => paketMap.set(String(pk.id), pk));

  const formatKelasReadable = (raw) => {
    if (!raw || String(raw).trim().toUpperCase() === 'SEMUA') return 'Semua Kelas';
    return String(raw)
      .split(',')
      .map(s => {
        const clean = s.trim();
        if (!clean) return '';
        return clean.toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${clean.split(':')[1]}` : clean;
      })
      .filter(Boolean)
      .join(', ') || 'Semua Kelas';
  };

  const formatJurusanReadable = (raw) => {
    if (!raw || String(raw).trim().toUpperCase() === 'SEMUA') return 'Semua Jurusan';
    return String(raw).split(',').map(s => s.trim()).filter(Boolean).join(', ') || 'Semua Jurusan';
  };

  // Sheet 1: Rekap Guru (1 baris per guru + progres jumlah paket & total soal)
  const rekapHeaders = [
    'No',
    'Username',
    'Nama Lengkap Guru',
    'Mata Pelajaran Diampu',
    'Tingkat / Kelas Diampu',
    'Jurusan Diampu',
    'Paket Soal Terkait',
    'Jumlah Paket',
    'Total Butir Soal',
    'Status Input Soal'
  ];
  const rekapRows = [rekapHeaders];

  // Sheet 2: Rincian Penugasan Mapel (1 baris per mapel per guru)
  const rincianHeaders = [
    'No',
    'Username',
    'Nama Lengkap Guru',
    'Mata Pelajaran',
    'Tingkat / Kelas',
    'Jurusan'
  ];
  const rincianRows = [rincianHeaders];
  let rincianNo = 1;

  allGuru.forEach((g, idx) => {
    let penugasanList = [];
    if (Array.isArray(g.penugasan_mapel)) {
      penugasanList = g.penugasan_mapel;
    } else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
      try {
        const parsed = JSON.parse(g.penugasan_mapel);
        if (Array.isArray(parsed)) penugasanList = parsed;
      } catch (e) {}
    }

    let paketIds = [];
    if (Array.isArray(g.paket_ids)) {
      paketIds = g.paket_ids;
    } else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try {
        const parsed = JSON.parse(g.paket_ids);
        if (Array.isArray(parsed)) paketIds = parsed;
      } catch (e) {}
    }

    let totalSoalGuru = 0;
    const paketSummaries = [];
    const seenPids = new Set();
    paketIds.forEach(pid => {
      const sId = String(pid).trim();
      if (!sId || seenPids.has(sId)) return;
      seenPids.add(sId);
      const pk = paketMap.get(sId);
      if (pk) {
        const sc = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
        totalSoalGuru += sc;
        const cleanName = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
        paketSummaries.push(`${cleanName} (${sc} Soal)`);
      }
    });

    let mapelSummary = '';
    let kelasSummary = '';
    let jurusanSummary = '';
    if (penugasanList.length > 0) {
      mapelSummary = Array.from(new Set(penugasanList.map(x => (x.mapel || '').trim()).filter(Boolean))).join(', ');
      kelasSummary = Array.from(new Set(penugasanList.map(x => formatKelasReadable(x.tingkat)))).join(' | ');
      jurusanSummary = Array.from(new Set(penugasanList.map(x => formatJurusanReadable(x.jurusan)))).join(' | ');

      penugasanList.forEach(item => {
        rincianRows.push([
          rincianNo++,
          String(g.username || ''),
          String(g.nama_lengkap || ''),
          String(item.mapel || '-'),
          formatKelasReadable(item.tingkat),
          formatJurusanReadable(item.jurusan)
        ]);
      });
    } else {
      mapelSummary = String(g.mapel_diampu || '').trim() || 'Belum diatur';
      kelasSummary = g.mapel_diampu ? formatKelasReadable(g.kelas_diampu) : '-';
      jurusanSummary = g.mapel_diampu ? formatJurusanReadable(g.jurusan_diampu) : '-';

      rincianRows.push([
        rincianNo++,
        String(g.username || ''),
        String(g.nama_lengkap || ''),
        mapelSummary,
        kelasSummary,
        jurusanSummary
      ]);
    }

    let statusSoal = 'Belum Atur Mapel';
    if (paketSummaries.length > 0 || penugasanList.length > 0 || g.mapel_diampu) {
      statusSoal = totalSoalGuru > 0 ? 'Sudah Ada Soal' : 'Masih Kosong (0 Soal)';
    }

    rekapRows.push([
      idx + 1,
      String(g.username || ''),
      String(g.nama_lengkap || ''),
      mapelSummary,
      kelasSummary,
      jurusanSummary,
      paketSummaries.length > 0 ? paketSummaries.join('; ') : '-',
      paketSummaries.length,
      totalSoalGuru,
      statusSoal
    ]);
  });

  const wb = XLSX.utils.book_new();

  const wsRekap = XLSX.utils.aoa_to_sheet(rekapRows);
  wsRekap['!cols'] = [
    { wch: 5 },  // No
    { wch: 18 }, // Username
    { wch: 30 }, // Nama Lengkap Guru
    { wch: 28 }, // Mata Pelajaran
    { wch: 28 }, // Tingkat / Kelas
    { wch: 22 }, // Jurusan
    { wch: 42 }, // Paket Soal Terkait
    { wch: 13 }, // Jumlah Paket
    { wch: 16 }, // Total Butir Soal
    { wch: 22 }  // Status Input Soal
  ];
  // Format kolom Username sebagai Text agar angka 0 di depan tidak terpotong
  for (let r = 2; r <= rekapRows.length; r++) {
    const ref = `B${r}`;
    if (wsRekap[ref]) { wsRekap[ref].t = 's'; wsRekap[ref].z = '@'; }
  }
  XLSX.utils.book_append_sheet(wb, wsRekap, 'Rekap Guru');

  const wsRincian = XLSX.utils.aoa_to_sheet(rincianRows);
  wsRincian['!cols'] = [
    { wch: 5 },  // No
    { wch: 18 }, // Username
    { wch: 30 }, // Nama Lengkap Guru
    { wch: 28 }, // Mata Pelajaran
    { wch: 28 }, // Tingkat / Kelas
    { wch: 22 }  // Jurusan
  ];
  for (let r = 2; r <= rincianRows.length; r++) {
    const ref = `B${r}`;
    if (wsRincian[ref]) { wsRincian[ref].t = 's'; wsRincian[ref].z = '@'; }
  }
  XLSX.utils.book_append_sheet(wb, wsRincian, 'Rincian Mapel');

  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `Data_Guru_Mapel_CBT_${dateStr}.xlsx`);
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
        <td colspan="6" class="text-center py-4 text-muted">
          Belum ada akun guru mata pelajaran. Klik tombol <strong>+ Tambah Akun Guru</strong> di kanan atas untuk membuat akun baru.
        </td>
      </tr>
    `;
    return;
  }

  const paketLookup = new Map();
  (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket).forEach(pk => {
    if (pk && pk.id) paketLookup.set(String(pk.id), pk);
  });

  const conflictSourcePakets = (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket);
  const { conflictsByGuruId, allCollisions } = findAllGuruAssignmentConflicts(allGuru, conflictSourcePakets);
  renderConflictSummaryBanner('admin-guru-conflict-banner', allCollisions);

  const rows = list.map((g, idx) => {
    // Cek apakah akun guru ini terlibat dalam tabrakan kelas
    const myConflicts = conflictsByGuruId.get(String(g.id)) || [];
    let conflictBadgeHtml = '';
    if (myConflicts.length > 0) {
      const cTexts = myConflicts.map(c => `• Mapel <strong>${escapeHtml(c.mapel)}</strong> (${escapeHtml(c.overlapText)}) ganda dg <strong>${escapeHtml(c.otherGuruName)}</strong>`).join('<br>');
      conflictBadgeHtml = `
        <div class="alert alert-danger py-1 px-2 mt-2 mb-0 small rounded-2 border-danger d-inline-flex align-items-start gap-1 shadow-sm" style="font-size: 0.72rem; line-height: 1.35;">
          <i class="bi bi-exclamation-triangle-fill text-danger flex-shrink-0 mt-1"></i>
          <div>
            <strong class="text-danger d-block">Tabrakan Kelas:</strong>
            ${cTexts}
          </div>
        </div>
      `;
    }

    // 1. Tampilkan daftar penugasan mapel (Multi-Mapel & Tingkat)
    let penugasanList = [];
    if (Array.isArray(g.penugasan_mapel)) {
      penugasanList = g.penugasan_mapel;
    } else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
      try {
        const parsed = JSON.parse(g.penugasan_mapel);
        if (Array.isArray(parsed)) penugasanList = parsed;
      } catch (e) {}
    }

    let penugasanHtml = '';
    if (penugasanList.length > 0) {
      penugasanHtml = penugasanList.map(item => {
        const jText = (item.jurusan && item.jurusan.toUpperCase() !== 'SEMUA') ? item.jurusan : 'Semua Jurusan';
        let kText = 'Semua Kelas';
        if (item.tingkat && item.tingkat.toUpperCase() !== 'SEMUA') {
          kText = item.tingkat.split(',').map(k => {
            const clean = k.trim();
            return clean.toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${clean.split(':')[1]}` : clean;
          }).filter(Boolean).join(', ');
        }
        return `
          <div class="d-inline-flex align-items-center gap-1 border rounded px-2 py-1 bg-light me-1 mb-1 shadow-sm" style="font-size: 0.8rem;">
            <i class="bi bi-book text-primary"></i>
            <strong class="text-dark">${escapeHtml(item.mapel)}</strong>
            <span class="badge bg-primary-subtle text-primary border" style="font-size: 0.68rem;" title="${escapeAttr(kText)}">${escapeHtml(kText)}</span>
            <span class="badge bg-info-subtle text-dark border" style="font-size: 0.68rem;" title="${escapeAttr(jText)}">${escapeHtml(jText)}</span>
          </div>
        `;
      }).join('');
    } else if (g.mapel_diampu) {
      const mapels = String(g.mapel_diampu).split(',').map(m => m.trim()).filter(Boolean);
      penugasanHtml = mapels.map(m => `<span class="badge bg-success-subtle text-success border me-1 mb-1">${escapeHtml(m)}</span>`).join('') +
        `<div class="small text-muted mt-1"><span class="badge bg-secondary-subtle text-secondary border me-1">${escapeHtml(g.kelas_diampu || 'Semua Kelas')}</span> <span class="badge bg-secondary-subtle text-secondary border">${escapeHtml(g.jurusan_diampu || 'Semua Jurusan')}</span></div>`;
    } else {
      penugasanHtml = `<span class="badge bg-warning-subtle text-dark border"><i class="bi bi-exclamation-circle me-1"></i>Belum ada mapel diatur</span>`;
    }

    // 2. Tampilkan paket soal terkait
    let rawPaketIds = [];
    if (Array.isArray(g.paket_ids)) {
      rawPaketIds = g.paket_ids;
    } else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try {
        const parsed = JSON.parse(g.paket_ids);
        if (Array.isArray(parsed)) rawPaketIds = parsed;
      } catch (e) {}
    }

    const validPaketIds = [];
    const seenIds = new Set();
    let hasDeadOrDuplicateIds = false;

    rawPaketIds.forEach(pid => {
      const sId = String(pid).trim();
      if (!sId) return;
      if (seenIds.has(sId)) {
        hasDeadOrDuplicateIds = true;
        return;
      }
      seenIds.add(sId);
      if (paketLookup.has(sId)) {
        validPaketIds.push(sId);
      } else {
        hasDeadOrDuplicateIds = true;
      }
    });

    if (hasDeadOrDuplicateIds && g.id) {
      g.paket_ids = validPaketIds;
      DB.saveGuru(g.id, {
        username: g.username,
        nama_lengkap: g.nama_lengkap,
        mapel_diampu: g.mapel_diampu || '',
        jurusan_diampu: g.jurusan_diampu || '',
        kelas_diampu: g.kelas_diampu || '',
        paket_ids: validPaketIds,
        penugasan_mapel: penugasanList
      }).catch(err => console.warn('Self-heal paket_ids admin gagal:', err));
    }

    const paketBadges = validPaketIds.length > 0
      ? validPaketIds.map(pid => {
          const pkObj = paketLookup.get(String(pid));
          if (!pkObj) return '';
          const pName = pkObj.nama_paket || 'Paket Soal';
          return `
            <span class="badge bg-primary-subtle text-primary border border-primary-subtle me-1 mb-1 d-inline-flex align-items-center gap-1" style="font-size: 0.72rem;">
              <i class="bi bi-journal-check"></i>
              <span>${escapeHtml(pName)}</span>
              <button type="button" class="btn-close" style="font-size: 0.48rem; width: 0.5rem; height: 0.5rem;"
                onclick="quickDeleteGuruPaket('${escapeAttr(g.id)}', '${escapeAttr(pid)}', '${escapeAttr(pName)}')"
                title="Hapus paket soal ini"></button>
            </span>
          `;
        }).filter(Boolean).join('')
      : `<span class="text-muted small"><i class="bi bi-magic me-1"></i>Otomatis</span>`;

    return `
      <tr>
        <td>${idx + 1}</td>
        <td class="font-monospace fw-bold text-primary">${escapeHtml(g.username)}</td>
        <td class="fw-semibold">${escapeHtml(g.nama_lengkap)}</td>
        <td>${penugasanHtml}${conflictBadgeHtml}</td>
        <td>${paketBadges}</td>
        <td class="text-center">
          <div class="d-flex align-items-center justify-content-center gap-1 flex-wrap">
            <button class="btn btn-sm btn-success fw-bold py-1 px-2 shadow-sm" onclick="openPenugasanGuruModal('${escapeAttr(g.id)}')" title="Tambah & Atur Mapel Guru Ini">
              <i class="bi bi-plus-circle me-1"></i>+ Tambah Mapel
            </button>
            <button class="btn btn-sm btn-outline-secondary py-1 px-2" onclick="editGuru('${escapeAttr(g.id)}')" title="Edit Akun Guru">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger py-1 px-2" onclick="deleteGuru('${escapeAttr(g.id)}', '${escapeAttr(g.nama_lengkap)}')" title="Hapus Akun">
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
  const addSplit = (raw) => {
    String(raw || '').split(',').map(s => s.trim().toUpperCase()).forEach(n => {
      if (n && n !== 'SEMUA') set.add(n);
    });
  };
  (allJurusan || []).forEach(j => addSplit(j.nama_jurusan || j.nama));
  (allPeserta || []).forEach(p => addSplit(p.jurusan));
  (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket).forEach(pk => addSplit(pk.jurusan));
  if (set.size === 0) {
    ['TKJ', 'AKL', 'TBSM', 'TKRO', 'ATP'].forEach(d => set.add(d));
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function getAllAvailableKelasNames() {
  const set = new Set();
  const addSplit = (raw) => {
    String(raw || '').split(',').map(s => s.trim().toUpperCase()).forEach(n => {
      if (n && n !== 'SEMUA' && !n.startsWith('TINGKAT:')) set.add(n);
    });
  };
  (allKelas || []).forEach(k => addSplit(k.nama_kelas || k.nama));
  (allPeserta || []).forEach(p => addSplit(p.kelas));
  (allPaketUnfiltered.length > 0 ? allPaketUnfiltered : allPaket).forEach(pk => addSplit(pk.kelas));
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
    container.innerHTML = `<div class="text-muted small py-2 text-center">Belum ada paket soal dibuat. Admin dapat membuat paket soal terlebih dahulu di Bank Soal, lalu mencentangnya di sini.</div>`;
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
    const searchKey = `${pk.nama_paket} ${jurusanText} ${kelasText}`.toLowerCase();
    return `
      <div class="form-check mb-1 d-flex align-items-center flex-wrap gap-1 item-guru-paket-row" data-search="${escapeAttr(searchKey)}">
        <input class="form-check-input chk-guru-paket me-1" type="checkbox" value="${escapeAttr(pk.id)}" id="chk-gp-${escapeAttr(pk.id)}" ${checked}>
        <label class="form-check-label small fw-semibold" for="chk-gp-${escapeAttr(pk.id)}">
          ${escapeHtml(pk.nama_paket)}
          <span class="badge bg-info-subtle text-dark border ms-1" style="font-size: 0.7rem;"><i class="bi bi-diagram-3 me-1"></i>${escapeHtml(jurusanText)}</span>
          <span class="badge bg-primary-subtle text-primary border ms-1" style="font-size: 0.7rem;"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(kelasText)}</span>
        </label>
      </div>
    `;
  }).join('');
}

function filterGuruPaketChecklist(query) {
  const q = String(query || '').toLowerCase().trim();
  const rows = document.querySelectorAll('.item-guru-paket-row');
  rows.forEach(r => {
    const text = r.getAttribute('data-search') || '';
    if (!q || text.includes(q)) {
      r.classList.remove('d-none');
    } else {
      r.classList.add('d-none');
    }
  });
}

function toggleAllGuruPakets(check) {
  document.querySelectorAll('.chk-guru-paket').forEach(el => {
    const parentRow = el.closest('.item-guru-paket-row');
    if (!parentRow || !parentRow.classList.contains('d-none')) {
      el.checked = !!check;
    }
  });
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
  document.getElementById('guruFormTitle').innerHTML = `<i class="bi bi-person-plus-fill me-2 text-primary"></i>Buat Akun Guru Baru`;
  document.getElementById('form-guru-crud').reset();
  document.getElementById('guru-id').value = "";
  document.getElementById('crud-guru-pass').required = true;
  const passReq = document.getElementById('crud-guru-pass-required');
  if (passReq) passReq.classList.remove('d-none');
  document.getElementById('crud-guru-pass-help').innerText = "Wajib diisi untuk akun guru baru.";
  if (guruFormModalInstance) guruFormModalInstance.show();
}

function editGuru(id) {
  const g = (allGuru || []).find(item => String(item.id) === String(id));
  if (!g) return;

  document.getElementById('guruFormTitle').innerHTML = `<i class="bi bi-pencil-square me-2 text-primary"></i>Edit Akun Guru`;
  document.getElementById('guru-id').value = g.id;
  document.getElementById('crud-guru-username').value = g.username || '';
  document.getElementById('crud-guru-nama').value = g.nama_lengkap || '';
  document.getElementById('crud-guru-pass').value = '';
  document.getElementById('crud-guru-pass').required = false;
  const passReq = document.getElementById('crud-guru-pass-required');
  if (passReq) passReq.classList.add('d-none');
  document.getElementById('crud-guru-pass-help').innerText = "Biarkan kosong jika tidak ingin mengubah password guru.";

  if (guruFormModalInstance) guruFormModalInstance.show();
}

async function handleGuruCrudSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('guru-id').value;
  const username = document.getElementById('crud-guru-username').value.trim();
  const nama = document.getElementById('crud-guru-nama').value.trim();
  const pass = document.getElementById('crud-guru-pass').value;

  if (!username || !nama) {
    Swal.fire('Data Belum Lengkap', 'Username dan Nama Lengkap guru wajib diisi.', 'warning');
    return;
  }

  const existing = id ? (allGuru || []).find(item => String(item.id) === String(id)) : null;

  const btn = document.getElementById('btn-save-guru-crud');
  btn.disabled = true;

  try {
    const saved = await DB.saveGuru(id, {
      username,
      nama_lengkap: nama,
      mapel_diampu: existing ? (existing.mapel_diampu || '') : '',
      jurusan_diampu: existing ? (existing.jurusan_diampu || '') : '',
      kelas_diampu: existing ? (existing.kelas_diampu || '') : '',
      paket_ids: existing ? (existing.paket_ids || []) : [],
      penugasan_mapel: existing ? (existing.penugasan_mapel || []) : []
    }, pass);

    if (guruFormModalInstance) guruFormModalInstance.hide();
    await loadGuru();

    if (!id && saved && saved.id) {
      const ask = await Swal.fire({
        title: 'Akun Guru Berhasil Dibuat!',
        html: `Akun untuk <strong>${escapeHtml(nama)}</strong> telah aktif.<br><br>Apakah Anda ingin langsung menambahkan mata pelajaran yang diampu guru ini?`,
        icon: 'success',
        showCancelButton: true,
        confirmButtonText: '<i class="bi bi-plus-circle me-1"></i> Ya, Tambah Mapel Sekarang',
        cancelButtonText: 'Nanti Lewat Tabel',
        confirmButtonColor: '#198754',
        cancelButtonColor: '#6c757d'
      });
      if (ask.isConfirmed) {
        openPenugasanGuruModal(saved.id);
      }
    } else {
      Swal.fire('Berhasil Disimpan', `Data akun guru "${nama}" berhasil diperbarui.`, 'success');
    }
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan saat menyimpan akun guru.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteGuru(id, name) {
  const g = (allGuru || []).find(item => String(item.id) === String(id));
  const sourcePakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const paketLookup = new Map(sourcePakets.map(p => [String(p.id), p]));

  // Kumpulkan seluruh paket_ids milik guru ini
  let guruPaketIds = [];
  if (g) {
    if (Array.isArray(g.paket_ids)) guruPaketIds = g.paket_ids.map(String).filter(Boolean);
    else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try {
        const parsed = JSON.parse(g.paket_ids);
        if (Array.isArray(parsed)) guruPaketIds = parsed.map(String).filter(Boolean);
      } catch (e) {}
    }
  }
  guruPaketIds = Array.from(new Set(guruPaketIds));

  // Pastikan hanya paket eksklusif milik guru ini yang ikut dihapus (bukan yang terikat guru lain)
  const otherGuruPaketIds = getOtherGuruOwnedPaketIds(id);
  const ownedPaketIds = guruPaketIds.filter(pid => !otherGuruPaketIds.has(String(pid)));

  let totalSoal = 0;
  const paketLabels = ownedPaketIds.map(pid => {
    const pk = paketLookup.get(String(pid));
    const cnt = pk ? (Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0) : 0;
    totalSoal += cnt;
    const pName = pk ? pk.nama_paket : `Paket (${pid.slice(0, 8)})`;
    return cnt > 0 ? `${pName} (${cnt} soal)` : pName;
  });

  let detailHtml = `<div class="small text-muted mt-2">Akun guru ini belum memiliki paket soal terkait.</div>`;
  if (ownedPaketIds.length > 0) {
    const previewItems = paketLabels.slice(0, 6).map(lbl => `<li>${escapeHtml(lbl)}</li>`).join('');
    const moreItem = paketLabels.length > 6 ? `<li class="text-muted">...dan ${paketLabels.length - 6} paket lainnya</li>` : '';
    const soalNote = totalSoal > 0 ? ` (termasuk <strong>${totalSoal} butir soal</strong>)` : '';
    detailHtml = `
      <div class="alert alert-danger text-start py-2 px-3 small mt-3 mb-0">
        <div class="fw-bold mb-1"><i class="bi bi-exclamation-triangle-fill me-1"></i>${ownedPaketIds.length} Paket Soal Ikut Dihapus Permanen${soalNote}:</div>
        <ul class="mb-0 ps-3">${previewItems}${moreItem}</ul>
      </div>
    `;
  }

  const res = await Swal.fire({
    title: 'Hapus Akun Guru & Paket Soalnya?',
    html: `Anda yakin ingin menghapus akun guru <strong>"${escapeHtml(name)}"</strong>?${detailHtml}`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: ownedPaketIds.length > 0 ? 'Ya, Hapus Akun & Paket Soal' : 'Ya, Hapus Akun',
    cancelButtonText: 'Batal'
  });

  if (res.isConfirmed) {
    try {
      Swal.fire({
        title: 'Menghapus...',
        text: ownedPaketIds.length > 0
          ? `Menghapus akun guru dan ${ownedPaketIds.length} paket soal terkait...`
          : 'Menghapus akun guru...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      // Hapus seluruh paket soal milik guru ini terlebih dahulu (beserta soal-soal di dalamnya)
      let deletedPaketCount = 0;
      for (const pid of ownedPaketIds) {
        try {
          await DB.deletePaket(String(pid));
          deletedPaketCount++;
          if (String(activePaketId) === String(pid)) {
            activePaketId = null;
            const d = document.getElementById('soal-detail-panel');
            const e = document.getElementById('soal-empty-state');
            if (d) d.classList.add('d-none');
            if (e) e.classList.remove('d-none');
          }
        } catch (delErr) {
          console.warn(`Gagal menghapus paket ${pid} milik guru ${name}:`, delErr);
        }
      }

      await DB.deleteGuru(id);

      const doneMsg = deletedPaketCount > 0
        ? `Akun guru "${name}" beserta ${deletedPaketCount} paket soal terkait berhasil dihapus.`
        : `Akun guru "${name}" berhasil dihapus.`;
      Swal.fire('Dihapus!', doneMsg, 'success');
      await loadGuru();
      await loadPaket();
    } catch (err) {
      Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan.', 'error');
    }
  }
}

// -------------------------------------------------------------
// PENUGASAN MAPEL GURU (MULTI-MAPEL, TINGKAT & JURUSAN)
// -------------------------------------------------------------

function openPenugasanGuruModal(id) {
  const g = (allGuru || []).find(item => String(item.id) === String(id));
  if (!g) return;

  document.getElementById('penugasan-guru-id').value = g.id;
  document.getElementById('penugasanGuruTitle').innerHTML = `
    <i class="bi bi-journal-bookmark-fill me-2 text-primary"></i>Atur Mata Pelajaran: <strong>${escapeHtml(g.nama_lengkap || g.username)}</strong>
  `;

  const tbody = document.getElementById('tbody-penugasan-mapel');
  if (tbody) tbody.innerHTML = '';

  let list = [];
  if (Array.isArray(g.penugasan_mapel)) {
    list = g.penugasan_mapel;
  } else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
    try {
      const parsed = JSON.parse(g.penugasan_mapel);
      if (Array.isArray(parsed)) list = parsed;
    } catch (e) {}
  }

  // Jika penugasan_mapel masih kosong tapi punya mapel_diampu legacy, konversi otomatis
  if (list.length === 0 && g.mapel_diampu) {
    const mapels = String(g.mapel_diampu).split(',').map(m => m.trim()).filter(Boolean);
    const jStr = String(g.jurusan_diampu || '').trim();
    const kStr = String(g.kelas_diampu || '').trim();
    mapels.forEach(m => {
      list.push({
        mapel: m,
        tingkat: kStr,
        jurusan: jStr
      });
    });
  }

  if (list.length > 0) {
    list.forEach(item => addPenugasanRow(item));
  } else {
    addPenugasanRow(); // buat 1 baris kosong siap diisi
  }

  updatePenugasanConflictWarning();

  if (penugasanGuruModalInstance) {
    penugasanGuruModalInstance.show();
  }
}

function updatePenugasanKelasLabel(tr) {
  const allChk = tr.querySelector('.chk-kelas-all');
  const checkedItems = Array.from(tr.querySelectorAll('.chk-kelas-item:checked'));
  const labelEl = tr.querySelector('.penugasan-dropdown-kelas .dropdown-label');
  if (!labelEl) return;

  if (allChk && allChk.checked) {
    labelEl.textContent = 'Semua Kelas (Umum)';
    labelEl.className = 'dropdown-label text-truncate text-muted';
    return;
  }

  if (checkedItems.length === 0) {
    if (allChk) allChk.checked = true;
    labelEl.textContent = 'Semua Kelas (Umum)';
    labelEl.className = 'dropdown-label text-truncate text-muted';
    return;
  }

  const labels = checkedItems.map(c => c.dataset.label || c.value);
  if (labels.length <= 2) {
    labelEl.textContent = labels.join(', ');
  } else {
    labelEl.textContent = `${labels.slice(0, 2).join(', ')} (+${labels.length - 2})`;
  }
  labelEl.className = 'dropdown-label text-truncate fw-semibold text-primary';
}

function updatePenugasanJurusanLabel(tr) {
  const allChk = tr.querySelector('.chk-jurusan-all');
  const checkedItems = Array.from(tr.querySelectorAll('.chk-jurusan-item:checked'));
  const labelEl = tr.querySelector('.penugasan-dropdown-jurusan .dropdown-label');
  if (!labelEl) return;

  if (allChk && allChk.checked) {
    labelEl.textContent = 'Semua Jurusan (Umum)';
    labelEl.className = 'dropdown-label text-truncate text-muted';
    return;
  }

  if (checkedItems.length === 0) {
    if (allChk) allChk.checked = true;
    labelEl.textContent = 'Semua Jurusan (Umum)';
    labelEl.className = 'dropdown-label text-truncate text-muted';
    return;
  }

  const labels = checkedItems.map(c => c.dataset.label || c.value);
  if (labels.length <= 2) {
    labelEl.textContent = labels.join(', ');
  } else {
    labelEl.textContent = `${labels.slice(0, 2).join(', ')} (+${labels.length - 2})`;
  }
  labelEl.className = 'dropdown-label text-truncate fw-semibold text-primary';
}

function addPenugasanRow(data = {}) {
  const tbody = document.getElementById('tbody-penugasan-mapel');
  if (!tbody) return;

  const rowId = 'prow_' + Math.random().toString(36).substring(2, 9);
  const currentMapel = data.mapel || '';

  // 1. Parsing Nilai Tingkat/Kelas Terpilih (bisa string koma atau array)
  let selTingkat = [];
  if (Array.isArray(data.tingkat)) {
    selTingkat = data.tingkat.map(s => String(s).trim().toUpperCase()).filter(Boolean);
  } else if (typeof data.tingkat === 'string' && data.tingkat.trim()) {
    selTingkat = data.tingkat.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  selTingkat = selTingkat.filter(s => s !== 'SEMUA');
  const isAllKelas = selTingkat.length === 0;

  // 2. Parsing Nilai Jurusan Terpilih (bisa string koma atau array)
  let selJurusan = [];
  if (Array.isArray(data.jurusan)) {
    selJurusan = data.jurusan.map(s => String(s).trim().toUpperCase()).filter(Boolean);
  } else if (typeof data.jurusan === 'string' && data.jurusan.trim()) {
    selJurusan = data.jurusan.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  selJurusan = selJurusan.filter(s => s !== 'SEMUA');
  const isAllJurusan = selJurusan.length === 0;

  // 3. Bangun Opsi Checkbox Tingkat & Rombel
  const tingkats = [
    { val: 'TINGKAT:X', label: 'Tingkat X (Semua Rombel)' },
    { val: 'TINGKAT:XI', label: 'Tingkat XI (Semua Rombel)' },
    { val: 'TINGKAT:XII', label: 'Tingkat XII (Semua Rombel)' }
  ];
  const allAvailableKelas = getAllAvailableKelasNames();

  const tingkatItemsHtml = tingkats.map((t, idx) => {
    const checked = selTingkat.includes(t.val) ? 'checked' : '';
    return `
      <div class="form-check mb-1">
        <input class="form-check-input chk-kelas-item" type="checkbox" value="${escapeAttr(t.val)}" data-label="Tingkat ${t.val.split(':')[1]}" id="chk-k-${rowId}-${idx}" ${checked}>
        <label class="form-check-label small fw-semibold text-dark" for="chk-k-${rowId}-${idx}">
          ${escapeHtml(t.label)}
        </label>
      </div>
    `;
  }).join('');

  const rombelItemsHtml = allAvailableKelas.map((k, idx) => {
    const checked = selTingkat.includes(k.toUpperCase()) ? 'checked' : '';
    return `
      <div class="form-check mb-1">
        <input class="form-check-input chk-kelas-item" type="checkbox" value="${escapeAttr(k)}" data-label="${escapeAttr(k)}" id="chk-kr-${rowId}-${idx}" ${checked}>
        <label class="form-check-label small text-secondary" for="chk-kr-${rowId}-${idx}">
          Rombel ${escapeHtml(k)}
        </label>
      </div>
    `;
  }).join('');

  // 4. Bangun Opsi Checkbox Jurusan
  const allAvailableJurusan = getAllAvailableJurusanNames();
  const jurusanItemsHtml = allAvailableJurusan.map((j, idx) => {
    const checked = selJurusan.includes(j.toUpperCase()) ? 'checked' : '';
    return `
      <div class="form-check mb-1">
        <input class="form-check-input chk-jurusan-item" type="checkbox" value="${escapeAttr(j)}" data-label="${escapeAttr(j)}" id="chk-j-${rowId}-${idx}" ${checked}>
        <label class="form-check-label small fw-semibold" for="chk-j-${rowId}-${idx}">
          Jurusan ${escapeHtml(j)}
        </label>
      </div>
    `;
  }).join('');

  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.innerHTML = `
    <td>
      <input type="text" class="form-control form-control-sm penugasan-mapel-input" placeholder="Nama mapel (cth: Matematika, Koding)" value="${escapeAttr(currentMapel)}" oninput="updatePenugasanConflictWarning()" required>
    </td>
    <td>
      <div class="dropdown penugasan-dropdown-kelas">
        <button class="btn btn-outline-secondary btn-sm dropdown-toggle w-100 text-start d-flex justify-content-between align-items-center" 
                type="button" 
                id="btn-k-${rowId}" 
                data-bs-toggle="dropdown" 
                data-bs-auto-close="outside" 
                data-bs-display="dynamic"
                aria-expanded="false">
          <span class="dropdown-label text-truncate" style="max-width: 175px;">Semua Kelas (Umum)</span>
        </button>
        <div class="dropdown-menu p-2 shadow penugasan-menu-kelas" aria-labelledby="btn-k-${rowId}" style="max-height: 280px; overflow-y: auto; min-width: 250px; z-index: 1060;">
          <div class="form-check border-bottom pb-1 mb-2">
            <input class="form-check-input chk-kelas-all" type="checkbox" id="chk-kall-${rowId}" ${isAllKelas ? 'checked' : ''}>
            <label class="form-check-label fw-bold text-success small" for="chk-kall-${rowId}">
              <i class="bi bi-check-all me-1"></i>Semua Kelas (Umum)
            </label>
          </div>
          <div class="text-muted fw-bold mb-1" style="font-size: 0.68rem; text-transform: uppercase;">Per Tingkat Angkatan:</div>
          ${tingkatItemsHtml}
          ${rombelItemsHtml ? `
            <div class="text-muted fw-bold mt-2 mb-1 pt-1 border-top" style="font-size: 0.68rem; text-transform: uppercase;">Rombel Spesifik:</div>
            ${rombelItemsHtml}
          ` : ''}
        </div>
      </div>
    </td>
    <td>
      <div class="dropdown penugasan-dropdown-jurusan">
        <button class="btn btn-outline-secondary btn-sm dropdown-toggle w-100 text-start d-flex justify-content-between align-items-center" 
                type="button" 
                id="btn-j-${rowId}" 
                data-bs-toggle="dropdown" 
                data-bs-auto-close="outside" 
                data-bs-display="dynamic"
                aria-expanded="false">
          <span class="dropdown-label text-truncate" style="max-width: 175px;">Semua Jurusan (Umum)</span>
        </button>
        <div class="dropdown-menu p-2 shadow penugasan-menu-jurusan" aria-labelledby="btn-j-${rowId}" style="max-height: 280px; overflow-y: auto; min-width: 220px; z-index: 1060;">
          <div class="form-check border-bottom pb-1 mb-2">
            <input class="form-check-input chk-jurusan-all" type="checkbox" id="chk-jall-${rowId}" ${isAllJurusan ? 'checked' : ''}>
            <label class="form-check-label fw-bold text-primary small" for="chk-jall-${rowId}">
              <i class="bi bi-check-all me-1"></i>Semua Jurusan (Umum)
            </label>
          </div>
          <div class="text-muted fw-bold mb-1" style="font-size: 0.68rem; text-transform: uppercase;">Pilih Jurusan:</div>
          ${jurusanItemsHtml}
        </div>
      </div>
    </td>
    <td class="text-center">
      <button type="button" class="btn btn-outline-danger btn-sm p-1" onclick="this.closest('tr').remove(); updatePenugasanConflictWarning();" title="Hapus baris mapel ini">
        <i class="bi bi-trash"></i>
      </button>
    </td>
  `;

  tbody.appendChild(tr);

  // Pasang event listeners untuk checkbox kelas
  const chkKelasAll = tr.querySelector('.chk-kelas-all');
  const chkKelasItems = tr.querySelectorAll('.chk-kelas-item');
  if (chkKelasAll) {
    chkKelasAll.addEventListener('change', () => {
      if (chkKelasAll.checked) {
        chkKelasItems.forEach(c => { c.checked = false; });
      }
      updatePenugasanKelasLabel(tr);
      updatePenugasanConflictWarning();
    });
  }
  const parseKelasTokenInfo = (val) => {
    const v = String(val || '').trim().toUpperCase();
    if (v.startsWith('TINGKAT:')) return { isTingkat: true, grade: v.replace('TINGKAT:', '').trim() };
    const tok = v.split(/[\s\-_]+/)[0] || '';
    return { isTingkat: false, grade: ['X', 'XI', 'XII', '10', '11', '12'].includes(tok) ? tok : '' };
  };

  chkKelasItems.forEach(c => {
    c.addEventListener('change', () => {
      // Pengaman Centang Ganda: Jika mencentang TINGKAT:X, lepas rombel spesifik X; jika mencentang rombel spesifik X, lepas TINGKAT:X
      if (c.checked) {
        const cur = parseKelasTokenInfo(c.value);
        if (cur.grade) {
          chkKelasItems.forEach(other => {
            if (other === c || !other.checked) return;
            const oInfo = parseKelasTokenInfo(other.value);
            if (oInfo.grade === cur.grade && oInfo.isTingkat !== cur.isTingkat) {
              other.checked = false;
            }
          });
        }
      }
      const anyChecked = Array.from(chkKelasItems).some(x => x.checked);
      if (chkKelasAll) chkKelasAll.checked = !anyChecked;
      updatePenugasanKelasLabel(tr);
      updatePenugasanConflictWarning();
    });
  });

  // Pasang event listeners untuk checkbox jurusan
  const chkJurusanAll = tr.querySelector('.chk-jurusan-all');
  const chkJurusanItems = tr.querySelectorAll('.chk-jurusan-item');
  if (chkJurusanAll) {
    chkJurusanAll.addEventListener('change', () => {
      if (chkJurusanAll.checked) {
        chkJurusanItems.forEach(c => { c.checked = false; });
      }
      updatePenugasanJurusanLabel(tr);
      updatePenugasanConflictWarning();
    });
  }
  chkJurusanItems.forEach(c => {
    c.addEventListener('change', () => {
      const anyChecked = Array.from(chkJurusanItems).some(x => x.checked);
      if (chkJurusanAll) chkJurusanAll.checked = !anyChecked;
      updatePenugasanJurusanLabel(tr);
      updatePenugasanConflictWarning();
    });
  });

  // Set initial labels
  updatePenugasanKelasLabel(tr);
  updatePenugasanJurusanLabel(tr);
}

async function savePenugasanGuru() {
  const guruId = document.getElementById('penugasan-guru-id').value;
  const g = (allGuru || []).find(item => String(item.id) === String(guruId));
  if (!g) return;

  const rows = document.querySelectorAll('#tbody-penugasan-mapel tr');
  const penugasanList = [];
  rows.forEach(tr => {
    const mapel = (tr.querySelector('.penugasan-mapel-input')?.value || '').trim();
    if (!mapel) return;

    // Tingkat / Kelas (otomatis bersihkan TINGKAT:G jika rombel spesifik tingkat G juga tercentang)
    const chkKelasAll = tr.querySelector('.chk-kelas-all');
    let tingkat = '';
    if (!chkKelasAll || !chkKelasAll.checked) {
      let checkedKelas = Array.from(tr.querySelectorAll('.chk-kelas-item:checked')).map(c => c.value);
      const specGrades = new Set(
        checkedKelas
          .filter(v => !String(v).toUpperCase().startsWith('TINGKAT:'))
          .map(v => String(v).trim().toUpperCase().split(/[\s\-_]+/)[0])
          .filter(g => ['X', 'XI', 'XII', '10', '11', '12'].includes(g))
      );
      checkedKelas = checkedKelas.filter(v => {
        const up = String(v).trim().toUpperCase();
        if (up.startsWith('TINGKAT:')) {
          return !specGrades.has(up.replace('TINGKAT:', '').trim());
        }
        return true;
      });
      if (checkedKelas.length > 0) {
        tingkat = checkedKelas.join(', ');
      }
    }

    // Jurusan
    const chkJurusanAll = tr.querySelector('.chk-jurusan-all');
    let jurusan = '';
    if (!chkJurusanAll || !chkJurusanAll.checked) {
      const checkedJurusan = Array.from(tr.querySelectorAll('.chk-jurusan-item:checked')).map(c => c.value);
      if (checkedJurusan.length > 0) {
        jurusan = checkedJurusan.join(', ');
      }
    }

    // Pengaman Otomatis Rombel -> Jurusan:
    // Jika guru memilih rombel spesifik (misal "X TKJ 1" atau "XII TKRO 1") dan tidak memilih "Semua Jurusan",
    // pastikan jurusan dari rombel tersebut ("TKJ", "TKRO") otomatis ikut disertakan agar siswa di rombel itu tidak terblokir!
    if (tingkat && jurusan) {
      const jurSet = new Set(jurusan.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
      const knownJurNorms = new Set(Array.from(jurSet).map(normalizeJurAlias));
      tingkat.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).forEach(kTok => {
        if (kTok.startsWith('TINGKAT:')) return;
        const parts = kTok.split(/[\s\-_]+/);
        if (parts.length >= 2 && ['X', 'XI', 'XII', '10', '11', '12'].includes(parts[0])) {
          const rombelJur = parts[1];
          const normRJ = normalizeJurAlias(rombelJur);
          if (rombelJur && !knownJurNorms.has(normRJ)) {
            jurSet.add(rombelJur);
            knownJurNorms.add(normRJ);
          }
        }
      });
      jurusan = Array.from(jurSet).join(', ');
    }

    penugasanList.push({ mapel, tingkat, jurusan });
  });

  // Cek Validasi Tabrakan Mapel & Kelas dengan Guru Lain sebelum menyimpan (STRICT BLOCK)
  const conflictPakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const conflicts = detectMapelKelasConflicts(g.id, penugasanList, allGuru, conflictPakets);
  if (conflicts.length > 0) {
    const listHtml = conflicts.slice(0, 8).map(c =>
      `<li class="mb-1 text-danger">Mata Pelajaran <strong>${escapeHtml(c.mapel)}</strong> pada kelas <span class="badge bg-danger text-white">${escapeHtml(c.overlapText)}</span> sudah diampu oleh <strong>${escapeHtml(c.otherGuruName)}</strong></li>`
    ).join('');
    const moreHtml = conflicts.length > 8 ? `<li class="text-muted">...dan ${conflicts.length - 8} kelas lainnya</li>` : '';
    await Swal.fire({
      icon: 'error',
      title: 'Tidak Bisa Simpan Penugasan!',
      html: `
        <div class="text-start small">
          <div class="alert alert-danger py-2 px-3 mb-3 border-danger shadow-sm">
            <div class="fw-bold mb-1"><i class="bi bi-x-octagon-fill me-1"></i>Terdeteksi Tabrakan Kelas dengan Guru Lain:</div>
            <ul class="mb-0 ps-3">${listHtml}${moreHtml}</ul>
          </div>
          <p class="text-muted mb-0">
            <i class="bi bi-shield-lock-fill text-danger me-1"></i>
            <strong>Aturan Sistem:</strong> Satu kelas/rombel tidak boleh diampu oleh lebih dari satu guru untuk mata pelajaran yang sama agar paket soal ujian siswa tidak tertukar atau tumpang tindih. Silakan hapus atau ubah centang kelas yang bentrok terlebih dahulu.
          </p>
        </div>
      `,
      confirmButtonText: '<i class="bi bi-pencil-square me-1"></i> Kembali & Ubah Pembagian Kelas',
      confirmButtonColor: '#dc3545'
    });
    return; // DIBUAT TIDAK BISA SIMPAN!
  }

  const btn = document.getElementById('btn-save-penugasan-guru');
  btn.disabled = true;

  try {
    const autoCreatePaket = document.getElementById('chk-auto-create-paket')?.checked;
    let updatedPaketIds = Array.isArray(g.paket_ids) ? [...g.paket_ids] : [];
    if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try { updatedPaketIds = JSON.parse(g.paket_ids) || []; } catch (e) {}
    }
    updatedPaketIds = updatedPaketIds.map(String);

    // Kumpulkan seluruh paket_ids yang sudah dimiliki oleh GURU LAIN agar paket soal tidak pernah bercampur/terpakai bersama
    const otherGuruPaketIds = getOtherGuruOwnedPaketIds(g.id);
    // Lepaskan paket yang sebelumnya tidak sengaja terikat bersama guru lain
    updatedPaketIds = updatedPaketIds.filter(pid => !otherGuruPaketIds.has(String(pid)));

    if (autoCreatePaket) {
      let sourcePakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
      if (sourcePakets.length === 0) {
        try {
          const fetched = await DB.getPaketList();
          if (Array.isArray(fetched)) {
            allPaketUnfiltered = fetched;
            sourcePakets = fetched;
          }
        } catch (e) {}
      }

      const shortGuruName = String(g.nama_lengkap || g.username || '')
        .replace(/^(bpk\.?|ibu\.?|drs\.?|dr\.?|ir\.?|hj\.?|h\.?)\s+/i, '')
        .split(/[,\s]+/)[0]
        .trim();

      // Daftar paket eksklusif milik guru ini yang sudah ada di Bank Soal
      const myOwnPakets = sourcePakets.filter(p =>
        updatedPaketIds.includes(String(p.id)) && !otherGuruPaketIds.has(String(p.id))
      );
      const claimedPaketIds = new Set();

      const buildTargetPaketName = (item) => {
        let newName = item.mapel;
        const kParts = (item.tingkat || '').split(',').map(s => s.trim()).filter(Boolean);
        if (kParts.length === 1) {
          const single = kParts[0];
          newName += ` - ${single.toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${single.split(':')[1]}` : single}`;
        } else if (kParts.length > 1) {
          const firstT = kParts[0].split(/[\s\-_]+/)[0].toUpperCase();
          if (kParts.every(k => k.split(/[\s\-_]+/)[0].toUpperCase() === firstT) && ['X', 'XI', 'XII', '10', '11', '12'].includes(firstT)) {
            newName += ` - Kelas ${firstT}`;
          } else {
            newName += ` (${kParts.length} Kelas)`;
          }
        }

        const jParts = (item.jurusan || '').split(',').map(s => s.trim()).filter(Boolean);
        if (jParts.length === 1) {
          newName += ` (${jParts[0]})`;
        } else if (jParts.length === 2) {
          newName += ` (${jParts.join(', ')})`;
        }

        const duplicateOtherGuru = sourcePakets.some(p =>
          !updatedPaketIds.includes(String(p.id)) &&
          String(p.nama_paket || '').trim().toLowerCase() === newName.trim().toLowerCase()
        );
        if (duplicateOtherGuru && shortGuruName) {
          newName += ` [${shortGuruName}]`;
        }
        return newName;
      };

      const extractGradesSet = (rawKelas) => {
        const parsed = parseCleanKelasTokens(rawKelas);
        const gSet = new Set(parsed.grades);
        parsed.rombels.forEach(r => {
          const gTok = r.split(/[\s\-_]+/)[0];
          if (['X', 'XI', 'XII', '10', '11', '12'].includes(gTok)) gSet.add(gTok);
        });
        return gSet;
      };

      for (const item of penugasanList) {
        const jVal = item.jurusan || '';
        const newName = buildTargetPaketName(item);
        const itemFam = normalizeMapelFamily(item.mapel);
        const itemGrades = extractGradesSet(item.tingkat);

        // Cari paket milik guru ini yang belum diklaim baris lain untuk di-UPDATE langsung di Bank Soal
        const availableOwn = myOwnPakets.filter(p => !claimedPaketIds.has(String(p.id)));

        // Prioritas 1: Cocok persis (mapel + kelas + jurusan)
        let matchedPaket = availableOwn.find(p => {
          const pName = String(p.nama_paket || '').toLowerCase();
          const mName = item.mapel.toLowerCase();
          const pJ = String(p.jurusan || '').toUpperCase();
          const pK = String(p.kelas || '').toUpperCase();
          const matchM = pName.includes(mName) || normalizeMapelFamily(p.nama_paket.split(' - ')[0].split(' (')[0]) === itemFam;
          const matchJ = (!jVal && (!pJ || pJ === 'SEMUA')) || (pJ === jVal.toUpperCase());
          const matchK = (!item.tingkat && (!pK || pK === 'SEMUA')) || (pK === item.tingkat.toUpperCase());
          return matchM && matchJ && matchK;
        });

        // Prioritas 2: Mapel sama & tingkat/kelas beririsan (utamakan paket yang sudah berisi soal > 0)
        if (!matchedPaket) {
          const sameMapelAndGrade = availableOwn.filter(p => {
            const pBase = String(p.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
            const pFam = normalizeMapelFamily(pBase);
            const sameM = (pFam && pFam === itemFam) || String(p.nama_paket || '').toLowerCase().includes(item.mapel.toLowerCase());
            if (!sameM) return false;
            if (getOverlappingClasses(p.kelas, item.tingkat).length > 0) return true;
            const pGrades = extractGradesSet(p.kelas);
            for (const gTok of itemGrades) {
              if (pGrades.has(gTok)) return true;
            }
            return itemGrades.size === 0 && pGrades.size === 0;
          });
          sameMapelAndGrade.sort((a, b) =>
            (Number(b.total_soal || b.soal_count || 0) - Number(a.total_soal || a.soal_count || 0))
          );
          matchedPaket = sameMapelAndGrade[0] || null;
        }

        // Prioritas 3: Mapel sama (jika guru mengganti tingkat kelas pada satu-satunya paket mapel tersebut)
        if (!matchedPaket) {
          const sameMapelOnly = availableOwn.filter(p => {
            const pBase = String(p.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
            const pFam = normalizeMapelFamily(pBase);
            return (pFam && pFam === itemFam) || String(p.nama_paket || '').toLowerCase().includes(item.mapel.toLowerCase());
          });
          sameMapelOnly.sort((a, b) =>
            (Number(b.total_soal || b.soal_count || 0) - Number(a.total_soal || a.soal_count || 0))
          );
          matchedPaket = sameMapelOnly[0] || null;
        }

        if (matchedPaket) {
          const pidStr = String(matchedPaket.id);
          claimedPaketIds.add(pidStr);
          if (!updatedPaketIds.includes(pidStr)) updatedPaketIds.push(pidStr);

          // Sinkronkan perubahan Nama Paket, Kelas, atau Jurusan langsung ke paket tersebut di Bank Soal
          const curK = String(matchedPaket.kelas || '').trim();
          const curJ = String(matchedPaket.jurusan || '').trim();
          const nextK = String(item.tingkat || '').trim();
          const nextJ = String(jVal || '').trim();
          const curName = String(matchedPaket.nama_paket || '').trim();

          if (curK.toUpperCase() !== nextK.toUpperCase() || curJ.toUpperCase() !== nextJ.toUpperCase() || curName !== newName) {
            await DB.savePaket(pidStr, {
              nama_paket: newName,
              jurusan: nextJ || null,
              kelas: nextK || null,
              jadwal_mulai: matchedPaket.jadwal_mulai || null,
              jadwal_selesai: matchedPaket.jadwal_selesai || null
            });
            matchedPaket.nama_paket = newName;
            matchedPaket.jurusan = nextJ || null;
            matchedPaket.kelas = nextK || null;
          }
        } else {
          const created = await DB.savePaket('', {
            nama_paket: newName,
            jurusan: jVal || null,
            kelas: item.tingkat || null,
            jadwal_mulai: null,
            jadwal_selesai: null
          });

          if (created && created.id) {
            const cId = String(created.id);
            claimedPaketIds.add(cId);
            if (!updatedPaketIds.includes(cId)) {
              updatedPaketIds.push(cId);
            }
            sourcePakets.push(created);
          }
        }
      }

      // Bersihkan otomatis paket ganda / paket yatim milik guru ini di Bank Soal yang tidak terpakai & masih kosong (0 soal)
      const unclaimedOwnPakets = myOwnPakets.filter(p => !claimedPaketIds.has(String(p.id)));
      for (const oldPk of unclaimedOwnPakets) {
        const oldId = String(oldPk.id);
        let soalCount = Number(oldPk.total_soal !== undefined ? oldPk.total_soal : (oldPk.soal_count || 0)) || 0;
        if (soalCount === 0 && oldPk.total_soal === undefined && typeof DB.getSoalByPaket === 'function') {
          try {
            const qList = await DB.getSoalByPaket(oldId);
            soalCount = Array.isArray(qList) ? qList.length : 0;
          } catch (e) {}
        }
        if (soalCount === 0) {
          try {
            await DB.deletePaket(oldId);
            updatedPaketIds = updatedPaketIds.filter(id => id !== oldId);
          } catch (e) {
            console.warn('Gagal hapus paket yatim kosong:', oldId, e);
          }
        }
      }
    }

    const uniqueMapels = Array.from(new Set(penugasanList.map(p => p.mapel).filter(Boolean)));
    const uniqueJurusans = Array.from(new Set(penugasanList.flatMap(p => (p.jurusan || '').split(',').map(s => s.trim())).filter(Boolean)));
    const uniqueTingkats = Array.from(new Set(penugasanList.flatMap(p => (p.tingkat || '').split(',').map(s => s.trim())).filter(Boolean)));

    await DB.saveGuru(g.id, {
      username: g.username,
      nama_lengkap: g.nama_lengkap,
      mapel_diampu: uniqueMapels.join(', '),
      jurusan_diampu: uniqueJurusans.join(', '),
      kelas_diampu: uniqueTingkats.join(', '),
      paket_ids: updatedPaketIds,
      penugasan_mapel: penugasanList
    });

    if (penugasanGuruModalInstance) {
      penugasanGuruModalInstance.hide();
    }

    Swal.fire('Berhasil Disimpan', `Daftar mata pelajaran untuk guru "${g.nama_lengkap}" berhasil diperbarui.`, 'success');
    await loadGuru();
    await loadPaket();
    if (typeof updateKesiapanSidebarBadge === 'function') updateKesiapanSidebarBadge();
    if (activeTab === 'kesiapan' && typeof loadKesiapanMonitoring === 'function') {
      await loadKesiapanMonitoring(false);
    }
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------
// HAPUS PAKET CEPAT DI TABEL GURU & DETEKSI TABRAKAN MAPEL-KELAS
// -------------------------------------------------------------

async function quickDeleteGuruPaket(guruId, paketId, paketName) {
  const g = (allGuru || []).find(item => String(item.id) === String(guruId));
  const sourcePakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const pk = sourcePakets.find(p => String(p.id) === String(paketId));
  const soalCount = pk ? (Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0) : 0;

  const warnExtra = soalCount > 0
    ? `<div class="alert alert-danger py-2 px-3 small mt-2 mb-0"><i class="bi bi-exclamation-triangle-fill me-1"></i><strong>Perhatian:</strong> Paket ini sudah berisi <strong>${soalCount} butir soal</strong>! Semua soal di dalamnya akan ikut terhapus.</div>`
    : `<div class="small text-muted mt-2">Paket soal ini akan dihapus permanen dan dilepas dari daftar guru <strong>${escapeHtml(g ? g.nama_lengkap : '')}</strong>.</div>`;

  const res = await Swal.fire({
    icon: 'warning',
    title: 'Hapus Paket Soal?',
    html: `Anda yakin ingin menghapus paket <strong>"${escapeHtml(paketName)}"</strong>?${warnExtra}`,
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: '<i class="bi bi-trash me-1"></i> Ya, Hapus Paket',
    cancelButtonText: 'Batal'
  });

  if (!res.isConfirmed) return;

  try {
    await DB.deletePaket(String(paketId));
    if (g) {
      let curIds = [];
      if (Array.isArray(g.paket_ids)) curIds = g.paket_ids.map(String);
      else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
        try { curIds = (JSON.parse(g.paket_ids) || []).map(String); } catch (e) {}
      }
      const nextIds = curIds.filter(id => id !== String(paketId));
      await DB.saveGuru(g.id, {
        username: g.username,
        nama_lengkap: g.nama_lengkap,
        mapel_diampu: g.mapel_diampu || '',
        jurusan_diampu: g.jurusan_diampu || '',
        kelas_diampu: g.kelas_diampu || '',
        paket_ids: nextIds,
        penugasan_mapel: g.penugasan_mapel || []
      });
    }
    if (String(activePaketId) === String(paketId)) {
      activePaketId = null;
      const d = document.getElementById('soal-detail-panel');
      const e = document.getElementById('soal-empty-state');
      if (d) d.classList.add('d-none');
      if (e) e.classList.remove('d-none');
    }
    Swal.fire({ icon: 'success', title: 'Paket Dihapus', text: `Paket "${paketName}" berhasil dihapus.`, timer: 1600, showConfirmButton: false });
    await loadGuru();
    await loadPaket();
  } catch (err) {
    Swal.fire('Gagal Menghapus', err.message || 'Terjadi kesalahan saat menghapus paket.', 'error');
  }
}

async function cleanupOrphanAndDuplicatePakets() {
  if (isGuruMode()) return;

  Swal.fire({
    title: 'Menganalisis Bank Soal & Penugasan Guru...',
    html: 'Memeriksa paket yatim, paket duplikat kosong (0 soal), dan kesesuaian kelas/jurusan...',
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const [freshGurus, freshPakets] = await Promise.all([
      DB.getGuruList(),
      DB.getPaketList()
    ]);
    allGuru = Array.isArray(freshGurus) ? freshGurus : (allGuru || []);
    allPaketUnfiltered = Array.isArray(freshPakets) ? freshPakets : (allPaketUnfiltered || []);

    const paketMap = new Map();
    allPaketUnfiltered.forEach(p => { if (p && p.id) paketMap.set(String(p.id), p); });

    // Helper: lengkapi otomatis jurusan dari rombel spesifik (cth: X TKJ 1 -> tambah TKJ)
    const completeJurusanFromKelas = (rawKelas, rawJurusan) => {
      const tStr = String(rawKelas || '').trim();
      const jStr = String(rawJurusan || '').trim();
      if (!tStr || !jStr || jStr.toUpperCase() === 'SEMUA') return jStr;
      const jurSet = new Set(jStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
      const knownNorms = new Set(Array.from(jurSet).map(normalizeJurAlias));
      tStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).forEach(kTok => {
        if (kTok.startsWith('TINGKAT:')) return;
        const parts = kTok.split(/[\s\-_]+/);
        if (parts.length >= 2 && ['X', 'XI', 'XII', '10', '11', '12'].includes(parts[0])) {
          const rJur = parts[1];
          const nRJ = normalizeJurAlias(rJur);
          if (rJur && !knownNorms.has(nRJ)) {
            jurSet.add(rJur);
            knownNorms.add(nRJ);
          }
        }
      });
      return Array.from(jurSet).join(', ');
    };

    const extractGradesSet = (rawKelas) => {
      const parsed = parseCleanKelasTokens(rawKelas);
      const gSet = new Set(parsed.grades);
      parsed.rombels.forEach(r => {
        const gTok = r.split(/[\s\-_]+/)[0];
        if (['X', 'XI', 'XII', '10', '11', '12'].includes(gTok)) gSet.add(gTok);
      });
      return gSet;
    };

    // 1. Kumpulkan seluruh paket yang terikat ke guru beserta rencana sinkronisasi per guru
    const allOwnedPaketIds = new Set();
    const duplicateEmptyPaketsToDelete = []; // { paket, guruName }
    const paketsToUpdate = [];               // { paket, nextKelas, nextJurusan, guruName }
    const gurusToUpdate = [];                // { guru, nextPaketIds, nextPenugasan }

    for (const g of allGuru) {
      let pids = [];
      if (Array.isArray(g.paket_ids)) pids = g.paket_ids.map(String).filter(Boolean);
      else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
        try { const dec = JSON.parse(g.paket_ids); if (Array.isArray(dec)) pids = dec.map(String).filter(Boolean); } catch (e) {}
      }
      pids = Array.from(new Set(pids)).filter(pid => paketMap.has(pid));

      let pList = [];
      if (Array.isArray(g.penugasan_mapel)) pList = g.penugasan_mapel;
      else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
        try { const dec = JSON.parse(g.penugasan_mapel); if (Array.isArray(dec)) pList = dec; } catch (e) {}
      }

      // Lengkapi jurusan yang terlupa pada setiap baris penugasan guru
      let penugasanChanged = false;
      const cleanPenugasan = pList.map(item => {
        const fixedJur = completeJurusanFromKelas(item.tingkat || '', item.jurusan || '');
        if (fixedJur !== String(item.jurusan || '').trim()) penugasanChanged = true;
        return { ...item, jurusan: fixedJur };
      });

      const myPakets = pids.map(pid => paketMap.get(pid)).filter(Boolean);

      if (cleanPenugasan.length === 0) {
        // Jika guru belum mengatur baris penugasan, hanya pertahankan paket yang sudah berisi soal (> 0 soal)
        const keptIds = [];
        for (const pk of myPakets) {
          const sc = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
          if (sc > 0) {
            keptIds.push(String(pk.id));
            allOwnedPaketIds.add(String(pk.id));
          } else {
            duplicateEmptyPaketsToDelete.push({ paket: pk, guruName: g.nama_lengkap || g.username });
          }
        }
        if (keptIds.length !== pids.length) {
          gurusToUpdate.push({ guru: g, nextPaketIds: keptIds, nextPenugasan: cleanPenugasan });
        } else {
          keptIds.forEach(id => allOwnedPaketIds.add(id));
        }
        continue;
      }

      const claimedIds = new Set();

      // Pasangkan setiap baris penugasan guru ke paket terbaik miliknya (utamakan paket yang sudah berisi soal > 0!)
      for (const item of cleanPenugasan) {
        const itemFam = normalizeMapelFamily(item.mapel);
        const itemGrades = extractGradesSet(item.tingkat);
        const avail = myPakets.filter(p => !claimedIds.has(String(p.id)));

        // Cari paket dengan mapel yang sama & tingkat/kelas beririsan (utamakan total_soal > 0)
        let candidates = avail.filter(p => {
          const pBase = String(p.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
          const pFam = normalizeMapelFamily(pBase);
          const sameM = (pFam && pFam === itemFam) || String(p.nama_paket || '').toLowerCase().includes(String(item.mapel || '').toLowerCase());
          if (!sameM) return false;
          if (getOverlappingClasses(p.kelas, item.tingkat).length > 0) return true;
          const pGrades = extractGradesSet(p.kelas);
          for (const gTok of itemGrades) {
            if (pGrades.has(gTok)) return true;
          }
          return itemGrades.size === 0 && pGrades.size === 0;
        });

        if (candidates.length === 0) {
          candidates = avail.filter(p => {
            const pBase = String(p.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
            const pFam = normalizeMapelFamily(pBase);
            return (pFam && pFam === itemFam) || String(p.nama_paket || '').toLowerCase().includes(String(item.mapel || '').toLowerCase());
          });
        }

        // Jika di paket milik guru belum ada, cari dari seluruh paket di Bank Soal yang belum diklaim guru lain
        if (candidates.length === 0) {
          const unassignedGlobal = allPaketUnfiltered.filter(p => p && p.id && !allOwnedPaketIds.has(String(p.id)) && !claimedIds.has(String(p.id)));
          candidates = unassignedGlobal.filter(p => {
            const pBase = String(p.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
            const pFam = normalizeMapelFamily(pBase);
            const sameM = (pFam && pFam === itemFam) || String(p.nama_paket || '').toLowerCase().includes(String(item.mapel || '').toLowerCase());
            if (!sameM) return false;
            if (getOverlappingClasses(p.kelas, item.tingkat).length > 0) return true;
            const pGrades = extractGradesSet(p.kelas);
            for (const gTok of itemGrades) {
              if (pGrades.has(gTok)) return true;
            }
            return itemGrades.size === 0 && pGrades.size === 0;
          });
          if (candidates.length === 0) {
            candidates = unassignedGlobal.filter(p => {
              const pBase = String(p.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
              const pFam = normalizeMapelFamily(pBase);
              return (pFam && pFam === itemFam) || String(p.nama_paket || '').toLowerCase().includes(String(item.mapel || '').toLowerCase());
            });
          }
        }

        candidates.sort((a, b) => {
          const scA = Number(a.total_soal !== undefined ? a.total_soal : (a.soal_count || 0)) || 0;
          const scB = Number(b.total_soal !== undefined ? b.total_soal : (b.soal_count || 0)) || 0;
          if ((scB > 0 ? 1 : 0) !== (scA > 0 ? 1 : 0)) return (scB > 0 ? 1 : 0) - (scA > 0 ? 1 : 0);
          const exactK_A = String(a.kelas || '').trim().toUpperCase() === String(item.tingkat || '').trim().toUpperCase() ? 1 : 0;
          const exactK_B = String(b.kelas || '').trim().toUpperCase() === String(item.tingkat || '').trim().toUpperCase() ? 1 : 0;
          if (exactK_B !== exactK_A) return exactK_B - exactK_A;
          return scB - scA;
        });

        const best = candidates[0] || null;
        if (best) {
          const bId = String(best.id);
          claimedIds.add(bId);
          allOwnedPaketIds.add(bId);

          // Cek apakah kelas atau jurusan paket perlu disinkronkan dengan penugasan guru
          const curK = String(best.kelas || '').trim();
          const curJ = String(best.jurusan || '').trim();
          const nextK = String(item.tingkat || '').trim();
          const nextJ = String(item.jurusan || '').trim();
          if (curK.toUpperCase() !== nextK.toUpperCase() || curJ.toUpperCase() !== nextJ.toUpperCase()) {
            paketsToUpdate.push({
              paket: best,
              nextKelas: nextK || null,
              nextJurusan: nextJ || null,
              guruName: g.nama_lengkap || g.username
            });
          }
        }
      }

      // Periksa sisa paket milik guru ini yang TIDAK diklaim oleh baris penugasan mana pun
      const nextIds = Array.from(claimedIds);
      for (const pk of myPakets) {
        const pidStr = String(pk.id);
        if (claimedIds.has(pidStr)) continue;
        const sc = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
        if (sc > 0) {
          // Paket sudah ada soalnya (> 0 soal) -> JANGAN DIHAPUS! Tetap pertahankan & lengkapi jurusannya bila lupa
          nextIds.push(pidStr);
          allOwnedPaketIds.add(pidStr);
          const fixedJ = completeJurusanFromKelas(pk.kelas || '', pk.jurusan || '');
          if (fixedJ.toUpperCase() !== String(pk.jurusan || '').trim().toUpperCase()) {
            paketsToUpdate.push({
              paket: pk,
              nextKelas: pk.kelas || null,
              nextJurusan: fixedJ || null,
              guruName: g.nama_lengkap || g.username
            });
          }
        } else {
          // Paket kembar/duplikat yang masih 0 soal -> masukkan ke daftar hapus
          duplicateEmptyPaketsToDelete.push({ paket: pk, guruName: g.nama_lengkap || g.username });
        }
      }

      if (penugasanChanged || nextIds.length !== pids.length || !nextIds.every((v, i) => v === pids[i])) {
        gurusToUpdate.push({ guru: g, nextPaketIds: nextIds, nextPenugasan: cleanPenugasan });
      }
    }

    // 2. Cari paket yatim tanpa guru pengampu yang masih kosong (0 soal)
    const orphanEmptyPaketsToDelete = [];
    const orphanFilledPakets = [];
    for (const pk of allPaketUnfiltered) {
      if (!pk || !pk.id) continue;
      if (allOwnedPaketIds.has(String(pk.id))) continue;
      // Pastikan juga tidak ada di daftar duplicateEmptyPaketsToDelete
      if (duplicateEmptyPaketsToDelete.some(d => String(d.paket.id) === String(pk.id))) continue;

      const sc = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
      if (sc === 0) {
        orphanEmptyPaketsToDelete.push(pk);
      } else {
        orphanFilledPakets.push(pk);
      }
    }

    const totalToDelete = orphanEmptyPaketsToDelete.length + duplicateEmptyPaketsToDelete.length;
    if (totalToDelete === 0 && paketsToUpdate.length === 0 && gurusToUpdate.length === 0) {
      Swal.fire({
        icon: 'success',
        title: 'Bank Soal Sudah Bersih & Sinkron!',
        text: 'Tidak ditemukan paket yatim kosong (0 soal), paket duplikat kosong, maupun selisih kelas/jurusan pada Bank Soal.',
        confirmButtonColor: '#198754'
      });
      return;
    }

    const updatePreviewHtml = paketsToUpdate.length > 0
      ? `<div class="mb-2"><strong class="text-primary"><i class="bi bi-arrow-repeat me-1"></i>${paketsToUpdate.length} Paket Disinkronkan Kelas/Jurusannya:</strong><ul class="mb-1 ps-3 small">${paketsToUpdate.slice(0, 6).map(u => `<li><strong>${escapeHtml(u.guruName)}</strong> — ${escapeHtml(u.paket.nama_paket)} &rarr; Kelas: <code>${escapeHtml(u.nextKelas || 'Semua')}</code> | Jur: <code>${escapeHtml(u.nextJurusan || 'Semua')}</code></li>`).join('')}${paketsToUpdate.length > 6 ? `<li class="text-muted">...dan ${paketsToUpdate.length - 6} paket lainnya</li>` : ''}</ul></div>`
      : '';

    const dupPreviewHtml = duplicateEmptyPaketsToDelete.length > 0
      ? `<div class="mb-2"><strong class="text-danger"><i class="bi bi-files me-1"></i>${duplicateEmptyPaketsToDelete.length} Paket Ganda/Duplikat Guru yang Kosong (0 Soal) Dihapus:</strong><ul class="mb-1 ps-3 small">${duplicateEmptyPaketsToDelete.slice(0, 5).map(d => `<li><strong>${escapeHtml(d.guruName)}</strong> — ${escapeHtml(d.paket.nama_paket)} (0 Soal)</li>`).join('')}${duplicateEmptyPaketsToDelete.length > 5 ? `<li class="text-muted">...dan ${duplicateEmptyPaketsToDelete.length - 5} paket kosong lainnya</li>` : ''}</ul></div>`
      : '';

    const orphanPreviewHtml = orphanEmptyPaketsToDelete.length > 0
      ? `<div class="mb-2"><strong class="text-danger"><i class="bi bi-trash me-1"></i>${orphanEmptyPaketsToDelete.length} Paket Yatim Tanpa Guru yang Kosong (0 Soal) Dihapus:</strong><ul class="mb-1 ps-3 small">${orphanEmptyPaketsToDelete.slice(0, 5).map(p => `<li>${escapeHtml(p.nama_paket)} (0 Soal)</li>`).join('')}${orphanEmptyPaketsToDelete.length > 5 ? `<li class="text-muted">...dan ${orphanEmptyPaketsToDelete.length - 5} paket yatim kosong lainnya</li>` : ''}</ul></div>`
      : '';

    const safeNoteHtml = `<div class="alert alert-success py-2 px-3 small mb-0 mt-2"><i class="bi bi-shield-check me-1"></i><strong>Jaminan Aman:</strong> Seluruh paket yang sudah berisi soal (<strong>&gt; 0 soal</strong>) <strong>TIDAK AKAN DIHAPUS</strong>.</div>`;

    const confirmRes = await Swal.fire({
      icon: 'question',
      title: 'Bersihkan & Sinkronkan Bank Soal?',
      html: `<div class="text-start small">${updatePreviewHtml}${dupPreviewHtml}${orphanPreviewHtml}${safeNoteHtml}</div>`,
      showCancelButton: true,
      confirmButtonText: '<i class="bi bi-magic me-1"></i> Ya, Bersihkan & Sinkronkan Sekarang',
      cancelButtonText: 'Batal',
      confirmButtonColor: '#198754',
      cancelButtonColor: '#6c757d',
      width: '620px'
    });

    if (!confirmRes.isConfirmed) return;

    Swal.fire({
      title: 'Memproses Pembersihan & Sinkronisasi...',
      html: 'Mohon tunggu sebentar...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    // 1. Update paket yang kelas/jurusannya perlu disinkronkan
    let updatedPaketCount = 0;
    for (const u of paketsToUpdate) {
      try {
        await DB.savePaket(String(u.paket.id), {
          nama_paket: u.paket.nama_paket,
          jurusan: u.nextJurusan,
          kelas: u.nextKelas,
          jadwal_mulai: u.paket.jadwal_mulai || null,
          jadwal_selesai: u.paket.jadwal_selesai || null
        });
        updatedPaketCount++;
      } catch (e) {
        console.warn('Gagal update paket saat sinkronisasi:', u.paket.id, e);
      }
    }

    // 2. Hapus paket duplikat kosong & paket yatim kosong (verifikasi ulang 0 soal sebelum hapus)
    const allToDelete = [
      ...duplicateEmptyPaketsToDelete.map(d => d.paket),
      ...orphanEmptyPaketsToDelete
    ];
    let deletedCount = 0;
    for (const pk of allToDelete) {
      const pidStr = String(pk.id);
      let sc = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
      if (sc === 0 && pk.total_soal === undefined && typeof DB.getSoalByPaket === 'function') {
        try {
          const qCheck = await DB.getSoalByPaket(pidStr);
          sc = Array.isArray(qCheck) ? qCheck.length : 0;
        } catch (e) {}
      }
      if (sc > 0) continue; // Pengaman ekstra: jangan pernah hapus jika ternyata ada soalnya
      try {
        await DB.deletePaket(pidStr);
        deletedCount++;
        if (String(activePaketId) === pidStr) {
          activePaketId = null;
        }
      } catch (e) {
        console.warn('Gagal hapus paket kosong:', pidStr, e);
      }
    }

    // 3. Simpan pembaruan paket_ids & penugasan pada akun guru yang terdampak
    for (const gu of gurusToUpdate) {
      const g = gu.guru;
      const pList = gu.nextPenugasan;
      const uniqueMapels = Array.from(new Set(pList.map(p => p.mapel).filter(Boolean)));
      const uniqueJurusans = Array.from(new Set(pList.flatMap(p => (p.jurusan || '').split(',').map(s => s.trim())).filter(Boolean)));
      const uniqueTingkats = Array.from(new Set(pList.flatMap(p => (p.tingkat || '').split(',').map(s => s.trim())).filter(Boolean)));
      try {
        await DB.saveGuru(g.id, {
          username: g.username,
          nama_lengkap: g.nama_lengkap,
          mapel_diampu: uniqueMapels.length > 0 ? uniqueMapels.join(', ') : (g.mapel_diampu || ''),
          jurusan_diampu: uniqueJurusans.length > 0 ? uniqueJurusans.join(', ') : (g.jurusan_diampu || ''),
          kelas_diampu: uniqueTingkats.length > 0 ? uniqueTingkats.join(', ') : (g.kelas_diampu || ''),
          paket_ids: gu.nextPaketIds,
          penugasan_mapel: pList
        });
      } catch (e) {
        console.warn('Gagal update paket_ids guru:', g.nama_lengkap, e);
      }
    }

    await loadGuru();
    await loadPaket();

    Swal.fire({
      icon: 'success',
      title: 'Pembersihan & Sinkronisasi Selesai!',
      html: `
        <div class="text-start small">
          <ul class="mb-0 ps-3">
            <li><strong>${updatedPaketCount} paket soal</strong> berhasil disinkronkan kelas & jurusannya sesuai penugasan guru.</li>
            <li><strong>${deletedCount} paket yatim / duplikat kosong (0 soal)</strong> berhasil dihapus dari Bank Soal.</li>
            <li><strong>${gurusToUpdate.length} akun guru</strong> berhasil dirapikan daftar paket terkaitnya.</li>
          </ul>
        </div>
      `,
      confirmButtonColor: '#198754'
    });
  } catch (err) {
    console.error('Gagal cleanupOrphanAndDuplicatePakets:', err);
    Swal.fire('Gagal Memproses', err.message || 'Terjadi kesalahan saat membersihkan Bank Soal.', 'error');
  }
}

function normalizeMapelFamily(name) {
  const s = String(name || '').toLowerCase().trim();
  if (!s) return '';
  if (s.includes('agama islam') || s.includes('agma islam') || /\bpai(bp)?\b/.test(s)) return 'pendidikan agama islam';
  if (s.includes('kristen') && !s.includes('katolik') && !s.includes('katholik')) return 'agama kristen protestan';
  if (s.includes('katolik') || s.includes('katholik')) return 'agama katolik';
  if (s.includes('hindu')) return 'agama hindu';
  if (s.includes('budha') || s.includes('buddha')) return 'agama buddha';
  if (s.includes('konghucu') || s.includes('khonghucu')) return 'agama konghucu';
  if (s.includes('indonesia') || s.includes('ainonesia')) return 'bahasa indonesia';
  if (s.includes('inggris')) return 'bahasa inggris';
  if (s.includes('matematika') || s === 'mtk') return 'matematika';
  if (s.includes('jasmani') || s.includes('pjok') || s.includes('olahrga')) return 'pjok';
  if (s.includes('kewirausahaan') || s.includes('kewirauusahaan') || s.includes('kreativ') || s.includes('kreatv') || s === 'pkk') return 'pkk / kewirausahaan';
  if (s.includes('ipas') || s.includes('ilmu pengeahuan alam') || s.includes('ilmu pengetahuan alam')) return 'projek ipas';
  if (s.includes('koding') || s.includes('coding') || s.includes('kka')) return 'koding / kka';
  if (s.includes('informatika')) return 'informatika';
  if (s.includes('sejarah')) return 'sejarah';
  if (s.includes('pancasila') || s === 'pkn' || s === 'ppkn') return 'pendidikan pancasila';
  if (s.includes('seni')) return 'seni budaya / musik';
  if (s.includes('dasar-dasar kejuruan teknik jaringan') || s.includes('tjkt')) return 'ddk tjkt';
  if (s.includes('kejuruan akuntansi')) return 'kejuruan akuntansi';
  return s.replace(/\s+/g, ' ');
}

function normalizeJurAlias(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s || s === 'semua' || s === 'semua jurusan') return 'semua';
  if (s === 'akl' || s === 'akuntansi' || s.startsWith('akuntansi ')) return 'akl';
  if (s === 'tkj' || s === 'tjkt') return 'tkj';
  if (s === 'tkro' || s === 'tkr') return 'tkro';
  if (s === 'tbsm' || s === 'tsm') return 'tbsm';
  return s;
}

function parseCleanKelasTokens(rawKelas) {
  const raw = String(rawKelas || '').trim();
  if (!raw || raw.toUpperCase() === 'SEMUA' || raw.toUpperCase() === 'SEMUA KELAS') {
    return { isAll: true, rombels: [], grades: [] };
  }
  const parts = raw.split(',').map(s => s.trim().toUpperCase()).filter(s => s && s !== 'SEMUA');
  const rombels = [];
  const rawGrades = [];
  const specGrades = new Set();
  parts.forEach(p => {
    if (p.startsWith('TINGKAT:')) {
      rawGrades.push(p.replace('TINGKAT:', '').trim());
    } else if (p.startsWith('TINGKAT ')) {
      rawGrades.push(p.replace('TINGKAT ', '').trim());
    } else if (['X', 'XI', 'XII', '10', '11', '12'].includes(p)) {
      rawGrades.push(p);
    } else {
      rombels.push(p);
      const g = p.split(/[\s\-_]+/)[0];
      if (['X', 'XI', 'XII', '10', '11', '12'].includes(g)) specGrades.add(g);
    }
  });
  const grades = rawGrades.filter(g => !specGrades.has(g));
  return { isAll: (rombels.length === 0 && grades.length === 0), rombels, grades };
}

function getOverlappingClasses(kelasA, kelasB) {
  const a = parseCleanKelasTokens(kelasA);
  const b = parseCleanKelasTokens(kelasB);
  if (a.isAll && b.isAll) return ['Semua Kelas'];
  if (a.isAll) return [...b.rombels, ...b.grades.map(g => `Tingkat ${g}`)];
  if (b.isAll) return [...a.rombels, ...a.grades.map(g => `Tingkat ${g}`)];

  const overlaps = new Set();
  a.rombels.forEach(r => {
    const g = r.split(/[\s\-_]+/)[0];
    if (b.rombels.includes(r) || b.grades.includes(g)) overlaps.add(r);
  });
  b.rombels.forEach(r => {
    const g = r.split(/[\s\-_]+/)[0];
    if (a.grades.includes(g)) overlaps.add(r);
  });
  a.grades.forEach(g => {
    if (b.grades.includes(g)) overlaps.add(`Tingkat ${g}`);
  });
  return Array.from(overlaps);
}

function hasJurusanOverlap(jurA, jurB) {
  const parseJ = (raw) => {
    const parts = String(raw || '').split(',').map(normalizeJurAlias).filter(Boolean);
    return parts.length === 0 || parts.includes('semua') ? null : new Set(parts);
  };
  const setA = parseJ(jurA);
  const setB = parseJ(jurB);
  if (!setA || !setB) return true;
  for (const x of setA) {
    if (setB.has(x)) return true;
  }
  return false;
}

function detectMapelKelasConflicts(currentGuruId, rowsToCheck, guruList, paketList, excludePaketId = '') {
  const conflicts = [];
  const seenKey = new Set();
  const pkMap = new Map();
  (paketList || []).forEach(p => {
    if (p && p.id && String(p.id) !== String(excludePaketId)) pkMap.set(String(p.id), p);
  });

  (rowsToCheck || []).forEach(item => {
    const famA = normalizeMapelFamily(item.mapel);
    if (!famA) return;

    (guruList || []).forEach(other => {
      if (!other || (currentGuruId && String(other.id) === String(currentGuruId))) return;
      const otherName = other.nama_lengkap || other.username || 'Guru Lain';

      const otherEntries = [];
      let pList = [];
      if (Array.isArray(other.penugasan_mapel)) pList = other.penugasan_mapel;
      else if (typeof other.penugasan_mapel === 'string' && other.penugasan_mapel.trim()) {
        try { const dec = JSON.parse(other.penugasan_mapel); if (Array.isArray(dec)) pList = dec; } catch (e) {}
      }
      pList.forEach(pe => {
        if (pe && pe.mapel) otherEntries.push({ mapel: pe.mapel, kelas: pe.tingkat || '', jurusan: pe.jurusan || '' });
      });

      let pids = [];
      if (Array.isArray(other.paket_ids)) pids = other.paket_ids;
      else if (typeof other.paket_ids === 'string' && other.paket_ids.trim()) {
        try { const dec = JSON.parse(other.paket_ids); if (Array.isArray(dec)) pids = dec; } catch (e) {}
      }
      pids.forEach(pid => {
        const pk = pkMap.get(String(pid));
        if (pk && pk.nama_paket) {
          const baseMapel = pk.nama_paket.split(' - ')[0].split(' (')[0].trim();
          otherEntries.push({ mapel: baseMapel, kelas: pk.kelas || '', jurusan: pk.jurusan || '' });
        }
      });

      otherEntries.forEach(oe => {
        const famB = normalizeMapelFamily(oe.mapel);
        if (!famB) return;
        const sameMapel = (famA === famB) || (famA.length >= 6 && famB.length >= 6 && (famA.includes(famB) || famB.includes(famA)));
        if (!sameMapel) return;
        if (!hasJurusanOverlap(item.jurusan, oe.jurusan)) return;

        const ov = getOverlappingClasses(item.tingkat, oe.kelas);
        if (ov.length > 0) {
          const overlapText = ov.join(', ');
          const dedup = `${famA}|${other.id}|${overlapText}`;
          if (!seenKey.has(dedup)) {
            seenKey.add(dedup);
            conflicts.push({
              mapel: item.mapel,
              overlapText,
              otherGuruName: otherName,
              otherMapel: oe.mapel
            });
          }
        }
      });
    });
  });

  return conflicts;
}

function collectCurrentPenugasanRows() {
  const rows = document.querySelectorAll('#tbody-penugasan-mapel tr');
  const list = [];
  rows.forEach(tr => {
    const mapel = (tr.querySelector('.penugasan-mapel-input')?.value || '').trim();
    if (!mapel) return;
    const chkKelasAll = tr.querySelector('.chk-kelas-all');
    let tingkat = '';
    if (!chkKelasAll || !chkKelasAll.checked) {
      tingkat = Array.from(tr.querySelectorAll('.chk-kelas-item:checked')).map(c => c.value).join(', ');
    }
    const chkJurusanAll = tr.querySelector('.chk-jurusan-all');
    let jurusan = '';
    if (!chkJurusanAll || !chkJurusanAll.checked) {
      jurusan = Array.from(tr.querySelectorAll('.chk-jurusan-item:checked')).map(c => c.value).join(', ');
    }
    list.push({ mapel, tingkat, jurusan });
  });
  return list;
}

function updatePenugasanConflictWarning() {
  const box = document.getElementById('penugasan-conflict-warning');
  if (!box) return;
  const guruId = document.getElementById('penugasan-guru-id')?.value || '';
  const rows = collectCurrentPenugasanRows();
  const conflictPakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const conflicts = detectMapelKelasConflicts(guruId, rows, allGuru, conflictPakets);

  const btnSave = document.getElementById('btn-save-penugasan-guru');
  if (conflicts.length === 0) {
    box.classList.add('d-none');
    box.innerHTML = '';
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.classList.remove('btn-secondary');
      btnSave.classList.add('btn-primary');
      btnSave.title = '';
    }
    return;
  }

  const itemsHtml = conflicts.slice(0, 6).map(c =>
    `<li>Mata Pelajaran <strong>${escapeHtml(c.mapel)}</strong> pada kelas <span class="badge bg-danger text-white">${escapeHtml(c.overlapText)}</span> sudah diampu oleh <strong>${escapeHtml(c.otherGuruName)}</strong></li>`
  ).join('');
  const moreHtml = conflicts.length > 6 ? `<li class="text-muted">...dan ${conflicts.length - 6} kelas lainnya.</li>` : '';

  box.innerHTML = `
    <div class="alert alert-danger border-danger shadow-sm d-flex align-items-start gap-2 mb-0">
      <i class="bi bi-x-octagon-fill text-danger fs-5 flex-shrink-0 mt-1"></i>
      <div>
        <div class="fw-bold text-danger mb-1"><i class="bi bi-exclamation-triangle-fill me-1"></i>Ditolak: Ada Tabrakan Kelas dengan Guru Lain!</div>
        <ul class="mb-2 ps-3 small text-dark">${itemsHtml}${moreHtml}</ul>
        <div class="small text-danger fw-semibold"><i class="bi bi-lock-fill me-1"></i>Tombol simpan dinonaktifkan sampai centang kelas yang bentrok diubah/dihapus.</div>
      </div>
    </div>
  `;
  box.classList.remove('d-none');

  if (btnSave) {
    btnSave.disabled = true;
    btnSave.classList.remove('btn-primary');
    btnSave.classList.add('btn-secondary');
    btnSave.title = 'Tidak bisa simpan: terdeteksi tabrakan kelas dengan guru lain';
  }
}

// Mendeteksi seluruh tabrakan penugasan kelas yang sudah terlanjur terjadi di database
function findAllGuruAssignmentConflicts(guruList, paketList) {
  const conflictsByGuruId = new Map();
  const allCollisions = [];
  const seenPairKeys = new Set();
  const pkMap = new Map();
  (paketList || []).forEach(p => { if (p && p.id) pkMap.set(String(p.id), p); });

  const guruEntries = [];
  (guruList || []).forEach(g => {
    if (!g || !g.id) return;
    const entries = [];
    let pList = [];
    if (Array.isArray(g.penugasan_mapel)) pList = g.penugasan_mapel;
    else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
      try { const dec = JSON.parse(g.penugasan_mapel); if (Array.isArray(dec)) pList = dec; } catch (e) {}
    }
    pList.forEach(pe => {
      if (pe && pe.mapel) entries.push({ mapel: pe.mapel, kelas: pe.tingkat || '', jurusan: pe.jurusan || '' });
    });

    let pids = [];
    if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
    else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try { const dec = JSON.parse(g.paket_ids); if (Array.isArray(dec)) pids = dec; } catch (e) {}
    }
    pids.forEach(pid => {
      const pk = pkMap.get(String(pid));
      if (pk && pk.nama_paket) {
        const baseMapel = pk.nama_paket.split(' - ')[0].split(' (')[0].trim();
        entries.push({ mapel: baseMapel, kelas: pk.kelas || '', jurusan: pk.jurusan || '' });
      }
    });

    guruEntries.push({ guru: g, id: String(g.id), name: g.nama_lengkap || g.username || 'Guru', entries });
  });

  for (let i = 0; i < guruEntries.length; i++) {
    const gA = guruEntries[i];
    for (let j = i + 1; j < guruEntries.length; j++) {
      const gB = guruEntries[j];

      for (const entA of gA.entries) {
        const famA = normalizeMapelFamily(entA.mapel);
        if (!famA) continue;

        for (const entB of gB.entries) {
          const famB = normalizeMapelFamily(entB.mapel);
          if (!famB) continue;

          const sameMapel = (famA === famB) || (famA.length >= 6 && famB.length >= 6 && (famA.includes(famB) || famB.includes(famA)));
          if (!sameMapel) continue;
          if (!hasJurusanOverlap(entA.jurusan, entB.jurusan)) continue;

          const ov = getOverlappingClasses(entA.kelas, entB.kelas);
          if (ov.length > 0) {
            const overlapText = ov.join(', ');
            const pairKey = `${famA}|${[gA.id, gB.id].sort().join('-')}|${overlapText}`;
            if (!seenPairKeys.has(pairKey)) {
              seenPairKeys.add(pairKey);
              const collisionObj = {
                mapel: entA.mapel,
                overlapText,
                guruAName: gA.name,
                guruBName: gB.name
              };
              allCollisions.push(collisionObj);

              if (!conflictsByGuruId.has(gA.id)) conflictsByGuruId.set(gA.id, []);
              conflictsByGuruId.get(gA.id).push({ mapel: entA.mapel, overlapText, otherGuruName: gB.name });

              if (!conflictsByGuruId.has(gB.id)) conflictsByGuruId.set(gB.id, []);
              conflictsByGuruId.get(gB.id).push({ mapel: entB.mapel, overlapText, otherGuruName: gA.name });
            }
          }
        }
      }
    }
  }

  return { conflictsByGuruId, allCollisions };
}

function renderConflictSummaryBanner(containerId, allCollisions) {
  const banner = document.getElementById(containerId);
  if (!banner) return;
  if (!allCollisions || allCollisions.length === 0) {
    banner.classList.add('d-none');
    banner.innerHTML = '';
    return;
  }

  const listHtml = allCollisions.map((c, i) => `
    <tr>
      <td class="text-danger fw-bold text-nowrap" style="width: 35px;">#${i + 1}</td>
      <td>
        <strong class="text-dark">${escapeHtml(c.mapel)}</strong>
        <span class="badge bg-danger text-white ms-1">${escapeHtml(c.overlapText)}</span>
      </td>
      <td class="text-dark">
        <span class="badge bg-warning-subtle text-dark border me-1">${escapeHtml(c.guruAName)}</span>
        <span class="text-danger fw-bold">&harr;</span>
        <span class="badge bg-warning-subtle text-dark border ms-1">${escapeHtml(c.guruBName)}</span>
      </td>
    </tr>
  `).join('');

  banner.innerHTML = `
    <div class="alert alert-danger border-danger shadow-sm rounded-3 p-3 mb-0">
      <div class="d-flex align-items-start gap-3">
        <i class="bi bi-exclamation-triangle-fill fs-3 text-danger flex-shrink-0 mt-1"></i>
        <div class="w-100">
          <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-1">
            <h6 class="fw-bold text-danger mb-0">
              <i class="bi bi-shield-exclamation me-1"></i>Peringatan Admin: Terdeteksi ${allCollisions.length} Tabrakan Pembagian Kelas!
            </h6>
            <span class="badge bg-danger text-white">Perlu Tindakan Kurikulum / Admin</span>
          </div>
          <p class="small text-dark mb-2">Terdapat guru dengan mata pelajaran yang sama mengampu rombel/kelas yang sama. Harap segera sesuaikan penugasan mapel agar paket soal dan nilai ujian siswa tidak tertukar:</p>
          <div class="table-responsive bg-white rounded border border-danger-subtle p-2">
            <table class="table table-sm table-hover mb-0 small">
              <thead class="text-muted border-bottom">
                <tr>
                  <th>No</th>
                  <th>Mata Pelajaran & Kelas Bentrok</th>
                  <th>Guru yang Berselisih</th>
                </tr>
              </thead>
              <tbody>${listHtml}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
  banner.classList.remove('d-none');
}

// Menampilkan peringatan tabrakan kelas khusus di akun guru yang sedang login
function checkAndRenderGuruConflictAlert() {
  if (!isGuruMode() || !currentAdminUser) return;
  const banner = document.getElementById('guru-conflict-alert-banner');
  if (!banner) return;

  const conflictPakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const myConflicts = detectMapelKelasConflicts(currentAdminUser.id, getGuruPenugasanList(), allGuru, conflictPakets);

  if (myConflicts.length === 0) {
    banner.classList.add('d-none');
    banner.innerHTML = '';
    return;
  }

  const listHtml = myConflicts.map(c => `
    <li class="mb-1">Mata Pelajaran <strong>${escapeHtml(c.mapel)}</strong> pada kelas <span class="badge bg-danger text-white">${escapeHtml(c.overlapText)}</span> juga diampu oleh <strong>${escapeHtml(c.otherGuruName)}</strong></li>
  `).join('');

  banner.innerHTML = `
    <div class="alert alert-danger border-danger shadow-sm rounded-3 p-3 mb-0">
      <div class="d-flex align-items-start gap-3">
        <i class="bi bi-exclamation-octagon-fill fs-2 text-danger flex-shrink-0 mt-1"></i>
        <div class="w-100">
          <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-1">
            <h5 class="fw-bold text-danger mb-0">
              <i class="bi bi-exclamation-triangle-fill me-1"></i>PERHATIAN: Terdeteksi Tabrakan Pembagian Kelas!
            </h5>
            <span class="badge bg-danger text-white">Perlu Koordinasi</span>
          </div>
          <p class="text-dark mb-2 small">
            Mata pelajaran dan kelas yang Anda ampu <strong>terdeteksi ganda (bentrok)</strong> dengan guru lain:
          </p>
          <ul class="mb-2 ps-3 small text-danger fw-semibold">
            ${listHtml}
          </ul>
          <div class="alert alert-warning py-2 px-3 small mb-0 border-warning-subtle text-dark">
            <i class="bi bi-info-circle-fill text-warning me-1"></i>
            <strong>Tindakan yang Diperlukan:</strong> Harap segera berkoordinasi dengan <strong>Waka Kurikulum / Admin CBT</strong> atau guru yang bersangkutan untuk memperbarui pembagian rombel Anda agar paket soal ujian siswa tidak tertukar saat ujian berlangsung.
          </div>
        </div>
      </div>
    </div>
  `;
  banner.classList.remove('d-none');

  // Pop-up SweetAlert sekali per sesi login guru
  const alertKey = `CBT_ALERTED_CONFLICT_${currentAdminUser.id || currentAdminUser.username}`;
  if (!sessionStorage.getItem(alertKey)) {
    sessionStorage.setItem(alertKey, '1');
    Swal.fire({
      icon: 'warning',
      title: 'Peringatan: Tabrakan Kelas Terdeteksi!',
      html: `
        <div class="text-start small">
          <p class="mb-2">Mata pelajaran dan kelas yang Anda ampu terdaftar ganda dengan guru lain:</p>
          <ul class="text-danger ps-3 mb-2 fw-semibold">${listHtml}</ul>
          <p class="text-muted mb-0">Mohon segera hubungi Admin / Waka Kurikulum untuk membagi rombel kelas secara tepat.</p>
        </div>
      `,
      confirmButtonText: 'Saya Mengerti, Saya Akan Koordinasi',
      confirmButtonColor: '#dc3545'
    });
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

function onCetakPasswordModeChange() {
  const mode = document.getElementById('cetak-password-mode')?.value;
  const col = document.getElementById('col-cetak-custom-pass');
  const lbl = document.getElementById('label-cetak-custom-pass');
  const help = document.getElementById('help-cetak-custom-pass');
  if (!col) return;

  if (mode === 'same_as_username') {
    col.style.display = 'none';
  } else if (mode === 'custom') {
    col.style.display = 'block';
    if (lbl) lbl.innerText = 'Password Seragam Semua Siswa';
    if (help) help.innerText = 'Seluruh kartu akan mencetak password seragam yang Anda ketikkan di atas.';
  } else {
    // auto
    col.style.display = 'block';
    if (lbl) lbl.innerText = 'Password Cadangan / Pengganti';
    if (help) help.innerText = 'Jika akun lama belum tercatat password aslinya di database, teks ini yang akan dicetak di kartu.';
  }
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
    pisahKelas: document.getElementById('cetak-opt-pisah-kelas')?.checked ?? true,
    passwordMode: document.getElementById('cetak-password-mode')?.value || 'auto',
    customPass: (document.getElementById('cetak-custom-pass-val')?.value || '').trim()
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
    pisahKelas: false,
    passwordMode: 'auto',
    customPass: '123456'
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

      ${pGroup.students.map(p => {
        let printPass = '';
        if (opt.passwordMode === 'same_as_username') {
          printPass = p.username;
        } else if (opt.passwordMode === 'custom') {
          printPass = opt.customPass || '123456';
        } else {
          // auto: utamakan password_plain/password, jika tidak ada gunakan customPass atau username
          printPass = p.password || p.password_plain || opt.customPass || p.username;
        }

        return `
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
                <td class="val"><span class="badge-pass">${escapeHtml(printPass)}</span></td>
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
      `;
      }).join('')}
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
    if (!allGuru || allGuru.length === 0) {
      try {
        allGuru = await DB.getGuruList() || [];
      } catch (e) {
        console.warn('Gagal memuat daftar guru di loadPaket:', e);
      }
    }
    const rawPaket = await DB.getPaketList();
    allPaketUnfiltered = rawPaket || [];

    // Otomatis rapikan nama paket yang terlanjur panjang akibat dump kelas/jurusan koma-koma
    allPaketUnfiltered.forEach(p => {
      const clean = getCleanPaketName(p.nama_paket, p.kelas, p.jurusan);
      if (clean && clean !== p.nama_paket) {
        p.nama_paket = clean;
        DB.savePaket(p.id, {
          nama_paket: clean,
          jurusan: p.jurusan,
          kelas: p.kelas,
          jadwal_mulai: p.jadwal_mulai,
          jadwal_selesai: p.jadwal_selesai
        }).catch(err => console.warn('Gagal merapikan nama paket otomatis di DB:', err));
      }
    });

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

function getCleanPaketName(namaPaket, rawKelas, rawJurusan) {
  if (!namaPaket || typeof namaPaket !== 'string') return namaPaket || 'Paket Soal';
  let name = namaPaket.trim();

  // Jika nama paket mengandung dump daftar kelas/jurusan koma-koma yang panjang
  if (name.includes(',') && name.length > 25 && name.includes(' - ')) {
    const dashIdx = name.indexOf(' - ');
    const mapelPart = name.substring(0, dashIdx).trim();

    const kList = String(rawKelas || '').split(',').map(s => s.trim()).filter(Boolean);
    let kStr = '';
    if (kList.length === 1) {
      kStr = kList[0].toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${kList[0].split(':')[1]}` : kList[0];
    } else if (kList.length > 1) {
      const firstT = kList[0].split(/[\s\-_]+/)[0].toUpperCase();
      if (kList.every(k => k.split(/[\s\-_]+/)[0].toUpperCase() === firstT) && ['X', 'XI', 'XII', '10', '11', '12'].includes(firstT)) {
        kStr = `Kelas ${firstT}`;
      } else {
        kStr = `${kList.length} Kelas`;
      }
    }
    return kStr ? `${mapelPart} - ${kStr}` : mapelPart;
  }

  return name;
}

function formatKelasBadge(rawKelas) {
  if (!rawKelas || rawKelas.toLowerCase() === 'semua') {
    return `<span class="badge bg-secondary-subtle text-dark border ms-1"><i class="bi bi-mortarboard me-1"></i>Semua Kelas</span>`;
  }
  const list = rawKelas.split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 1) {
    const single = list[0];
    if (single.toUpperCase().startsWith('TINGKAT:')) {
      const tVal = single.split(':')[1];
      return `<span class="badge bg-primary text-white ms-1" title="Semua rombel tingkat ${escapeHtml(tVal)}"><i class="bi bi-mortarboard-fill me-1"></i>Tingkat ${escapeHtml(tVal)}</span>`;
    }
    return `<span class="badge bg-success text-white ms-1"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(single)}</span>`;
  }

  const firstT = list[0].split(/[\s\-_]+/)[0].toUpperCase();
  const allSame = list.every(k => k.split(/[\s\-_]+/)[0].toUpperCase() === firstT);
  const prefix = (allSame && ['X', 'XI', 'XII', '10', '11', '12'].includes(firstT)) ? `Tingkat ${firstT} • ` : '';

  if (list.length <= 2) {
    return `<span class="badge bg-success text-white ms-1" title="${escapeAttr(rawKelas)}"><i class="bi bi-mortarboard me-1"></i>${escapeHtml(list.join(', '))}</span>`;
  }
  return `<span class="badge bg-success-subtle text-success border ms-1" title="${escapeAttr(rawKelas)}" data-bs-toggle="tooltip"><i class="bi bi-mortarboard me-1"></i>${prefix}${list.length} Kelas (${list.slice(0, 2).join(', ')} +${list.length - 2})</span>`;
}

function formatJurusanBadge(rawJurusan) {
  if (!rawJurusan || rawJurusan.toLowerCase() === 'semua') {
    return `<span class="badge bg-secondary ms-1">Semua Jurusan</span>`;
  }
  const list = rawJurusan.split(',').map(s => s.trim()).filter(Boolean);
  if (list.length <= 2) {
    return `<span class="badge bg-info text-dark ms-1" title="${escapeAttr(rawJurusan)}"><i class="bi bi-diagram-3 me-1"></i>${escapeHtml(list.join(', '))}</span>`;
  }
  return `<span class="badge bg-info-subtle text-dark border ms-1" title="${escapeAttr(rawJurusan)}" data-bs-toggle="tooltip"><i class="bi bi-diagram-3 me-1"></i>${list.length} Jurusan (${list.join(', ')})</span>`;
}

let expandedGuruPaketGroups = new Set();
let lastRenderedGuruGroupKeys = [];

function toggleGuruPaketGroup(groupKey) {
  if (!groupKey) return;
  if (expandedGuruPaketGroups.has(groupKey)) {
    expandedGuruPaketGroups.delete(groupKey);
  } else {
    expandedGuruPaketGroups.add(groupKey);
  }
  renderPaketList(allPaket);
}

function toggleAllGuruPaketGroups(expandAll) {
  if (expandAll) {
    lastRenderedGuruGroupKeys.forEach(k => expandedGuruPaketGroups.add(k));
  } else {
    expandedGuruPaketGroups.clear();
  }
  renderPaketList(allPaket);
}

function renderSinglePaketItemHtml(p, isIndented = false) {
  const isActive = String(p.id) === String(activePaketId);
  const cleanTitle = getCleanPaketName(p.nama_paket, p.kelas, p.jurusan);
  const jurusanBadge = formatJurusanBadge(p.jurusan);
  const kelasBadge = formatKelasBadge(p.kelas);
  const soalCount = p.total_soal !== undefined ? p.total_soal : (p.soal_count || 0);
  const soalBadge = `<span class="badge ${soalCount > 0 ? (isActive ? 'bg-light text-primary' : 'bg-primary text-white') : 'bg-warning text-dark'} ms-1 flex-shrink-0" style="font-size: 0.7rem;"><i class="bi bi-question-circle me-1"></i>${soalCount} Soal</span>`;

  if (isIndented) {
    const activeStyle = isActive
      ? 'bg-primary text-white border-primary shadow-sm'
      : 'bg-white text-dark border-light-subtle';
    const subTextClass = isActive ? 'text-white-50' : 'text-muted';
    return `
      <a href="#" class="d-block text-decoration-none p-2 rounded-2 border mb-1 ${activeStyle}" onclick="selectPaket('${escapeAttr(p.id)}'); return false;" style="transition: all 0.15s ease;">
        <div class="d-flex justify-content-between align-items-start gap-1 mb-1">
          <div class="fw-semibold small text-break" style="line-height: 1.25;">
            <i class="bi bi-journal-text me-1 ${isActive ? 'text-white' : 'text-primary'}"></i>${escapeHtml(cleanTitle)}
          </div>
          ${soalBadge}
        </div>
        <div class="d-flex flex-wrap gap-1 align-items-center" style="font-size: 0.72rem;">
          ${jurusanBadge} ${kelasBadge}
        </div>
        <div class="${subTextClass} mt-1" style="font-size: 0.7rem;">
          <i class="bi bi-calendar-event me-1"></i>${p.jadwal_mulai ? new Date(p.jadwal_mulai).toLocaleString() : 'Jadwal belum diatur'}
        </div>
      </a>
    `;
  }

  return `
    <a href="#" class="list-group-item list-group-item-action ${isActive ? 'active' : ''}" onclick="selectPaket('${escapeAttr(p.id)}'); return false;">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <h6 class="mb-0 fw-bold">${escapeHtml(cleanTitle)}</h6>
        ${soalBadge}
      </div>
      <div class="mb-1">${jurusanBadge} ${kelasBadge}</div>
      <small class="mb-0 d-block ${isActive ? 'text-white-50' : 'text-muted'}"><i class="bi bi-calendar-event me-1"></i>${p.jadwal_mulai ? new Date(p.jadwal_mulai).toLocaleString() : 'Belum diatur'}</small>
    </a>
  `;
}

function renderPaketList(list) {
  if (isGuruMode()) {
    checkAndRenderGuruConflictAlert();
  }
  const container = document.getElementById('paket-list-container');
  if (!container) return;
  container.innerHTML = '';

  const filterJurusanEl = document.getElementById('filter-jurusan-paket');
  const selJurusan = filterJurusanEl ? filterJurusanEl.value.toUpperCase().trim() : '';

  const filterKelasEl = document.getElementById('filter-kelas-paket');
  const selKelas = filterKelasEl ? filterKelasEl.value.toUpperCase().trim() : '';

  const filterSearchEl = document.getElementById('filter-search-paket');
  const searchQ = filterSearchEl ? filterSearchEl.value.toLowerCase().trim() : '';

  let filtered = list || allPaket || [];
  if (selJurusan) {
    filtered = filtered.filter(p => {
      const pj = (p.jurusan || '').toUpperCase().trim();
      if (!pj || pj === 'SEMUA') return true;
      return pj.split(',').map(s => s.trim()).includes(selJurusan);
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

  // MODE GURU: tampilkan langsung paket milik guru sendiri tanpa folder tambahan
  if (isGuruMode()) {
    if (searchQ) {
      filtered = filtered.filter(p => {
        const hay = `${p.nama_paket || ''} ${p.kelas || ''} ${p.jurusan || ''}`.toLowerCase();
        return hay.includes(searchQ);
      });
    }
    if (filtered.length === 0) {
      container.innerHTML = `<div class="text-center py-4 text-muted small">Belum ada paket soal yang cocok dengan filter.</div>`;
      return;
    }
    container.innerHTML = `<div class="list-group">${filtered.map(p => renderSinglePaketItemHtml(p, false)).join('')}</div>`;
    return;
  }

  // MODE ADMIN: Kelompokkan Paket Soal sebagai Folder Accordion berdasarkan Nama Guru
  const guruList = Array.isArray(allGuru) ? allGuru : [];
  if (guruList.length === 0 && typeof DB !== 'undefined' && typeof DB.getGuruList === 'function' && !window._fetchingGuruForPaketList) {
    window._fetchingGuruForPaketList = true;
    DB.getGuruList().then(res => {
      allGuru = Array.isArray(res) ? res : [];
      window._fetchingGuruForPaketList = false;
      renderPaketList(list);
    }).catch(e => {
      window._fetchingGuruForPaketList = false;
      console.warn('Gagal memuat guru di renderPaketList:', e);
    });
  }

  const paketById = new Map();
  filtered.forEach(p => paketById.set(String(p.id), p));

  const assignedPaketIds = new Set();
  const guruPaketsMap = new Map();
  guruList.forEach(g => {
    guruPaketsMap.set(String(g.id || g.username), []);
  });

  // Tahap 1: Tautkan paket yang secara eksplisit tercatat di g.paket_ids
  guruList.forEach(g => {
    const gKey = String(g.id || g.username);
    let pids = [];
    if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
    else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try { pids = JSON.parse(g.paket_ids) || []; } catch (e) {}
    }

    pids.forEach(pid => {
      const pk = paketById.get(String(pid));
      if (pk) {
        guruPaketsMap.get(gKey).push(pk);
        assignedPaketIds.add(String(pid));
      }
    });
  });

  // Tahap 2: Smart Assignment Fallback (Pencocokan Cerdas Penugasan Mapel & Rombel)
  // Untuk paket-paket yang belum tertaut via ID eksplisit, pasangkan ke guru yang mengampu mapel & rombel tersebut
  filtered.forEach(pk => {
    const pkIdStr = String(pk.id);
    if (assignedPaketIds.has(pkIdStr)) return;

    const pClean = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
    const pBase = (pClean.split(' - ')[0] || pk.nama_paket || '').split(' (')[0].trim();
    const pFam = typeof normalizeMapelFamily === 'function' ? normalizeMapelFamily(pBase) : pBase.toLowerCase();

    let bestGuru = null;
    let bestScore = -1;

    guruList.forEach(g => {
      let pList = [];
      if (Array.isArray(g.penugasan_mapel)) pList = g.penugasan_mapel;
      else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
        try { const dec = JSON.parse(g.penugasan_mapel); if (Array.isArray(dec)) pList = dec; } catch (e) {}
      }

      // 2a. Evaluasi dari penugasan_mapel
      for (const item of pList) {
        const itemMapel = (item.mapel || '').trim();
        const itemFam = typeof normalizeMapelFamily === 'function' ? normalizeMapelFamily(itemMapel) : itemMapel.toLowerCase();
        const sameMapel = (pFam && itemFam && pFam === itemFam) ||
          String(pk.nama_paket || '').toLowerCase().includes(itemMapel.toLowerCase()) ||
          itemMapel.toLowerCase().includes(pBase.toLowerCase());
        if (!sameMapel) continue;

        const jurMatch = typeof hasJurusanOverlap === 'function' ? hasJurusanOverlap(pk.jurusan, item.jurusan) : true;
        if (!jurMatch) continue;

        const overlaps = typeof getOverlappingClasses === 'function' ? getOverlappingClasses(pk.kelas, item.tingkat) : [];
        let score = 10;
        if (overlaps.length > 0) score += 20;
        if (String(pk.kelas || '').trim().toUpperCase() === String(item.tingkat || '').trim().toUpperCase()) score += 50;

        if (score > bestScore) {
          bestScore = score;
          bestGuru = g;
        }
      }

      // 2b. Evaluasi dari mapel_diampu legacy jika belum ada kecocokan tinggi
      if (bestScore < 30 && g.mapel_diampu) {
        const gMapels = String(g.mapel_diampu).split(/[,;/|]+/).map(s => s.trim()).filter(Boolean);
        for (const m of gMapels) {
          const mFam = typeof normalizeMapelFamily === 'function' ? normalizeMapelFamily(m) : m.toLowerCase();
          const sameM = (pFam && mFam && pFam === mFam) ||
            String(pk.nama_paket || '').toLowerCase().includes(m.toLowerCase()) ||
            m.toLowerCase().includes(pBase.toLowerCase());
          if (!sameM) continue;

          const jurMatch = typeof hasJurusanOverlap === 'function' ? hasJurusanOverlap(pk.jurusan, g.jurusan_diampu) : true;
          if (!jurMatch) continue;

          const overlaps = typeof getOverlappingClasses === 'function' ? getOverlappingClasses(pk.kelas, g.kelas_diampu) : [];
          let score = 5;
          if (overlaps.length > 0) score += 15;
          if (score > bestScore) {
            bestScore = score;
            bestGuru = g;
          }
        }
      }
    });

    if (bestGuru && bestScore > 0) {
      const gKey = String(bestGuru.id || bestGuru.username);
      if (guruPaketsMap.has(gKey)) {
        guruPaketsMap.get(gKey).push(pk);
        assignedPaketIds.add(pkIdStr);
      }
    }
  });

  const groups = [];

  // 1. Bangun grup untuk setiap guru terdaftar
  guruList.forEach(g => {
    const gKey = String(g.id || g.username);
    const guruPakets = guruPaketsMap.get(gKey) || [];

    const namaGuru = g.nama_lengkap || g.username || 'Guru';
    const usernameGuru = g.username || '';

    // Pencarian cepat: cocokkan nama guru/username ATAU nama mapel/paket di dalamnya
    const teacherMatchesSearch = !searchQ ||
      namaGuru.toLowerCase().includes(searchQ) ||
      usernameGuru.toLowerCase().includes(searchQ) ||
      String(g.mapel_diampu || '').toLowerCase().includes(searchQ);

    let visiblePakets = guruPakets;
    if (searchQ && !teacherMatchesSearch) {
      visiblePakets = guruPakets.filter(p => {
        const hay = `${p.nama_paket || ''} ${p.kelas || ''} ${p.jurusan || ''}`.toLowerCase();
        return hay.includes(searchQ);
      });
    }

    // Tampilkan folder guru jika punya paket yg cocok, ATAU jika admin mencari spesifik guru tsb, ATAU tanpa filter jika guru memiliki penugasan
    const hasPenugasan = Boolean(g.mapel_diampu || (Array.isArray(g.penugasan_mapel) ? g.penugasan_mapel.length > 0 : Boolean(g.penugasan_mapel)));
    if (visiblePakets.length > 0 || (searchQ && teacherMatchesSearch && !selJurusan && !selKelas) || (!searchQ && !selJurusan && !selKelas && hasPenugasan)) {
      const mapelNames = Array.from(new Set(
        visiblePakets.map(p => {
          const clean = getCleanPaketName(p.nama_paket, p.kelas, p.jurusan);
          return clean.split(' - ')[0].trim();
        }).filter(Boolean)
      ));
      let pList = [];
      if (Array.isArray(g.penugasan_mapel)) pList = g.penugasan_mapel;
      else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
        try { const dec = JSON.parse(g.penugasan_mapel); if (Array.isArray(dec)) pList = dec; } catch (e) {}
      }
      const penugasanMapelNames = pList.map(p => p.mapel).filter(Boolean);
      const fallbackMapel = penugasanMapelNames.length > 0 ? penugasanMapelNames.join(', ') : String(g.mapel_diampu || '').trim();
      const mapelPreview = mapelNames.length > 0 ? mapelNames.join(', ') : (fallbackMapel || 'Belum ada mapel');

      groups.push({
        key: `guru_${g.id || usernameGuru}`,
        isUnassigned: false,
        nama: namaGuru,
        username: usernameGuru,
        mapelPreview,
        pakets: visiblePakets
      });
    }
  });

  // Urutkan folder guru berdasarkan abjad nama
  groups.sort((a, b) => a.nama.localeCompare(b.nama, 'id', { sensitivity: 'base' }));

  // 2. Paket yang belum tertaut ke guru manapun (Paket Umum / Buatan Admin langsung)
  let unassignedPakets = filtered.filter(p => !assignedPaketIds.has(String(p.id)));
  if (searchQ) {
    const labelMatch = 'paket umum tanpa guru admin'.includes(searchQ);
    if (!labelMatch) {
      unassignedPakets = unassignedPakets.filter(p => {
        const hay = `${p.nama_paket || ''} ${p.kelas || ''} ${p.jurusan || ''}`.toLowerCase();
        return hay.includes(searchQ);
      });
    }
  }
  if (unassignedPakets.length > 0) {
    groups.push({
      key: 'guru_unassigned',
      isUnassigned: true,
      nama: 'Paket Umum / Tanpa Guru',
      username: 'Admin CBT',
      mapelPreview: `${unassignedPakets.length} paket belum ditautkan ke guru`,
      pakets: unassignedPakets
    });
  }

  lastRenderedGuruGroupKeys = groups.map(g => g.key);

  // Perbarui ringkasan jumlah guru & paket
  const summaryEl = document.getElementById('paket-guru-group-summary');
  if (summaryEl) {
    const guruCount = groups.filter(g => !g.isUnassigned).length;
    const totalVisiblePakets = groups.reduce((acc, g) => acc + g.pakets.length, 0);
    summaryEl.innerHTML = `<i class="bi bi-people-fill text-primary me-1"></i><strong>${guruCount}</strong> Guru &bull; <strong>${totalVisiblePakets}</strong> Paket`;
  }

  if (groups.length === 0) {
    container.innerHTML = `<div class="text-center py-4 text-muted small"><i class="bi bi-search d-block fs-4 mb-1"></i>Tidak ada guru atau paket soal yang cocok dengan filter.</div>`;
    return;
  }

  // Render Folder Accordion per Nama Guru
  const html = groups.map(grp => {
    const hasActiveChild = grp.pakets.some(p => String(p.id) === String(activePaketId));
    if (hasActiveChild) {
      expandedGuruPaketGroups.add(grp.key);
    }
    const isExpanded = Boolean(searchQ) || expandedGuruPaketGroups.has(grp.key);

    const totalSoal = grp.pakets.reduce((sum, p) => sum + (Number(p.total_soal !== undefined ? p.total_soal : (p.soal_count || 0)) || 0), 0);
    const soalBadgeClass = totalSoal > 0
      ? 'bg-success-subtle text-success border border-success-subtle'
      : 'bg-warning-subtle text-dark border border-warning-subtle';

    const iconClass = grp.isUnassigned ? 'bi-folder2-open text-secondary' : 'bi-person-circle text-primary';
    const headerBg = hasActiveChild
      ? 'bg-primary-subtle border-primary'
      : (isExpanded ? 'bg-light border-secondary-subtle' : 'bg-white');

    const bodyHtml = isExpanded
      ? `
        <div class="p-2 pt-1 bg-light bg-opacity-50 border-top">
          ${grp.pakets.length > 0
            ? grp.pakets.map(p => renderSinglePaketItemHtml(p, true)).join('')
            : `<div class="text-muted small fst-italic py-2 px-2">Guru ini belum memiliki paket soal.</div>`
          }
        </div>
      `
      : '';

    return `
      <div class="border rounded-3 mb-2 overflow-hidden shadow-sm flex-shrink-0 ${hasActiveChild ? 'border-primary' : 'border-light-subtle'}">
        <button type="button"
          class="w-100 text-start border-0 p-2 px-3 d-flex align-items-center justify-content-between gap-2 ${headerBg}"
          onclick="toggleGuruPaketGroup('${escapeAttr(grp.key)}')"
          style="cursor: pointer;">
          <div class="d-flex align-items-center gap-2 overflow-hidden" style="min-width: 0;">
            <i class="bi ${isExpanded ? 'bi-chevron-down text-primary' : 'bi-chevron-right text-muted'} flex-shrink-0" style="font-size: 0.78rem;"></i>
            <i class="bi ${iconClass} fs-5 flex-shrink-0"></i>
            <div class="overflow-hidden" style="min-width: 0;">
              <div class="fw-bold text-dark text-truncate" style="font-size: 0.86rem;" title="${escapeAttr(grp.nama)}">${escapeHtml(grp.nama)}</div>
              <div class="text-muted text-truncate" style="font-size: 0.72rem;" title="${escapeAttr(grp.mapelPreview)}">
                <i class="bi bi-book me-1"></i>${escapeHtml(grp.mapelPreview)}
              </div>
            </div>
          </div>
          <div class="d-flex flex-column align-items-end gap-1 flex-shrink-0">
            <span class="badge bg-primary-subtle text-primary border border-primary-subtle" style="font-size: 0.68rem;">${grp.pakets.length} Paket</span>
            <span class="badge ${soalBadgeClass}" style="font-size: 0.68rem;">${totalSoal} Soal</span>
          </div>
        </button>
        ${bodyHtml}
      </div>
    `;
  }).join('');

  container.innerHTML = html;
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
  if (isGuruMode()) {
    Swal.fire({
      icon: 'info',
      title: 'Akses Dibatasi',
      text: 'Wadah paket soal telah disiapkan dan dikelola oleh Admin CBT. Akun Guru bertugas untuk mengisi dan mengelola butir soal.'
    });
    return;
  }

  document.getElementById('paketFormTitle').innerText = "Buat Paket Soal Baru";
  document.getElementById('form-paket-crud').reset();
  document.getElementById('paket-id').value = "";
  const hintEl = document.getElementById('paket-agama-hint');
  if (hintEl) hintEl.classList.add('d-none');
  populateJurusanDropdowns();
  populateKelasDropdowns();
  document.getElementById('crud-paket-jurusan').value = "";
  document.getElementById('crud-paket-kelas').value = "";

  // Kelola pilihan Guru Pengampu (Solusi 1)
  const guruWrapper = document.getElementById('crud-paket-guru-wrapper');
  const selGuru = document.getElementById('crud-paket-guru');
  if (isGuruMode()) {
    if (guruWrapper) guruWrapper.classList.add('d-none');
  } else {
    if (guruWrapper) guruWrapper.classList.remove('d-none');
    if (selGuru) {
      selGuru.innerHTML = '<option value="">-- Tanpa Penugasan Khusus (Otomatis Sesuai Mapel) --</option>' +
        (allGuru || []).map(g => `<option value="${escapeAttr(g.id)}">${escapeHtml(g.nama_lengkap || g.username)} (${escapeHtml(g.username)})</option>`).join('');
      selGuru.value = "";
    }
  }

  // Jika login sebagai Guru Mapel, isi otomatis nama paket, jurusan, dan kelas sesuai yang diampu
  if (isGuruMode()) {
    const penugasanList = getGuruPenugasanList();
    if (penugasanList.length > 0) {
      const first = penugasanList[0];
      if (first.mapel) {
        document.getElementById('crud-paket-nama').value = first.mapel;
        detectPaketAgamaHint(first.mapel);
      }
      if (first.jurusan) {
        const selJ = document.getElementById('crud-paket-jurusan');
        if (selJ) selJ.value = (first.jurusan === 'SEMUA') ? '' : first.jurusan;
      }
      if (first.tingkat) {
        const selK = document.getElementById('crud-paket-kelas');
        if (selK) selK.value = (first.tingkat === 'SEMUA') ? '' : first.tingkat;
      }
    } else if (currentAdminUser.mapel_diampu) {
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
        selJ.innerHTML = `<option value="">Semua Jurusan (Umum)</option>` +
          guruJurusans.map(j => `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`).join('');
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

  // Kelola pilihan Guru Pengampu (Solusi 1)
  const guruWrapper = document.getElementById('crud-paket-guru-wrapper');
  const selGuru = document.getElementById('crud-paket-guru');
  if (isGuruMode()) {
    if (guruWrapper) guruWrapper.classList.add('d-none');
  } else {
    if (guruWrapper) guruWrapper.classList.remove('d-none');
    if (selGuru) {
      selGuru.innerHTML = '<option value="">-- Tanpa Penugasan Khusus (Otomatis Sesuai Mapel) --</option>' +
        (allGuru || []).map(g => `<option value="${escapeAttr(g.id)}">${escapeHtml(g.nama_lengkap || g.username)} (${escapeHtml(g.username)})</option>`).join('');
      
      const assignedGuru = (allGuru || []).find(g => {
        let pids = [];
        if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
        else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
          try { pids = JSON.parse(g.paket_ids); } catch(e){}
        }
        return Array.isArray(pids) && pids.map(String).includes(String(p.id));
      });
      selGuru.value = assignedGuru ? String(assignedGuru.id) : "";
    }
  }

  document.getElementById('paketFormTitle').innerText = "Edit Paket Soal";
  document.getElementById('paket-id').value = p.id;
  document.getElementById('crud-paket-nama').value = getCleanPaketName(p.nama_paket, p.kelas, p.jurusan);
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
  if (!id && isGuruMode()) {
    Swal.fire({
      icon: 'warning',
      title: 'Akses Dibatasi',
      text: 'Akun Guru tidak diizinkan membuat paket ujian baru. Wadah paket disiapkan oleh Admin CBT.'
    });
    return;
  }
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

  // Cek Warning Tabrakan Paket Soal dengan Guru Lain sebelum menyimpan paket
  const selGuruElCheck = document.getElementById('crud-paket-guru');
  const targetGuruIdCheck = isGuruMode()
    ? String(currentAdminUser?.id || '')
    : (selGuruElCheck ? String(selGuruElCheck.value || '') : '');
  const baseMapelCheck = nama.split(' - ')[0].split(' (')[0].trim();
  const conflictPaketsCheck = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const paketConflicts = detectMapelKelasConflicts(
    targetGuruIdCheck,
    [{ mapel: baseMapelCheck, tingkat: kelas, jurusan: jurusan }],
    allGuru,
    conflictPaketsCheck,
    id
  );
  if (paketConflicts.length > 0) {
    const listHtml = paketConflicts.slice(0, 6).map(c =>
      `<li class="mb-1 text-danger">Mata Pelajaran <strong>${escapeHtml(c.mapel)}</strong> pada kelas <span class="badge bg-danger text-white">${escapeHtml(c.overlapText)}</span> sudah dibuat paket soalnya oleh <strong>${escapeHtml(c.otherGuruName)}</strong></li>`
    ).join('');
    await Swal.fire({
      icon: 'error',
      title: 'Tidak Bisa Simpan Paket Soal!',
      html: `
        <div class="text-start small">
          <div class="alert alert-danger py-2 px-3 mb-2 border-danger shadow-sm">
            <div class="fw-bold mb-1"><i class="bi bi-x-octagon-fill me-1"></i>Terdeteksi Tabrakan Kelas dengan Guru Lain:</div>
            <ul class="mt-2 mb-1 ps-3">${listHtml}</ul>
          </div>
          <div class="text-muted">
            Satu rombel/kelas tidak boleh memiliki paket soal ganda dari guru berbeda untuk mata pelajaran yang sama. Silakan ubah target kelas paket ini agar tidak bentrok.
          </div>
        </div>
      `,
      confirmButtonText: '<i class="bi bi-pencil-square me-1"></i> Kembali & Ubah Target Kelas',
      confirmButtonColor: '#dc3545'
    });
    return; // DIBUAT TIDAK BISA SIMPAN!
  }

  const btn = document.getElementById('btn-save-paket');
  btn.disabled = true;

  try {
    const res = await DB.savePaket(id, payload);
    const savedPaketId = String(id || (res && res.id));
    
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

    // Sinkronisasi Guru Pengampu jika disimpan oleh Admin (Solusi 1)
    if (!isGuruMode() && savedPaketId) {
      const selGuruEl = document.getElementById('crud-paket-guru');
      const targetGuruId = selGuruEl ? String(selGuruEl.value || '') : '';

      for (const g of (allGuru || [])) {
        let pids = [];
        if (Array.isArray(g.paket_ids)) pids = [...g.paket_ids];
        else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
          try { pids = JSON.parse(g.paket_ids) || []; } catch(e){}
        }
        pids = pids.map(String);

        if (String(g.id) === targetGuruId) {
          // Tambahkan paket jika belum terdaftar
          if (!pids.includes(savedPaketId)) {
            pids.push(savedPaketId);
            await DB.saveGuru(g.id, {
              username: g.username,
              nama_lengkap: g.nama_lengkap,
              mapel_diampu: g.mapel_diampu,
              jurusan_diampu: g.jurusan_diampu || '',
              kelas_diampu: g.kelas_diampu || '',
              paket_ids: pids
            });
            g.paket_ids = pids;
          }
        } else {
          // Jika guru lain sebelumnya memegang paket ini tetapi sekarang dialihkan/dilepas:
          if (pids.includes(savedPaketId)) {
            pids = pids.filter(x => x !== savedPaketId);
            await DB.saveGuru(g.id, {
              username: g.username,
              nama_lengkap: g.nama_lengkap,
              mapel_diampu: g.mapel_diampu,
              jurusan_diampu: g.jurusan_diampu || '',
              kelas_diampu: g.kelas_diampu || '',
              paket_ids: pids
            });
            g.paket_ids = pids;
          }
        }
      }
    }

    Swal.fire('Berhasil', 'Paket soal berhasil disimpan.', 'success');
    paketFormModalInstance.hide();
    
    if (!id && res && res.id) activePaketId = res.id;
    
    await loadPaket();
    await refreshJurusanDanKelas();
    if (!isGuruMode()) {
      await loadGuru();
    }
  } catch (err) {
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deletePaket() {
  if (!activePaketId) return;
  const p = (allPaket || []).find(item => String(item.id) === String(activePaketId));
  if (!p) return;

  // Pengaman: Guru hanya boleh menghapus paket soal yang termasuk dalam cakupan akunnya sendiri
  if (isGuruMode() && !isPaketAllowedForGuru(p)) {
    Swal.fire({
      icon: 'warning',
      title: 'Akses Dibatasi',
      text: 'Anda hanya dapat menghapus paket soal milik mata pelajaran/akun Anda sendiri.'
    });
    return;
  }

  const displayName = getCleanPaketName(p.nama_paket, p.kelas, p.jurusan);
  const result = await Swal.fire({
    title: 'Hapus Paket Soal?',
    html: `Anda akan menghapus paket <strong>"${escapeHtml(displayName)}"</strong>.<br><small class="text-danger">Semua butir pertanyaan di dalam paket ini akan ikut terhapus secara permanen.</small>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Hapus Paket!',
    cancelButtonText: 'Batal'
  });

  if (result.isConfirmed) {
    const deletedId = String(activePaketId);
    try {
      await DB.deletePaket(deletedId);

      // Bersihkan referensi paket_ids pada akun guru yang sedang login agar tidak ada badge paket yatim di daftar-guru.html
      if (isGuruMode() && currentAdminUser && currentAdminUser.id) {
        try {
          const curIds = getGuruAllowedPaketIds();
          if (curIds.includes(deletedId)) {
            const nextIds = curIds.filter(pid => String(pid) !== deletedId);
            currentAdminUser.paket_ids = nextIds;
            try {
              sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(currentAdminUser));
            } catch (e) {}
            await DB.saveGuru(currentAdminUser.id, {
              username: currentAdminUser.username,
              nama_lengkap: currentAdminUser.nama_lengkap,
              mapel_diampu: currentAdminUser.mapel_diampu || '',
              jurusan_diampu: currentAdminUser.jurusan_diampu || '',
              kelas_diampu: currentAdminUser.kelas_diampu || '',
              paket_ids: nextIds,
              penugasan_mapel: currentAdminUser.penugasan_mapel || []
            });
          }
        } catch (syncErr) {
          console.warn('Gagal membersihkan referensi paket_ids guru:', syncErr);
        }
      }

      Swal.fire('Dihapus!', 'Paket Soal telah berhasil dihapus.', 'success');
      activePaketId = null;
      const detailEl = document.getElementById('paket-detail-container');
      const emptyEl = document.getElementById('paket-empty-state');
      if (detailEl) detailEl.classList.add('d-none');
      if (emptyEl) emptyEl.classList.remove('d-none');

      await loadPaket();
      if (!isGuruMode()) {
        await refreshJurusanDanKelas();
      }
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
  
  const cleanTitle = getCleanPaketName(p.nama_paket, p.kelas, p.jurusan);
  const jBadge = formatJurusanBadge(p.jurusan);
  const kBadge = formatKelasBadge(p.kelas);
  const soalCount = p.total_soal !== undefined ? p.total_soal : (p.soal_count || 0);

  let guruBadge = '';
  if (!isGuruMode() && allGuru && allGuru.length > 0) {
    const assignedGuru = allGuru.find(g => {
      let pids = [];
      if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
      else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
        try { pids = JSON.parse(g.paket_ids); } catch(e){}
      }
      return Array.isArray(pids) && pids.map(String).includes(String(p.id));
    });
    if (assignedGuru) {
      guruBadge = `<span class="badge bg-success-subtle text-success border border-success ms-1 fs-6 align-middle"><i class="bi bi-person-badge me-1"></i>Guru: ${escapeHtml(assignedGuru.nama_lengkap || assignedGuru.username)}</span>`;
    }
  }

  document.getElementById('active-paket-title').innerHTML = `
    <span class="align-middle fw-bold text-dark">${escapeHtml(cleanTitle)}</span>
    <span class="badge ${soalCount > 0 ? 'bg-primary' : 'bg-warning text-dark'} fs-6 ms-2 align-middle" id="active-paket-soal-count"><i class="bi bi-question-circle me-1"></i>${soalCount} Soal</span>
    ${jBadge}
    ${kBadge}
    ${guruBadge}
  `;

  const btnDelete = document.getElementById('btn-delete-paket');
  if (btnDelete) {
    if (!isGuruMode() || isPaketAllowedForGuru(p)) {
      btnDelete.classList.remove('d-none');
    } else {
      btnDelete.classList.add('d-none');
    }
  }
  
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

const MATH_SUPERSCRIPT_MAP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', '/': 'ᐟ',
  'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'f': 'ᶠ',
  'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ', 'k': 'ᵏ', 'l': 'ˡ',
  'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ', 'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ',
  't': 'ᵗ', 'u': 'ᵘ', 'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
  'A': 'ᴬ', 'B': 'ᴮ', 'D': 'ᴰ', 'E': 'ᴱ', 'G': 'ᴳ', 'H': 'ᴴ',
  'I': 'ᴵ', 'J': 'ᴶ', 'K': 'ᴷ', 'L': 'ᴸ', 'M': 'ᴹ', 'N': 'ᴺ',
  'O': 'ᴼ', 'P': 'ᴾ', 'R': 'ᴿ', 'T': 'ᵀ', 'U': 'ᵁ', 'V': 'ⱽ', 'W': 'ᵂ'
};

const MATH_SUPERSCRIPT_REVERSE_MAP = Object.fromEntries(
  Object.entries(MATH_SUPERSCRIPT_MAP).map(([k, v]) => [v, k])
);

const MATH_SUBSCRIPT_MAP = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎'
};

const MATH_SUBSCRIPT_REVERSE_MAP = Object.fromEntries(
  Object.entries(MATH_SUBSCRIPT_MAP).map(([k, v]) => [v, k])
);

function toUnicodeSuperscript(expStr) {
  const chars = Array.from(String(expStr || ''));
  if (chars.length === 0) return '';
  const mapped = [];
  for (const ch of chars) {
    if (ch === ' ') continue;
    if (MATH_SUPERSCRIPT_MAP[ch]) {
      mapped.push(MATH_SUPERSCRIPT_MAP[ch]);
    } else if (MATH_SUPERSCRIPT_REVERSE_MAP[ch]) {
      mapped.push(ch);
    } else {
      return null;
    }
  }
  return mapped.join('');
}

function toUnicodeSubscript(subStr) {
  const chars = Array.from(String(subStr || ''));
  if (chars.length === 0) return '';
  const mapped = [];
  for (const ch of chars) {
    if (ch === ' ') continue;
    if (MATH_SUBSCRIPT_MAP[ch]) {
      mapped.push(MATH_SUBSCRIPT_MAP[ch]);
    } else if (MATH_SUBSCRIPT_REVERSE_MAP[ch]) {
      mapped.push(ch);
    } else {
      return null;
    }
  }
  return mapped.join('');
}

function formatMathExponents(text) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  if (!s) return '';

  // 1. Konversi tag HTML <sup>...</sup> dan <sub>...</sub> menjadi karakter Unicode pangkat/subskrip
  s = s.replace(/<\s*sup\b[^>]*>([\s\S]*?)<\s*\/\s*sup\s*>/gi, (m, inner) => {
    const sup = toUnicodeSuperscript(inner.replace(/<[^>]+>/g, '').trim());
    return sup !== null ? sup : m;
  });
  s = s.replace(/<\s*sub\b[^>]*>([\s\S]*?)<\s*\/\s*sub\s*>/gi, (m, inner) => {
    const sub = toUnicodeSubscript(inner.replace(/<[^>]+>/g, '').trim());
    return sub !== null ? sub : m;
  });

  // Pisahkan tag HTML (seperti <img src="...">) agar atribut di dalam tag tidak ikut diubah
  const parts = s.split(/(<[^>]+>)/g);
  const baseCharClass = '[A-Za-z0-9\\)\\]\\u00B2\\u00B3\\u00B9\\u2070-\\u209F\\u03C0]';
  const reBraced = new RegExp(`(${baseCharClass})[ \\t]*\\^[ \\t]*\\{([0-9+\\-=()a-zA-Z\\/\\s]+)\\}`, 'g');
  const reParen = new RegExp(`(${baseCharClass})[ \\t]*\\^[ \\t]*\\(([0-9+\\-=a-zA-Z\\/\\s]+)\\)`, 'g');
  const reDirect = new RegExp(`(${baseCharClass})[ \\t]*\\^[ \\t]*([+\\-]?\\d+(?:\\/\\d+)?(?:[a-zA-Z](?![a-zA-Z]))?|[a-zA-Z](?![a-zA-Z]))`, 'g');
  const reSubBraced = new RegExp(`(${baseCharClass})_\\{([0-9+\\-=()]+)\\}`, 'g');

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg || (seg.startsWith('<') && seg.endsWith('>'))) continue;

    let t = seg;

    // Bersihkan pembungkus LaTeX ($...$, \(...\), \[...\]) dan simbol matematika umum
    t = t
      .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
      .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
      .replace(/\$([^$\n]{1,120})\$/g, (m, inner) => {
        if (/[\^_\\0-9+\-=*/()]/.test(inner)) return inner;
        return m;
      })
      .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1/$2)')
      .replace(/\\sqrt\s*\{([^{}]+)\}/g, '√($1)')
      .replace(/\\times\b/g, '×')
      .replace(/\\div\b/g, '÷')
      .replace(/\\pm\b/g, '±')
      .replace(/\\leq?\b/g, '≤')
      .replace(/\\geq?\b/g, '≥')
      .replace(/\\neq?\b/g, '≠')
      .replace(/\\cdot\b/g, '·')
      .replace(/\\pi\b/g, 'π')
      .replace(/\^\\circ\b|\\degree\b/g, '°');

    // Jalankan hingga 3 putaran agar pangkat bertingkat seperti (2^3)^4 atau 2^2^3 terkonversi tuntas
    for (let pass = 0; pass < 3; pass++) {
      const before = t;
      t = t.replace(reBraced, (m, base, exp) => {
        const sup = toUnicodeSuperscript(exp);
        return sup !== null ? `${base}${sup}` : m;
      });
      t = t.replace(reParen, (m, base, exp) => {
        const sup = toUnicodeSuperscript(exp);
        return sup !== null ? `${base}${sup}` : m;
      });
      t = t.replace(reDirect, (m, base, exp) => {
        const sup = toUnicodeSuperscript(exp);
        return sup !== null ? `${base}${sup}` : m;
      });
      t = t.replace(reSubBraced, (m, base, sub) => {
        const conv = toUnicodeSubscript(sub);
        return conv !== null ? `${base}${conv}` : m;
      });
      if (t === before) break;
    }

    // Bersihkan koma liar di akhir opsi angka berpangkat dari AI (contoh: "3¹," -> "3¹")
    if (/^[0-9a-zA-Z\s+\-×÷()⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᐟ]+,$/.test(t.trim()) && /[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(t)) {
      t = t.replace(/,\s*$/, '');
    }

    parts[i] = t;
  }

  return parts.join('');
}

function splitWacanaAndQuestion(rawText) {
  const s = String(rawText || '');
  const match = s.match(/^\s*\[WACANA\]\s*([\s\S]*?)\s*\[\/WACANA\]\s*([\s\S]*)$/i);
  if (match) {
    return {
      wacana: match[1].trim(),
      question: match[2].trim()
    };
  }
  return { wacana: '', question: s };
}

function combineWacanaAndQuestion(wacana, question) {
  const cleanW = String(wacana || '')
    .replace(/^\s*\[WACANA\]\s*/i, '')
    .replace(/\s*\[\/WACANA\]\s*$/i, '')
    .trim();
  const cleanQ = String(question || '').trim();
  if (!cleanW) return cleanQ;
  return `[WACANA]\n${cleanW}\n[/WACANA]\n${cleanQ}`;
}

function renderMathHtmlCore(rawText) {
  if (rawText === null || rawText === undefined) return '';
  const normalized = formatMathExponents(String(rawText));
  if (!normalized) return '';

  const supChars = Object.values(MATH_SUPERSCRIPT_MAP).join('');
  const subChars = Object.values(MATH_SUBSCRIPT_MAP).join('');
  const supRegex = new RegExp(`[${supChars.replace(/[\\\]^-]/g, '\\$&')}]+`, 'g');
  const subRegex = new RegExp(`[${subChars.replace(/[\\\]^-]/g, '\\$&')}]+`, 'g');

  // Pisahkan tag HTML aman (<img ...>, <br>) jika ada, sedangkan teks biasa di-escape lalu diubah ke <sup>/<sub>
  const tokens = normalized.split(/(<\s*img\b[^>]*>|<\s*br\s*\/?>)/gi);
  return tokens.map(tok => {
    if (!tok) return '';
    if (/^<\s*(img\b|br\b)/i.test(tok)) return tok;
    let esc = escapeHtml(tok);
    esc = esc.replace(supRegex, (match) => {
      const ascii = Array.from(match).map(ch => MATH_SUPERSCRIPT_REVERSE_MAP[ch] || ch).join('');
      return `<sup>${escapeHtml(ascii)}</sup>`;
    });
    esc = esc.replace(subRegex, (match) => {
      const ascii = Array.from(match).map(ch => MATH_SUBSCRIPT_REVERSE_MAP[ch] || ch).join('');
      return `<sub>${escapeHtml(ascii)}</sub>`;
    });
    return esc;
  }).join('');
}

// Merender teks soal/opsi ke HTML dengan tag <sup>...</sup>, <sub>...</sub>, dan Kotak Wacana jika soal memiliki [WACANA]...[/WACANA]
function renderMathHtml(rawText) {
  if (rawText === null || rawText === undefined) return '';
  const { wacana, question } = splitWacanaAndQuestion(rawText);
  if (wacana) {
    return `<div class="p-2 px-3 mb-2 rounded border-start border-4 border-primary bg-white text-dark small shadow-xs" style="max-height: 180px; overflow-y: auto; white-space: pre-wrap; font-weight: 400; line-height: 1.6; border: 1px solid #cbd5e1;"><div class="fw-bold text-primary mb-1"><i class="bi bi-book-half me-1"></i>Teks Wacana / Bacaan:</div>${renderMathHtmlCore(wacana)}</div><div>${renderMathHtmlCore(question)}</div>`;
  }
  return renderMathHtmlCore(question);
}

let lastFocusedSoalFieldId = 'crud-soal-pertanyaan';
let soalMathInputsInitialized = false;

function initSoalMathInputs() {
  if (soalMathInputsInitialized) return;
  const fieldIds = [
    'crud-soal-wacana',
    'crud-soal-pertanyaan',
    'crud-soal-opsia',
    'crud-soal-opsib',
    'crud-soal-opsic',
    'crud-soal-opsid',
    'crud-soal-opsie'
  ];
  // Regex konversi live saat guru mengetik spasi atau tanda baca setelah pangkat (cth: "2^2 " -> "2² ")
  const liveCaretRegex = /([A-Za-z0-9\)\]])\^([+\-]?\d+|[a-zA-Z])([\s,;:.?!+\-*/=)\]])$/;

  fieldIds.forEach(fid => {
    const el = document.getElementById(fid);
    if (!el) return;
    el.addEventListener('focus', () => {
      lastFocusedSoalFieldId = fid;
    });
    el.addEventListener('input', () => {
      const pos = typeof el.selectionStart === 'number' ? el.selectionStart : null;
      if (pos === null) return;
      const beforeCursor = el.value.slice(0, pos);
      if (liveCaretRegex.test(beforeCursor)) {
        const replacedBefore = formatMathExponents(beforeCursor);
        if (replacedBefore !== beforeCursor) {
          const afterCursor = el.value.slice(pos);
          el.value = replacedBefore + afterCursor;
          const newPos = replacedBefore.length;
          try { el.setSelectionRange(newPos, newPos); } catch (e) {}
        }
      }
    });
    el.addEventListener('paste', () => {
      setTimeout(() => {
        const formatted = formatMathExponents(el.value);
        if (formatted !== el.value) el.value = formatted;
      }, 10);
    });
    // Otomatis ubah 2^2 -> 2² saat guru selesai mengetik di kolom tersebut (blur)
    el.addEventListener('blur', () => {
      const formatted = formatMathExponents(el.value);
      if (formatted !== el.value) {
        el.value = formatted;
      }
    });
  });

  const wordRawEl = document.getElementById('word-raw-input');
  if (wordRawEl) {
    wordRawEl.addEventListener('blur', () => {
      const formatted = formatMathExponents(wordRawEl.value);
      if (formatted !== wordRawEl.value) wordRawEl.value = formatted;
    });
  }

  soalMathInputsInitialized = true;
}

function insertMathSymbol(symbol) {
  initSoalMathInputs();
  const target = document.getElementById(lastFocusedSoalFieldId) || document.getElementById('crud-soal-pertanyaan');
  if (!target) return;

  const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
  const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.value.length;
  const val = target.value || '';

  target.value = val.slice(0, start) + symbol + val.slice(end);
  target.focus();
  const nextCursor = start + symbol.length;
  try {
    target.setSelectionRange(nextCursor, nextCursor);
  } catch (e) {}
}

function convertAllSoalFormExponents() {
  const fieldIds = [
    'crud-soal-wacana',
    'crud-soal-pertanyaan',
    'crud-soal-opsia',
    'crud-soal-opsib',
    'crud-soal-opsic',
    'crud-soal-opsid',
    'crud-soal-opsie'
  ];
  fieldIds.forEach(fid => {
    const el = document.getElementById(fid);
    if (el && el.value) {
      el.value = formatMathExponents(el.value);
    }
  });
}

let lastUsedWacanaText = '';

function copyWacanaFromPrevSoal() {
  const wacanaEl = document.getElementById('crud-soal-wacana');
  if (!wacanaEl) return;

  const curNo = parseInt(document.getElementById('crud-soal-nomor')?.value) || (allSoal.length + 1);
  // Cari wacana dari soal sebelumnya terdekat di paket ini
  let foundWacana = '';
  const sorted = [...(allSoal || [])].sort((a, b) => (Number(b.nomor) || 0) - (Number(a.nomor) || 0));
  for (const s of sorted) {
    if ((Number(s.nomor) || 0) < curNo) {
      const { wacana } = splitWacanaAndQuestion(s.pertanyaan);
      if (wacana) {
        foundWacana = wacana;
        break;
      }
    }
  }
  if (!foundWacana) {
    for (const s of sorted) {
      const { wacana } = splitWacanaAndQuestion(s.pertanyaan);
      if (wacana) {
        foundWacana = wacana;
        break;
      }
    }
  }
  if (!foundWacana && lastUsedWacanaText) {
    foundWacana = lastUsedWacanaText;
  }

  if (!foundWacana) {
    Swal.fire('Belum Ada Wacana', 'Belum ditemukan teks wacana pada soal-soal sebelumnya di paket ini. Silakan tempel teks wacana pada soal pertama terlebih dahulu.', 'info');
    return;
  }

  wacanaEl.value = foundWacana;
  wacanaEl.focus();
}

function clearSoalWacanaInput() {
  const wacanaEl = document.getElementById('crud-soal-wacana');
  if (wacanaEl) wacanaEl.value = '';
}

async function applyWacanaToSoalRangePrompt() {
  const wacanaEl = document.getElementById('crud-soal-wacana');
  const wacanaText = formatMathExponents((wacanaEl?.value || '').trim());
  if (!wacanaText) {
    Swal.fire('Wacana Masih Kosong', 'Silakan isi atau tempel Teks Wacana / Bacaan pada kotak wacana terlebih dahulu.', 'warning');
    return;
  }
  if (!allSoal || allSoal.length === 0) {
    Swal.fire('Belum Ada Soal', 'Simpan soal ini terlebih dahulu atau buat butir soal di paket ini sebelum menerapkan wacana ke rentang nomor.', 'info');
    return;
  }

  const curNo = parseInt(document.getElementById('crud-soal-nomor')?.value) || 1;
  const maxNo = Math.max(...allSoal.map(s => Number(s.nomor) || 1), curNo);

  const { value: rangeVals } = await Swal.fire({
    title: 'Terapkan Wacana ke Beberapa Soal',
    html: `
      <div class="text-start small mb-2">Pasang teks wacana ini sekaligus ke soal nomor:</div>
      <div class="d-flex align-items-center gap-2 justify-content-center">
        <div>
          <label class="small fw-bold">Dari Nomor</label>
          <input type="number" id="swal-wacana-start" class="form-control text-center" min="1" value="${curNo}">
        </div>
        <span class="mt-3 fw-bold">s.d.</span>
        <div>
          <label class="small fw-bold">Sampai Nomor</label>
          <input type="number" id="swal-wacana-end" class="form-control text-center" min="1" value="${Math.min(curNo + 3, maxNo)}">
        </div>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Terapkan Wacana',
    cancelButtonText: 'Batal',
    confirmButtonColor: '#198754',
    preConfirm: () => {
      const sNo = parseInt(document.getElementById('swal-wacana-start')?.value);
      const eNo = parseInt(document.getElementById('swal-wacana-end')?.value);
      if (!sNo || !eNo || sNo < 1 || eNo < sNo) {
        Swal.showValidationMessage('Rentang nomor soal tidak valid.');
        return false;
      }
      return { sNo, eNo };
    }
  });

  if (!rangeVals) return;

  const targets = (allSoal || []).filter(s => {
    const n = Number(s.nomor) || 0;
    return n >= rangeVals.sNo && n <= rangeVals.eNo;
  });

  if (targets.length === 0) {
    Swal.fire('Tidak Ditemukan', `Tidak ada soal dengan nomor antara ${rangeVals.sNo} s.d. ${rangeVals.eNo} yang sudah tersimpan di paket ini.`, 'warning');
    return;
  }

  Swal.fire({
    title: 'Menerapkan Wacana...',
    text: `Memperbarui ${targets.length} butir soal...`,
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    for (const s of targets) {
      const { question } = splitWacanaAndQuestion(s.pertanyaan);
      const updatedPertanyaan = combineWacanaAndQuestion(wacanaText, question);
      await DB.saveSoal(s.id, {
        paket_soal_id: s.paket_soal_id || activePaketId,
        nomor: s.nomor,
        bobot: s.bobot || 1,
        pertanyaan: updatedPertanyaan,
        opsi_a: s.opsi_a,
        opsi_b: s.opsi_b,
        opsi_c: s.opsi_c || null,
        opsi_d: s.opsi_d || null,
        opsi_e: s.opsi_e || null,
        jawaban_benar: s.jawaban_benar,
        gambar: s.gambar || null
      });
    }
    lastUsedWacanaText = wacanaText;
    await loadSoal();
    Swal.fire('Berhasil!', `Teks wacana berhasil diterapkan ke ${targets.length} soal (No. ${rangeVals.sNo} s.d. ${rangeVals.eNo}).`, 'success');
  } catch (err) {
    Swal.fire('Gagal', err.message || 'Terjadi kesalahan saat menerapkan wacana.', 'error');
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
        <div class="col-md-6"><strong>A.</strong> ${renderMathHtml(s.opsi_a)}</div>
        <div class="col-md-6"><strong>B.</strong> ${renderMathHtml(s.opsi_b)}</div>
    `;

    if (!isBs) {
      optionsHtml += `
        <div class="col-md-6"><strong>C.</strong> ${renderMathHtml(s.opsi_c || '-')}</div>
        <div class="col-md-6"><strong>D.</strong> ${renderMathHtml(s.opsi_d || '-')}</div>
      `;
      if (s.opsi_e) {
        optionsHtml += `
          <div class="col-md-6"><strong>E.</strong> ${renderMathHtml(s.opsi_e)}</div>
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
            <h6 class="fw-semibold text-dark mt-1" style="white-space: pre-wrap;">${renderMathHtml(s.pertanyaan)}</h6>
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
  initSoalMathInputs();
  lastFocusedSoalFieldId = 'crud-soal-pertanyaan';
  document.getElementById('soalFormTitle').innerText = "Tambah Soal Baru";
  document.getElementById('form-soal-crud').reset();
  document.getElementById('soal-id').value = "";
  document.getElementById('crud-soal-nomor').value = allSoal.length + 1;
  const elWacana = document.getElementById('crud-soal-wacana');
  if (elWacana) elWacana.value = "";
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
  initSoalMathInputs();
  lastFocusedSoalFieldId = 'crud-soal-pertanyaan';
  const s = allSoal.find(item => item.id === id);
  if (!s) return;

  const { wacana, question } = splitWacanaAndQuestion(s.pertanyaan);

  document.getElementById('soalFormTitle').innerText = "Edit Soal Ujian";
  document.getElementById('soal-id').value = s.id;
  document.getElementById('crud-soal-nomor').value = s.nomor;
  document.getElementById('crud-soal-bobot').value = s.bobot;
  const elWacana = document.getElementById('crud-soal-wacana');
  if (elWacana) elWacana.value = formatMathExponents(wacana);
  document.getElementById('crud-soal-pertanyaan').value = formatMathExponents(question);
  document.getElementById('crud-soal-opsia').value = formatMathExponents(s.opsi_a);
  document.getElementById('crud-soal-opsib').value = formatMathExponents(s.opsi_b);
  document.getElementById('crud-soal-opsic').value = formatMathExponents(s.opsi_c || "");
  document.getElementById('crud-soal-opsid').value = formatMathExponents(s.opsi_d || "");
  const elOpsiE = document.getElementById('crud-soal-opsie');
  if (elOpsiE) elOpsiE.value = formatMathExponents(s.opsi_e || "");
  
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
  const wacanaVal = formatMathExponents((document.getElementById('crud-soal-wacana')?.value || '').trim());
  if (wacanaVal) lastUsedWacanaText = wacanaVal;
  const qCore = formatMathExponents(document.getElementById('crud-soal-pertanyaan').value.trim());
  const q = combineWacanaAndQuestion(wacanaVal, qCore);
  const oa = formatMathExponents(document.getElementById('crud-soal-opsia').value.trim());
  const ob = formatMathExponents(document.getElementById('crud-soal-opsib').value.trim());
  const oc = formatMathExponents(document.getElementById('crud-soal-opsic').value.trim());
  const od = formatMathExponents(document.getElementById('crud-soal-opsid').value.trim());
  const oe = formatMathExponents((document.getElementById('crud-soal-opsie')?.value || '').trim());
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

function htmlToPlainTextForExport(rawHtml) {
  if (rawHtml === null || rawHtml === undefined) return '';
  let str = formatMathExponents(String(rawHtml));
  // Ganti tag gambar menjadi label ringkas agar tidak melebihi batas sel Excel (32.767 karakter)
  str = str.replace(/<img\b[^>]*>/gi, ' [Gambar] ');
  // Pertahankan jeda baris dari tag blok/br
  str = str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  const tmp = document.createElement('div');
  tmp.innerHTML = str;
  return (tmp.textContent || tmp.innerText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeFilenamePart(str) {
  return String(str || 'Paket')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Paket';
}

function formatKelasExportText(raw) {
  if (!raw || String(raw).trim().toUpperCase() === 'SEMUA') return 'Semua Kelas';
  return String(raw)
    .split(',')
    .map(s => {
      const clean = s.trim();
      if (!clean) return '';
      return clean.toUpperCase().startsWith('TINGKAT:') ? `Tingkat ${clean.split(':')[1]}` : clean;
    })
    .filter(Boolean)
    .join(', ') || 'Semua Kelas';
}

function getPaketOwnerNameMap() {
  const map = new Map();
  if (isGuruMode() && currentAdminUser) {
    const guruName = currentAdminUser.nama_lengkap || currentAdminUser.username || 'Guru Mapel';
    (allPaket || []).forEach(pk => { if (pk && pk.id) map.set(String(pk.id), guruName); });
    return map;
  }
  const gurus = Array.isArray(allGuru) ? allGuru : [];
  const pakets = Array.isArray(allPaketUnfiltered) && allPaketUnfiltered.length > 0
    ? allPaketUnfiltered
    : (Array.isArray(allPaket) ? allPaket : []);

  // 1. Explicit paket_ids
  gurus.forEach(g => {
    const gName = g.nama_lengkap || g.username || '';
    if (!gName) return;
    let pids = [];
    if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
    else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try { const p = JSON.parse(g.paket_ids); if (Array.isArray(p)) pids = p; } catch (e) {}
    }
    pids.forEach(pid => {
      if (pid && !map.has(String(pid))) map.set(String(pid), gName);
    });
  });

  // 2. Smart fallback untuk paket yang belum tertaut via explicit ID
  pakets.forEach(pk => {
    if (!pk || !pk.id) return;
    const pkIdStr = String(pk.id);
    if (map.has(pkIdStr)) return;

    const pClean = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
    const pBase = (pClean.split(' - ')[0] || pk.nama_paket || '').split(' (')[0].trim();
    const pFam = typeof normalizeMapelFamily === 'function' ? normalizeMapelFamily(pBase) : pBase.toLowerCase();

    let bestGuruName = '';
    let bestScore = -1;

    gurus.forEach(g => {
      const gName = g.nama_lengkap || g.username || '';
      if (!gName) return;

      let pList = [];
      if (Array.isArray(g.penugasan_mapel)) pList = g.penugasan_mapel;
      else if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
        try { const dec = JSON.parse(g.penugasan_mapel); if (Array.isArray(dec)) pList = dec; } catch (e) {}
      }

      for (const item of pList) {
        const itemFam = typeof normalizeMapelFamily === 'function' ? normalizeMapelFamily(item.mapel) : (item.mapel || '').toLowerCase();
        const sameMapel = (pFam && itemFam && pFam === itemFam) ||
          String(pk.nama_paket || '').toLowerCase().includes(String(item.mapel || '').toLowerCase()) ||
          String(item.mapel || '').toLowerCase().includes(pBase.toLowerCase());
        if (!sameMapel) continue;

        const jurMatch = typeof hasJurusanOverlap === 'function' ? hasJurusanOverlap(pk.jurusan, item.jurusan) : true;
        if (!jurMatch) continue;

        const overlaps = typeof getOverlappingClasses === 'function' ? getOverlappingClasses(pk.kelas, item.tingkat) : [];
        let score = 10;
        if (overlaps.length > 0) score += 20;
        if (String(pk.kelas || '').trim().toUpperCase() === String(item.tingkat || '').trim().toUpperCase()) score += 50;

        if (score > bestScore) {
          bestScore = score;
          bestGuruName = gName;
        }
      }

      if (bestScore < 30 && g.mapel_diampu) {
        const gFam = typeof normalizeMapelFamily === 'function' ? normalizeMapelFamily(g.mapel_diampu) : (g.mapel_diampu || '').toLowerCase();
        if ((pFam && gFam && pFam === gFam) || String(pk.nama_paket || '').toLowerCase().includes(String(g.mapel_diampu).toLowerCase())) {
          const jurMatch = typeof hasJurusanOverlap === 'function' ? hasJurusanOverlap(pk.jurusan, g.jurusan_diampu) : true;
          if (jurMatch) {
            const overlaps = typeof getOverlappingClasses === 'function' ? getOverlappingClasses(pk.kelas, g.kelas_diampu) : [];
            let score = 5;
            if (overlaps.length > 0) score += 15;
            if (score > bestScore) {
              bestScore = score;
              bestGuruName = gName;
            }
          }
        }
      }
    });

    if (bestGuruName && bestScore > 0) {
      map.set(pkIdStr, bestGuruName);
    }
  });

  return map;
}

function exportSoalData() {
  if (!activePaketId) {
    Swal.fire('Pilih Paket Dulu', 'Silakan pilih paket soal terlebih dahulu untuk mengunduh soalnya.', 'info');
    return;
  }
  if (!allSoal || allSoal.length === 0) {
    Swal.fire('Ekspor Kosong', 'Paket ini belum memiliki butir soal untuk diunduh.', 'warning');
    return;
  }

  const pk = (allPaket || []).find(p => String(p.id) === String(activePaketId))
    || (allPaketUnfiltered || []).find(p => String(p.id) === String(activePaketId));
  const paketName = pk ? getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan) : 'Paket_Soal';
  const todayStr = new Date().toISOString().split('T')[0];

  const headers = ['Nomor', 'Pertanyaan', 'Opsi A', 'Opsi B', 'Opsi C', 'Opsi D', 'Opsi E', 'Jawaban Benar', 'Bobot'];
  const sorted = [...allSoal].sort((a, b) => (Number(a.nomor) || 0) - (Number(b.nomor) || 0));
  const rows = [headers];

  sorted.forEach((s, idx) => {
    rows.push([
      s.nomor || (idx + 1),
      htmlToPlainTextForExport(s.pertanyaan),
      htmlToPlainTextForExport(s.opsi_a),
      htmlToPlainTextForExport(s.opsi_b),
      htmlToPlainTextForExport(s.opsi_c),
      htmlToPlainTextForExport(s.opsi_d),
      htmlToPlainTextForExport(s.opsi_e),
      String(s.jawaban_benar || '').toUpperCase().trim(),
      Number(s.bobot) || 1
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 8 },  // Nomor
    { wch: 55 }, // Pertanyaan
    { wch: 28 }, // Opsi A
    { wch: 28 }, // Opsi B
    { wch: 28 }, // Opsi C
    { wch: 28 }, // Opsi D
    { wch: 28 }, // Opsi E
    { wch: 15 }, // Jawaban Benar
    { wch: 8 }   // Bobot
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Soal');

  const safeName = sanitizeFilenamePart(paketName);
  XLSX.writeFile(wb, `Soal_${safeName}_${todayStr}.xlsx`);
}

function exportPaketSoalWord() {
  if (!activePaketId) {
    Swal.fire('Pilih Paket Dulu', 'Silakan pilih paket soal terlebih dahulu untuk mengunduh naskah soal.', 'info');
    return;
  }
  if (!allSoal || allSoal.length === 0) {
    Swal.fire('Naskah Kosong', 'Paket ini belum memiliki butir soal untuk diunduh.', 'warning');
    return;
  }

  const pk = (allPaket || []).find(p => String(p.id) === String(activePaketId))
    || (allPaketUnfiltered || []).find(p => String(p.id) === String(activePaketId));
  const paketName = pk ? getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan) : 'Paket Soal';
  const ownerMap = getPaketOwnerNameMap();
  const guruName = ownerMap.get(String(activePaketId)) || (isGuruMode() && currentAdminUser ? (currentAdminUser.nama_lengkap || '-') : '-');
  const kelasText = pk ? formatKelasExportText(pk.kelas) : 'Semua Kelas';
  const jurusanText = (pk && pk.jurusan && String(pk.jurusan).trim().toUpperCase() !== 'SEMUA') ? pk.jurusan : 'Semua Jurusan';
  const sorted = [...allSoal].sort((a, b) => (Number(a.nomor) || 0) - (Number(b.nomor) || 0));

  const soalBlocks = sorted.map((s, idx) => {
    const no = s.nomor || (idx + 1);
    const opts = [
      { key: 'A', val: s.opsi_a },
      { key: 'B', val: s.opsi_b },
      { key: 'C', val: s.opsi_c },
      { key: 'D', val: s.opsi_d },
      { key: 'E', val: s.opsi_e }
    ].filter(o => o.val !== null && o.val !== undefined && String(o.val).trim() !== '');

    const optsHtml = opts.map(o => `
      <tr>
        <td style="width: 24px; vertical-align: top; font-weight: bold;">${o.key}.</td>
        <td style="vertical-align: top;">${renderMathHtml(o.val)}</td>
      </tr>
    `).join('');

    return `
      <div style="margin-bottom: 14px; page-break-inside: avoid;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="width: 28px; vertical-align: top; font-weight: bold;">${no}.</td>
            <td style="vertical-align: top;">
              <div style="margin-bottom: 6px;">${renderMathHtml(s.pertanyaan || '')}</div>
              <table style="width: 100%; border-collapse: collapse; margin-left: 4px;">
                ${optsHtml}
              </table>
            </td>
          </tr>
        </table>
      </div>
    `;
  }).join('');

  const keyCells = sorted.map((s, idx) =>
    `<td style="border: 1px solid #333; padding: 4px 8px; text-align: center;"><strong>${s.nomor || (idx + 1)}.</strong> ${escapeHtml(String(s.jawaban_benar || '-').toUpperCase())}</td>`
  );
  const keyRows = [];
  for (let i = 0; i < keyCells.length; i += 10) {
    keyRows.push(`<tr>${keyCells.slice(i, i + 10).join('')}</tr>`);
  }

  const docHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:w="urn:schemas-microsoft-com:office:word"
          xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <title>${escapeHtml(paketName)}</title>
      <style>
        body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.45; color: #111; }
        img { max-width: 480px; height: auto; }
        .kop { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 16px; }
        .meta td { padding: 2px 6px; font-size: 11pt; }
      </style>
    </head>
    <body>
      <div class="kop">
        <h2 style="margin: 0 0 6px 0; text-align: center;">NASKAH BANK SOAL CBT</h2>
        <table class="meta" style="width: 100%; border-collapse: collapse;">
          <tr><td style="width: 140px;"><strong>Paket / Mapel</strong></td><td>: ${escapeHtml(paketName)}</td></tr>
          <tr><td><strong>Guru Pengampu</strong></td><td>: ${escapeHtml(guruName)}</td></tr>
          <tr><td><strong>Tingkat / Kelas</strong></td><td>: ${escapeHtml(kelasText)}</td></tr>
          <tr><td><strong>Jurusan</strong></td><td>: ${escapeHtml(jurusanText)}</td></tr>
          <tr><td><strong>Jumlah Soal</strong></td><td>: ${sorted.length} butir</td></tr>
        </table>
      </div>
      ${soalBlocks}
      <div style="margin-top: 24px; border-top: 1px dashed #666; padding-top: 12px; page-break-before: auto;">
        <h4 style="margin: 0 0 8px 0;">KUNCI JAWABAN</h4>
        <table style="border-collapse: collapse; font-size: 10.5pt;">
          ${keyRows.join('')}
        </table>
      </div>
    </body>
    </html>
  `;

  const blob = new Blob(['\ufeff', docHtml], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const todayStr = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `Naskah_Soal_${sanitizeFilenamePart(paketName)}_${todayStr}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportAllBankSoalExcel() {
  // Pastikan daftar paket sudah termuat
  let targetPakets = isGuruMode()
    ? (allPaket || [])
    : ((allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []));

  if (targetPakets.length === 0) {
    try {
      const fetched = await DB.getPaketList();
      if (Array.isArray(fetched)) {
        allPaketUnfiltered = fetched;
        targetPakets = isGuruMode() ? fetched.filter(pk => isPaketAllowedForGuru(pk)) : fetched;
      }
    } catch (e) {
      Swal.fire('Gagal Memuat', e.message || 'Tidak dapat memuat daftar paket ujian.', 'error');
      return;
    }
  }

  if (targetPakets.length === 0) {
    Swal.fire('Ekspor Kosong', 'Belum ada paket ujian di Bank Soal untuk diekspor.', 'warning');
    return;
  }

  // Pastikan daftar guru termuat (mode Admin) untuk melengkapi kolom Guru Pengampu
  if (!isGuruMode() && (!allGuru || allGuru.length === 0)) {
    try { allGuru = await DB.getGuruList() || []; } catch (e) {}
  }

  Swal.fire({
    title: 'Menyiapkan Export Bank Soal...',
    html: `Mengambil data soal dari <strong>0 / ${targetPakets.length}</strong> paket ujian...`,
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const ownerMap = getPaketOwnerNameMap();
    const soalByPaket = new Map();
    let doneCount = 0;

    // Ambil soal per paket secara paralel (batch 5) agar terhindar dari limit 1000 baris Supabase
    const BATCH_SIZE = 5;
    for (let i = 0; i < targetPakets.length; i += BATCH_SIZE) {
      const batch = targetPakets.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (pk) => {
        try {
          const list = await DB.getSoalByPaket(pk.id);
          return { id: String(pk.id), list: Array.isArray(list) ? list : [] };
        } catch (err) {
          console.warn(`Gagal ambil soal paket ${pk.nama_paket}:`, err);
          return { id: String(pk.id), list: [] };
        }
      }));
      results.forEach(r => soalByPaket.set(r.id, r.list));
      doneCount += batch.length;
      const htmlEl = Swal.getHtmlContainer();
      if (htmlEl) {
        htmlEl.innerHTML = `Mengambil data soal dari <strong>${Math.min(doneCount, targetPakets.length)} / ${targetPakets.length}</strong> paket ujian...`;
      }
    }

    const formatJadwal = (iso) => {
      if (!iso) return '-';
      const d = new Date(iso);
      return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('id-ID');
    };

    const rekapHeaders = [
      'No',
      'Guru Pengampu',
      'Nama Paket Ujian',
      'Tingkat / Kelas',
      'Jurusan',
      'Jumlah Soal',
      'Jadwal Mulai',
      'Jadwal Selesai'
    ];
    const rekapRows = [rekapHeaders];

    const soalHeaders = [
      'No',
      'Guru Pengampu',
      'Nama Paket Ujian',
      'Tingkat / Kelas',
      'Jurusan',
      'Nomor Soal',
      'Pertanyaan',
      'Opsi A',
      'Opsi B',
      'Opsi C',
      'Opsi D',
      'Opsi E',
      'Jawaban Benar',
      'Bobot'
    ];
    const soalRows = [soalHeaders];
    let globalSoalNo = 1;

    // Urutkan paket berdasarkan nama guru lalu nama paket agar rapi saat dibuka di Excel
    const sortedPakets = [...targetPakets].sort((a, b) => {
      const gA = (ownerMap.get(String(a.id)) || 'ZZZ').toLowerCase();
      const gB = (ownerMap.get(String(b.id)) || 'ZZZ').toLowerCase();
      if (gA !== gB) return gA.localeCompare(gB);
      return String(a.nama_paket || '').localeCompare(String(b.nama_paket || ''));
    });

    sortedPakets.forEach((pk, idx) => {
      const guruName = ownerMap.get(String(pk.id)) || '-';
      const paketName = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
      const kelasText = formatKelasExportText(pk.kelas);
      const jurText = (pk.jurusan && String(pk.jurusan).trim().toUpperCase() !== 'SEMUA') ? pk.jurusan : 'Semua Jurusan';
      const questions = (soalByPaket.get(String(pk.id)) || []).sort((a, b) => (Number(a.nomor) || 0) - (Number(b.nomor) || 0));

      rekapRows.push([
        idx + 1,
        guruName,
        paketName,
        kelasText,
        jurText,
        questions.length,
        formatJadwal(pk.jadwal_mulai),
        formatJadwal(pk.jadwal_selesai)
      ]);

      questions.forEach((s, qIdx) => {
        soalRows.push([
          globalSoalNo++,
          guruName,
          paketName,
          kelasText,
          jurText,
          s.nomor || (qIdx + 1),
          htmlToPlainTextForExport(s.pertanyaan),
          htmlToPlainTextForExport(s.opsi_a),
          htmlToPlainTextForExport(s.opsi_b),
          htmlToPlainTextForExport(s.opsi_c),
          htmlToPlainTextForExport(s.opsi_d),
          htmlToPlainTextForExport(s.opsi_e),
          String(s.jawaban_benar || '').toUpperCase().trim(),
          Number(s.bobot) || 1
        ]);
      });
    });

    const wb = XLSX.utils.book_new();

    const wsRekap = XLSX.utils.aoa_to_sheet(rekapRows);
    wsRekap['!cols'] = [
      { wch: 5 },  // No
      { wch: 28 }, // Guru Pengampu
      { wch: 38 }, // Nama Paket Ujian
      { wch: 26 }, // Tingkat / Kelas
      { wch: 18 }, // Jurusan
      { wch: 13 }, // Jumlah Soal
      { wch: 20 }, // Jadwal Mulai
      { wch: 20 }  // Jadwal Selesai
    ];
    XLSX.utils.book_append_sheet(wb, wsRekap, 'Rekap Paket Ujian');

    const wsSoal = XLSX.utils.aoa_to_sheet(soalRows);
    wsSoal['!cols'] = [
      { wch: 6 },  // No
      { wch: 26 }, // Guru Pengampu
      { wch: 34 }, // Nama Paket
      { wch: 22 }, // Kelas
      { wch: 16 }, // Jurusan
      { wch: 11 }, // Nomor Soal
      { wch: 52 }, // Pertanyaan
      { wch: 26 }, // Opsi A
      { wch: 26 }, // Opsi B
      { wch: 26 }, // Opsi C
      { wch: 26 }, // Opsi D
      { wch: 26 }, // Opsi E
      { wch: 14 }, // Jawaban Benar
      { wch: 8 }   // Bobot
    ];
    XLSX.utils.book_append_sheet(wb, wsSoal, 'Bank Soal');

    const todayStr = new Date().toISOString().split('T')[0];
    const suffix = isGuruMode() && currentAdminUser
      ? `_${sanitizeFilenamePart(currentAdminUser.nama_lengkap || currentAdminUser.username)}`
      : '';
    const fileName = `Bank_Soal_dan_Paket_Ujian${suffix}_${todayStr}.xlsx`;
    XLSX.writeFile(wb, fileName);

    Swal.fire({
      icon: 'success',
      title: 'Export Berhasil!',
      html: `Berhasil mengunduh <strong>${sortedPakets.length} paket ujian</strong> dengan total <strong>${globalSoalNo - 1} butir soal</strong> ke file <code>${escapeHtml(fileName)}</code>.`,
      confirmButtonColor: '#198754'
    });
  } catch (err) {
    console.error('Export semua bank soal gagal:', err);
    Swal.fire('Gagal Export', err.message || 'Terjadi kesalahan saat mengekspor Bank Soal.', 'error');
  }
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

async function bersihkanHasilSimulasiModal() {
  if (isGuruMode()) {
    Swal.fire('Akses Ditolak', 'Hanya Administrator Utama yang berwenang mengosongkan seluruh rekap hasil ujian.', 'warning');
    return;
  }

  const countHasil = (allHasil || []).length;
  if (countHasil === 0) {
    Swal.fire({
      icon: 'info',
      title: 'Tabel Nilai Sudah Bersih',
      text: 'Tidak ada data hasil ujian yang tersimpan saat ini. Sistem sudah dalam kondisi kosong/fresh.'
    });
    return;
  }

  const result = await Swal.fire({
    title: 'Bersihkan Seluruh Hasil Simulasi?',
    html: `
      <div class="text-start">
        <p class="mb-2">Tindakan ini bertujuan untuk <strong>mengosongkan seluruh data jejak simulasi</strong> agar sistem siap 100% FRESH sebelum hari-H ujian utama dimulai.</p>
        
        <div class="alert alert-danger py-2 px-3 mb-3 border-danger shadow-sm">
          <div class="d-flex align-items-center mb-1">
            <i class="bi bi-exclamation-triangle-fill me-2 fs-5 text-danger"></i>
            <strong class="text-danger">Peringatan Penghapusan:</strong>
          </div>
          <small class="text-dark d-block">
            Sebanyak <strong>${countHasil} data nilai hasil simulasi</strong> dan seluruh rekaman jawaban sementara akan <strong>DIHAPUS PERMANEN</strong> dari server.
          </small>
        </div>

        <div class="bg-success-subtle p-3 rounded-3 border border-success mb-3 small">
          <div class="fw-bold text-success mb-1"><i class="bi bi-shield-check me-1"></i> Data yang DIJAMIN AMAN (TIDAK AKAN HILANG):</div>
          <ul class="mb-0 ps-3 text-secondary">
            <li><strong>Data Peserta (${(allPeserta || []).length} siswa)</strong>: Akun, password, dan kartu ujian tetap utuh.</li>
            <li><strong>Bank Soal & Paket Soal</strong>: Seluruh butir soal, opsi jawaban, gambar, dan kunci tetap aman.</li>
            <li><strong>Data Master</strong>: Rombel kelas, jurusan, akun guru, dan pengaturan sistem tetap aman.</li>
          </ul>
        </div>

        <div class="bg-light p-2 rounded border mb-2 small text-muted">
          <i class="bi bi-info-circle me-1 text-primary"></i> <em>Tips: Pastikan Anda telah menekan tombol <strong>Download Nilai (Excel)</strong> terlebih dahulu jika sekolah membutuhkan dokumen arsip nilai simulasi.</em>
        </div>

        <p class="small text-danger fw-bold text-center mt-3 mb-1">Ketik kata <span class="badge bg-danger">KOSONGKAN</span> di bawah untuk konfirmasi:</p>
      </div>
    `,
    icon: 'warning',
    input: 'text',
    inputPlaceholder: 'Ketik KOSONGKAN...',
    inputAttributes: {
      autocapitalize: 'characters',
      autocomplete: 'off',
      style: 'text-align: center; font-weight: bold; font-size: 1.1rem; letter-spacing: 2px; text-transform: uppercase;'
    },
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    confirmButtonText: '<i class="bi bi-trash3-fill me-1"></i> Ya, Kosongkan Nilai Simulasi',
    cancelButtonColor: '#6c757d',
    cancelButtonText: 'Batal',
    reverseButtons: true,
    preConfirm: (inputVal) => {
      if (!inputVal || inputVal.trim().toUpperCase() !== 'KOSONGKAN') {
        Swal.showValidationMessage('Ketik kata KOSONGKAN dengan tepat untuk melanjutkan!');
        return false;
      }
      return true;
    }
  });

  if (result.isConfirmed) {
    Swal.fire({
      title: 'Membersihkan Hasil Simulasi...',
      html: 'Menghapus nilai simulasi, jawaban lama, & mereset kehadiran siswa...',
      allowOutsideClick: false,
      didOpen: () => { Swal.showLoading(); }
    });

    try {
      await DB.bersihkanHasilSimulasi();
      allHasil = [];
      await loadHasil();
      await loadDashboardStats(true);
      await loadPeserta();

      Swal.fire({
        icon: 'success',
        title: 'Sistem 100% Fresh & Bersih!',
        html: `
          <div class="text-center">
            <p class="mb-2 text-success fw-bold"><i class="bi bi-check-circle-fill me-1"></i> Seluruh Hasil Simulasi Berhasil Dikosongkan!</p>
            <p class="small text-muted mb-2">Tabel Hasil Ujian kini telah bersih (0 data nilai). Status seluruh peserta telah dikembalikan ke <strong>"Belum Ujian"</strong> dengan 0 pelanggaran.</p>
            <div class="alert alert-light border small text-dark p-2 mb-0">
              <i class="bi bi-stars text-warning me-1"></i> Sistem CBT SMKN 1 Lempuing kini dalam kondisi <strong>siap total</strong> untuk pelaksanaan hari-H ujian utama.
            </div>
          </div>
        `,
        confirmButtonColor: '#0d6efd',
        confirmButtonText: 'Selesai'
      });
    } catch (err) {
      console.error("Gagal bersihkan hasil simulasi:", err);
      Swal.fire('Gagal Membersihkan', err.message || 'Terjadi kesalahan saat mengosongkan hasil simulasi.', 'error');
    }
  }
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
  } else if (mode === 'guru') {
    title.innerText = "Import Akun Guru dari Excel";
    btnTemplate.setAttribute('onclick', 'ExcelTemplates.downloadGuruTemplate()');
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
    } else if (importMode === 'guru') {
      importedDataCache = await ExcelHelpers.parseGuruExcel(file);
      renderImportPreviewGuru(importedDataCache);
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

function renderImportPreviewGuru(data) {
  const table = document.getElementById('excel-preview-table');
  const existingUsers = new Set((allGuru || []).map(g => (g.username || '').trim().toLowerCase()));
  const seenInFile = new Set();

  let html = `
    <thead>
      <tr>
        <th style="width: 45px;">No</th>
        <th>Username</th>
        <th>Nama Lengkap & Gelar</th>
        <th>Password</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
  `;

  data.slice(0, 15).forEach((r, idx) => {
    let statusBadge = `<span class="badge bg-success-subtle text-success border border-success-subtle">Siap Disimpan</span>`;
    if (!r.username || !r.nama_lengkap || !r.password) {
      statusBadge = `<span class="badge bg-danger-subtle text-danger border border-danger-subtle">Data Belum Lengkap</span>`;
    } else if (existingUsers.has(r.username)) {
      statusBadge = `<span class="badge bg-warning-subtle text-dark border border-warning-subtle">Sudah Terdaftar (Lewati)</span>`;
    } else if (seenInFile.has(r.username)) {
      statusBadge = `<span class="badge bg-warning-subtle text-dark border border-warning-subtle">Duplikat di Excel</span>`;
    }
    if (r.username) seenInFile.add(r.username);

    html += `
      <tr>
        <td class="text-muted">${idx + 1}</td>
        <td><code>${escapeHtml(r.username || '-')}</code></td>
        <td class="fw-semibold">${escapeHtml(r.nama_lengkap || '-')}</td>
        <td><code>${escapeHtml(r.password || '-')}</code></td>
        <td>${statusBadge}</td>
      </tr>
    `;
  });

  if (data.length > 15) {
    html += `<tr><td colspan="5" class="text-center text-muted">...dan ${data.length - 15} akun guru lainnya...</td></tr>`;
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
        <td class="text-truncate" style="max-width: 150px;">${renderMathHtml(r.pertanyaan)}</td>
        <td>${renderMathHtml(r.opsi_a)}</td>
        <td>${renderMathHtml(r.opsi_b)}</td>
        <td>${renderMathHtml(r.opsi_c || '-')}</td>
        <td>${renderMathHtml(r.opsi_d || '-')}</td>
        <td>${renderMathHtml(r.opsi_e || '-')}</td>
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
    } else if (importMode === 'guru') {
      let success = 0;
      let fails = 0;
      const failedDetails = [];

      for (let i = 0; i < importedDataCache.length; i++) {
        const item = importedDataCache[i];
        Swal.update({
          html: `Mengimpor akun guru ${i + 1} dari ${importedDataCache.length}...<br>Berhasil: <strong>${success}</strong>, Gagal/Dilewati: <strong>${fails}</strong>`
        });

        try {
          if (!item.username || !item.nama_lengkap || !item.password) {
            throw new Error('Username, Password, dan Nama Lengkap wajib diisi.');
          }
          await DB.saveGuru('', {
            username: item.username,
            nama_lengkap: item.nama_lengkap,
            mapel_diampu: '',
            jurusan_diampu: '',
            kelas_diampu: '',
            paket_ids: [],
            penugasan_mapel: []
          }, item.password);
          success++;
        } catch (err) {
          console.error("Gagal mengimpor guru:", item.username, err);
          fails++;
          if (failedDetails.length < 15) {
            failedDetails.push(`<li><code>${escapeHtml(item.username || '-')}</code> (${escapeHtml(item.nama_lengkap || '-')}): ${escapeHtml(err.message || 'Gagal disimpan')}</li>`);
          }
        }
      }

      let resultHtml = `Proses import akun guru selesai.<br>Berhasil: <strong>${success}</strong>, Gagal/Dilewati: <strong>${fails}</strong>`;
      if (failedDetails.length > 0) {
        resultHtml += `<div class="text-start small mt-3 p-2 bg-light border rounded" style="max-height:160px;overflow-y:auto;"><strong>Daftar baris yang gagal/dilewati:</strong><ul class="mb-0 ps-3 mt-1">${failedDetails.join('')}</ul></div>`;
      } else if (success > 0) {
        resultHtml += `<div class="small text-muted mt-2">Selanjutnya Anda atau Bapak/Ibu Guru dapat mengatur mata pelajaran melalui tombol <strong>+ Tambah Mapel</strong>.</div>`;
      }

      Swal.fire({
        title: 'Import Akun Guru Selesai',
        html: resultHtml,
        icon: fails === 0 ? 'success' : 'warning'
      });
      await loadGuru();
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
// WORD / TEXT IMPORT WORKFLOWS (.docx & Copy-Paste)
// -------------------------------------------------------------

function openImportWordModal() {
  if (!activePaketId) {
    Swal.fire({
      icon: 'warning',
      title: 'Pilih Paket Soal',
      text: 'Silakan pilih atau buat paket soal terlebih dahulu di panel sebelah kiri sebelum mengimpor soal.',
      confirmButtonColor: '#1e3c72'
    });
    return;
  }

  const p = (allPaket || []).find(item => String(item.id) === String(activePaketId));
  const pName = p ? (p.nama_paket || 'Paket Soal') : 'Paket Soal';

  const titleEl = document.getElementById('importWordModalTitle');
  if (titleEl) {
    titleEl.innerHTML = `<i class="bi bi-file-earmark-word-fill me-2 text-primary"></i>Import Soal Word: <strong>${escapeHtml(pName)}</strong>`;
  }

  // Reset inputs & preview
  wordImportedDataCache = [];
  const rawInput = document.getElementById('word-raw-input');
  if (rawInput) rawInput.value = '';
  const fileInput = document.getElementById('word-file-input');
  if (fileInput) fileInput.value = '';
  const fileLabel = document.getElementById('word-file-name-label');
  if (fileLabel) fileLabel.innerText = '';

  const previewSec = document.getElementById('word-preview-section');
  if (previewSec) previewSec.classList.add('d-none');

  const btnSave = document.getElementById('btn-save-word-import');
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Simpan ke Bank Soal`;
  }

  // Switch to tab 1 (Paste) by default
  const tabPasteBtn = document.getElementById('tab-word-paste');
  if (tabPasteBtn && typeof bootstrap !== 'undefined' && bootstrap.Tab) {
    const tabTrigger = new bootstrap.Tab(tabPasteBtn);
    tabTrigger.show();
  }

  if (importWordModalInstance) {
    importWordModalInstance.show();
  }
}

function initWordDropZone() {
  const dropArea = document.getElementById('drop-area-word');
  if (!dropArea) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropArea.classList.add('bg-primary-subtle', 'border-primary');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropArea.classList.remove('bg-primary-subtle', 'border-primary');
    }, false);
  });

  dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    const files = dt ? dt.files : null;
    if (files && files.length > 0) {
      handleWordFile(files[0]);
    }
  });
}

function handleWordFileUpload(input) {
  if (!input || !input.files || input.files.length === 0) return;
  handleWordFile(input.files[0]);
}

function handleWordFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.docx')) {
    Swal.fire({
      icon: 'warning',
      title: 'Format Berkas Salah',
      text: 'Harap unggah berkas berekstensi .docx (Microsoft Word). Jika berkas bertipe .doc lama, silakan buka di Word dan simpan sebagai .docx, atau salin (copy-paste) teksnya langsung.'
    });
    return;
  }

  const fileLabel = document.getElementById('word-file-name-label');
  if (fileLabel) {
    fileLabel.innerHTML = `<i class="bi bi-file-earmark-check-fill text-success me-1"></i>${escapeHtml(file.name)} (${(file.size / 1024).toFixed(1)} KB)`;
  }

  if (typeof mammoth === 'undefined') {
    Swal.fire('Library Belum Siap', 'Pustaka pembaca berkas Word sedang dimuat. Harap periksa koneksi internet Anda atau gunakan fitur Tempel Teks Word (Copy-Paste).', 'error');
    return;
  }

  Swal.fire({
    title: 'Membaca Berkas Word...',
    html: `Mengekstrak teks dari <strong>${escapeHtml(file.name)}</strong>...`,
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  const reader = new FileReader();
  reader.onload = function(e) {
    const arrayBuffer = e.target.result;
    // Gunakan convertToHtml terlebih dahulu agar format Superscript (pangkat 2²) & Subscript (H₂O) asli dari Microsoft Word tidak hilang
    const extractPromise = (typeof mammoth.convertToHtml === 'function')
      ? mammoth.convertToHtml({ arrayBuffer: arrayBuffer }).then(function(htmlRes) {
          let html = htmlRes.value || '';
          if (!html) return mammoth.extractRawText({ arrayBuffer: arrayBuffer });
          // Ubah <sup>...</sup> dan <sub>...</sub> menjadi karakter pangkat/subskrip Unicode
          html = formatMathExponents(html);
          html = html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          const text = (tmp.textContent || tmp.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
          return { value: text };
        }).catch(function() {
          return mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        })
      : mammoth.extractRawText({ arrayBuffer: arrayBuffer });

    extractPromise
      .then(function(result) {
        Swal.close();
        const extractedText = formatMathExponents((result.value || '').trim());
        if (!extractedText) {
          Swal.fire('Berkas Kosong', 'Tidak ditemukan teks pada berkas Word yang diunggah.', 'warning');
          return;
        }

        const rawInput = document.getElementById('word-raw-input');
        if (rawInput) rawInput.value = extractedText;

        // Beralih ke tab 1 (Paste) agar guru bisa melihat teks yang diekstrak
        const tabPasteBtn = document.getElementById('tab-word-paste');
        if (tabPasteBtn && typeof bootstrap !== 'undefined' && bootstrap.Tab) {
          const tabTrigger = new bootstrap.Tab(tabPasteBtn);
          tabTrigger.show();
        }

        // Jalankan parsing otomatis
        triggerParseWordText();
      })
      .catch(function(err) {
        console.error(err);
        Swal.fire('Gagal Membaca File', 'Terjadi kesalahan saat mengekstrak teks: ' + (err.message || err), 'error');
      });
  };
  reader.onerror = function() {
    Swal.fire('Gagal Membaca File', 'Gagal membaca berkas dari perangkat Anda.', 'error');
  };
  reader.readAsArrayBuffer(file);
}

function loadSampleWordText() {
  const sample = `SOAL PENILAIAN AKHIR SEMESTER (PAS)
MATA PELAJARAN: TEKNOLOGI INFORMASI & KOMUNIKASI
SMK NEGERI 1 LEMPUING

1. Berikut ini yang termasuk dalam kelompok perangkat keras masukan (input device) pada komputer adalah...
A. Monitor
B. Keyboard
C. Speaker
D. Proyektor
E. Plotter
Kunci: B

2. Manakah topologi jaringan di bawah ini yang menggunakan perangkat sentral berupa switch atau hub?
A. Bus
B. Star
C. Ring
D. Mesh
E. Tree
Jawaban: B

3. Satuan dari kecepatan transfer data pada jaringan komputer dinyatakan dalam...
A. bps (bit per second)
B. Byte
C. Hertz
D. Volt
E. Watt
Jawab: A

4. Perhatikan potongan kode berikut:
x = 10
y = 20
print(x + y)
Output yang dihasilkan dari baris kode program di atas adalah...
A. 1020
B. 30
C. 10
D. 20
E. Error
Kunci: B

5. Di bawah ini yang merupakan contoh media transmisi jaringan nirkabel (wireless) adalah...
A. Kabel UTP
B. Kabel Coaxial
C. Gelombang Radio / Wi-Fi
D. Kabel Fiber Optik
E. Kabel STP
Jawaban: C`;

  const input = document.getElementById('word-raw-input');
  if (input) input.value = sample;
  triggerParseWordText();
}

function clearWordRawInput() {
  const input = document.getElementById('word-raw-input');
  if (input) input.value = '';
  wordImportedDataCache = [];
  const previewSec = document.getElementById('word-preview-section');
  if (previewSec) previewSec.classList.add('d-none');
  const btnSave = document.getElementById('btn-save-word-import');
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Simpan ke Bank Soal`;
  }
}

function detectWacanaRangeHeader(line) {
  const s = String(line || '').trim();
  if (!s) return null;

  // 1. Tag eksplisit: [WACANA 1-4] atau [WACANA 1 s.d. 4]
  const tagMatch = s.match(/^\[\s*wacana\s+(\d+)\s*(?:-|–|—|s\.?d\.?|sampai|to)\s*(\d+)\s*\](.*)$/i);
  if (tagMatch) {
    const a = parseInt(tagMatch[1]);
    const b = parseInt(tagMatch[2]);
    if (a >= 1 && b >= a && (b - a) <= 30) {
      return { startNo: a, endNo: b, remainderText: (tagMatch[3] || '').trim() };
    }
  }

  // Pastikan baris mengandung kata kunci penanda wacana/bacaan (Indonesia / Inggris)
  const hasWacanaKeyword = /\b(?:bacalah|perhatikan|cermati|simaklah|teks|wacana|kutipan|dialog|percakapan|puisi|cerita|bacaan|paragraf|artikel|surat|pengumuman|read|following|passage|text|dialogue|story|letter|announcement|table|chart)\b/i.test(s);
  if (!hasWacanaKeyword) return null;

  // Pola rentang nomor: "nomor 1 s.d. 4", "no. 1 - 4", "soal 1 sampai 4", "questions 1 to 4", "number 1 and 2"
  const rangeRegex = /(?:(?:untuk(?:\s+menjawab)?|menjawab|for|to\s+answer|refer(?:s)?\s+to)\s+)?(?:(?:soal|pertanyaan|questions?|numbers?|items?|nomor|no\.?)\s*)+(?:nomor\s*|no\.?\s*|number\s*)?(\d+)\s*(?:-|–|—|s\.?d\.?|sampai(?:\s+dengan)?|to|through|until|dan|and|&)\s*(?:(?:soal|pertanyaan|questions?|numbers?|nomor|no\.?)\s*)?(\d+)\b[\s\!\.\:\-]*(.*)$/i;
  const m = s.match(rangeRegex);
  if (m) {
    const a = parseInt(m[1]);
    const b = parseInt(m[2]);
    if (a >= 1 && b >= a && (b - a) <= 30) {
      return { startNo: a, endNo: b, remainderText: (m[3] || '').trim() };
    }
  }

  // Pola Inggris alternatif: "Questions 1 - 3 refer to the following text"
  const altEng = s.match(/^(?:questions?|numbers?|items?|soal(?:\s+nomor)?)\s+(\d+)\s*(?:-|–|—|s\.?d\.?|sampai|to|through|and|dan)\s*(\d+)\b[^:\n]*[\:\.\!]?\s*(.*)$/i);
  if (altEng) {
    const a = parseInt(altEng[1]);
    const b = parseInt(altEng[2]);
    if (a >= 1 && b >= a && (b - a) <= 30) {
      return { startNo: a, endNo: b, remainderText: (altEng[3] || '').trim() };
    }
  }

  return null;
}

function parseWordQuestions(rawText) {
  if (!rawText || !rawText.trim()) return [];

  // 1. Normalisasi baris
  let cleanText = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Pisahkan blok kunci jawaban di akhir dokumen jika ada
  // Cth: 'KUNCI JAWABAN:', 'DAFTAR KUNCI:', 'KUNCI SOAL:'
  const separatedKeys = {};
  const kunciBlockMatch = cleanText.match(/\n\s*(?:kunci\s*jawaban|daftar\s*kunci|kunci\s*soal|kunci\s*pilihan\s*ganda)[\s\:\-]*\n([\s\S]*)$/i);
  if (kunciBlockMatch) {
    const keySection = kunciBlockMatch[1];
    const keyPairs = keySection.matchAll(/(?:no\.?\s*)?(\d+)[\.\s\:\=\)\-]+([A-Ea-e])/gi);
    for (const kp of keyPairs) {
      separatedKeys[parseInt(kp[1])] = kp[2].toUpperCase();
    }
    cleanText = cleanText.substring(0, kunciBlockMatch.index);
  }

  const rawLines = cleanText.split('\n');
  const lines = [];
  
  // Pra-proses: pisahkan opsi yang ditulis horizontal dalam satu baris (cth: A. text   B. text)
  for (let l of rawLines) {
    const trimmed = l.trim();
    if (!trimmed) continue;

    const multiOptMatch = trimmed.match(/^(\(?[A-Ea-e][\.\)])\s+(.+?)(?=\s+\(?[B-Eb-e][\.\)]\s+)/);
    if (multiOptMatch && /\s+\(?[B-Eb-e][\.\)]\s+/.test(trimmed)) {
      const parts = trimmed.split(/(?=\s+\(?[A-Ea-e][\.\)]\s+)/);
      parts.forEach(p => { if (p.trim()) lines.push(p.trim()); });
    } else {
      lines.push(trimmed);
    }
  }

  const questions = [];
  const sharedWacanaBlocks = [];
  let curQ = null;
  let activeWacana = null;

  const qRegex = /^(?:no\.?\s*|soal\s*)?(\d+)[\.\)\:\-\]]\s*(.*)/i;
  const optRegex = /^\(?([A-Ea-e])[\.\)\:\-]\s*(.*)/;
  const keyRegex = /^(?:kunci(?:\s*jawaban)?|jawaban|jawab|answer|kunci)[\s\:\-]+([A-Ea-e])/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Cek baris kunci jawaban
    const keyMatch = line.match(keyRegex);
    if (keyMatch && curQ) {
      curQ.jawaban_benar = keyMatch[1].toUpperCase();
      continue;
    }

    // Cek apakah baris ini adalah opsi jawaban (A, B, C, D, E)
    const optMatch = line.match(optRegex);
    // Cek apakah baris ini adalah nomor soal baru
    const qMatch = line.match(qRegex);

    // Cek apakah baris ini adalah pengantar wacana untuk rentang soal (misal: "Bacalah teks berikut untuk soal nomor 1 s.d. 4!")
    if (!optMatch && !qMatch) {
      const wRange = detectWacanaRangeHeader(line);
      if (wRange) {
        // Simpan soal sebelumnya agar teks wacana baru TIDAK masuk ke Opsi E soal sebelumnya
        if (curQ && curQ.pertanyaan && (curQ.opsi_a || curQ.opsi_b)) {
          questions.push(curQ);
          curQ = null;
        }
        if (activeWacana && activeWacana.lines.length > 0) {
          sharedWacanaBlocks.push({
            startNo: activeWacana.startNo,
            endNo: activeWacana.endNo,
            text: activeWacana.lines.join('\n').trim()
          });
        }
        activeWacana = {
          startNo: wRange.startNo,
          endNo: wRange.endNo,
          lines: wRange.remainderText ? [wRange.remainderText] : []
        };
        continue;
      }
    }

    // Jika sedang mengumpulkan baris-baris cerita wacana sebelum nomor soal berikutnya dimulai
    if (activeWacana && !qMatch) {
      activeWacana.lines.push(line);
      continue;
    }

    if (optMatch && curQ && curQ.pertanyaan) {
      const letter = optMatch[1].toLowerCase();
      let optText = optMatch[2] ? optMatch[2].trim() : '';

      if (optText.startsWith('*') || optText.endsWith('*')) {
        curQ.jawaban_benar = letter.toUpperCase();
        optText = optText.replace(/\*/g, '').trim();
      }

      curQ['opsi_' + letter] = optText;
      continue;
    }

    if (qMatch && !optMatch) {
      // Jika ada blok wacana yang baru selesai dikumpulkan tepat sebelum soal ini, simpan ke daftar wacana bersama
      if (activeWacana) {
        if (activeWacana.lines.length > 0) {
          sharedWacanaBlocks.push({
            startNo: activeWacana.startNo,
            endNo: activeWacana.endNo,
            text: activeWacana.lines.join('\n').trim()
          });
        }
        activeWacana = null;
      }

      // Simpan soal sebelumnya jika valid
      if (curQ && curQ.pertanyaan && (curQ.opsi_a || curQ.opsi_b)) {
        questions.push(curQ);
      }

      const qNum = parseInt(qMatch[1]);
      curQ = {
        nomor: qNum || (questions.length + 1),
        pertanyaan: qMatch[2] ? qMatch[2].trim() : '',
        opsi_a: '',
        opsi_b: '',
        opsi_c: '',
        opsi_d: '',
        opsi_e: '',
        jawaban_benar: separatedKeys[qNum] || '',
        bobot: 1
      };

      const inlineKey = curQ.pertanyaan.match(/\((?:kunci|jawaban)[\s\:\-]+([A-Ea-e])\)/i);
      if (inlineKey) {
        curQ.jawaban_benar = inlineKey[1].toUpperCase();
        curQ.pertanyaan = curQ.pertanyaan.replace(inlineKey[0], '').trim();
      }

      continue;
    }

    // Jika bukan soal baru dan bukan opsi baru:
    if (curQ) {
      if (!curQ.opsi_a) {
        curQ.pertanyaan += (curQ.pertanyaan ? '\n' : '') + line;
      } else {
        const letters = ['e', 'd', 'c', 'b', 'a'];
        for (const l of letters) {
          if (curQ['opsi_' + l]) {
            curQ['opsi_' + l] += ' ' + line;
            break;
          }
        }
      }
    }
  }

  // Masukkan soal terakhir
  if (curQ && curQ.pertanyaan && (curQ.opsi_a || curQ.opsi_b)) {
    questions.push(curQ);
  }

  // Cek juga jika guru menaruh kalimat pengantar wacana ("1. Bacalah teks berikut untuk soal nomor 1 - 3!\n<cerita>\n<pertanyaan>") di dalam nomor soal pertama
  questions.forEach(q => {
    const qLines = String(q.pertanyaan || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (qLines.length >= 3) {
      const inHeader = detectWacanaRangeHeader(qLines[0]);
      if (inHeader) {
        const coreQ = qLines[qLines.length - 1];
        const bodyParts = [
          ...(inHeader.remainderText ? [inHeader.remainderText] : []),
          ...qLines.slice(1, qLines.length - 1)
        ];
        const wText = bodyParts.join('\n').trim();
        if (wText && coreQ) {
          q.pertanyaan = combineWacanaAndQuestion(wText, coreQ);
          sharedWacanaBlocks.push({
            startNo: inHeader.startNo,
            endNo: inHeader.endNo,
            text: wText
          });
        }
      }
    }
  });

  // Sematkan setiap blok wacana bersama ke seluruh nomor soal dalam rentangnya (startNo s.d. endNo)
  sharedWacanaBlocks.forEach(block => {
    if (!block.text) return;
    questions.forEach(q => {
      const qNo = Number(q.nomor) || 0;
      if (qNo >= block.startNo && qNo <= block.endNo) {
        const { wacana, question } = splitWacanaAndQuestion(q.pertanyaan);
        if (!wacana) {
          q.pertanyaan = combineWacanaAndQuestion(block.text, question);
        }
      }
    });
  });

  // Konversi otomatis penulisan pangkat seperti 2^2 -> 2², x^3 -> x³ pada hasil ekstraksi Word/teks
  questions.forEach(q => {
    q.pertanyaan = formatMathExponents(q.pertanyaan);
    q.opsi_a = formatMathExponents(q.opsi_a);
    q.opsi_b = formatMathExponents(q.opsi_b);
    q.opsi_c = formatMathExponents(q.opsi_c);
    q.opsi_d = formatMathExponents(q.opsi_d);
    q.opsi_e = formatMathExponents(q.opsi_e);
  });

  return questions;
}

function triggerParseWordText() {
  const input = document.getElementById('word-raw-input');
  const text = (input ? input.value : '').trim();

  if (!text) {
    Swal.fire('Teks Masih Kosong', 'Silakan tempel (paste) naskah soal dari Word atau unggah berkas .docx terlebih dahulu.', 'warning');
    return;
  }

  const parsed = parseWordQuestions(text);
  if (parsed.length === 0) {
    Swal.fire({
      icon: 'warning',
      title: 'Tidak Ada Soal Terdeteksi',
      html: `Sistem belum dapat mengenali butir soal pada teks yang dimasukkan.<br><br>
        Pastikan setiap soal menggunakan nomor (contoh: <code>1. </code> atau <code>1) </code>) 
        dan pilihan opsi berhuruf (contoh: <code>A. </code>, <code>B. </code>, dst).<br>
        Klik tombol <strong>"Lihat Contoh Format"</strong> di atas untuk panduan.`,
      confirmButtonColor: '#1e3c72'
    });
    return;
  }

  wordImportedDataCache = parsed;
  renderWordPreview();

  const previewSec = document.getElementById('word-preview-section');
  if (previewSec) {
    previewSec.classList.remove('d-none');
    previewSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const btnSave = document.getElementById('btn-save-word-import');
  if (btnSave) {
    btnSave.disabled = false;
    btnSave.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Simpan ${wordImportedDataCache.length} Soal ke Bank Soal`;
  }
}

function renderWordPreview() {
  const container = document.getElementById('word-preview-list');
  if (!container) return;

  let totalSoal = wordImportedDataCache.length;
  let kunciOk = 0;
  let kunciMissing = 0;

  wordImportedDataCache.forEach(q => {
    if (q.jawaban_benar && ['A', 'B', 'C', 'D', 'E'].includes(q.jawaban_benar.toUpperCase())) {
      kunciOk++;
    } else {
      kunciMissing++;
    }
  });

  // Update badges
  const badgeTotal = document.getElementById('badge-word-total');
  if (badgeTotal) badgeTotal.innerText = `${totalSoal} Soal Terdeteksi`;
  const badgeOk = document.getElementById('badge-word-kunci-ok');
  if (badgeOk) badgeOk.innerText = `${kunciOk} Kunci Lengkap`;
  const badgeMissing = document.getElementById('badge-word-kunci-missing');
  if (badgeMissing) {
    badgeMissing.innerText = `${kunciMissing} Belum Ada Kunci`;
    if (kunciMissing > 0) {
      badgeMissing.className = 'badge bg-warning text-dark px-3 py-2 rounded-pill fw-bold';
    } else {
      badgeMissing.className = 'badge bg-light text-muted px-3 py-2 rounded-pill';
    }
  }

  const html = wordImportedDataCache.map((q, idx) => {
    const activeKey = (q.jawaban_benar || '').toUpperCase();
    const letters = ['A', 'B', 'C', 'D', 'E'];

    const keyButtons = letters.map(letter => {
      const isSelected = (activeKey === letter);
      const btnClass = isSelected ? 'btn-success fw-bold text-white' : 'btn-outline-secondary';
      return `
        <button type="button" class="btn btn-sm ${btnClass} px-2 py-0" style="font-size: 0.78rem;" onclick="setWordQuestionKey(${idx}, '${letter}')">
          ${letter}
        </button>
      `;
    }).join('');

    const optionsHtml = letters.map(letter => {
      const text = q['opsi_' + letter.toLowerCase()];
      if (!text) return '';
      const isCorrect = (activeKey === letter);
      const optClass = isCorrect ? 'border-success bg-success-subtle text-success fw-bold' : 'border bg-light text-dark';
      return `
        <div class="p-1 px-2 rounded mb-1 small d-flex align-items-center gap-2 ${optClass}" style="font-size: 0.82rem;">
          <span class="badge ${isCorrect ? 'bg-success text-white' : 'bg-secondary text-white'}" style="font-size: 0.72rem;">${letter}</span>
          <span>${renderMathHtml(text)}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="card mb-3 border ${activeKey ? 'border-success-subtle' : 'border-warning'} shadow-sm">
        <div class="card-header bg-light py-2 px-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div class="d-flex align-items-center gap-2">
            <span class="badge bg-primary rounded-pill">#${q.nomor || (idx + 1)}</span>
            <span class="small fw-bold text-secondary">Kunci Jawaban:</span>
            <div class="btn-group btn-group-sm" role="group">
              ${keyButtons}
            </div>
            ${!activeKey ? '<span class="badge bg-warning text-dark" style="font-size: 0.7rem;"><i class="bi bi-exclamation-triangle-fill me-1"></i>Pilih Kunci</span>' : ''}
          </div>
          <div class="d-flex align-items-center gap-2">
            <div class="input-group input-group-sm" style="width: 105px;">
              <span class="input-group-text px-1" style="font-size: 0.72rem;">Bobot</span>
              <input type="number" class="form-control form-control-sm text-center px-1" value="${q.bobot || 1}" min="1" max="100" onchange="wordImportedDataCache[${idx}].bobot = parseInt(this.value) || 1">
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" onclick="deleteWordQuestion(${idx})" title="Hapus butir soal ini">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
        <div class="card-body p-3">
          <div class="fw-semibold text-dark mb-2" style="white-space: pre-line; font-size: 0.9rem;">${renderMathHtml(q.pertanyaan)}</div>
          <div class="ps-1">
            ${optionsHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

function setWordQuestionKey(index, key) {
  if (wordImportedDataCache[index]) {
    wordImportedDataCache[index].jawaban_benar = key.toUpperCase();
    renderWordPreview();
  }
}

function deleteWordQuestion(index) {
  if (wordImportedDataCache[index]) {
    wordImportedDataCache.splice(index, 1);
    // Renumber
    wordImportedDataCache.forEach((q, i) => { q.nomor = i + 1; });
    renderWordPreview();

    const btnSave = document.getElementById('btn-save-word-import');
    if (btnSave) {
      if (wordImportedDataCache.length > 0) {
        btnSave.disabled = false;
        btnSave.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Simpan ${wordImportedDataCache.length} Soal ke Bank Soal`;
      } else {
        btnSave.disabled = true;
        btnSave.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Simpan ke Bank Soal`;
        const previewSec = document.getElementById('word-preview-section');
        if (previewSec) previewSec.classList.add('d-none');
      }
    }
  }
}

async function saveWordImportedData() {
  if (!activePaketId) {
    Swal.fire('Pilih Paket', 'Silakan pilih paket soal terlebih dahulu sebelum menyimpan.', 'warning');
    return;
  }

  if (!wordImportedDataCache || wordImportedDataCache.length === 0) {
    Swal.fire('Tidak Ada Soal', 'Belum ada data butir soal yang diproses.', 'warning');
    return;
  }

  // Cek apakah ada soal yang belum memiliki kunci
  const missingKeysCount = wordImportedDataCache.filter(q => !q.jawaban_benar || !['A','B','C','D','E'].includes(q.jawaban_benar.toUpperCase())).length;
  if (missingKeysCount > 0) {
    const confirmAsk = await Swal.fire({
      icon: 'warning',
      title: 'Ada Kunci Belum Diisi',
      html: `Terdapat <strong>${missingKeysCount} soal</strong> yang belum memiliki kunci jawaban.<br><br>Apakah Anda ingin tetap menyimpan? Soal tanpa kunci akan otomatis disetel ke opsi <strong>A</strong>.`,
      showCancelButton: true,
      confirmButtonText: 'Ya, Simpan Semua',
      cancelButtonText: 'Periksa Kembali',
      confirmButtonColor: '#198754',
      cancelButtonColor: '#6c757d'
    });
    if (!confirmAsk.isConfirmed) return;
  }

  const btn = document.getElementById('btn-save-word-import');
  btn.disabled = true;

  Swal.fire({
    title: 'Menyimpan Soal...',
    html: `Menyimpan <strong>${wordImportedDataCache.length}</strong> butir soal ke Bank Soal...`,
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  try {
    const payloadSoal = wordImportedDataCache.map((s, idx) => ({
      paket_soal_id: activePaketId,
      nomor: s.nomor || (idx + 1),
      pertanyaan: s.pertanyaan,
      opsi_a: s.opsi_a || '',
      opsi_b: s.opsi_b || '',
      opsi_c: s.opsi_c || '',
      opsi_d: s.opsi_d || '',
      opsi_e: s.opsi_e || '',
      jawaban_benar: (s.jawaban_benar && ['A','B','C','D','E'].includes(s.jawaban_benar.toUpperCase())) ? s.jawaban_benar.toUpperCase() : 'A',
      bobot: s.bobot || 1
    }));

    await DB.bulkInsertSoal(payloadSoal);

    if (importWordModalInstance) {
      importWordModalInstance.hide();
    }

    Swal.fire({
      icon: 'success',
      title: 'Import Word Berhasil!',
      text: `${payloadSoal.length} Butir soal berhasil disimpan ke Bank Soal.`,
      confirmButtonColor: '#1e3c72'
    });

    await loadSoal();
    await loadDashboardStats();
  } catch (err) {
    console.error('Gagal menyimpan soal import Word:', err);
    Swal.fire('Gagal Menyimpan', err.message || 'Terjadi kesalahan saat menyimpan soal ke database.', 'error');
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
  const customModel = document.getElementById('ai-model-select')?.value || 'gemini-3.1-flash-lite';
  const modelCandidates = [
    customModel,
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-flash-lite-latest',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.7-flash',
    'gemini-3.5-flash'
  ].filter((v, i, a) => v && a.indexOf(v) === i);
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
9. Untuk penulisan bilangan berpangkat / eksponen / satuan persegi atau kubik, tulis dengan jelas (misal 3^5, 2^2, (2^3)^4, 10^-5, x^2, cm^2) dan JANGAN menambahkan tanda baca koma di akhir teks pilihan jawaban (contoh salah: "3¹," -> contoh benar: "3^1").
10. Khusus jika soal menggunakan teks bacaan / wacana / cerita / dialog (seperti Bahasa Indonesia, Bahasa Inggris, atau studi kasus), WAJIB sertakan teks wacananya langsung di dalam field "pertanyaan" pada setiap butir soal yang merujuk wacana tersebut dengan format: "[WACANA]\\n(isi teks wacana/bacaan)\\n[/WACANA]\\n(kalimat pertanyaan inti)". JANGAN PERNAH merujuk ke nomor soal lain seperti "Berdasarkan teks pada soal nomor 1..." tanpa menyertakan teks wacananya, karena urutan soal di layar siswa akan diacak.

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
      const abortCtrl = new AbortController();
      const timeoutId = setTimeout(() => abortCtrl.abort(), 16000);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${curModel}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortCtrl.signal,
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
        clearTimeout(timeoutId);

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
        clearTimeout(timeoutId);
        const isTimeout = callErr.name === 'AbortError';
        const msg = isTimeout ? 'Waktu habis (server AI lambat merespons)' : callErr.message;
        lastError = new Error(msg);
        console.warn(`[CBT AI] Model ${curModel} gagal: ${msg}. Mencoba model alternatif...`);
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
      pertanyaan: formatMathExponents(q.pertanyaan || ''),
      opsi_a: formatMathExponents(q.opsi_a || ''),
      opsi_b: formatMathExponents(q.opsi_b || ''),
      opsi_c: formatMathExponents(q.opsi_c || ''),
      opsi_d: formatMathExponents(q.opsi_d || ''),
      opsi_e: formatMathExponents(q.opsi_e || ''),
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
    let userMsg = err.message || 'Terjadi kesalahan.';
    if (userMsg.includes('high demand') || userMsg.includes('503') || userMsg.includes('UNAVAILABLE')) {
      userMsg = 'Server Google AI saat ini sedang mengalami lonjakan beban trafik global (High Demand). Silakan coba klik "Generate Soal Sekarang" sekali lagi, atau buat dalam jumlah lebih sedikit (misal 5 atau 10 butir terlebih dahulu).';
    } else if (userMsg.includes('quota') || userMsg.includes('429')) {
      userMsg = 'Batas kuota gratis Google AI tercapai sementara. Tunggu sekitar 1 menit lalu klik Generate kembali.';
    }
    Swal.fire({
      icon: 'error',
      title: 'Gagal Membuat Soal',
      text: userMsg,
      confirmButtonText: 'Tutup'
    });
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
        <p class="mb-2 fw-semibold text-dark" style="white-space: pre-wrap;">${renderMathHtml(q.pertanyaan)}</p>
        <div class="row g-2 small">
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'A' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>A.</strong> ${renderMathHtml(q.opsi_a)}
            </div>
          </div>
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'B' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>B.</strong> ${renderMathHtml(q.opsi_b)}
            </div>
          </div>
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'C' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>C.</strong> ${renderMathHtml(q.opsi_c)}
            </div>
          </div>
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'D' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>D.</strong> ${renderMathHtml(q.opsi_d)}
            </div>
          </div>
          ${q.opsi_e ? `
          <div class="col-md-6">
            <div class="p-2 border rounded ${q.jawaban_benar === 'E' ? 'border-success bg-success-subtle fw-bold text-success' : 'bg-light'}">
              <strong>E.</strong> ${renderMathHtml(q.opsi_e)}
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

// -------------------------------------------------------------
// MONITORING KESIAPAN GURU & CAKUPAN MAPEL PER KELAS (ADMIN)
// -------------------------------------------------------------
let kesiapanActiveSubTab = 'guru';
let kesiapanSelectedTingkat = 'X';
let kesiapanSoalCountsHydrated = false;
let kesiapanLastSnapshot = null;

const KESIAPAN_CUSTOM_TARGETS_KEY = 'CBT_KESIAPAN_CUSTOM_MAPEL_TARGETS_V1';

const KESIAPAN_COMMON_MAPEL_FAMS = new Set([
  'pendidikan agama islam',
  'pendidikan pancasila',
  'bahasa indonesia',
  'matematika',
  'bahasa inggris',
  'sejarah',
  'pjok',
  'seni budaya / musik',
  'projek ipas',
  'informatika',
  'pkk / kewirausahaan',
  'koding / kka'
]);

const KESIAPAN_OPTIONAL_RELIGION_FAMS = new Set([
  'agama kristen protestan',
  'agama katolik',
  'agama hindu',
  'agama buddha',
  'agama konghucu'
]);

const KESIAPAN_MAPEL_DISPLAY_LABELS = {
  'pendidikan agama islam': 'Pendidikan Agama Islam',
  'agama kristen protestan': 'Agama Kristen',
  'agama katolik': 'Agama Katolik',
  'agama hindu': 'Agama Hindu',
  'agama buddha': 'Agama Buddha',
  'agama konghucu': 'Agama Konghucu',
  'pendidikan pancasila': 'Pendidikan Pancasila',
  'bahasa indonesia': 'Bahasa Indonesia',
  'matematika': 'Matematika',
  'bahasa inggris': 'Bahasa Inggris',
  'sejarah': 'Sejarah',
  'pjok': 'PJOK',
  'seni budaya / musik': 'Seni Budaya / Musik',
  'projek ipas': 'Projek IPAS',
  'informatika': 'Informatika',
  'pkk / kewirausahaan': 'PKK / Kewirausahaan',
  'koding / kka': 'Koding / KKA',
  'ddk tjkt': 'DDK TJKT',
  'kejuruan akuntansi': 'Kejuruan Akuntansi'
};

function getKesiapanMapelDisplayLabel(fam, fallbackRaw = '') {
  if (KESIAPAN_MAPEL_DISPLAY_LABELS[fam]) return KESIAPAN_MAPEL_DISPLAY_LABELS[fam];
  const src = String(fallbackRaw || fam || '').trim();
  if (!src) return '-';
  return src.replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getKesiapanCustomTargetsMap() {
  try {
    const raw = localStorage.getItem(KESIAPAN_CUSTOM_TARGETS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {}
  return { X: [], XI: [], XII: [] };
}

function saveKesiapanCustomTargetsMap(mapObj) {
  try {
    localStorage.setItem(KESIAPAN_CUSTOM_TARGETS_KEY, JSON.stringify(mapObj));
  } catch (e) {}
}

function getKesiapanCustomTargets(tingkat) {
  const all = getKesiapanCustomTargetsMap();
  const list = all[tingkat];
  return Array.isArray(list) ? list : [];
}

function addCustomTargetMapel() {
  const input = document.getElementById('input-target-mapel-wajib');
  if (!input) return;
  const rawVal = input.value.trim();
  if (!rawVal) return;

  const fam = normalizeMapelFamily(rawVal);
  if (!fam) return;

  const all = getKesiapanCustomTargetsMap();
  if (!Array.isArray(all[kesiapanSelectedTingkat])) all[kesiapanSelectedTingkat] = [];

  const exists = all[kesiapanSelectedTingkat].some(item => normalizeMapelFamily(item) === fam);
  if (!exists) {
    all[kesiapanSelectedTingkat].push(rawVal);
    saveKesiapanCustomTargetsMap(all);
  }
  input.value = '';
  recomputeAndRenderKesiapan();
}

function removeCustomTargetMapel(tingkat, index) {
  const all = getKesiapanCustomTargetsMap();
  if (Array.isArray(all[tingkat])) {
    all[tingkat].splice(index, 1);
    saveKesiapanCustomTargetsMap(all);
  }
  recomputeAndRenderKesiapan();
}

function normalizeTingkatToken(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (s === '10' || s === 'X') return 'X';
  if (s === '11' || s === 'XI') return 'XI';
  if (s === '12' || s === 'XII') return 'XII';
  return '';
}

function extractJurusanHintFromMapel(rawMapel) {
  const s = String(rawMapel || '').toLowerCase();
  const found = new Set();
  if (/\b(tkj|tjkt)\b/.test(s) || s.includes('jaringan komputer') || s.includes('pengalamatan jaringan')) found.add('tkj');
  if (/\b(akl)\b/.test(s) || s.includes('akuntansi')) found.add('akl');
  if (/\b(tbsm|tsm)\b/.test(s) || s.includes('sepeda motor')) found.add('tbsm');
  if (/\b(tkro|tkr)\b/.test(s) || s.includes('kendaraan ringan') || s.includes('otomotif')) found.add('tkro');
  if (/\b(atp)\b/.test(s) || s.includes('agribisnis')) found.add('atp');
  return found;
}

function isVocationalMapelName(rawMapel, fam) {
  if (KESIAPAN_COMMON_MAPEL_FAMS.has(fam)) return false;
  const s = String(rawMapel || fam || '').toLowerCase();
  if (extractJurusanHintFromMapel(s).size > 0) return true;
  if (s.includes('kejuruan') || s.includes('dasar-dasar') || s.includes('dasar dasar') || s.includes('pilihan') || s.includes('produktif')) {
    return true;
  }
  return false;
}

async function hydrateAllPaketSoalCounts(force = false) {
  const pakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  if (pakets.length === 0) return;

  // Cek apakah semua paket sudah memiliki total_soal numerik (misal dari backend PHP)
  const alreadyHasCounts = pakets.every(p => typeof p.total_soal === 'number' && !isNaN(p.total_soal));
  if (alreadyHasCounts && !force && kesiapanSoalCountsHydrated) return;

  const counts = new Map();
  let success = false;

  // 1. Mode Local Storage
  if (typeof DB !== 'undefined' && typeof DB.isLocal === 'function' && DB.isLocal()) {
    try {
      const soalAll = await DB.getSoalList();
      (soalAll || []).forEach(s => {
        if (s && s.paket_soal_id) {
          const pid = String(s.paket_soal_id);
          counts.set(pid, (counts.get(pid) || 0) + 1);
        }
      });
      success = true;
    } catch (e) {
      console.warn('Gagal hitung soal lokal:', e);
    }
  }
  // 2. Mode Supabase (Ringan: hanya ambil kolom paket_soal_id secara paginasi 1000 baris)
  else if (window.CBT_CONFIG && window.CBT_CONFIG.backend === 'supabase' && window.supabaseClient) {
    try {
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 30;
      let page = 0;
      let totalFetched = 0;
      while (page < MAX_PAGES) {
        const from = page * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await window.supabaseClient
          .from('soal')
          .select('paket_soal_id')
          .not('paket_soal_id', 'is', null)
          .neq('nomor', -999)
          .neq('nomor', -998)
          .range(from, to);
        if (error) throw error;
        const rows = Array.isArray(data) ? data : [];
        rows.forEach(r => {
          if (r && r.paket_soal_id) {
            const pid = String(r.paket_soal_id);
            counts.set(pid, (counts.get(pid) || 0) + 1);
          }
        });
        totalFetched += rows.length;
        if (rows.length < PAGE_SIZE) break;
        page++;
      }
      success = true;
      // Jika totalFetched 0 padahal ada paket (misal shard lain), cek cepat per batch jika perlu
      if (totalFetched === 0 && pakets.length <= 150) {
        const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
        if (shards.length > 1) {
          for (let sIdx = 1; sIdx < shards.length; sIdx++) {
            const c = shards[sIdx] && shards[sIdx].client;
            if (!c) continue;
            const { data } = await c
              .from('soal')
              .select('paket_soal_id')
              .not('paket_soal_id', 'is', null)
              .neq('nomor', -999)
              .neq('nomor', -998)
              .limit(1000);
            if (Array.isArray(data) && data.length > 0) {
              data.forEach(r => {
                if (r && r.paket_soal_id) {
                  const pid = String(r.paket_soal_id);
                  counts.set(pid, (counts.get(pid) || 0) + 1);
                }
              });
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Gagal hitung soal cepat di Supabase, fallback per paket:', e);
    }
  }
  // 3. Mode PHP (sudah terisi dari getPaketList)
  else if (alreadyHasCounts) {
    pakets.forEach(p => counts.set(String(p.id), Number(p.total_soal) || 0));
    success = true;
  }

  // Fallback jika metode cepat gagal: hitung paralel per batch 8 paket
  if (!success && typeof DB !== 'undefined' && typeof DB.getSoalByPaket === 'function') {
    const BATCH = 8;
    for (let i = 0; i < pakets.length; i += BATCH) {
      const slice = pakets.slice(i, i + BATCH);
      const res = await Promise.allSettled(slice.map(pk => DB.getSoalByPaket(pk.id)));
      res.forEach((r, idx) => {
        const pid = String(slice[idx].id);
        counts.set(pid, (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value.length : 0);
      });
    }
    success = true;
  }

  if (success) {
    pakets.forEach(p => {
      p.total_soal = counts.get(String(p.id)) || 0;
    });
    if (Array.isArray(allPaket) && allPaket !== pakets) {
      allPaket.forEach(p => {
        p.total_soal = counts.get(String(p.id)) || 0;
      });
    }
    kesiapanSoalCountsHydrated = true;
    // Perbarui badge jumlah soal di Bank Soal juga
    if (typeof renderPaketList === 'function') {
      renderPaketList(allPaket);
    }
  }
}

function getPaketSoalCountSafe(pk) {
  if (!pk) return 0;
  return Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
}

function parseGuruPenugasanSafe(g) {
  if (!g) return [];
  if (Array.isArray(g.penugasan_mapel)) return g.penugasan_mapel.filter(x => x && String(x.mapel || '').trim());
  if (typeof g.penugasan_mapel === 'string' && g.penugasan_mapel.trim()) {
    try {
      const dec = JSON.parse(g.penugasan_mapel);
      if (Array.isArray(dec)) return dec.filter(x => x && String(x.mapel || '').trim());
    } catch (e) {}
  }
  return [];
}

function buildKesiapanGuruAnalysis() {
  const gurus = Array.isArray(allGuru) ? allGuru : [];
  const pakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const paketById = new Map();
  pakets.forEach(p => { if (p && p.id) paketById.set(String(p.id), p); });

  const assignedPaketIds = new Set();
  const guruPaketsMap = new Map();
  gurus.forEach(g => guruPaketsMap.set(String(g.id || g.username), []));

  // Tahap 1: Paket eksplisit via g.paket_ids
  gurus.forEach(g => {
    const gKey = String(g.id || g.username);
    let pids = [];
    if (Array.isArray(g.paket_ids)) pids = g.paket_ids;
    else if (typeof g.paket_ids === 'string' && g.paket_ids.trim()) {
      try { const p = JSON.parse(g.paket_ids); if (Array.isArray(p)) pids = p; } catch (e) {}
    }
    pids.forEach(pid => {
      const pk = paketById.get(String(pid));
      if (pk && !assignedPaketIds.has(String(pid))) {
        guruPaketsMap.get(gKey).push(pk);
        assignedPaketIds.add(String(pid));
      }
    });
  });

  // Tahap 2: Smart assignment fallback untuk paket yang belum tercatat di paket_ids
  pakets.forEach(pk => {
    if (!pk || !pk.id) return;
    const pkIdStr = String(pk.id);
    if (assignedPaketIds.has(pkIdStr)) return;

    const pClean = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
    const pBase = (pClean.split(' - ')[0] || pk.nama_paket || '').split(' (')[0].trim();
    const pFam = normalizeMapelFamily(pBase);

    let bestGuru = null;
    let bestScore = -1;

    gurus.forEach(g => {
      const pList = parseGuruPenugasanSafe(g);
      for (const item of pList) {
        const itemMapel = String(item.mapel || '').trim();
        const itemFam = normalizeMapelFamily(itemMapel);
        const sameM = (pFam && itemFam && pFam === itemFam) ||
          String(pk.nama_paket || '').toLowerCase().includes(itemMapel.toLowerCase()) ||
          itemMapel.toLowerCase().includes(pBase.toLowerCase());
        if (!sameM) continue;
        if (!hasJurusanOverlap(pk.jurusan, item.jurusan)) continue;
        const overlaps = getOverlappingClasses(pk.kelas, item.tingkat);
        let score = 10;
        if (overlaps.length > 0) score += 20;
        if (String(pk.kelas || '').trim().toUpperCase() === String(item.tingkat || '').trim().toUpperCase()) score += 50;
        if (score > bestScore) {
          bestScore = score;
          bestGuru = g;
        }
      }

      if (bestScore < 30 && g.mapel_diampu) {
        const gMapels = String(g.mapel_diampu).split(/[,;/|]+/).map(s => s.trim()).filter(Boolean);
        for (const m of gMapels) {
          const mFam = normalizeMapelFamily(m);
          const sameM = (pFam && mFam && pFam === mFam) ||
            String(pk.nama_paket || '').toLowerCase().includes(m.toLowerCase()) ||
            m.toLowerCase().includes(pBase.toLowerCase());
          if (!sameM) continue;
          if (!hasJurusanOverlap(pk.jurusan, g.jurusan_diampu)) continue;
          const overlaps = getOverlappingClasses(pk.kelas, g.kelas_diampu);
          let score = 5;
          if (overlaps.length > 0) score += 15;
          if (score > bestScore) {
            bestScore = score;
            bestGuru = g;
          }
        }
      }
    });

    if (bestGuru && bestScore > 0) {
      const gKey = String(bestGuru.id || bestGuru.username);
      if (guruPaketsMap.has(gKey)) {
        guruPaketsMap.get(gKey).push(pk);
        assignedPaketIds.add(pkIdStr);
      }
    }
  });

  const statusOrder = { NO_MAPEL: 1, NO_PAKET: 2, ZERO_SOAL: 3, READY: 4 };

  const rows = gurus.map(g => {
    const gKey = String(g.id || g.username);
    const penugasan = parseGuruPenugasanSafe(g);
    const legacyMapelStr = String(g.mapel_diampu || '').trim();
    const hasMapel = penugasan.length > 0 || legacyMapelStr.length > 0;
    const myPakets = guruPaketsMap.get(gKey) || [];

    const filledPakets = myPakets.filter(p => getPaketSoalCountSafe(p) > 0);
    const emptyPakets = myPakets.filter(p => getPaketSoalCountSafe(p) === 0);
    const totalSoal = myPakets.reduce((acc, p) => acc + getPaketSoalCountSafe(p), 0);

    // Cek penugasan yang belum punya paket sama sekali
    const unmatchedPenugasan = penugasan.filter(item => {
      const itemFam = normalizeMapelFamily(item.mapel);
      return !myPakets.some(pk => {
        const pBase = String(pk.nama_paket || '').split(' - ')[0].split(' (')[0].trim();
        const pFam = normalizeMapelFamily(pBase);
        const sameM = (pFam && itemFam && pFam === itemFam) ||
          String(pk.nama_paket || '').toLowerCase().includes(String(item.mapel || '').toLowerCase());
        if (!sameM) return false;
        return getOverlappingClasses(pk.kelas, item.tingkat).length > 0;
      });
    });

    let status = 'READY';
    if (!hasMapel && myPakets.length === 0) {
      status = 'NO_MAPEL';
    } else if (hasMapel && myPakets.length === 0) {
      status = 'NO_PAKET';
    } else if (emptyPakets.length > 0 || unmatchedPenugasan.length > 0) {
      status = 'ZERO_SOAL';
    } else {
      status = 'READY';
    }

    return {
      guru: g,
      id: g.id,
      nama: g.nama_lengkap || g.username || 'Guru',
      username: g.username || '',
      penugasan,
      legacyMapelStr,
      hasMapel,
      pakets: myPakets,
      filledPakets,
      emptyPakets,
      unmatchedPenugasan,
      totalSoal,
      status
    };
  });

  rows.sort((a, b) => {
    const oA = statusOrder[a.status] || 9;
    const oB = statusOrder[b.status] || 9;
    if (oA !== oB) return oA - oB;
    return a.nama.localeCompare(b.nama, 'id', { sensitivity: 'base' });
  });

  return rows;
}

function buildKesiapanRombelsList() {
  const rombelMap = new Map(); // UPPER_NAME -> { nama, tingkat, jurusan, jurNorm, siswaCount }
  const jurVoteByRombel = new Map();

  const isStandaloneGrade = (tok) => {
    const u = String(tok || '').toUpperCase().trim();
    if (!u || u === 'SEMUA' || u === 'SEMUA KELAS' || u.startsWith('TINGKAT:')) return true;
    if (['X', 'XI', 'XII', '10', '11', '12', 'KELAS X', 'KELAS XI', 'KELAS XII', 'KELAS 10', 'KELAS 11', 'KELAS 12'].includes(u)) return true;
    return false;
  };

  const registerRombel = (rawName, rawJur = '', countStudent = false) => {
    const clean = String(rawName || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (isStandaloneGrade(clean)) return;

    const parts = clean.split(/[\s\-_]+/).filter(Boolean);
    let tingkat = normalizeTingkatToken(parts[0]);
    let jurFromName = parts.length >= 2 ? parts[1] : '';
    if (!tingkat && parts[0] === 'KELAS' && parts.length >= 2) {
      tingkat = normalizeTingkatToken(parts[1]);
      jurFromName = parts.length >= 3 ? parts[2] : '';
    }
    if (!tingkat) return;

    if (!rombelMap.has(clean)) {
      const initJur = (rawJur && rawJur.toUpperCase() !== 'SEMUA') ? rawJur.toUpperCase().trim() : jurFromName;
      rombelMap.set(clean, {
        nama: clean,
        tingkat,
        jurusan: initJur || '-',
        jurNorm: normalizeJurAlias(initJur || ''),
        siswaCount: 0
      });
    }

    const entry = rombelMap.get(clean);
    if (countStudent) {
      entry.siswaCount++;
      const j = String(rawJur || '').toUpperCase().trim();
      if (j && j !== 'SEMUA') {
        if (!jurVoteByRombel.has(clean)) jurVoteByRombel.set(clean, new Map());
        const vm = jurVoteByRombel.get(clean);
        vm.set(j, (vm.get(j) || 0) + 1);
      }
    }
  };

  (allKelas || []).forEach(k => registerRombel(k.nama_kelas || k.nama, '', false));
  (allPeserta || []).forEach(p => registerRombel(p.kelas, p.jurusan, true));

  // Gunakan jurusan mayoritas dari peserta jika ada
  jurVoteByRombel.forEach((vm, clean) => {
    let bestJ = '';
    let bestC = -1;
    vm.forEach((c, j) => { if (c > bestC) { bestC = c; bestJ = j; } });
    if (bestJ && rombelMap.has(clean)) {
      const entry = rombelMap.get(clean);
      entry.jurusan = bestJ;
      entry.jurNorm = normalizeJurAlias(bestJ);
    }
  });

  return Array.from(rombelMap.values()).sort((a, b) => a.nama.localeCompare(b.nama, 'id', { numeric: true }));
}

function buildKesiapanKelasAnalysis() {
  const rombels = buildKesiapanRombelsList();
  const pakets = (allPaketUnfiltered && allPaketUnfiltered.length > 0) ? allPaketUnfiltered : (allPaket || []);
  const gurus = Array.isArray(allGuru) ? allGuru : [];
  const ownerMap = getPaketOwnerNameMap();

  const grades = ['X', 'XI', 'XII'];
  const byGrade = {};

  // Pra-parsing paket dengan mapel family-nya
  const parsedPakets = pakets.map(pk => {
    const pClean = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
    const pBase = (pClean.split(' - ')[0] || pk.nama_paket || '').split(' (')[0].trim();
    const fam = normalizeMapelFamily(pBase);
    return {
      pk,
      pBase,
      fam,
      soalCount: getPaketSoalCountSafe(pk),
      ownerName: ownerMap.get(String(pk.id)) || ''
    };
  }).filter(x => x.fam);

  // Pra-parsing penugasan guru
  const parsedAssignments = [];
  gurus.forEach(g => {
    const gName = g.nama_lengkap || g.username || 'Guru';
    const pList = parseGuruPenugasanSafe(g);
    if (pList.length > 0) {
      pList.forEach(item => {
        const fam = normalizeMapelFamily(item.mapel);
        if (fam) {
          parsedAssignments.push({
            guruId: g.id,
            guruName: gName,
            rawMapel: item.mapel,
            fam,
            tingkat: item.tingkat || 'SEMUA',
            jurusan: item.jurusan || 'SEMUA'
          });
        }
      });
    } else if (g.mapel_diampu) {
      String(g.mapel_diampu).split(/[,;/|]+/).map(s => s.trim()).filter(Boolean).forEach(m => {
        const fam = normalizeMapelFamily(m);
        if (fam) {
          parsedAssignments.push({
            guruId: g.id,
            guruName: gName,
            rawMapel: m,
            fam,
            tingkat: g.kelas_diampu || 'SEMUA',
            jurusan: g.jurusan_diampu || 'SEMUA'
          });
        }
      });
    }
  });

  grades.forEach(grade => {
    const gradeRombels = rombels.filter(r => r.tingkat === grade);
    const customTargets = getKesiapanCustomTargets(grade);
    const customFams = new Set(customTargets.map(m => normalizeMapelFamily(m)).filter(Boolean));

    // Kumpulkan semua mapel family yang relevan untuk tingkat ini
    const mapelMeta = new Map(); // fam -> { fam, label, rawSample, observedJurNorms: Set, isCustom, isVocational, isOptional }

    const touchMapel = (fam, rawName, matchedRombels, isCustom = false) => {
      if (!fam) return;
      if (!mapelMeta.has(fam)) {
        mapelMeta.set(fam, {
          fam,
          label: getKesiapanMapelDisplayLabel(fam, rawName),
          rawSample: rawName,
          observedJurNorms: new Set(),
          isCustom: Boolean(isCustom),
          isVocational: isVocationalMapelName(rawName, fam),
          isOptional: KESIAPAN_OPTIONAL_RELIGION_FAMS.has(fam) && !isCustom
        });
      }
      const meta = mapelMeta.get(fam);
      if (isCustom) {
        meta.isCustom = true;
        meta.isOptional = false;
      }
      matchedRombels.forEach(r => {
        if (r.jurNorm && r.jurNorm !== 'semua') meta.observedJurNorms.add(r.jurNorm);
      });
      extractJurusanHintFromMapel(rawName).forEach(jh => meta.observedJurNorms.add(jh));
    };

    // 1. Dari Target Mapel Wajib kustom
    customTargets.forEach(rawM => {
      const fam = normalizeMapelFamily(rawM);
      touchMapel(fam, rawM, gradeRombels, true);
    });

    // 2. Dari paket soal yang menjangkau minimal 1 rombel di tingkat ini
    parsedPakets.forEach(pp => {
      const matched = gradeRombels.filter(r =>
        checkKelasMatch(pp.pk.kelas, r.nama).match && hasJurusanOverlap(pp.pk.jurusan, r.jurusan)
      );
      if (matched.length > 0) {
        touchMapel(pp.fam, pp.pBase, matched, false);
      }
    });

    // 3. Dari penugasan guru yang menjangkau minimal 1 rombel di tingkat ini
    parsedAssignments.forEach(asg => {
      const matched = gradeRombels.filter(r =>
        checkKelasMatch(asg.tingkat, r.nama).match && hasJurusanOverlap(asg.jurusan, r.jurusan)
      );
      if (matched.length > 0) {
        touchMapel(asg.fam, asg.rawMapel, matched, false);
      }
    });

    // Finalisasi klasifikasi Umum vs Kejuruan per kolom mapel
    const mapelColumns = Array.from(mapelMeta.values()).map(meta => {
      const hintJurs = extractJurusanHintFromMapel(meta.rawSample);
      const isCommon = !meta.isVocational && (
        meta.isCustom ||
        KESIAPAN_COMMON_MAPEL_FAMS.has(meta.fam) ||
        meta.observedJurNorms.size >= 2
      );
      const applicableJurNorms = hintJurs.size > 0 ? hintJurs : meta.observedJurNorms;
      return {
        ...meta,
        isCommon: isCommon && hintJurs.size === 0,
        applicableJurNorms
      };
    });

    // Urutkan kolom: Umum dulu, lalu Kejuruan, lalu Agama minoritas opsional
    mapelColumns.sort((a, b) => {
      const rank = (m) => m.isOptional ? 3 : (m.isCommon ? 1 : 2);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.label.localeCompare(b.label, 'id', { sensitivity: 'base' });
    });

    // Evaluasi setiap sel (Rombel x Mapel)
    let gradeMissingCount = 0;
    let gradeZeroCount = 0;
    let gradeConflictCount = 0;
    let gradeIncompleteRombels = 0;

    const rombelRows = gradeRombels.map(r => {
      const cells = [];
      let requiredCount = 0;
      let readyCount = 0;
      let missingList = [];
      let zeroList = [];
      let noPaketList = [];
      let conflictList = [];

      mapelColumns.forEach(col => {
        const applies = col.isCommon || col.isOptional || col.applicableJurNorms.has(r.jurNorm);
        if (!applies) {
          cells.push({ col, state: 'NA' });
          return;
        }

        const matchedPakets = parsedPakets.filter(pp =>
          pp.fam === col.fam &&
          checkKelasMatch(pp.pk.kelas, r.nama).match &&
          hasJurusanOverlap(pp.pk.jurusan, r.jurusan)
        );

        const matchedAsg = parsedAssignments.filter(asg =>
          asg.fam === col.fam &&
          checkKelasMatch(asg.tingkat, r.nama).match &&
          hasJurusanOverlap(asg.jurusan, r.jurusan)
        );

        // Hitung guru unik dari penugasan & pemilik paket
        const uniqueGuruNames = new Set();
        matchedAsg.forEach(a => uniqueGuruNames.add(a.guruName));
        matchedPakets.forEach(pp => { if (pp.ownerName) uniqueGuruNames.add(pp.ownerName); });

        // Paket terbaik (soal terbanyak)
        const sortedPk = [...matchedPakets].sort((a, b) => b.soalCount - a.soalCount);
        const bestPk = sortedPk[0] || null;
        const filledPkCount = sortedPk.filter(x => x.soalCount > 0).length;

        const isConflict = uniqueGuruNames.size > 1 || (matchedAsg.length > 1 && new Set(matchedAsg.map(a => String(a.guruId))).size > 1) || filledPkCount > 1;

        if (!col.isOptional) requiredCount++;

        let state = 'MISSING';
        if (isConflict) {
          state = 'CONFLICT';
          conflictList.push({ label: col.label, gurus: Array.from(uniqueGuruNames) });
          gradeConflictCount++;
        } else if (bestPk && bestPk.soalCount > 0) {
          state = 'READY';
          if (!col.isOptional) readyCount++;
        } else if (bestPk && bestPk.soalCount === 0) {
          state = 'ZERO_SOAL';
          if (!col.isOptional) {
            zeroList.push({ label: col.label, guru: bestPk.ownerName || (matchedAsg[0]?.guruName || '-') });
            gradeZeroCount++;
          }
        } else if (matchedAsg.length > 0) {
          state = 'NO_PAKET';
          if (!col.isOptional) {
            noPaketList.push({ label: col.label, guru: matchedAsg[0].guruName });
            gradeZeroCount++;
          }
        } else if (col.isOptional) {
          state = 'OPTIONAL';
        } else {
          state = 'MISSING';
          missingList.push(col.label);
          gradeMissingCount++;
        }

        cells.push({
          col,
          state,
          soalCount: bestPk ? bestPk.soalCount : 0,
          paketId: bestPk ? bestPk.pk.id : null,
          paketName: bestPk ? bestPk.pk.nama_paket : '',
          guruId: matchedAsg[0] ? matchedAsg[0].guruId : null,
          guruName: Array.from(uniqueGuruNames).join(', ') || '-'
        });
      });

      const hasIssues = missingList.length > 0 || zeroList.length > 0 || noPaketList.length > 0 || conflictList.length > 0;
      if (hasIssues) gradeIncompleteRombels++;

      return {
        rombel: r,
        cells,
        requiredCount,
        readyCount,
        missingList,
        zeroList,
        noPaketList,
        conflictList,
        hasIssues
      };
    });

    byGrade[grade] = {
      grade,
      rombels: rombelRows,
      columns: mapelColumns,
      missingCount: gradeMissingCount,
      zeroCount: gradeZeroCount,
      conflictCount: gradeConflictCount,
      incompleteRombels: gradeIncompleteRombels,
      totalIssues: gradeMissingCount + gradeZeroCount + gradeConflictCount
    };
  });

  return byGrade;
}

function updateKesiapanSidebarBadge() {
  const navBadge = document.getElementById('nav-badge-kesiapan');
  if (!navBadge || isGuruMode()) return;
  try {
    const guruRows = buildKesiapanGuruAnalysis();
    const noMapel = guruRows.filter(r => r.status === 'NO_MAPEL').length;
    const noPaket = guruRows.filter(r => r.status === 'NO_PAKET').length;
    const count = noMapel + noPaket;
    if (count > 0) {
      navBadge.innerText = String(count);
      navBadge.title = `${noMapel} guru belum atur mapel, ${noPaket} belum ada paket`;
      navBadge.classList.remove('d-none');
    } else {
      navBadge.classList.add('d-none');
    }
  } catch (e) {}
}

async function loadKesiapanMonitoring(forceRefresh = false) {
  if (isGuruMode()) return;

  const banner = document.getElementById('kesiapan-sync-banner');
  const syncText = document.getElementById('kesiapan-sync-text');
  const btnRefresh = document.getElementById('btn-refresh-kesiapan');
  if (btnRefresh) btnRefresh.disabled = true;
  if (banner) {
    banner.classList.remove('d-none');
    banner.classList.add('d-flex');
  }

  try {
    if (forceRefresh || !allGuru.length || !allPaketUnfiltered.length || !allKelas.length) {
      if (syncText) syncText.innerText = 'Menyegarkan data guru, paket soal, kelas, dan peserta...';
      const [gRes, pkRes, kRes, jRes, pRes] = await Promise.all([
        DB.getGuruList(),
        DB.getPaketList(),
        DB.getKelasList(),
        DB.getJurusanList(),
        allPeserta.length > 0 && !forceRefresh ? Promise.resolve(allPeserta) : DB.getPesertaList()
      ]);
      allGuru = gRes || [];
      allPaketUnfiltered = pkRes || [];
      allPaket = allPaketUnfiltered;
      allKelas = kRes || [];
      allJurusan = jRes || [];
      allPeserta = pRes || [];
    }

    if (syncText) syncText.innerText = 'Menghitung jumlah butir soal aktif untuk setiap paket ujian...';
    await hydrateAllPaketSoalCounts(forceRefresh);

    // Populate dropdown jurusan di Monitoring Kelas
    const selJur = document.getElementById('kesiapan-kelas-jurusan');
    if (selJur) {
      const prev = selJur.value;
      const jurList = getAllAvailableJurusanNames();
      selJur.innerHTML = '<option value="">Semua Jurusan</option>' +
        jurList.map(j => `<option value="${escapeAttr(j)}">${escapeHtml(j)}</option>`).join('');
      if (prev && jurList.includes(prev)) selJur.value = prev;
    }

    recomputeAndRenderKesiapan();

    const updatedEl = document.getElementById('kesiapan-last-updated');
    if (updatedEl) {
      const nowStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      updatedEl.innerHTML = `<i class="bi bi-check-circle-fill text-success me-1"></i>Terakhir dicek: <strong>${nowStr}</strong>`;
    }
  } catch (err) {
    console.error('Gagal loadKesiapanMonitoring:', err);
    Swal.fire('Gagal Memuat Monitoring', err.message || 'Terjadi kesalahan saat menganalisis kesiapan.', 'error');
  } finally {
    if (banner) {
      banner.classList.add('d-none');
      banner.classList.remove('d-flex');
    }
    if (btnRefresh) btnRefresh.disabled = false;
  }
}

function recomputeAndRenderKesiapan() {
  const guruRows = buildKesiapanGuruAnalysis();
  const kelasByGrade = buildKesiapanKelasAnalysis();

  const guruNoMapel = guruRows.filter(r => r.status === 'NO_MAPEL').length;
  const guruNoSoal = guruRows.filter(r => r.status === 'NO_PAKET' || r.status === 'ZERO_SOAL').length;
  const guruReady = guruRows.filter(r => r.status === 'READY').length;
  const guruIssuesTotal = guruNoMapel + guruNoSoal;

  const totalIncompleteRombels = ['X', 'XI', 'XII'].reduce((acc, g) => acc + (kelasByGrade[g]?.incompleteRombels || 0), 0);
  const totalRombels = ['X', 'XI', 'XII'].reduce((acc, g) => acc + (kelasByGrade[g]?.rombels.length || 0), 0);

  kesiapanLastSnapshot = {
    guruRows,
    kelasByGrade,
    summary: { guruNoMapel, guruNoSoal, guruReady, guruIssuesTotal, totalIncompleteRombels, totalRombels }
  };

  // Jika tingkat yang sedang dipilih tidak memiliki rombel, otomatis pilih tingkat pertama yang punya rombel
  if ((kelasByGrade[kesiapanSelectedTingkat]?.rombels.length || 0) === 0) {
    const firstNonEmpty = ['X', 'XI', 'XII'].find(g => (kelasByGrade[g]?.rombels.length || 0) > 0);
    if (firstNonEmpty) kesiapanSelectedTingkat = firstNonEmpty;
  }

  // Update 4 KPI Cards
  const elNoMapel = document.getElementById('kesiapan-stat-guru-nomapel');
  const elNoSoal = document.getElementById('kesiapan-stat-guru-nosoal');
  const elSiap = document.getElementById('kesiapan-stat-guru-siap');
  const elKelasKurang = document.getElementById('kesiapan-stat-kelas-kurang');
  const elKelasKurangSub = document.getElementById('kesiapan-stat-kelas-kurang-sub');

  if (elNoMapel) elNoMapel.innerText = guruNoMapel;
  if (elNoSoal) elNoSoal.innerText = guruNoSoal;
  if (elSiap) elSiap.innerText = `${guruReady} / ${guruRows.length}`;
  if (elKelasKurang) elKelasKurang.innerText = `${totalIncompleteRombels} / ${totalRombels}`;
  if (elKelasKurangSub) {
    const totalMissingCells = ['X', 'XI', 'XII'].reduce((acc, g) => acc + (kelasByGrade[g]?.missingCount || 0), 0);
    elKelasKurangSub.innerText = totalMissingCells > 0
      ? `${totalMissingCells} slot mapel kelas masih kosong`
      : 'Cek kelas dengan soal masih 0 / tabrakan';
  }

  // Update badges pada sub-tab & sidebar
  const bGuru = document.getElementById('badge-subtab-guru-issues');
  if (bGuru) {
    bGuru.innerText = guruIssuesTotal;
    bGuru.className = `badge ms-1 rounded-pill ${guruIssuesTotal > 0 ? 'bg-danger' : 'bg-success'}`;
  }
  const bKelas = document.getElementById('badge-subtab-kelas-issues');
  if (bKelas) {
    bKelas.innerText = totalIncompleteRombels;
    bKelas.className = `badge ms-1 rounded-pill ${totalIncompleteRombels > 0 ? 'bg-danger' : 'bg-success'}`;
  }
  const navBadge = document.getElementById('nav-badge-kesiapan');
  if (navBadge) {
    if (guruIssuesTotal > 0) {
      navBadge.innerText = guruIssuesTotal;
      navBadge.classList.remove('d-none');
    } else {
      navBadge.classList.add('d-none');
    }
  }

  // Update badges pada tombol Tingkat X / XI / XII
  ['X', 'XI', 'XII'].forEach(g => {
    const bEl = document.getElementById(`badge-tingkat-${g}`);
    if (bEl) {
      const gd = kelasByGrade[g];
      const inc = gd ? gd.incompleteRombels : 0;
      const tot = gd ? gd.rombels.length : 0;
      bEl.innerText = tot === 0 ? '0 kelas' : (inc > 0 ? `${inc} belum lengkap` : `✓ ${tot} siap`);
      bEl.className = `badge ms-1 ${inc > 0 ? 'bg-danger text-white' : 'bg-success-subtle text-success'}`;
    }
  });

  renderKesiapanGuruTable();
  renderKesiapanKelasMatrix();
}

function switchKesiapanSubTab(subTab) {
  kesiapanActiveSubTab = subTab === 'kelas' ? 'kelas' : 'guru';
  const pGuru = document.getElementById('kesiapan-panel-guru');
  const pKelas = document.getElementById('kesiapan-panel-kelas');
  const bGuru = document.getElementById('btn-subtab-kesiapan-guru');
  const bKelas = document.getElementById('btn-subtab-kesiapan-kelas');

  if (kesiapanActiveSubTab === 'guru') {
    if (pGuru) pGuru.classList.remove('d-none');
    if (pKelas) pKelas.classList.add('d-none');
    if (bGuru) bGuru.classList.add('active');
    if (bKelas) bKelas.classList.remove('active');
  } else {
    if (pGuru) pGuru.classList.add('d-none');
    if (pKelas) pKelas.classList.remove('d-none');
    if (bGuru) bGuru.classList.remove('active');
    if (bKelas) bKelas.classList.add('active');
  }
}

function jumpKesiapanFilter(subTab, filterVal) {
  switchKesiapanSubTab(subTab);
  if (subTab === 'guru') {
    const sel = document.getElementById('kesiapan-guru-status');
    if (sel) sel.value = filterVal;
    renderKesiapanGuruTable();
  } else {
    const chk = document.getElementById('kesiapan-kelas-only-issues');
    if (chk) chk.checked = (filterVal === 'ISSUES');
    // Pilih tingkat pertama yang punya masalah
    if (kesiapanLastSnapshot) {
      const targetG = ['X', 'XI', 'XII'].find(g => (kesiapanLastSnapshot.kelasByGrade[g]?.incompleteRombels || 0) > 0);
      if (targetG) selectKesiapanTingkat(targetG);
      else renderKesiapanKelasMatrix();
    }
  }
}

function selectKesiapanTingkat(tingkat) {
  kesiapanSelectedTingkat = tingkat;
  const pills = document.querySelectorAll('#kesiapan-tingkat-pills button[data-tingkat]');
  pills.forEach(btn => {
    const isAct = btn.getAttribute('data-tingkat') === tingkat;
    btn.classList.toggle('btn-primary', isAct);
    btn.classList.toggle('btn-outline-primary', !isAct);
  });
  renderKesiapanKelasMatrix();
}

function renderKesiapanGuruTable() {
  const tbody = document.getElementById('tbody-kesiapan-guru');
  if (!tbody) return;
  if (!kesiapanLastSnapshot) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">Belum ada data. Klik "Refresh & Hitung Soal".</td></tr>`;
    return;
  }

  const q = (document.getElementById('kesiapan-guru-search')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('kesiapan-guru-status')?.value || 'ISSUES';

  const filtered = kesiapanLastSnapshot.guruRows.filter(row => {
    if (statusFilter === 'ISSUES' && row.status === 'READY') return false;
    if (statusFilter === 'NO_MAPEL' && row.status !== 'NO_MAPEL') return false;
    if (statusFilter === 'NO_PAKET' && row.status !== 'NO_PAKET') return false;
    if (statusFilter === 'ZERO_SOAL' && row.status !== 'ZERO_SOAL') return false;
    if (statusFilter === 'READY' && row.status !== 'READY') return false;

    if (q) {
      const hay = [
        row.nama,
        row.username,
        row.legacyMapelStr,
        ...row.penugasan.map(p => `${p.mapel} ${p.tingkat} ${p.jurusan}`),
        ...row.pakets.map(p => `${p.nama_paket} ${p.kelas} ${p.jurusan}`)
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const msg = statusFilter === 'ISSUES'
      ? '🎉 Luar biasa! Seluruh guru sudah mengatur mapel dan mengisi soal pada paket ujiannya.'
      : 'Tidak ada data guru yang sesuai dengan filter pencarian.';
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((row, idx) => {
    let statusBadge = '';
    if (row.status === 'NO_MAPEL') {
      statusBadge = `<span class="badge bg-danger text-white rounded-pill px-2 py-1"><i class="bi bi-x-circle-fill me-1"></i>Belum Atur Mapel</span>`;
    } else if (row.status === 'NO_PAKET') {
      statusBadge = `<span class="badge bg-warning text-dark rounded-pill px-2 py-1"><i class="bi bi-folder-x me-1"></i>Belum Ada Paket</span>`;
    } else if (row.status === 'ZERO_SOAL') {
      const subText = row.unmatchedPenugasan.length > 0
        ? `${row.filledPakets.length}/${row.pakets.length + row.unmatchedPenugasan.length} Terisi`
        : `${row.filledPakets.length}/${row.pakets.length} Paket Terisi`;
      statusBadge = `
        <span class="badge bg-warning-subtle text-dark border border-warning rounded-pill px-2 py-1">
          <i class="bi bi-hourglass-split text-warning-emphasis me-1"></i>Soal Masih 0 / Kurang
        </span>
        <div class="small text-muted mt-1" style="font-size: 0.72rem;">${subText}</div>
      `;
    } else {
      statusBadge = `
        <span class="badge bg-success-subtle text-success border border-success-subtle rounded-pill px-2 py-1">
          <i class="bi bi-check-circle-fill me-1"></i>Siap Ujian
        </span>
        <div class="small text-success fw-semibold mt-1" style="font-size: 0.72rem;">${row.totalSoal} total soal</div>
      `;
    }

    let mapelHtml = '';
    if (row.penugasan.length > 0) {
      mapelHtml = row.penugasan.map(p => {
        const kTxt = (p.tingkat && p.tingkat.toUpperCase() !== 'SEMUA') ? p.tingkat.replace(/TINGKAT:/gi, 'Tingkat ') : 'Semua Kelas';
        return `<div class="small mb-1"><span class="fw-semibold text-dark">${escapeHtml(p.mapel)}</span> <span class="badge bg-light text-secondary border" style="font-size: 0.68rem;">${escapeHtml(kTxt)}</span></div>`;
      }).join('');
    } else if (row.legacyMapelStr) {
      mapelHtml = `<div class="small text-dark">${escapeHtml(row.legacyMapelStr)}</div>`;
    } else {
      mapelHtml = `<span class="text-danger small fst-italic"><i class="bi bi-exclamation-circle me-1"></i>Belum mengatur mapel</span>`;
    }

    let paketHtml = '';
    if (row.pakets.length > 0) {
      paketHtml = row.pakets.map(pk => {
        const sc = getPaketSoalCountSafe(pk);
        const pName = getCleanPaketName(pk.nama_paket, pk.kelas, pk.jurusan);
        const bCls = sc > 0 ? 'bg-success-subtle text-success border-success-subtle' : 'bg-danger-subtle text-danger border-danger-subtle';
        return `
          <button type="button" class="badge border ${bCls} text-decoration-none me-1 mb-1 d-inline-flex align-items-center gap-1 kesiapan-cell-btn"
            style="font-size: 0.7rem;" onclick="openPaketFromKesiapan('${escapeAttr(pk.id)}')" title="Klik untuk membuka paket ini di Bank Soal">
            <span>${escapeHtml(pName)}</span>
            <strong class="ms-1">(${sc} soal)</strong>
          </button>
        `;
      }).join('');
    }
    if (row.unmatchedPenugasan.length > 0) {
      paketHtml += row.unmatchedPenugasan.map(u => `
        <span class="badge bg-warning-subtle text-dark border border-warning me-1 mb-1" style="font-size: 0.7rem;">
          <i class="bi bi-exclamation-triangle me-1"></i>${escapeHtml(u.mapel)} (Belum ada paket)
        </span>
      `).join('');
    }
    if (!paketHtml) {
      paketHtml = `<span class="text-muted small fst-italic">Belum ada paket soal</span>`;
    }

    const firstEmptyOrAnyPk = row.emptyPakets[0] || row.pakets[0] || null;
    const actionBtnHtml = `
      <div class="d-flex justify-content-center gap-1 flex-wrap">
        <button type="button" class="btn btn-sm btn-outline-primary rounded-pill px-2 py-0 fw-semibold" style="font-size: 0.75rem;"
          onclick="openPenugasanGuruModal('${escapeAttr(row.id)}')" title="Atur / Tambah Mata Pelajaran Guru">
          <i class="bi bi-journal-plus me-1"></i>Atur Mapel
        </button>
        ${firstEmptyOrAnyPk ? `
          <button type="button" class="btn btn-sm btn-outline-secondary rounded-pill px-2 py-0" style="font-size: 0.75rem;"
            onclick="openPaketFromKesiapan('${escapeAttr(firstEmptyOrAnyPk.id)}')" title="Buka Paket di Bank Soal">
            <i class="bi bi-box-arrow-up-right"></i>
          </button>
        ` : ''}
      </div>
    `;

    return `
      <tr>
        <td class="text-center text-muted fw-semibold">${idx + 1}</td>
        <td>
          <div class="fw-bold text-dark">${escapeHtml(row.nama)}</div>
          <span class="badge bg-light text-secondary border font-monospace" style="font-size: 0.7rem;">${escapeHtml(row.username || '-')}</span>
        </td>
        <td>${statusBadge}</td>
        <td>${mapelHtml}</td>
        <td>${paketHtml}</td>
        <td class="text-center">${actionBtnHtml}</td>
      </tr>
    `;
  }).join('');
}

function renderKesiapanCustomTargetsList() {
  const lbl = document.getElementById('kesiapan-target-tingkat-label');
  if (lbl) lbl.innerText = `Tingkat ${kesiapanSelectedTingkat}`;
  const container = document.getElementById('list-custom-target-mapel');
  if (!container) return;

  const list = getKesiapanCustomTargets(kesiapanSelectedTingkat);
  if (list.length === 0) {
    container.innerHTML = `<span class="small text-muted fst-italic">Belum ada target mapel wajib tambahan untuk Tingkat ${kesiapanSelectedTingkat}.</span>`;
    return;
  }
  container.innerHTML = list.map((m, idx) => `
    <span class="badge bg-primary-subtle text-primary border border-primary-subtle d-inline-flex align-items-center gap-1 px-2 py-1">
      <span>${escapeHtml(m)}</span>
      <button type="button" class="btn-close" style="font-size: 0.5rem;" onclick="removeCustomTargetMapel('${escapeAttr(kesiapanSelectedTingkat)}', ${idx})" title="Hapus target mapel ini"></button>
    </span>
  `).join('');
}

function renderKesiapanKelasMatrix() {
  renderKesiapanCustomTargetsList();

  const thead = document.getElementById('thead-kesiapan-kelas');
  const tbody = document.getElementById('tbody-kesiapan-kelas');
  const summaryBox = document.getElementById('kesiapan-kelas-summary-box');
  if (!thead || !tbody) return;

  if (!kesiapanLastSnapshot) {
    tbody.innerHTML = `<tr><td class="text-center py-4 text-muted">Belum ada data. Klik "Refresh & Hitung Soal".</td></tr>`;
    return;
  }

  const gradeData = kesiapanLastSnapshot.kelasByGrade[kesiapanSelectedTingkat];
  const selJur = (document.getElementById('kesiapan-kelas-jurusan')?.value || '').toUpperCase().trim();
  const selJurNorm = selJur ? normalizeJurAlias(selJur) : '';
  const onlyIssues = Boolean(document.getElementById('kesiapan-kelas-only-issues')?.checked);

  if (!gradeData || gradeData.rombels.length === 0) {
    thead.innerHTML = `<tr><th class="sticky-col px-3 py-2">Kelas / Rombel</th></tr>`;
    tbody.innerHTML = `<tr><td class="text-center py-4 text-muted">Belum ada data rombel kelas untuk <strong>Tingkat ${kesiapanSelectedTingkat}</strong> (pastikan Data Kelas / Peserta sudah diinput).</td></tr>`;
    if (summaryBox) summaryBox.innerHTML = '';
    return;
  }

  const visibleRombels = gradeData.rombels.filter(rr => {
    if (selJurNorm && rr.rombel.jurNorm !== selJurNorm) return false;
    if (onlyIssues && !rr.hasIssues) return false;
    return true;
  });

  // Saring kolom mapel agar jika filter jurusan aktif, hanya tampilkan mapel umum + mapel jurusan tersebut
  const visibleCols = gradeData.columns.filter(col => {
    if (!selJurNorm) return true;
    return col.isCommon || col.isOptional || col.applicableJurNorms.has(selJurNorm);
  });

  // Ringkasan cepat kelas bermasalah di tingkat ini
  if (summaryBox) {
    const problemRombels = gradeData.rombels.filter(rr => {
      if (selJurNorm && rr.rombel.jurNorm !== selJurNorm) return false;
      return rr.hasIssues;
    });

    if (problemRombels.length === 0) {
      summaryBox.innerHTML = `
        <div class="alert alert-success border-success-subtle py-2 px-3 small mb-0 d-flex align-items-center gap-2">
          <i class="bi bi-check-circle-fill fs-5 text-success"></i>
          <div><strong>Lengkap &amp; Siap!</strong> Semua rombel di <strong>Tingkat ${kesiapanSelectedTingkat}</strong>${selJur ? ` (${escapeHtml(selJur)})` : ''} sudah mendapatkan seluruh mapel dan paket soalnya sudah terisi.</div>
        </div>
      `;
    } else {
      const itemsHtml = problemRombels.map(rr => {
        const parts = [];
        if (rr.missingList.length > 0) parts.push(`<span class="text-danger fw-semibold">❌ Belum dapat: ${escapeHtml(rr.missingList.join(', '))}</span>`);
        if (rr.noPaketList.length > 0) parts.push(`<span class="text-warning-emphasis fw-semibold">🟠 Belum ada paket: ${escapeHtml(rr.noPaketList.map(x => x.label).join(', '))}</span>`);
        if (rr.zeroList.length > 0) parts.push(`<span class="text-warning-emphasis">⚠️ 0 soal: ${escapeHtml(rr.zeroList.map(x => `${x.label} (${x.guru})`).join(', '))}</span>`);
        if (rr.conflictList.length > 0) parts.push(`<span class="text-danger fw-bold">🔥 Ganda: ${escapeHtml(rr.conflictList.map(x => x.label).join(', '))}</span>`);
        return `<li class="mb-1"><strong>${escapeHtml(rr.rombel.nama)}</strong> <span class="text-muted">(${rr.rombel.siswaCount} siswa)</span>: ${parts.join(' &bull; ')}</li>`;
      }).join('');

      summaryBox.innerHTML = `
        <div class="alert alert-danger border-danger-subtle bg-danger-subtle text-dark py-2 px-3 small mb-0">
          <div class="fw-bold text-danger mb-1">
            <i class="bi bi-exclamation-triangle-fill me-1"></i>
            Ditemukan ${problemRombels.length} Rombel Belum Lengkap di Tingkat ${kesiapanSelectedTingkat}${selJur ? ` (${escapeHtml(selJur)})` : ''}:
          </div>
          <ul class="mb-0 ps-3" style="max-height: 150px; overflow-y: auto;">${itemsHtml}</ul>
        </div>
      `;
    }
  }

  // Render header matriks
  thead.innerHTML = `
    <tr>
      <th class="sticky-col px-3 py-2" style="min-width: 150px;">Kelas / Rombel</th>
      <th class="text-center px-2 py-2" style="min-width: 85px;">Siap</th>
      ${visibleCols.map(col => {
        const typeBadge = col.isOptional
          ? `<span class="badge bg-light text-muted border d-block mt-1" style="font-size: 0.6rem;">Agama Opsional</span>`
          : (col.isCommon
            ? `<span class="badge bg-primary-subtle text-primary d-block mt-1" style="font-size: 0.6rem;">Umum${col.isCustom ? ' • Wajib' : ''}</span>`
            : `<span class="badge bg-info-subtle text-dark d-block mt-1" style="font-size: 0.6rem;">Kejuruan (${escapeHtml(Array.from(col.applicableJurNorms).join(', ').toUpperCase())})</span>`);
        return `<th class="text-center px-2 py-2" style="min-width: 118px; font-size: 0.76rem; line-height: 1.25;">${escapeHtml(col.label)}${typeBadge}</th>`;
      }).join('')}
    </tr>
  `;

  if (visibleRombels.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${visibleCols.length + 2}" class="text-center py-4 text-muted">Tidak ada rombel yang cocok dengan filter saat ini.</td></tr>`;
    return;
  }

  const visibleColFams = new Set(visibleCols.map(c => c.fam));

  tbody.innerHTML = visibleRombels.map(rr => {
    const pct = rr.requiredCount > 0 ? Math.round((rr.readyCount / rr.requiredCount) * 100) : 100;
    const progressCls = rr.missingList.length > 0 || rr.conflictList.length > 0
      ? 'bg-danger'
      : (rr.zeroList.length > 0 || rr.noPaketList.length > 0 ? 'bg-warning text-dark' : 'bg-success');

    const cellsHtml = rr.cells.filter(c => visibleColFams.has(c.col.fam)).map(cell => {
      if (cell.state === 'NA' || cell.state === 'OPTIONAL') {
        return `<td class="text-center text-muted bg-light-subtle" style="font-size: 0.72rem;" title="${cell.state === 'OPTIONAL' ? 'Mapel agama minoritas (opsional)' : 'Bukan mapel jurusan kelas ini'}">—</td>`;
      }
      if (cell.state === 'READY') {
        return `
          <td class="text-center p-1 bg-success-subtle kesiapan-cell-btn"
            onclick="${cell.paketId ? `openPaketFromKesiapan('${escapeAttr(cell.paketId)}')` : ''}"
            title="Siap: ${escapeAttr(cell.paketName)} • Guru: ${escapeAttr(cell.guruName)} (${cell.soalCount} soal). Klik untuk buka paket.">
            <div class="fw-bold text-success" style="font-size: 0.74rem;">✅ ${cell.soalCount} soal</div>
            <div class="text-truncate text-muted mx-auto" style="max-width: 110px; font-size: 0.65rem;">${escapeHtml(cell.guruName)}</div>
          </td>
        `;
      }
      if (cell.state === 'ZERO_SOAL') {
        return `
          <td class="text-center p-1 bg-warning-subtle kesiapan-cell-btn"
            onclick="${cell.paketId ? `openPaketFromKesiapan('${escapeAttr(cell.paketId)}')` : ''}"
            title="Paket ada tapi masih 0 soal • Guru: ${escapeAttr(cell.guruName)}. Klik untuk buka paket.">
            <div class="fw-bold text-warning-emphasis" style="font-size: 0.74rem;">⚠️ 0 soal</div>
            <div class="text-truncate text-dark mx-auto" style="max-width: 110px; font-size: 0.65rem;">${escapeHtml(cell.guruName)}</div>
          </td>
        `;
      }
      if (cell.state === 'NO_PAKET') {
        return `
          <td class="text-center p-1 bg-warning-subtle kesiapan-cell-btn"
            onclick="${cell.guruId ? `openPenugasanGuruModal('${escapeAttr(cell.guruId)}')` : ''}"
            title="Guru sudah ditugaskan (${escapeAttr(cell.guruName)}), tapi paket soalnya belum terbentuk. Klik untuk cek penugasan.">
            <div class="fw-bold text-warning-emphasis" style="font-size: 0.72rem;">🟠 0 paket</div>
            <div class="text-truncate text-dark mx-auto" style="max-width: 110px; font-size: 0.65rem;">${escapeHtml(cell.guruName)}</div>
          </td>
        `;
      }
      if (cell.state === 'CONFLICT') {
        return `
          <td class="text-center p-1 bg-danger text-white"
            title="TABRAKAN: Lebih dari 1 guru/paket aktif untuk ${escapeAttr(cell.col.label)} di ${escapeAttr(rr.rombel.nama)} (${escapeAttr(cell.guruName)})">
            <div class="fw-bold" style="font-size: 0.74rem;">🔥 Ganda</div>
            <div class="text-truncate mx-auto" style="max-width: 110px; font-size: 0.64rem;">${escapeHtml(cell.guruName)}</div>
          </td>
        `;
      }
      return `
        <td class="text-center p-1 bg-danger-subtle"
          title="BELUM DAPAT MAPEL: Belum ada guru maupun paket ${escapeAttr(cell.col.label)} untuk kelas ${escapeAttr(rr.rombel.nama)}">
          <div class="fw-bold text-danger" style="font-size: 0.74rem;">❌ Kosong</div>
          <div class="text-danger-emphasis" style="font-size: 0.63rem;">Belum ada guru</div>
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td class="sticky-col px-3 py-2">
          <div class="fw-bold text-dark">${escapeHtml(rr.rombel.nama)}</div>
          <div class="small text-muted" style="font-size: 0.7rem;">${escapeHtml(rr.rombel.jurusan)} &bull; ${rr.rombel.siswaCount} siswa</div>
        </td>
        <td class="text-center px-2">
          <span class="badge ${progressCls} rounded-pill" style="font-size: 0.72rem;">${rr.readyCount}/${rr.requiredCount}</span>
          <div class="text-muted" style="font-size: 0.65rem;">${pct}%</div>
        </td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');
}

function openPaketFromKesiapan(paketId) {
  if (!paketId) return;
  switchTab('soal');
  setTimeout(() => {
    selectPaket(paketId);
  }, 80);
}

async function copyKesiapanWaRecap(mode = 'auto') {
  if (!kesiapanLastSnapshot) {
    await loadKesiapanMonitoring(false);
  }
  if (!kesiapanLastSnapshot) return;

  const targetMode = mode === 'auto' ? kesiapanActiveSubTab : mode;
  const tgl = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
  let text = '';

  if (targetMode === 'guru') {
    const rows = kesiapanLastSnapshot.guruRows;
    const noMapel = rows.filter(r => r.status === 'NO_MAPEL');
    const noPaket = rows.filter(r => r.status === 'NO_PAKET');
    const zeroSoal = rows.filter(r => r.status === 'ZERO_SOAL');
    const ready = rows.filter(r => r.status === 'READY');

    text += `📋 *REKAP KESIAPAN GURU CBT SMKN 1 LEMPUING*\n`;
    text += `📅 Tanggal: ${tgl}\n`;
    text += `✅ Siap Ujian: *${ready.length} / ${rows.length} Guru*\n\n`;

    if (noMapel.length > 0) {
      text += `🔴 *BELUM MENGATUR MAPEL (${noMapel.length} Guru):*\n`;
      noMapel.forEach((r, i) => {
        text += `${i + 1}. ${r.nama} (user: ${r.username})\n`;
      });
      text += `\n`;
    }
    if (noPaket.length > 0) {
      text += `🟠 *MAPEL ADA, BELUM ADA PAKET SOAL (${noPaket.length} Guru):*\n`;
      noPaket.forEach((r, i) => {
        const mNames = r.penugasan.map(p => p.mapel).join(', ') || r.legacyMapelStr;
        text += `${i + 1}. ${r.nama} — ${mNames}\n`;
      });
      text += `\n`;
    }
    if (zeroSoal.length > 0) {
      text += `🟡 *PAKET SOAL MASIH 0 SOAL / BELUM LENGKAP (${zeroSoal.length} Guru):*\n`;
      zeroSoal.forEach((r, i) => {
        const kosongNames = r.emptyPakets.map(p => getCleanPaketName(p.nama_paket, p.kelas, p.jurusan));
        r.unmatchedPenugasan.forEach(u => kosongNames.push(`${u.mapel} (belum ada paket)`));
        text += `${i + 1}. ${r.nama} — [${r.filledPakets.length}/${r.pakets.length + r.unmatchedPenugasan.length} terisi] Belum diisi: ${kosongNames.join('; ')}\n`;
      });
      text += `\n`;
    }
    if (noMapel.length === 0 && noPaket.length === 0 && zeroSoal.length === 0) {
      text += `🎉 *Seluruh guru sudah lengkap mengatur mapel dan mengisi soal ujian!*\n`;
    } else {
      text += `Mohon Bapak/Ibu Guru yang tercantum di atas segera melengkapi penugasan mapel / input butir soal di portal CBT. Terima kasih 🙏`;
    }
  } else {
    text += `📋 *REKAP KESIAPAN MAPEL PER KELAS CBT SMKN 1 LEMPUING*\n`;
    text += `📅 Tanggal: ${tgl}\n\n`;
    let anyProblem = false;

    ['X', 'XI', 'XII'].forEach(g => {
      const gd = kesiapanLastSnapshot.kelasByGrade[g];
      if (!gd || gd.rombels.length === 0) return;
      const probs = gd.rombels.filter(rr => rr.hasIssues);
      if (probs.length === 0) {
        text += `✅ *Tingkat ${g}*: Semua ${gd.rombels.length} kelas sudah lengkap!\n`;
        return;
      }
      anyProblem = true;
      text += `⚠️ *Tingkat ${g} (${probs.length}/${gd.rombels.length} kelas belum lengkap):*\n`;
      probs.forEach(rr => {
        const det = [];
        if (rr.missingList.length > 0) det.push(`❌ Belum ada mapel: ${rr.missingList.join(', ')}`);
        if (rr.noPaketList.length > 0) det.push(`🟠 Belum ada paket: ${rr.noPaketList.map(x => x.label).join(', ')}`);
        if (rr.zeroList.length > 0) det.push(`⚠️ 0 soal: ${rr.zeroList.map(x => `${x.label} (${x.guru})`).join(', ')}`);
        if (rr.conflictList.length > 0) det.push(`🔥 Ganda: ${rr.conflictList.map(x => x.label).join(', ')}`);
        text += `• *${rr.rombel.nama}*: ${det.join(' | ')}\n`;
      });
      text += `\n`;
    });

    if (!anyProblem) {
      text += `\n🎉 *Semua kelas X, XI, dan XII sudah mendapatkan seluruh paket ujian dan soal siap!*`;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    Swal.fire({
      icon: 'success',
      title: 'Rekap WA Berhasil Disalin!',
      text: 'Silakan langsung Paste (Ctrl+V) di Grup WhatsApp Guru / Panitia.',
      timer: 2200,
      showConfirmButton: false
    });
  } catch (err) {
    // Fallback textarea copy
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    Swal.fire({
      icon: 'success',
      title: 'Rekap WA Disalin!',
      text: 'Silakan tempel di WhatsApp.',
      timer: 2000,
      showConfirmButton: false
    });
  }
}

function exportKesiapanExcel() {
  if (!kesiapanLastSnapshot) {
    Swal.fire('Data Belum Siap', 'Silakan tunggu atau klik "Refresh & Hitung Soal" terlebih dahulu.', 'info');
    return;
  }
  if (typeof XLSX === 'undefined') {
    Swal.fire('Library Excel Belum Siap', 'SheetJS (XLSX) belum termuat di halaman.', 'error');
    return;
  }

  const wb = XLSX.utils.book_new();
  const statusLabelMap = {
    NO_MAPEL: 'Belum Atur Mapel',
    NO_PAKET: 'Belum Ada Paket Soal',
    ZERO_SOAL: 'Soal Masih 0 / Belum Lengkap',
    READY: 'Siap Ujian'
  };

  // Sheet 1: Kesiapan Guru
  const guruSheetData = [
    ['No', 'Nama Lengkap Guru', 'Username', 'Status Kesiapan', 'Penugasan Mapel', 'Jumlah Paket', 'Paket Terisi Soal', 'Paket Masih 0 Soal', 'Total Butir Soal', 'Rincian Paket']
  ];
  kesiapanLastSnapshot.guruRows.forEach((r, idx) => {
    const mapelTxt = r.penugasan.length > 0
      ? r.penugasan.map(p => `${p.mapel} (${p.tingkat || 'Semua'})`).join('; ')
      : (r.legacyMapelStr || '-');
    const paketTxt = r.pakets.map(p => `${getCleanPaketName(p.nama_paket, p.kelas, p.jurusan)} [${getPaketSoalCountSafe(p)} soal]`).join('; ') || '-';
    guruSheetData.push([
      idx + 1,
      r.nama,
      r.username,
      statusLabelMap[r.status] || r.status,
      mapelTxt,
      r.pakets.length,
      r.filledPakets.length,
      r.emptyPakets.length,
      r.totalSoal,
      paketTxt
    ]);
  });
  const wsGuru = XLSX.utils.aoa_to_sheet(guruSheetData);
  XLSX.utils.book_append_sheet(wb, wsGuru, 'Kesiapan Guru');

  // Sheet 2..4: Matriks per Tingkat (X, XI, XII)
  ['X', 'XI', 'XII'].forEach(g => {
    const gd = kesiapanLastSnapshot.kelasByGrade[g];
    if (!gd || gd.rombels.length === 0) return;

    const header = ['Kelas / Rombel', 'Jurusan', 'Jml Siswa', 'Siap/Target', ...gd.columns.map(c => c.label)];
    const aoa = [header];

    gd.rombels.forEach(rr => {
      const row = [
        rr.rombel.nama,
        rr.rombel.jurusan,
        rr.rombel.siswaCount,
        `${rr.readyCount}/${rr.requiredCount}`
      ];
      rr.cells.forEach(cell => {
        if (cell.state === 'NA' || cell.state === 'OPTIONAL') row.push('-');
        else if (cell.state === 'READY') row.push(`SIAP (${cell.soalCount} soal - ${cell.guruName})`);
        else if (cell.state === 'ZERO_SOAL') row.push(`0 SOAL (${cell.guruName})`);
        else if (cell.state === 'NO_PAKET') row.push(`BELUM ADA PAKET (${cell.guruName})`);
        else if (cell.state === 'CONFLICT') row.push(`GANDA (${cell.guruName})`);
        else row.push('BELUM DAPAT MAPEL');
      });
      aoa.push(row);
    });

    const wsG = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, wsG, `Kelas Tingkat ${g}`);
  });

  const todayStr = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `Monitoring_Kesiapan_CBT_${todayStr}.xlsx`);
}

// Bind to window
window.loadKesiapanMonitoring = loadKesiapanMonitoring;
window.switchKesiapanSubTab = switchKesiapanSubTab;
window.jumpKesiapanFilter = jumpKesiapanFilter;
window.selectKesiapanTingkat = selectKesiapanTingkat;
window.renderKesiapanGuruTable = renderKesiapanGuruTable;
window.renderKesiapanKelasMatrix = renderKesiapanKelasMatrix;
window.addCustomTargetMapel = addCustomTargetMapel;
window.removeCustomTargetMapel = removeCustomTargetMapel;
window.openPaketFromKesiapan = openPaketFromKesiapan;
window.copyKesiapanWaRecap = copyKesiapanWaRecap;
window.exportKesiapanExcel = exportKesiapanExcel;
window.switchTab = switchTab;
window.loadDashboardStats = loadDashboardStats;
window.exportPesertaData = exportPesertaData;
window.exportGuruData = exportGuruData;
window.exportSoalData = exportSoalData;
window.exportPaketSoalWord = exportPaketSoalWord;
window.exportAllBankSoalExcel = exportAllBankSoalExcel;
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
window.toggleGuruPaketGroup = toggleGuruPaketGroup;
window.toggleAllGuruPaketGroups = toggleAllGuruPaketGroups;
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
window.handleProctorResetLogin = handleProctorResetLogin;
window.bukaSesiMapelBaruModal = bukaSesiMapelBaruModal;
window.openCetakKartuModal = openCetakKartuModal;
window.onCetakPasswordModeChange = onCetakPasswordModeChange;
window.onCetakFilterJurusanChange = onCetakFilterJurusanChange;
window.populateCetakJurusanAndKelasDropdowns = populateCetakJurusanAndKelasDropdowns;
window.updateCetakPreviewCount = updateCetakPreviewCount;
window.prosesCetakKartu = prosesCetakKartu;
window.cetakKartuSiswa = cetakKartuSiswa;
window.filterSoalList = () => {};
window.filterHasilList = filterHasilList;
window.bersihkanHasilSimulasiModal = bersihkanHasilSimulasiModal;
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
window.openImportWordModal = openImportWordModal;
window.handleWordFileUpload = handleWordFileUpload;
window.loadSampleWordText = loadSampleWordText;
window.clearWordRawInput = clearWordRawInput;
window.triggerParseWordText = triggerParseWordText;
window.setWordQuestionKey = setWordQuestionKey;
window.deleteWordQuestion = deleteWordQuestion;
window.saveWordImportedData = saveWordImportedData;
window.quickDeleteGuruPaket = quickDeleteGuruPaket;
window.cleanupOrphanAndDuplicatePakets = cleanupOrphanAndDuplicatePakets;
window.updatePenugasanConflictWarning = updatePenugasanConflictWarning;
window.formatMathExponents = formatMathExponents;
window.renderMathHtml = renderMathHtml;
window.insertMathSymbol = insertMathSymbol;
window.convertAllSoalFormExponents = convertAllSoalFormExponents;
window.splitWacanaAndQuestion = splitWacanaAndQuestion;
window.combineWacanaAndQuestion = combineWacanaAndQuestion;
window.copyWacanaFromPrevSoal = copyWacanaFromPrevSoal;
window.clearSoalWacanaInput = clearSoalWacanaInput;
window.applyWacanaToSoalRangePrompt = applyWacanaToSoalRangePrompt;
