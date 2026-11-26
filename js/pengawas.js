// Portal Pengawas Ruang Controller (Mobile-Friendly, Scoped & Safe)

const PENGAWAS_SESSION_KEY = 'CBT_PENGAWAS_ACTIVE_SESSION_V1';
const PENGAWAS_FLEX_FILTER_KEY = 'CBT_PENGAWAS_FLEX_FILTER_V1';

let proctorSession = null;
let proctorAllPeserta = [];
let proctorExamSettings = null;
let proctorTokenTimer = null;
let proctorAutoRefreshTimer = null;

// Filter state
let selectedFlexRuang = '';
let selectedFlexKelasSet = new Set();
let selectedSesiFilter = '';
let selectedStatusFilter = '';

function escapeHtmlP(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttrP(str) {
  return escapeHtmlP(str);
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('form-login-pengawas');
  if (form) {
    form.addEventListener('submit', handlePengawasLoginSubmit);
  }

  // Cek parameter QR / Link Cepat (?kode=XXXX&nama=...)
  const params = new URLSearchParams(window.location.search);
  const qrKode = (params.get('kode') || params.get('pin') || '').trim();
  const qrNama = (params.get('nama') || '').trim();
  const savedName = localStorage.getItem('CBT_PENGAWAS_LAST_NAME') || '';

  const inpKode = document.getElementById('inp-kode-pengawas');
  const inpNama = document.getElementById('inp-nama-pengawas');
  if (inpNama && (qrNama || savedName)) inpNama.value = qrNama || savedName;
  if (inpKode && qrKode) inpKode.value = qrKode.toUpperCase();

  // Pulihkan sesi pengawas jika masih aktif di tab ini (dan tidak sedang scan kode ruangan baru yang berbeda)
  try {
    const raw = sessionStorage.getItem(PENGAWAS_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.role === 'pengawas') {
        if (!qrKode || String(parsed.kode_akses || '').toUpperCase() === qrKode.toUpperCase()) {
          proctorSession = parsed;
          await enterProctorDashboard();
          return;
        }
      }
    }
  } catch (e) {}
});

async function handlePengawasLoginSubmit(e) {
  e.preventDefault();
  const nama = (document.getElementById('inp-nama-pengawas')?.value || '').trim();
  const kode = (document.getElementById('inp-kode-pengawas')?.value || '').trim().toUpperCase();
  const btn = document.getElementById('btn-submit-pengawas');

  if (!nama || !kode) {
    Swal.fire('Data Belum Lengkap', 'Masukkan Nama Pengawas dan Kode Akses / PIN Pengawas.', 'warning');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Memverifikasi Ruang...`;
  }

  try {
    const session = await DB.verifyPengawasLogin(kode, nama);
    proctorSession = session;
    sessionStorage.setItem(PENGAWAS_SESSION_KEY, JSON.stringify(session));
    try { localStorage.setItem('CBT_PENGAWAS_LAST_NAME', nama); } catch (err) {}

    // Bersihkan query ?kode= dari URL bar agar rapi saat di-refresh
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, 'pengawas.html?v=84');
    }

    await enterProctorDashboard();
  } catch (err) {
    Swal.fire('Gagal Masuk', err.message || 'Kode Akses / PIN Pengawas tidak valid.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="bi bi-box-arrow-in-right me-1"></i> Masuk Ruang Ujian`;
    }
  }
}

async function enterProctorDashboard() {
  document.getElementById('view-pengawas-login')?.classList.add('d-none');
  document.getElementById('view-pengawas-main')?.classList.remove('d-none');

  // Pastikan sesi auth multi-shard aktif agar baca/buka kunci lintas server berjalan mulus
  await DB.ensureAllShardsAdminAuth();

  // Muat kembali filter fleksibel yang terakhir dipilih pengawas di HP ini
  if (proctorSession.mode_cakupan === 'fleksibel') {
    try {
      const savedFlex = JSON.parse(localStorage.getItem(PENGAWAS_FLEX_FILTER_KEY) || 'null');
      if (savedFlex) {
        selectedFlexRuang = savedFlex.ruang || '';
        selectedFlexKelasSet = new Set(Array.isArray(savedFlex.kelas) ? savedFlex.kelas : []);
        selectedSesiFilter = savedFlex.sesi || '';
      }
    } catch (e) {}
  } else {
    selectedSesiFilter = proctorSession.sesi_filter || '';
  }

  updateProctorHeaderUI();
  startProctorTokenLoop();
  await refreshProctorData(false);
  toggleProctorAutoRefresh(true);
}

