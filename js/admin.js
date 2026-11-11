// Admin Panel Controller

let setupModalInstance = null;
let importModalInstance = null;
let pesertaFormModalInstance = null;
let soalFormModalInstance = null;
let paketFormModalInstance = null;
let jurusanModalInstance = null;
let kelasModalInstance = null;
let cetakKartuModalInstance = null;

let currentAdminUser = null;
let allPeserta = [];
let allSoal = [];
let allHasil = [];
let allPaket = [];
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

  // Form Handlers
  document.getElementById('form-setup-supabase').addEventListener('submit', handleSupabaseSetup);
  document.getElementById('form-update-supabase').addEventListener('submit', handleSupabaseUpdate);
  document.getElementById('form-settings-exam').addEventListener('submit', handleSettingsUpdate);
  document.getElementById('form-peserta-crud').addEventListener('submit', handlePesertaCrudSubmit);
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

  // Authenticate Admin Session (supports local mock and supabase auth)
  currentAdminUser = await DB.checkSession('admin');
  if (!currentAdminUser) return;

  document.getElementById('admin-display-name').innerText = currentAdminUser.email;
  initAdminShardSelector();

  // Initial Data Load
  await refreshAllData();
  toggleAutoRefresh(true);
});

// Refresh all database cache
async function refreshAllData() {
  await Promise.all([
    loadDashboardStats(),
    loadPeserta(),
    loadPaket(),
    loadJurusan(),
    loadKelas(),
    loadHasil(),
    loadSettings()
  ]);
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
  activeTab = tabId;
  const sections = ['dashboard', 'peserta', 'soal', 'jurusan', 'nilai', 'pengaturan'];
  
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

  if (tabId === 'dashboard') {
    loadDashboardStats();
    const autoSw = document.getElementById('switch-auto-refresh');
    if (autoSw && autoSw.checked) toggleAutoRefresh(true);
  } else {
    toggleAutoRefresh(false);
    if (tabId === 'jurusan') {
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
      document.getElementById('settings-exam-duration').value = data.durasi_menit;
      const passingInput = document.getElementById('settings-exam-passing');
      if (passingInput) passingInput.value = data.passing_grade || 0;
      if (data.tampilkan_nilai !== undefined) {
        document.getElementById('settings-exam-show-score').checked = data.tampilkan_nilai;
      }
      if (data.token_ujian !== undefined) {
        document.getElementById('settings-exam-token').value = data.token_ujian;
      } else {
        document.getElementById('settings-exam-token').value = "CBT123";
      }
      if (data.token_aktif !== undefined) {
        document.getElementById('settings-exam-use-token').checked = data.token_aktif;
      }
      if (data.acak_soal !== undefined) {
        document.getElementById('settings-exam-randomize').checked = data.acak_soal;
      }
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

function generateNewToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 6; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  document.getElementById('settings-exam-token').value = token;
}

// -------------------------------------------------------------
// LIVE MONITORING & DASHBOARD STATISTICS
// -------------------------------------------------------------

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
    }, 10000);
  }
}