function updateProctorHeaderUI() {
  const nameEl = document.getElementById('lbl-proctor-name');
  const titleEl = document.getElementById('lbl-proctor-room-title');
  const lockedBanner = document.getElementById('proctor-locked-scope-banner');
  const flexBox = document.getElementById('proctor-flexible-scope-box');

  if (nameEl) nameEl.innerText = proctorSession.nama_pengawas || proctorSession.nama_akun || '-';

  if (proctorSession.mode_cakupan === 'fleksibel') {
    if (titleEl) titleEl.innerText = 'Panel Pengawas Ruang';
    lockedBanner?.classList.add('d-none');
    flexBox?.classList.remove('d-none');
    const sesiSel = document.getElementById('proctor-select-sesi');
    if (sesiSel) sesiSel.value = selectedSesiFilter;
  } else {
    if (titleEl) titleEl.innerText = proctorSession.nama_akun || 'Panel Pengawas Ruang';
    flexBox?.classList.add('d-none');
    lockedBanner?.classList.remove('d-none');

    const descParts = [];
    if (Array.isArray(proctorSession.ruang_list) && proctorSession.ruang_list.length > 0) {
      descParts.push(`Ruang: ${proctorSession.ruang_list.join(', ')}`);
    }
    if (Array.isArray(proctorSession.kelas_list) && proctorSession.kelas_list.length > 0) {
      descParts.push(`Kelas: ${proctorSession.kelas_list.join(', ')}`);
    }
    const lblDesc = document.getElementById('lbl-locked-scope-desc');
    if (lblDesc) lblDesc.innerText = descParts.join(' • ') || proctorSession.nama_akun;

    const sesiLocked = document.getElementById('proctor-sesi-select-locked');
    if (sesiLocked) sesiLocked.value = selectedSesiFilter;
  }
}

function startProctorTokenLoop() {
  if (proctorTokenTimer) clearInterval(proctorTokenTimer);

  const tick = () => {
    if (!DB || typeof DB.getActiveTokenState !== 'function') return;
    const state = DB.getActiveTokenState(proctorExamSettings);
    const totalSec = Math.max(0, Math.ceil(state.remainingMs / 1000));
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    const timeStr = `${m}:${s}`;

    const tokEl = document.getElementById('proctor-active-token');
    if (tokEl && tokEl.innerText !== state.token) tokEl.innerText = state.token;
    const cdEl = document.getElementById('proctor-token-countdown');
    if (cdEl && cdEl.innerText !== timeStr) cdEl.innerText = timeStr;
  };

  tick();
  proctorTokenTimer = setInterval(tick, 1000);
}

function toggleProctorAutoRefresh(enabled) {
  if (proctorAutoRefreshTimer) {
    clearInterval(proctorAutoRefreshTimer);
    proctorAutoRefreshTimer = null;
  }
  if (enabled) {
    // Refresh hemat tiap 25 detik (jeda otomatis jika layar HP pengawas sedang mati/diminimize)
    proctorAutoRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshProctorData(false);
    }, 25000);
  }
}

async function refreshProctorData(showSpin = false) {
  const icon = document.getElementById('icon-proctor-refresh');
  if (showSpin && icon) icon.classList.add('spin-anim');

  try {
    const [pesertaData, settingsData, regData] = await Promise.all([
      DB.getPesertaList(),
      DB.getSettings().catch(() => null),
      DB.getPengawasRegistry().catch(() => null)
    ]);

    proctorAllPeserta = Array.isArray(pesertaData) ? pesertaData : [];
    if (settingsData) proctorExamSettings = settingsData;
    if (regData && regData.config && proctorSession) {
      proctorSession.config = regData.config;
    }

    if (proctorSession && proctorSession.mode_cakupan === 'fleksibel') {
      populateFlexibleSelectors();
    }

    renderProctorStudentList();
  } catch (err) {
    console.error('Gagal memuat data pengawas:', err);
  } finally {
    if (showSpin && icon) setTimeout(() => icon.classList.remove('spin-anim'), 300);
  }
}

function populateFlexibleSelectors() {
  // 1. Dropdown Ruang Ujian unik beserta jumlah siswanya
  const ruangCounts = new Map();
  const kelasCounts = new Map();

  proctorAllPeserta.forEach(p => {
    const r = String(p.ruang || '').trim();
    if (r) {
      const rKey = r.toUpperCase();
      if (!ruangCounts.has(rKey)) ruangCounts.set(rKey, { label: r, count: 0 });
      ruangCounts.get(rKey).count++;
    }
    const k = String(p.kelas || '').trim();
    if (k) {
      const kKey = k.toUpperCase();
      if (!kelasCounts.has(kKey)) kelasCounts.set(kKey, { label: k.toUpperCase(), count: 0 });
      kelasCounts.get(kKey).count++;
    }
  });

  const ruangSel = document.getElementById('proctor-select-ruang');
  if (ruangSel) {
    const sortedRuangs = Array.from(ruangCounts.entries()).sort((a, b) =>
      a[1].label.localeCompare(b[1].label, undefined, { numeric: true })
    );
    let opts = `<option value="">-- Semua Ruang (${proctorAllPeserta.length} Siswa) --</option>`;
    sortedRuangs.forEach(([rKey, info]) => {
      const sel = selectedFlexRuang.toUpperCase() === rKey ? 'selected' : '';
      opts += `<option value="${escapeAttrP(rKey)}" ${sel}>${escapeHtmlP(info.label)} (${info.count} Siswa)</option>`;
    });
    ruangSel.innerHTML = opts;
  }

  // 2. Multi-Kelas Checklist Chips (mendukung gabungan >1 kelas dalam 1 ruangan!)
  const kContainer = document.getElementById('proctor-multi-kelas-container');
  const kBadge = document.getElementById('badge-selected-kelas-count');
  if (kBadge) {
    kBadge.innerText = selectedFlexKelasSet.size > 0 ? `${selectedFlexKelasSet.size} Kelas` : 'Semua';
  }

  if (kContainer) {
    const sortedKelas = Array.from(kelasCounts.entries()).sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true })
    );
    if (sortedKelas.length === 0) {
      kContainer.innerHTML = `<span class="text-muted small">Belum ada data kelas pada peserta.</span>`;
    } else {
      kContainer.innerHTML = sortedKelas.map(([kKey, info], idx) => {
        const checked = selectedFlexKelasSet.has(kKey);
        return `
          <label class="badge ${checked ? 'bg-primary text-white' : 'bg-white text-dark border'} px-2 py-2 kelas-chip-check d-inline-flex align-items-center gap-1" style="font-size: 0.76rem;">
            <input type="checkbox" class="form-check-input m-0" style="width: 0.85rem; height: 0.85rem;"
              value="${escapeAttrP(kKey)}" ${checked ? 'checked' : ''} onchange="toggleFlexibleKelasItem('${escapeAttrP(kKey)}', this.checked)">
            <span>${escapeHtmlP(info.label)} <small class="${checked ? 'text-white-50' : 'text-muted'}">(${info.count})</small></span>
          </label>
        `;
      }).join('');
    }
  }
}

function saveFlexibleFilterState() {
  try {
    localStorage.setItem(PENGAWAS_FLEX_FILTER_KEY, JSON.stringify({
      ruang: selectedFlexRuang,
      kelas: Array.from(selectedFlexKelasSet),
      sesi: selectedSesiFilter
    }));
  } catch (e) {}
}

function onFlexibleRuangChange() {
  const el = document.getElementById('proctor-select-ruang');
  selectedFlexRuang = el ? el.value : '';
  saveFlexibleFilterState();
  renderProctorStudentList();
}