async function loadDashboardStats(showIndicator = false) {
  const icon = document.getElementById('icon-refresh-dashboard');
  if (showIndicator && icon) icon.classList.add('spin-animation');

  try {
    const [pesertaList, hasilList] = await Promise.all([
      DB.getPesertaList(),
      DB.getHasilList()
    ]);
    allPeserta = pesertaList || [];
    allHasil = hasilList || [];

    const totalPeserta = allPeserta.length;
    const sudahUjian = allPeserta.filter(p => p.status_ujian === 'Sudah Ujian').length;
    const sedangUjian = allPeserta.filter(p => p.status_ujian === 'Sedang Ujian').length;
    const belumUjian = totalPeserta - sudahUjian - sedangUjian;
    const terkunciOrWarning = allPeserta.filter(p => Boolean(p.is_locked) || (parseInt(p.pelanggaran || 0) > 0)).length;

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
  } catch (err) {
    console.error("Gagal memuat dashboard stats:", err);
  } finally {
    if (icon) {
      setTimeout(() => icon.classList.remove('spin-animation'), 600);
    }
  }
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
    selCardJur.innerHTML = '<option value="">Semua Jurusan</option>';
    sortedJurusan.forEach(j => {
      selCardJur.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
    if (cur && sortedJurusan.includes(cur)) selCardJur.value = cur;
  }

  // 2. Dropdown Jurusan di atas Tabel
  const selTblJur = document.getElementById('monitor-table-filter-jurusan');
  if (selTblJur) {
    const cur = selTblJur.value;
    selTblJur.innerHTML = '<option value="">Semua Jurusan</option>';
    sortedJurusan.forEach(j => {
      selTblJur.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
    if (cur && sortedJurusan.includes(cur)) selTblJur.value = cur;
  }

  // 3. Dropdown Kelas di atas Tabel
  const selTblKls = document.getElementById('monitor-table-filter-kelas');
  if (selTblKls) {
    const cur = selTblKls.value;
    selTblKls.innerHTML = '<option value="">Semua Kelas</option>';
    sortedKelas.forEach(k => {
      selTblKls.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
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
  if (!canvas1) return;

  const ctx1 = canvas1.getContext('2d');
  if (scoreDistChart) scoreDistChart.destroy();

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

  const canvas2 = document.getElementById('passingRateChart');
  if (canvas2) {
    const ctx2 = canvas2.getContext('2d');
    if (passRateChart) passRateChart.destroy();

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

  // 1. Dropdown Form Peserta (crud-peserta-jurusan)
  const selPeserta = document.getElementById('crud-peserta-jurusan');
  if (selPeserta) {
    const cur = selPeserta.value;
    selPeserta.innerHTML = '<option value="">Pilih Jurusan...</option>';
    sortedList.forEach(j => {
      selPeserta.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
    if (cur) selPeserta.value = cur;
  }

  // 2. Dropdown Form Paket Soal (crud-paket-jurusan)
  const selPaket = document.getElementById('crud-paket-jurusan');
  if (selPaket) {
    const cur = selPaket.value;
    selPaket.innerHTML = '<option value="">Semua Jurusan (Umum)</option>';
    sortedList.forEach(j => {
      selPaket.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
    if (cur) selPaket.value = cur;
  }

  // 3. Filter Jurusan Paket Soal (filter-jurusan-paket)
  const fPaket = document.getElementById('filter-jurusan-paket');
  if (fPaket) {
    const cur = fPaket.value;
    fPaket.innerHTML = '<option value="">Semua Jurusan</option>';
    sortedList.forEach(j => {
      fPaket.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
    if (cur) fPaket.value = cur;
  }

  // 4. Filter Jurusan Peserta (filter-jurusan-peserta)
  const fPeserta = document.getElementById('filter-jurusan-peserta');
  if (fPeserta) {
    const cur = fPeserta.value;
    fPeserta.innerHTML = '<option value="">Semua Jurusan</option>';
    sortedList.forEach(j => {
      fPeserta.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
    if (cur) fPeserta.value = cur;
  }

  // 5. Filter Jurusan Hasil (filter-jurusan-hasil)
  const fHasil = document.getElementById('filter-jurusan-hasil');
  if (fHasil) {
    const cur = fHasil.value;
    fHasil.innerHTML = '<option value="">Semua Jurusan</option>';
    sortedList.forEach(j => {
      fHasil.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
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

  // 1. Dropdown Form Peserta (crud-peserta-kelas)
  const selPeserta = document.getElementById('crud-peserta-kelas');
  if (selPeserta) {
    const cur = selPeserta.value;
    selPeserta.innerHTML = '<option value="">Pilih Kelas...</option>';
    sortedList.forEach(k => {
      selPeserta.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
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
    `;
    sortedList.forEach(k => {
      selPaket.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
    selPaket.innerHTML += `</optgroup>`;
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
    `;
    sortedList.forEach(k => {
      fPaket.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
    fPaket.innerHTML += `</optgroup>`;
    if (cur) fPaket.value = cur;
  }

  // 4. Filter Kelas Peserta (filter-kelas-peserta)
  const fPeserta = document.getElementById('filter-kelas-peserta');
  if (fPeserta) {
    const cur = fPeserta.value;
    fPeserta.innerHTML = '<option value="">Semua Kelas</option>';
    sortedList.forEach(k => {
      fPeserta.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
    if (cur) fPeserta.value = cur;
  }

  // 5. Filter Kelas Hasil (filter-kelas-hasil)
  const fHasil = document.getElementById('filter-kelas-hasil');
  if (fHasil) {
    const cur = fHasil.value;
    fHasil.innerHTML = '<option value="">Semua Kelas</option>';
    sortedList.forEach(k => {
      fHasil.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
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

function renderPesertaTable(list) {
  const tbody = document.getElementById('table-peserta-body');
  tbody.innerHTML = '';

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">Data peserta kosong atau tidak ditemukan.</td></tr>`;
    return;
  }

  // Sort list by Jurusan first, then Name
  const sortedList = [...list].sort((a, b) => {
    const jA = (a.jurusan || 'Tanpa Jurusan').toUpperCase();
    const jB = (b.jurusan || 'Tanpa Jurusan').toUpperCase();
    if (jA < jB) return -1;
    if (jA > jB) return 1;
    return a.nama_lengkap.localeCompare(b.nama_lengkap);
  });

  let currentJurusan = null;

  sortedList.forEach(p => {
    let statusClass = "bg-secondary";
    if (p.status_ujian === 'Sedang Ujian') statusClass = "bg-warning text-dark";
    if (p.status_ujian === 'Sudah Ujian') statusClass = "bg-success";
    
    const pJurusan = (p.jurusan || 'Tanpa Jurusan').toUpperCase();

    // Group Header Row
    if (currentJurusan !== pJurusan) {
      tbody.innerHTML += `
        <tr class="table-light">
          <td colspan="9" class="fw-bold text-primary py-2" style="background-color: #f8f9fa;">
            <i class="bi bi-bookmark-fill me-2"></i>JURUSAN: ${pJurusan}
          </td>
        </tr>
      `;
      currentJurusan = pJurusan;
    }

    tbody.innerHTML += `
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
    `;
  });
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

  renderPesertaTable(filtered);
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
  const user = document.getElementById('crud-peserta-username').value.trim();
  const nama = document.getElementById('crud-peserta-nama').value.trim();
  const jurusan = document.getElementById('crud-peserta-jurusan').value.trim();
  const kelas = document.getElementById('crud-peserta-kelas').value.trim();
  const ruang = document.getElementById('crud-peserta-ruang').value.trim();
  const sesi = document.getElementById('crud-peserta-sesi').value.trim();
  const pass = document.getElementById('crud-peserta-pass').value;

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

  const lingkup = document.getElementById('cetak-filter-lingkup');
  if (lingkup) lingkup.value = 'semua';
  onCetakLingkupChange();
  if (cetakKartuModalInstance) cetakKartuModalInstance.show();
}

function onCetakLingkupChange() {
  const lingkup = document.getElementById('cetak-filter-lingkup')?.value || 'semua';
  const selSpesifik = document.getElementById('cetak-filter-spesifik');
  const labelSpesifik = document.getElementById('label-cetak-spesifik');
  if (!selSpesifik || !labelSpesifik) return;

  if (lingkup === 'semua') {
    selSpesifik.disabled = true;
    labelSpesifik.innerText = 'Semua Siswa';
    selSpesifik.innerHTML = '<option value="">- Seluruh Peserta -</option>';
  } else if (lingkup === 'kelas') {
    selSpesifik.disabled = false;
    labelSpesifik.innerText = 'Pilih Kelas';
    const classes = Array.from(new Set((allPeserta || []).map(p => (p.kelas || '').toUpperCase()).filter(Boolean))).sort();
    selSpesifik.innerHTML = '<option value="">Semua Kelas</option>';
    classes.forEach(k => {
      selSpesifik.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
    });
  } else if (lingkup === 'jurusan') {
    selSpesifik.disabled = false;
    labelSpesifik.innerText = 'Pilih Jurusan';
    const jurusans = Array.from(new Set((allPeserta || []).map(p => (p.jurusan || '').toUpperCase()).filter(Boolean))).sort();
    selSpesifik.innerHTML = '<option value="">Semua Jurusan</option>';
    jurusans.forEach(j => {
      selSpesifik.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
    });
  } else if (lingkup === 'sesi') {
    selSpesifik.disabled = false;
    labelSpesifik.innerText = 'Pilih Sesi';
    const sesis = Array.from(new Set((allPeserta || []).map(p => p.sesi).filter(Boolean))).sort();
    selSpesifik.innerHTML = '<option value="">Semua Sesi</option>';
    if (sesis.length === 0) {
      selSpesifik.innerHTML += '<option value="Sesi 1">Sesi 1</option><option value="Sesi 2">Sesi 2</option><option value="Sesi 3">Sesi 3</option>';
    } else {
      sesis.forEach(s => {
        selSpesifik.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`;
      });
    }
  } else if (lingkup === 'filter_tabel') {
    selSpesifik.disabled = true;
    labelSpesifik.innerText = 'Filter Tabel Aktif';
    selSpesifik.innerHTML = '<option value="">- Sesuai Tabel Peserta -</option>';
  }

  updateCetakPreviewCount();
}

function getTargetCetakStudents() {
  const lingkup = document.getElementById('cetak-filter-lingkup')?.value || 'semua';
  const spesifik = (document.getElementById('cetak-filter-spesifik')?.value || '').toUpperCase().trim();

  if (lingkup === 'semua') {
    return allPeserta || [];
  } else if (lingkup === 'kelas') {
    if (!spesifik) return allPeserta || [];
    return (allPeserta || []).filter(p => (p.kelas || '').toUpperCase().trim() === spesifik);
  } else if (lingkup === 'jurusan') {
    if (!spesifik) return allPeserta || [];
    return (allPeserta || []).filter(p => (p.jurusan || '').toUpperCase().trim() === spesifik);
  } else if (lingkup === 'sesi') {
    if (!spesifik) return allPeserta || [];
    return (allPeserta || []).filter(p => (p.sesi || '').toUpperCase().trim() === spesifik);
  } else if (lingkup === 'filter_tabel') {
    const q = (document.getElementById('search-peserta')?.value || '').toLowerCase().trim();
    const jurusan = (document.getElementById('filter-jurusan-peserta')?.value || '').toUpperCase().trim();
    const kelas = (document.getElementById('filter-kelas-peserta')?.value || '').toUpperCase().trim();
    const sesi = (document.getElementById('filter-sesi-peserta')?.value || '').trim();
    const status = (document.getElementById('filter-status-peserta')?.value || '').trim();

    return (allPeserta || []).filter(p => {
      const matchesSearch = !q ||
        (p.nama_lengkap || '').toLowerCase().includes(q) ||
        (p.username || '').toLowerCase().includes(q) ||
        (p.jurusan && p.jurusan.toLowerCase().includes(q)) ||
        (p.kelas && p.kelas.toLowerCase().includes(q));
      const matchesJurusan = !jurusan || (p.jurusan || '').toUpperCase().trim() === jurusan;
      const matchesKelas = !kelas || (p.kelas || '').toUpperCase().trim() === kelas;
      const matchesSesi = !sesi || p.sesi === sesi;
      const matchesStatus = !status || p.status_ujian === status;
      return matchesSearch && matchesJurusan && matchesKelas && matchesSesi && matchesStatus;
    });
  }
  return allPeserta || [];
}

function updateCetakPreviewCount() {
  const list = getTargetCetakStudents();
  const count = list.length;
  const pages = Math.ceil(count / 4);

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
    showTatib: document.getElementById('cetak-opt-tatib')?.checked ?? true
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
    showTatib: true
  };

  renderAndPrintCards([p], opt, mode);
}

function generatePrintCardsHtml(students, opt) {
  // Sort students by Kelas then Nama
  const sorted = [...students].sort((a, b) => {
    const kA = (a.kelas || '').toUpperCase();
    const kB = (b.kelas || '').toUpperCase();
    if (kA < kB) return -1;
    if (kA > kB) return 1;
    return (a.nama_lengkap || '').localeCompare(b.nama_lengkap || '');
  });

  const pages = [];
  for (let i = 0; i < sorted.length; i += 4) {
    pages.push(sorted.slice(i, i + 4));
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Cetak Kartu Ujian - ${escapeHtml(opt.namaSekolah)}</title>
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
      color: #000;
      font-size: 8px;
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

    /* Exact A4 Sheet Grid (296mm fits on single page without extra blank sheet) */
    .a4-sheet {
      width: 210mm;
      height: 296mm;
      margin: 10px auto;
      padding: 5mm 6mm;
      background: #ffffff;
      box-shadow: 0 4px 15px rgba(0,0,0,0.15);
      display: grid;
      grid-template-columns: calc(50% - 3mm) calc(50% - 3mm);
      grid-template-rows: calc(50% - 3mm) calc(50% - 3mm);
      gap: 6mm;
      box-sizing: border-box;
      page-break-after: always;
      break-after: page;
      overflow: hidden;
    }

    /* Single Card: Fits perfectly into 96mm x 139mm without overflowing */
    .kartu-card {
      border: 1px dashed #64748b;
      border-radius: 6px;
      padding: 5px 7px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
      background: #ffffff;
      box-sizing: border-box;
      height: 100%;
      overflow: hidden;
    }

    /* Kop Sekolah */
    .kop-sekolah {
      display: flex;
      align-items: center;
      border-bottom: 2px double #111;
      padding-bottom: 3px;
      margin-bottom: 3px;
    }
    .kop-logo {
      width: 32px;
      height: 32px;
      margin-right: 6px;
      flex-shrink: 0;
    }
    .kop-text {
      text-align: center;
      flex-grow: 1;
    }
    .kop-prov {
      font-size: 6.8px;
      font-weight: bold;
      text-transform: uppercase;
      line-height: 1.1;
      margin: 0;
      color: #333;
    }
    .kop-dinas {
      font-size: 7.2px;
      font-weight: bold;
      text-transform: uppercase;
      line-height: 1.1;
      margin: 0;
      color: #222;
    }
    .kop-nama {
      font-size: 9.5px;
      font-weight: 800;
      color: #0d6efd;
      text-transform: uppercase;
      line-height: 1.15;
      margin: 1px 0;
    }
    .kop-alamat {
      font-size: 6.5px;
      color: #555;
      line-height: 1.1;
      margin: 0;
    }

    /* Banner Judul */
    .title-banner {
      text-align: center;
      margin-bottom: 3px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 2px;
    }
    .title-main {
      font-size: 8px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      line-height: 1.15;
      color: #0f172a;
    }
    .title-sub {
      font-size: 7.2px;
      font-weight: 600;
      color: #475569;
      text-transform: uppercase;
      line-height: 1.1;
    }

    /* Body Siswa */
    .body-content {
      display: flex;
      gap: 5px;
      align-items: stretch;
      margin-bottom: 3px;
      flex-grow: 1;
    }
    .table-siswa {
      width: 100%;
      border-collapse: collapse;
      font-size: 7.8px;
      line-height: 1.25;
    }
    .table-siswa td {
      padding: 1.2px 0;
      vertical-align: top;
    }
    .table-siswa td.lbl {
      width: 58px;
      font-weight: 600;
      color: #475569;
    }
    .table-siswa td.col {
      width: 5px;
    }
    .table-siswa td.val {
      color: #0f172a;
      word-break: break-word;
    }
    .username-badge {
      font-family: monospace;
      font-size: 9px;
      font-weight: 800;
      color: #0d6efd;
      letter-spacing: 0.5px;
    }
    .password-code {
      font-family: monospace;
      font-size: 7.8px;
      background: #f1f5f9;
      padding: 1px 3px;
      border-radius: 3px;
      border: 1px solid #cbd5e1;
      font-weight: 600;
    }

    /* Photo / QR box */
    .photo-qr-box {
      width: 54px;
      height: 70px;
      border: 1px dashed #94a3b8;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      background: #f8fafc;
      text-align: center;
      padding: 2px;
      overflow: hidden;
    }
    .qr-img {
      width: 48px;
      height: 48px;
      display: block;
    }
    .photo-placeholder {
      font-size: 7px;
      color: #64748b;
      line-height: 1.2;
    }

    /* Footer */
    .footer-kartu {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-top: 1px solid #cbd5e1;
      padding-top: 3px;
      margin-top: auto;
      font-size: 6.5px;
    }
    .tatib-box {
      max-width: 56%;
      color: #475569;
      line-height: 1.2;
    }
    .tatib-box strong { font-size: 6.8px; color: #1e293b; }
    .tatib-box ol {
      margin: 1px 0 0 0;
      padding-left: 10px;
    }
    .tatib-box li {
      margin-bottom: 0.5px;
    }
    .ttd-box {
      text-align: center;
      min-width: 90px;
      line-height: 1.15;
      color: #1e293b;
    }
    .ttd-space {
      height: 20px;
    }
    .ttd-name {
      font-weight: bold;
      text-decoration: underline;
    }

    .cut-guide {
      position: absolute;
      bottom: 1px;
      right: 4px;
      font-size: 6px;
      color: #94a3b8;
      pointer-events: none;
    }

    @media print {
      body {
        background: #fff !important;
      }
      .no-print-bar {
        display: none !important;
      }
      .a4-sheet {
        margin: 0 !important;
        padding: 5mm 6mm !important;
        box-shadow: none !important;
        width: 100% !important;
        height: 296mm !important;
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
      📄 Pratinjau Kartu Ujian &bull; Total: ${sorted.length} Peserta (${pages.length} Lembar A4)
    </div>
    <div>
      <button class="btn-act btn-print" onclick="window.print()">🖨️ Cetak / Simpan PDF</button>
      <button class="btn-act btn-close" onclick="window.close()">Tutup Tab</button>
    </div>
  </div>

  ${pages.map((group) => `
    <div class="a4-sheet">
      ${group.map(p => `
        <div class="kartu-card">
          <!-- Kop Kartu -->
          <div class="kop-sekolah">
            <svg class="kop-logo" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="50" r="45" fill="#0d6efd" stroke="#ffffff" stroke-width="4" />
              <path d="M50 20 L25 40 L35 40 L35 75 L65 75 L65 40 L75 40 Z" fill="#ffffff" />
              <circle cx="50" cy="50" r="8" fill="#ffc107" />
            </svg>
            <div class="kop-text">
              <div class="kop-prov">PEMERINTAH PROVINSI SUMATERA SELATAN</div>
              <div class="kop-dinas">DINAS PENDIDIKAN</div>
              <div class="kop-nama">${escapeHtml(opt.namaSekolah)}</div>
              <div class="kop-alamat">Kec. Lempuing, Kab. Ogan Komering Ilir, Sumatera Selatan</div>
            </div>
          </div>

          <!-- Judul Ujian -->
          <div class="title-banner">
            <div class="title-main">${escapeHtml(opt.judulUjian)}</div>
            <div class="title-sub">${escapeHtml(opt.subjudulUjian)}</div>
          </div>

          <!-- Body Siswa & QR/Photo -->
          <div class="body-content">
            <table class="table-siswa">
              <tr>
                <td class="lbl">No. Peserta</td>
                <td class="col">:</td>
                <td class="val"><span class="username-badge">${escapeHtml(p.username)}</span></td>
              </tr>
              <tr>
                <td class="lbl">Password</td>
                <td class="col">:</td>
                <td class="val"><span class="password-code">${escapeHtml(p.password || 'Sesuai Akun')}</span></td>
              </tr>
              <tr>
                <td class="lbl">Nama Lengkap</td>
                <td class="col">:</td>
                <td class="val"><strong>${escapeHtml(p.nama_lengkap)}</strong></td>
              </tr>
              <tr>
                <td class="lbl">Jurusan</td>
                <td class="col">:</td>
                <td class="val">${escapeHtml(p.jurusan || '-')}</td>
              </tr>
              <tr>
                <td class="lbl">Kelas</td>
                <td class="col">:</td>
                <td class="val"><strong>${escapeHtml(p.kelas || '-')}</strong></td>
              </tr>
              <tr>
                <td class="lbl">Ruang / Sesi</td>
                <td class="col">:</td>
                <td class="val">${escapeHtml(p.ruang || '1')} / Sesi ${escapeHtml(p.sesi || '1')}</td>
              </tr>
            </table>

            <!-- Photo / QR Box -->
            <div class="photo-qr-box">
              ${opt.showQr ? `
                <img class="qr-img" src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(p.username)}" alt="QR" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                <div class="photo-placeholder" style="display: none;">Pasfoto<br>3 x 4 cm</div>
              ` : `
                <div class="photo-placeholder">Pasfoto<br>3 x 4 cm</div>
              `}
            </div>
          </div>

          <!-- Footer Kartu -->
          <div class="footer-kartu">
            ${opt.showTatib ? `
            <div class="tatib-box">
              <strong>Tata Tertib:</strong>
              <ol>
                <li>Bawa kartu ini saat ujian.</li>
                <li>Dilarang membuka tab lain.</li>
                <li>Hadir 15 mnt sebelum sesi.</li>
              </ol>
            </div>` : '<div></div>'}

            ${opt.showTtd ? `
            <div class="ttd-box">
              <div>${escapeHtml(opt.kotaTanggal)}</div>
              <div>Panitia Pelaksana,</div>
              <div class="ttd-space"></div>
              <div class="ttd-name">Panitia CBT</div>
              <div style="font-size: 6px; color: #64748b;">SMKN 1 Lempuing</div>
            </div>` : '<div></div>'}
          </div>

          <div class="cut-guide">✂️ potong</div>
        </div>
      `).join('')}
      ${group.length < 4 ? Array(4 - group.length).fill('<div style="border: 1px dashed #cbd5e1; border-radius: 6px;"></div>').join('') : ''}
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
    text: `Menyiapkan ${students.length} kartu (${Math.ceil(students.length / 4)} lembar A4)...`,
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
    allPaket = await DB.getPaketList();
    renderPaketList(allPaket);
    
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

  filtered.forEach(p => {
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

    container.innerHTML += `
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
}

function filterPaketList() {
  renderPaketList(allPaket);
}

function openPaketForm() {
  document.getElementById('paketFormTitle').innerText = "Buat Paket Soal Baru";
  document.getElementById('form-paket-crud').reset();
  document.getElementById('paket-id').value = "";
  populateJurusanDropdowns();
  populateKelasDropdowns();
  document.getElementById('crud-paket-jurusan').value = "";
  document.getElementById('crud-paket-kelas').value = "";
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

  list.forEach((s, idx) => {
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
    }
    optionsHtml += `</div>`;

    container.innerHTML += `
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

  const select = document.getElementById('crud-soal-jawaban');
  select.innerHTML = `
    <option value="">Pilih opsi benar...</option>
    <option value="A">Opsi A</option>
    <option value="B">Opsi B</option>
    <option value="C">Opsi C</option>
    <option value="D">Opsi D</option>
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

  if (s.opsi_c || s.opsi_d) {
    select.innerHTML += `
      <option value="C">Opsi C</option>
      <option value="D">Opsi D</option>
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
    jawaban_benar: 'Jawaban Benar',
    bobot: 'Bobot'
  };

  ExcelHelpers.exportJSONToExcel(allSoal, map, "Bank_Soal_CBT_SMKN1Lempuing", "Soal");
}

// -------------------------------------------------------------
// RESULTS: HASIL & NILAI
// -------------------------------------------------------------

async function loadHasil() {
  try {
    allHasil = await DB.getHasilList();
    
    // Populate dropdowns for Mapel, Jurusan and Kelas in Hasil Ujian
    const mapelSet = new Set();
    const jurusanSet = new Set();
    const kelasSet = new Set();

    // Collect from allPaket
    (allPaket || []).forEach(pk => {
      if (pk.nama_paket) mapelSet.add(pk.nama_paket);
    });

    // Collect from actual results
    allHasil.forEach(h => {
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
      fMapel.innerHTML = '<option value="">📚 Semua Mata Pelajaran</option>';
      Array.from(mapelSet).sort().forEach(m => {
        fMapel.innerHTML += `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`;
      });
      fMapel.value = fMapelVal;
    }
    
    const fJurusan = document.getElementById('filter-jurusan-hasil');
    if (fJurusan) {
      const fJurusanVal = fJurusan.value;
      fJurusan.innerHTML = '<option value="">Semua Jurusan</option>';
      Array.from(jurusanSet).sort().forEach(j => {
        fJurusan.innerHTML += `<option value="${escapeHtml(j)}">${escapeHtml(j)}</option>`;
      });
      fJurusan.value = fJurusanVal;
    }

    const fKelas = document.getElementById('filter-kelas-hasil');
    if (fKelas) {
      const fKelasVal = fKelas.value;
      fKelas.innerHTML = '<option value="">Semua Kelas</option>';
      Array.from(kelasSet).sort().forEach(k => {
        fKelas.innerHTML += `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`;
      });
      fKelas.value = fKelasVal;
    }
    
    renderHasilTable(allHasil);
  } catch (err) {
    console.error("Gagal memuat hasil ujian:", err);
  }
}

function renderHasilTable(list) {
  const tbody = document.getElementById('table-hasil-body');
  tbody.innerHTML = '';

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">Belum ada hasil ujian yang cocok atau tersimpan.</td></tr>`;
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
    
    return b.nilai - a.nilai;
  });

  let currentGroup = null;

  sortedList.forEach(h => {
    const p = h.peserta || { username: '-', nama_lengkap: 'Akun Terhapus', kelas: '-', jurusan: '-' };
    const lulusBadge = h.status_kelulusan === 'Lulus' ? 'bg-success' : 'bg-danger';

    const pMapel = h.nama_mapel || 'Umum';
    const pJurusan = (p.jurusan || 'Tanpa Jurusan').toUpperCase();
    const pKelas = (p.kelas || 'Tanpa Kelas').toUpperCase();
    const groupKey = `${pMapel} - ${pJurusan} - ${pKelas}`;

    // Group Header Row
    if (currentGroup !== groupKey) {
      tbody.innerHTML += `
        <tr class="table-light">
          <td colspan="9" class="fw-bold text-success py-2" style="background-color: #f8f9fa;">
            <i class="bi bi-book-half me-2 text-primary"></i>MAPEL: <span class="text-primary">${escapeHtml(pMapel)}</span>
            <span class="mx-2 text-muted">|</span>
            <i class="bi bi-collection-fill me-1"></i>JURUSAN: ${escapeHtml(pJurusan)}
            <span class="mx-2 text-muted">|</span>
            KELAS: ${escapeHtml(pKelas)}
          </td>
        </tr>
      `;
      currentGroup = groupKey;
    }

    tbody.innerHTML += `
      <tr>
        <td class="font-monospace text-primary"><strong>${escapeHtml(p.username)}</strong></td>
        <td class="cell-wrap fw-semibold">${escapeHtml(p.nama_lengkap)}</td>
        <td class="cell-wrap"><span class="badge bg-primary-subtle text-primary border border-primary-subtle">${escapeHtml(pMapel)}</span></td>
        <td><span class="badge bg-light text-dark border">${escapeHtml(p.kelas || '-')}</span></td>
        <td class="cell-wrap">${escapeHtml(p.jurusan || '-')}</td>
        <td class="text-center text-success fw-bold">${h.jumlah_benar}</td>
        <td class="text-center text-danger">${h.jumlah_salah}</td>
        <td class="text-center fw-bold" style="font-size: 1.1rem; color: var(--primary-dark);">${parseFloat(h.nilai).toFixed(1)}</td>
        <td class="text-center">
          <button class="btn btn-outline-danger btn-sm rounded-pill px-3" onclick="resetUjianPeserta('${escapeAttr(h.id)}', '${escapeAttr(p.id)}', '${escapeAttr(p.nama_lengkap)}')">
            <i class="bi bi-arrow-counterclockwise"></i> Reset Ujian
          </button>
        </td>
      </tr>
    `;
  });
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
  renderHasilTable(filtered);
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
        <td class="text-center font-heading fw-bold">${r.jawaban_benar}</td>
        <td class="text-center">${r.bobot}</td>
      </tr>
    `;
  });

  if (data.length > 10) {
    html += `<tr><td colspan="8" class="text-center text-muted">...dan ${data.length - 10} data lainnya...</td></tr>`;
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

      for (let i = 0; i < importedDataCache.length; i++) {
        const item = importedDataCache[i];
        Swal.update({
          html: `Mengimpor baris ${i + 1} dari ${importedDataCache.length}...<br>Berhasil: ${success}, Gagal: ${fails}`
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
        }
      }

      Swal.fire('Import Selesai', `Proses import peserta selesai. Berhasil: ${success}, Gagal: ${fails}`, 'info');
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

// Bind to window
window.switchTab = switchTab;
window.loadDashboardStats = loadDashboardStats;
window.exportPesertaData = exportPesertaData;
window.exportSoalData = exportSoalData;
window.exportHasilUjian = exportHasilUjian;
window.openPesertaForm = openPesertaForm;
window.openSoalForm = openSoalForm;
window.openPaketForm = openPaketForm;
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
window.onCetakLingkupChange = onCetakLingkupChange;
window.updateCetakPreviewCount = updateCetakPreviewCount;
window.prosesCetakKartu = prosesCetakKartu;
window.cetakKartuSiswa = cetakKartuSiswa;
window.filterSoalList = () => {};
window.filterHasilList = filterHasilList;