function toggleFlexibleKelasItem(kelasUpper, isChecked) {
  if (isChecked) selectedFlexKelasSet.add(kelasUpper);
  else selectedFlexKelasSet.delete(kelasUpper);
  saveFlexibleFilterState();
  populateFlexibleSelectors();
  renderProctorStudentList();
}

function clearFlexibleKelasChecks() {
  selectedFlexKelasSet.clear();
  saveFlexibleFilterState();
  populateFlexibleSelectors();
  renderProctorStudentList();
}

function resetFlexibleScopeSelection() {
  selectedFlexRuang = '';
  selectedFlexKelasSet.clear();
  selectedSesiFilter = '';
  const sesiEl = document.getElementById('proctor-select-sesi');
  if (sesiEl) sesiEl.value = '';
  saveFlexibleFilterState();
  populateFlexibleSelectors();
  renderProctorStudentList();
}

function onProctorSesiChange(val) {
  selectedSesiFilter = val || '';
  if (proctorSession && proctorSession.mode_cakupan === 'fleksibel') {
    saveFlexibleFilterState();
  }
  renderProctorStudentList();
}

function setProctorStatusFilter(st) {
  selectedStatusFilter = (selectedStatusFilter === st && st !== '') ? '' : st;
  const mapIds = {
    '': 'kpi-card-all',
    'LOCKED': 'kpi-card-locked',
    'Sedang Ujian': 'kpi-card-sedang',
    'Belum Ujian': 'kpi-card-belum'
  };
  Object.entries(mapIds).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active-kpi', k === selectedStatusFilter);
  });
  renderProctorStudentList();
}

// Ambil seluruh peserta yang masuk ke dalam cakupan ruangan / gabungan kelas pengawas ini
function getScopedStudentsForProctor() {
  if (!proctorSession) return [];

  const mode = proctorSession.mode_cakupan || 'fleksibel';
  const lockedRuangSet = new Set((proctorSession.ruang_list || []).map(r => String(r).trim().toUpperCase()).filter(Boolean));
  const lockedKelasSet = new Set((proctorSession.kelas_list || []).map(k => String(k).trim().toUpperCase()).filter(Boolean));

  return proctorAllPeserta.filter(p => {
    const pRuang = String(p.ruang || '').trim().toUpperCase();
    const pKelas = String(p.kelas || '').trim().toUpperCase();
    const pSesi = String(p.sesi || '').trim();

    if (selectedSesiFilter && pSesi.toLowerCase() !== selectedSesiFilter.toLowerCase()) {
      return false;
    }

    if (mode === 'ruang' && lockedRuangSet.size > 0) {
      return lockedRuangSet.has(pRuang);
    }
    if (mode === 'kelas' && lockedKelasSet.size > 0) {
      return lockedKelasSet.has(pKelas);
    }
    if (mode !== 'fleksibel' && (lockedRuangSet.size > 0 || lockedKelasSet.size > 0)) {
      const rOk = lockedRuangSet.size === 0 || lockedRuangSet.has(pRuang);
      const kOk = lockedKelasSet.size === 0 || lockedKelasSet.has(pKelas);
      return rOk && kOk;
    }

    // Mode Fleksibel: filter sesuai Ruang dan/atau gabungan Multi-Kelas yang dipilih di HP Pengawas
    if (selectedFlexRuang && pRuang !== selectedFlexRuang.toUpperCase()) {
      return false;
    }
    if (selectedFlexKelasSet.size > 0 && !selectedFlexKelasSet.has(pKelas)) {
      return false;
    }
    return true;
  });
}

function renderProctorStudentList() {
  const container = document.getElementById('proctor-student-list-container');
  if (!container) return;

  const scoped = getScopedStudentsForProctor();

  // Hitung KPI dari seluruh siswa di ruangan/kelas terpilih
  const total = scoped.length;
  const locked = scoped.filter(p => Boolean(p.is_locked) || parseInt(p.pelanggaran || 0) > 0).length;
  const sedang = scoped.filter(p => p.status_ujian === 'Sedang Ujian').length;
  const selesai = scoped.filter(p => p.status_ujian === 'Sudah Ujian').length;
  const belum = scoped.filter(p => !p.status_ujian || p.status_ujian === 'Belum Ujian').length;

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  setTxt('kpi-proctor-total', total);
  setTxt('kpi-proctor-locked', locked);
  setTxt('kpi-proctor-sedang', sedang);
  setTxt('kpi-proctor-selesai', selesai);
  setTxt('kpi-proctor-belum', belum);

  const q = (document.getElementById('proctor-search-input')?.value || '').trim().toLowerCase();

  let filtered = scoped.filter(p => {
    if (selectedStatusFilter === 'LOCKED') {
      if (!p.is_locked && !(parseInt(p.pelanggaran || 0) > 0)) return false;
    } else if (selectedStatusFilter) {
      const st = p.status_ujian || 'Belum Ujian';
      if (st !== selectedStatusFilter) return false;
    }

    if (q) {
      const hay = `${p.nama_lengkap || ''} ${p.username || ''} ${p.kelas || ''} ${p.ruang || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Urutkan prioritas: 1) TERKUNCI paling atas, 2) Ada pelanggaran, 3) Sedang Ujian, 4) Nama Alfabetis
  filtered.sort((a, b) => {
    const aLock = a.is_locked ? 1 : 0;
    const bLock = b.is_locked ? 1 : 0;
    if (bLock !== aLock) return bLock - aLock;

    const aViol = parseInt(a.pelanggaran || 0);
    const bViol = parseInt(b.pelanggaran || 0);
    if ((bViol > 0 ? 1 : 0) !== (aViol > 0 ? 1 : 0)) return bViol - aViol;

    const klsCmp = String(a.kelas || '').localeCompare(String(b.kelas || ''), undefined, { numeric: true });
    if (klsCmp !== 0) return klsCmp;
    return String(a.nama_lengkap || '').localeCompare(String(b.nama_lengkap || ''));
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="card border-0 shadow-sm rounded-4 p-4 text-center text-muted">
        <i class="bi bi-inbox fs-2 mb-2 text-secondary"></i>
        <div class="fw-semibold">Tidak ada peserta yang cocok dengan filter saat ini.</div>
        <small>Periksa pilihan Ruang / Kelas atau kata kunci pencarian di atas.</small>
      </div>
    `;
    return;
  }

  const cfg = (proctorSession && proctorSession.config) || {};
  const allowResetSesi = cfg.izinkan_reset_sesi !== false;
  const allowForceFinish = cfg.izinkan_paksa_selesai !== false;

  // Batasi render maksimal 250 kartu agar tetap super ringan di HP jika sedang memilih "Semua Ruang"
  const displayList = filtered.slice(0, 250);
  const moreCount = filtered.length - displayList.length;

  let html = displayList.map((p, idx) => {
    const pel = parseInt(p.pelanggaran || 0);
    const isLocked = Boolean(p.is_locked);
    const status = p.status_ujian || 'Belum Ujian';
    const hasDevice = Boolean(p.active_session_token);
    const shardId = p._shardId || p._shard_id || '';

    let cardCls = 'student-proctor-card p-3 shadow-sm';
    if (isLocked) cardCls += ' is-locked-alert';
    else if (pel > 0) cardCls += ' has-warning-alert';

    let statusBadge = `<span class="badge bg-secondary-subtle text-secondary border">Belum Masuk</span>`;
    if (status === 'Sedang Ujian') {
      statusBadge = `<span class="badge bg-success-subtle text-success border border-success"><span class="spinner-grow spinner-grow-sm me-1" style="width:0.4rem;height:0.4rem;"></span>Sedang Ujian</span>`;
    } else if (status === 'Sudah Ujian') {
      statusBadge = `<span class="badge bg-primary-subtle text-primary border border-primary"><i class="bi bi-check-circle-fill me-1"></i>Selesai</span>`;
    }

    let secBadge = '';
    if (isLocked) {
      secBadge = `<span class="badge bg-danger text-white"><i class="bi bi-lock-fill me-1"></i>TERKUNCI (${pel}x)</span>`;
    } else if (pel > 0) {
      secBadge = `<span class="badge bg-warning text-dark"><i class="bi bi-exclamation-triangle-fill me-1"></i>${pel}x Pelanggaran</span>`;
    }

    const unlockBtn = isLocked
      ? `<button class="btn btn-success btn-sm fw-bold px-3 shadow-sm" onclick="proctorUnlockStudent('${escapeAttrP(p.id)}', '${escapeAttrP(p.nama_lengkap)}', '${escapeAttrP(shardId)}')">
           <i class="bi bi-unlock-fill me-1"></i>Buka Kunci
         </button>`
      : '';

    const resetHpBtn = (status === 'Sedang Ujian' || hasDevice)
      ? `<button class="btn btn-outline-primary btn-sm fw-semibold" onclick="proctorResetDevice('${escapeAttrP(p.id)}', '${escapeAttrP(p.nama_lengkap)}', '${escapeAttrP(shardId)}')" title="Izinkan siswa pindah ke HP baru tanpa menghapus jawaban">
           <i class="bi bi-phone-flip me-1"></i>Pindah HP
         </button>`
      : '';

    const resetSesiBtn = (allowResetSesi && status !== 'Belum Ujian')
      ? `<button class="btn btn-outline-danger btn-sm" onclick="proctorResetStudentSesi('${escapeAttrP(p.id)}', '${escapeAttrP(p.nama_lengkap)}', '${escapeAttrP(shardId)}')" title="Reset sesi ujian siswa ini saja">
           <i class="bi bi-arrow-counterclockwise me-1"></i>Reset Sesi
         </button>`
      : '';

    const forceFinishBtn = (allowForceFinish && status === 'Sedang Ujian')
      ? `<button class="btn btn-outline-dark btn-sm" onclick="proctorForceFinishStudent('${escapeAttrP(p.id)}', '${escapeAttrP(p.nama_lengkap)}')" title="Kumpulkan & hitung nilai jawaban siswa ini">
           <i class="bi bi-check2-all me-1"></i>Selesai
         </button>`
      : '';

    return `
      <div class="${cardCls}">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div class="min-w-0">
            <div class="d-flex align-items-center flex-wrap gap-1 mb-1">
              <span class="text-muted small fw-semibold me-1">${idx + 1}.</span>
              <strong class="text-dark" style="font-size: 0.95rem;">${escapeHtmlP(p.nama_lengkap)}</strong>
              <span class="badge bg-light text-primary border font-monospace">${escapeHtmlP(p.username)}</span>
            </div>
            <div class="d-flex flex-wrap align-items-center gap-1">
              <span class="badge bg-dark-subtle text-dark border"><i class="bi bi-mortarboard-fill me-1"></i>${escapeHtmlP(p.kelas || '-')}</span>
              ${p.ruang ? `<span class="badge bg-info-subtle text-dark border"><i class="bi bi-door-open me-1"></i>${escapeHtmlP(p.ruang)}</span>` : ''}
              ${p.sesi ? `<span class="badge bg-light text-secondary border">${escapeHtmlP(p.sesi)}</span>` : ''}
              ${statusBadge}
              ${secBadge}
            </div>
          </div>

          <div class="d-flex align-items-center flex-wrap gap-1 ms-auto">
            ${unlockBtn}
            ${resetHpBtn}
            ${resetSesiBtn}
            ${forceFinishBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (moreCount > 0) {
    html += `
      <div class="alert alert-light border text-center small text-muted mb-0">
        Menampilkan 250 dari ${filtered.length} siswa. Pilih filter <strong>Ruang</strong> atau <strong>Centang Kelas</strong> di atas agar tampilan spesifik ke ruangan Anda.
      </div>
    `;
  }

  container.innerHTML = html;
}

// ==================== AKSI PENGAWAS PER-SISWA ====================

async function proctorUnlockStudent(pesertaId, nama, shardId = '') {
  const ask = await Swal.fire({
    title: 'Buka Kunci Pelanggaran?',
    html: `Buka blokir ujian untuk <strong>${escapeHtmlP(nama)}</strong> agar siswa dapat melanjutkan pengerjaan soal?`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#198754',
    confirmButtonText: '<i class="bi bi-unlock-fill me-1"></i> Ya, Buka Kunci',
    cancelButtonText: 'Batal'
  });
  if (!ask.isConfirmed) return;

  try {
    await DB.toggleLockPeserta(pesertaId, false, shardId || null);
    Swal.fire({
      toast: true,
      position: 'top-end',
      icon: 'success',
      title: `Kunci ujian "${nama}" berhasil dibuka!`,
      showConfirmButton: false,
      timer: 2200
    });
    await refreshProctorData(false);
  } catch (err) {
    Swal.fire('Gagal Membuka Kunci', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function proctorResetDevice(pesertaId, nama, shardId = '') {
  const ask = await Swal.fire({
    title: 'Izinkan Pindah HP?',
    html: `Lepas kunci perangkat HP lama milik <strong>${escapeHtmlP(nama)}</strong>?<br><br><span class="text-success small fw-semibold"><i class="bi bi-shield-check me-1"></i>Tenang: Jawaban ujian yang sudah terisi TIDAK akan hilang.</span>`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#0d6efd',
    confirmButtonText: '<i class="bi bi-phone-flip me-1"></i> Ya, Lepas Kunci HP',
    cancelButtonText: 'Batal'
  });
  if (!ask.isConfirmed) return;

  try {
    await DB.resetPesertaLoginSession(pesertaId, shardId || null);
    await DB.toggleLockPeserta(pesertaId, false, shardId || null);
    Swal.fire('Berhasil!', `Siswa "${nama}" kini dapat login di HP pengganti dan melanjutkan ujiannya.`, 'success');
    await refreshProctorData(false);
  } catch (err) {
    Swal.fire('Gagal Reset Login HP', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function proctorResetStudentSesi(pesertaId, nama, shardId = '') {
  const ask = await Swal.fire({
    title: 'Reset Sesi Siswa Ini?',
    html: `Perhatian: Sesi ujian atas nama <strong>${escapeHtmlP(nama)}</strong> akan dikembalikan ke <strong>Belum Ujian</strong> dan jawaban sementaranya dihapus.<br><br><small class="text-danger fw-semibold">Gunakan hanya jika siswa salah paket / error dan ingin mengulang dari awal.</small>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc3545',
    confirmButtonText: 'Ya, Reset Siswa Ini',
    cancelButtonText: 'Batal'
  });
  if (!ask.isConfirmed) return;

  Swal.fire({ title: 'Mereset Siswa...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  try {
    await DB.resetPesertaSesi(pesertaId, shardId || null);
    Swal.fire('Berhasil Direset', `Sesi ujian "${nama}" telah dikembalikan ke Belum Ujian.`, 'success');
    await refreshProctorData(false);
  } catch (err) {
    Swal.fire('Gagal Mereset', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function proctorForceFinishStudent(pesertaId, nama) {
  const p = proctorAllPeserta.find(x => String(x.id) === String(pesertaId));
  if (!p) return;

  const ask = await Swal.fire({
    title: 'Paksa Selesai Siswa Ini?',
    html: `Akhiri ujian atas nama <strong>${escapeHtmlP(nama)}</strong> dan hitung nilainya berdasarkan jawaban yang sudah masuk ke server?`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#0d6efd',
    confirmButtonText: 'Ya, Selesaikan & Simpan Nilai',
    cancelButtonText: 'Batal'
  });
  if (!ask.isConfirmed) return;

  Swal.fire({ title: 'Menyimpan Nilai Siswa...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  try {
    const res = await DB.paksaSelesaiSatuPeserta(p);
    Swal.fire('Ujian Diselesaikan', `Jawaban "${nama}" untuk mapel ${res.paket} berhasil dikumpulkan.`, 'success');
    await refreshProctorData(false);
  } catch (err) {
    Swal.fire('Gagal Paksa Selesai', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function copyProctorAttendanceWA() {
  const scoped = getScopedStudentsForProctor();
  if (scoped.length === 0) {
    Swal.fire('Kosong', 'Pilih Ruang atau Kelas terlebih dahulu sebelum menyalin absensi.', 'info');
    return;
  }

  const hadir = scoped.filter(p => p.status_ujian === 'Sedang Ujian' || p.status_ujian === 'Sudah Ujian');
  const belum = scoped.filter(p => !p.status_ujian || p.status_ujian === 'Belum Ujian');
  const selesai = scoped.filter(p => p.status_ujian === 'Sudah Ujian');

  const kelasUnik = Array.from(new Set(scoped.map(p => p.kelas).filter(Boolean))).sort();
  const ruangUnik = Array.from(new Set(scoped.map(p => p.ruang).filter(Boolean))).sort();
  const lokasiStr = [
    ruangUnik.length > 0 ? `Ruang: ${ruangUnik.join(', ')}` : '',
    kelasUnik.length > 0 ? `Kelas: ${kelasUnik.join(', ')}` : '',
    selectedSesiFilter ? `Sesi: ${selectedSesiFilter}` : ''
  ].filter(Boolean).join(' | ') || 'Semua Ruang';

  const nowStr = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  let lines = [
    `*LAPORAN KEHADIRAN RUANG CBT*`,
    `📅 Waktu: ${nowStr}`,
    `👤 Pengawas: ${proctorSession?.nama_pengawas || '-'}`,
    `🏫 ${lokasiStr}`,
    ``,
    `📊 *Ringkasan Peserta (${scoped.length} Siswa):*`,
    `✅ Hadir Mengikuti: *${hadir.length}* (${selesai.length} sudah selesai)`,
    `⏳ Belum Masuk: *${belum.length}*`
  ];

  if (belum.length > 0) {
    lines.push(``, `*Daftar Siswa Belum Masuk (${belum.length}):*`);
    belum.slice(0, 40).forEach((b, i) => {
      lines.push(`${i + 1}. ${b.nama_lengkap} (${b.kelas || '-'})`);
    });
    if (belum.length > 40) lines.push(`...dan ${belum.length - 40} lainnya.`);
  } else {
    lines.push(``, `🎉 *Seluruh siswa di ruangan ini hadir 100%!*`);
  }

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    Swal.fire({
      icon: 'success',
      title: 'Laporan Absensi Disalin!',
      text: 'Silakan tempel (Paste) langsung ke grup WhatsApp Panitia CBT.',
      timer: 2200,
      showConfirmButton: false
    });
  } catch (e) {
    Swal.fire({ title: 'Salin Manual Laporan', input: 'textarea', inputValue: text });
  }
}

function logoutPengawas() {
  sessionStorage.removeItem(PENGAWAS_SESSION_KEY);
  proctorSession = null;
  if (proctorTokenTimer) clearInterval(proctorTokenTimer);
  if (proctorAutoRefreshTimer) clearInterval(proctorAutoRefreshTimer);
  document.getElementById('view-pengawas-main')?.classList.add('d-none');
  document.getElementById('view-pengawas-login')?.classList.remove('d-none');
}

window.refreshProctorData = refreshProctorData;
window.logoutPengawas = logoutPengawas;
window.onFlexibleRuangChange = onFlexibleRuangChange;
window.toggleFlexibleKelasItem = toggleFlexibleKelasItem;
window.clearFlexibleKelasChecks = clearFlexibleKelasChecks;
window.resetFlexibleScopeSelection = resetFlexibleScopeSelection;
window.onProctorSesiChange = onProctorSesiChange;
window.setProctorStatusFilter = setProctorStatusFilter;
window.renderProctorStudentList = renderProctorStudentList;
window.toggleProctorAutoRefresh = toggleProctorAutoRefresh;
window.proctorUnlockStudent = proctorUnlockStudent;
window.proctorResetDevice = proctorResetDevice;
window.proctorResetStudentSesi = proctorResetStudentSesi;
window.proctorForceFinishStudent = proctorForceFinishStudent;
window.copyProctorAttendanceWA = copyProctorAttendanceWA;

