// Aplikasi Pengawas Ruang CBT — Langsung Pilih Kelas / Multi-Kelas Tanpa Login & Tanpa Setting Admin

const PENGAWAS_STATE_KEY = 'CBT_PENGAWAS_WATCH_STATE_V2';

let proctorAllPeserta = [];
let proctorMasterKelas = [];
let proctorMasterJurusan = [];
let proctorExamSettings = null;
let proctorTokenTimer = null;
let proctorAutoRefreshTimer = null;

// Pilihan Kelas / Ruang yang sedang diawasi guru di HP ini
let selectedKelasSet = new Set();
let selectedPickerJurusan = '';
let selectedRuang = '';
let selectedSesi = '';
let selectedStatusFilter = '';
let proctorName = '';

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

function loadSavedWatchState() {
  try {
    const raw = localStorage.getItem(PENGAWAS_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        selectedKelasSet = new Set(Array.isArray(parsed.kelas) ? parsed.kelas.map(k => String(k).toUpperCase()) : []);
        selectedRuang = parsed.ruang || '';
        selectedSesi = parsed.sesi || '';
        proctorName = parsed.nama || '';
      }
    }
  } catch (e) {}
}

function saveWatchState() {
  try {
    localStorage.setItem(PENGAWAS_STATE_KEY, JSON.stringify({
      kelas: Array.from(selectedKelasSet),
      ruang: selectedRuang,
      sesi: selectedSesi,
      nama: proctorName
    }));
  } catch (e) {}
}

function saveProctorName(val) {
  proctorName = String(val || '').trim();
  saveWatchState();
}

document.addEventListener('DOMContentLoaded', async () => {
  loadSavedWatchState();

  const nameInp = document.getElementById('inp-proctor-name');
  if (nameInp && proctorName) nameInp.value = proctorName;
  const sesiSel = document.getElementById('proctor-select-sesi');
  if (sesiSel && selectedSesi) sesiSel.value = selectedSesi;

  startProctorTokenLoop();

  // Autentikasi latar belakang transparan ke seluruh server Supabase (tanpa form login pengawas)
  await DB.ensureAllShardsAdminAuth();
  await refreshProctorData(false);

  // Jika sebelumnya di HP ini sudah memilih kelas, rapikan panel pilih agar langsung fokus ke daftar siswa
  if (hasActiveScopeSelected()) {
    setKelasPickerVisible(false);
  } else {
    setKelasPickerVisible(true);
  }

  toggleProctorAutoRefresh(true);
});

function hasActiveScopeSelected() {
  return selectedKelasSet.size > 0 || Boolean(selectedRuang);
}

function setKelasPickerVisible(visible) {
  const card = document.getElementById('card-kelas-picker');
  if (!card) return;
  if (visible) {
    card.classList.remove('d-none');
  } else if (hasActiveScopeSelected()) {
    card.classList.add('d-none');
  }
}

function toggleKelasPickerBox() {
  const card = document.getElementById('card-kelas-picker');
  if (!card) return;
  if (card.classList.contains('d-none')) {
    setKelasPickerVisible(true);
  } else if (hasActiveScopeSelected()) {
    setKelasPickerVisible(false);
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
    // Pastikan autentikasi seluruh 5 shard aktif sebelum menarik peserta gabungan lintas jurusan
    await DB.ensureAllShardsAdminAuth();

    const [pesertaData, settingsData, masterCat, kelasTbl, jurusanTbl] = await Promise.all([
      DB.getPesertaList({ forceAllShards: true }),
      DB.getSettings().catch(() => null),
      (typeof DB.getMasterCatalog === 'function' ? DB.getMasterCatalog().catch(() => null) : Promise.resolve(null)),
      (typeof DB.getKelasList === 'function' ? DB.getKelasList().catch(() => []) : Promise.resolve([])),
      (typeof DB.getJurusanList === 'function' ? DB.getJurusanList().catch(() => []) : Promise.resolve([]))
    ]);

    proctorAllPeserta = Array.isArray(pesertaData) ? pesertaData : [];
    if (settingsData) proctorExamSettings = settingsData;

    // Gabungkan seluruh Master Kelas & Jurusan dari ke-5 server + Master Registry + Data Peserta agar 100% lengkap!
    const kSet = new Set();
    const jSet = new Set();

    if (masterCat) {
      (masterCat.kelas || []).forEach(k => { if (k) kSet.add(String(k).trim().toUpperCase()); });
      (masterCat.jurusan || []).forEach(j => { if (j) jSet.add(String(j).trim().toUpperCase()); });
    }
    (kelasTbl || []).forEach(k => {
      const n = String(k?.nama_kelas || k?.nama || '').trim().toUpperCase();
      if (n) kSet.add(n);
    });
    (jurusanTbl || []).forEach(j => {
      const n = String(j?.nama_jurusan || j?.nama || '').trim().toUpperCase();
      if (n) jSet.add(n);
    });
    proctorAllPeserta.forEach(p => {
      const k = String(p.kelas || '').trim().toUpperCase();
      const j = String(p.jurusan || '').trim().toUpperCase();
      if (k) kSet.add(k);
      if (j) jSet.add(j);
    });

    // Normalisasi duplikat alias AKUNTANSI -> AKL di filter jurusan bila AKL sudah ada
    if (jSet.has('AKL') && jSet.has('AKUNTANSI')) {
      jSet.delete('AKUNTANSI');
    }

    proctorMasterKelas = Array.from(kSet)
      .filter(k => k && k !== 'SEMUA' && !k.startsWith('TINGKAT:'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    proctorMasterJurusan = Array.from(jSet)
      .filter(j => j && j !== 'SEMUA')
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    renderKelasPickerButtons();
    renderWatchedStudents();
  } catch (err) {
    console.error('Gagal memuat data pengawas:', err);
    const loadBox = document.getElementById('picker-loading-box');
    if (loadBox) {
      loadBox.innerHTML = `<span class="text-danger small"><i class="bi bi-exclamation-circle me-1"></i>Gagal memuat data peserta. Tekan tombol Refresh di kanan atas.</span>`;
    }
  } finally {
    if (showSpin && icon) setTimeout(() => icon.classList.remove('spin-anim'), 300);
  }
}

function detectTingkatGroup(kelasStr) {
  const clean = String(kelasStr || '').trim().toUpperCase();
  const tok = clean.split(/[\s\-_]+/)[0] || '';
  if (tok === 'X' || tok === '10') return 'Kelas X';
  if (tok === 'XI' || tok === '11') return 'Kelas XI';
  if (tok === 'XII' || tok === '12') return 'Kelas XII';
  return 'Kelas Lainnya';
}

function inferJurusanFromKelasName(kelasUpper, jurusanMapByKelas) {
  if (jurusanMapByKelas && jurusanMapByKelas.has(kelasUpper)) {
    return jurusanMapByKelas.get(kelasUpper);
  }
  const u = String(kelasUpper || '').toUpperCase();
  for (const j of proctorMasterJurusan) {
    const re = new RegExp(`(^|[\\s\\-_])${j.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\-_]|$)`, 'i');
    if (re.test(u)) return j;
  }
  if (u.includes('AKUNTANSI')) return 'AKL';
  if (u.includes('TJKT')) return 'TKJ';
  return '';
}

function setPickerJurusanFilter(jur) {
  selectedPickerJurusan = (selectedPickerJurusan === jur) ? '' : String(jur || '').toUpperCase();
  renderKelasPickerButtons();
}

function renderKelasPickerButtons() {
  const loadBox = document.getElementById('picker-loading-box');
  const groupsContainer = document.getElementById('picker-kelas-groups');
  const jurBar = document.getElementById('picker-jurusan-bar');
  const jurChips = document.getElementById('picker-jurusan-chips');
  const syncBadge = document.getElementById('badge-server-sync-info');
  const colRuang = document.getElementById('col-select-ruang');
  const ruangSel = document.getElementById('proctor-select-ruang');
  const btnClear = document.getElementById('btn-clear-kelas');
  const btnHide = document.getElementById('btn-hide-picker');

  if (loadBox) loadBox.classList.add('d-none');
  if (groupsContainer) groupsContainer.classList.remove('d-none');

  const active = hasActiveScopeSelected();
  if (btnClear) btnClear.classList.toggle('d-none', !active);
  if (btnHide) btnHide.classList.toggle('d-none', !active);

  const kelasCounts = new Map();
  const kelasJurusanMap = new Map();
  const ruangCounts = new Map();

  // Inisialisasi seluruh master kelas agar kelas yang pesertanya belum di-import (misal Kelas XII) tetap tampil lengkap!
  proctorMasterKelas.forEach(k => {
    kelasCounts.set(k, 0);
  });

  proctorAllPeserta.forEach(p => {
    const k = String(p.kelas || '').trim().toUpperCase();
    let j = String(p.jurusan || '').trim().toUpperCase();
    if (j === 'AKUNTANSI') j = 'AKL';
    if (k) {
      kelasCounts.set(k, (kelasCounts.get(k) || 0) + 1);
      if (j && !kelasJurusanMap.has(k)) kelasJurusanMap.set(k, j);
    }
    const r = String(p.ruang || '').trim();
    if (r) {
      const rKey = r.toUpperCase();
      if (!ruangCounts.has(rKey)) ruangCounts.set(rKey, { label: r, count: 0 });
      ruangCounts.get(rKey).count++;
    }
  });

  if (syncBadge) {
    const shardCount = (window.getSupabaseShards && window.getSupabaseShards().length) || 1;
    syncBadge.innerText = `${kelasCounts.size} Kelas • ${proctorMasterJurusan.length} Jurusan • ${proctorAllPeserta.length} Siswa (${shardCount} Server)`;
  }

  // Render chip filter Jurusan
  if (jurBar && jurChips) {
    if (proctorMasterJurusan.length > 0) {
      jurBar.classList.remove('d-none');
      let chipsHtml = `
        <button type="button" class="btn btn-sm rounded-pill py-0 px-3 fw-semibold ${!selectedPickerJurusan ? 'btn-dark' : 'btn-outline-secondary'}"
          style="font-size: 0.75rem;" onclick="setPickerJurusanFilter('')">
          Semua Jurusan (${kelasCounts.size})
        </button>
      `;
      proctorMasterJurusan.forEach(j => {
        const isAct = selectedPickerJurusan === j;
        chipsHtml += `
          <button type="button" class="btn btn-sm rounded-pill py-0 px-3 fw-semibold ${isAct ? 'btn-primary' : 'btn-outline-primary'}"
            style="font-size: 0.75rem;" onclick="setPickerJurusanFilter('${escapeAttrP(j)}')">
            ${escapeHtmlP(j)}
          </button>
        `;
      });
      jurChips.innerHTML = chipsHtml;
    } else {
      jurBar.classList.add('d-none');
    }
  }

  // Render dropdown Ruang jika ada data ruang pada peserta
  if (colRuang && ruangSel) {
    if (ruangCounts.size > 0) {
      colRuang.classList.remove('d-none');
      const sortedRuangs = Array.from(ruangCounts.entries()).sort((a, b) =>
        a[1].label.localeCompare(b[1].label, undefined, { numeric: true })
      );
      let opts = `<option value="">-- Pilih Lewat Tombol Kelas di Atas --</option>`;
      sortedRuangs.forEach(([rKey, info]) => {
        const sel = selectedRuang.toUpperCase() === rKey ? 'selected' : '';
        opts += `<option value="${escapeAttrP(rKey)}" ${sel}>${escapeHtmlP(info.label)} (${info.count} Siswa)</option>`;
      });
      ruangSel.innerHTML = opts;
    } else {
      colRuang.classList.add('d-none');
    }
  }

  if (!groupsContainer) return;

  let allKelas = Array.from(kelasCounts.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  // Filter tampilan tombol kelas jika pengawas memilih salah satu chip Jurusan (kelas yang sudah tercentang tetap ditampilkan agar terlihat!)
  if (selectedPickerJurusan) {
    allKelas = allKelas.filter(k =>
      selectedKelasSet.has(k) || inferJurusanFromKelasName(k, kelasJurusanMap) === selectedPickerJurusan
    );
  }

  if (allKelas.length === 0) {
    groupsContainer.innerHTML = `<div class="alert alert-warning small mb-0">Belum ada kelas untuk filter jurusan ini.</div>`;
    return;
  }

  const groups = {
    'Kelas X': [],
    'Kelas XI': [],
    'Kelas XII': [],
    'Kelas Lainnya': []
  };

  allKelas.forEach(k => {
    groups[detectTingkatGroup(k)].push(k);
  });

  let html = '';
  Object.entries(groups).forEach(([groupTitle, list]) => {
    if (list.length === 0) return;
    const pills = list.map(k => {
      const isSel = selectedKelasSet.has(k);
      const cnt = kelasCounts.get(k) || 0;
      return `
        <button type="button" class="kelas-pill-btn ${isSel ? 'selected' : ''}" onclick="toggleWatchedKelas('${escapeAttrP(k)}')">
          <i class="bi ${isSel ? 'bi-check-circle-fill' : 'bi-circle'}"></i>
          <span>${escapeHtmlP(k)}</span>
          <span class="badge ${isSel ? 'bg-white text-primary' : (cnt > 0 ? 'bg-light text-secondary border' : 'bg-warning-subtle text-dark border')} rounded-pill">${cnt}</span>
        </button>
      `;
    }).join('');

    html += `
      <div class="mb-3">
        <div class="small fw-bold text-secondary mb-2 text-uppercase" style="font-size: 0.72rem; letter-spacing: 0.5px;">${escapeHtmlP(groupTitle)}</div>
        <div class="d-flex flex-wrap gap-2">${pills}</div>
      </div>
    `;
  });

  groupsContainer.innerHTML = html;
}

function toggleWatchedKelas(kelasUpper) {
  const k = String(kelasUpper || '').trim().toUpperCase();
  if (!k) return;
  if (selectedKelasSet.has(k)) {
    selectedKelasSet.delete(k);
  } else {
    selectedKelasSet.add(k);
  }
  saveWatchState();
  renderKelasPickerButtons();
  renderWatchedStudents();
}

function onRuangSelectChange(val) {
  selectedRuang = String(val || '').trim();
  saveWatchState();
  renderKelasPickerButtons();
  renderWatchedStudents();
}

function onSesiSelectChange(val) {
  selectedSesi = String(val || '').trim();
  saveWatchState();
  renderWatchedStudents();
}

function resetAllSelectedScope() {
  selectedKelasSet.clear();
  selectedRuang = '';
  selectedSesi = '';
  const sesiEl = document.getElementById('proctor-select-sesi');
  if (sesiEl) sesiEl.value = '';
  const ruangEl = document.getElementById('proctor-select-ruang');
  if (ruangEl) ruangEl.value = '';
  saveWatchState();
  setKelasPickerVisible(true);
  renderKelasPickerButtons();
  renderWatchedStudents();
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
  renderWatchedStudents();
}

function getScopedStudentsForProctor() {
  if (!hasActiveScopeSelected()) return [];

  return proctorAllPeserta.filter(p => {
    const pKelas = String(p.kelas || '').trim().toUpperCase();
    const pRuang = String(p.ruang || '').trim().toUpperCase();
    const pSesi = String(p.sesi || '').trim();

    if (selectedSesi && pSesi.toLowerCase() !== selectedSesi.toLowerCase()) {
      return false;
    }
    if (selectedRuang && pRuang !== selectedRuang.toUpperCase()) {
      return false;
    }
    if (selectedKelasSet.size > 0 && !selectedKelasSet.has(pKelas)) {
      return false;
    }
    return true;
  });
}

function renderWatchedStudents() {
  const emptyPrompt = document.getElementById('empty-no-class-selected');
  const workspace = document.getElementById('proctor-active-workspace');
  const subtitle = document.getElementById('lbl-proctor-subtitle');
  const badgesEl = document.getElementById('active-selected-badges');
  const container = document.getElementById('proctor-student-list-container');

  if (!hasActiveScopeSelected()) {
    emptyPrompt?.classList.remove('d-none');
    workspace?.classList.add('d-none');
    if (subtitle) subtitle.innerText = 'Pilih kelas yang sedang Bapak/Ibu awasi';
    return;
  }

  emptyPrompt?.classList.add('d-none');
  workspace?.classList.remove('d-none');

  // Render badge kelas/ruang aktif
  const kelasArr = Array.from(selectedKelasSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const summaryParts = [];
  if (selectedRuang) summaryParts.push(`Ruang ${selectedRuang}`);
  if (kelasArr.length > 0) summaryParts.push(kelasArr.join(', '));
  if (selectedSesi) summaryParts.push(selectedSesi);
  if (subtitle) subtitle.innerText = `Mengawasi: ${summaryParts.join(' • ')}`;

  if (badgesEl) {
    let bHtml = '';
    if (selectedRuang) {
      bHtml += `<span class="badge bg-info text-dark"><i class="bi bi-door-open me-1"></i>${escapeHtmlP(selectedRuang)}</span>`;
    }
    bHtml += kelasArr.map(k => `
      <span class="badge bg-primary d-inline-flex align-items-center gap-1 py-1 px-2">
        <span>${escapeHtmlP(k)}</span>
        <i class="bi bi-x-circle-fill" style="cursor:pointer;" title="Lepas kelas ${escapeAttrP(k)}" onclick="toggleWatchedKelas('${escapeAttrP(k)}')"></i>
      </span>
    `).join('');
    if (selectedSesi) {
      bHtml += `<span class="badge bg-secondary">${escapeHtmlP(selectedSesi)}</span>`;
    }
    badgesEl.innerHTML = bHtml;
  }

  const scoped = getScopedStudentsForProctor();

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

  if (!container) return;

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

  // Prioritas urutan: 1) Siswa TERKUNCI paling atas, 2) Ada pelanggaran, 3) Kelas & Nama
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
        <div class="fw-semibold">Tidak ada siswa yang cocok dengan filter pencarian ini.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((p, idx) => {
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

    const resetSesiBtn = (status !== 'Belum Ujian')
      ? `<button class="btn btn-outline-danger btn-sm" onclick="proctorResetStudentSesi('${escapeAttrP(p.id)}', '${escapeAttrP(p.nama_lengkap)}', '${escapeAttrP(shardId)}')" title="Reset sesi ujian siswa ini saja">
           <i class="bi bi-arrow-counterclockwise me-1"></i>Reset Sesi
         </button>`
      : '';

    const forceFinishBtn = (status === 'Sedang Ujian')
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
}

// ==================== AKSI BANTUAN PER-SISWA ====================

async function proctorUnlockStudent(pesertaId, nama, shardId = '') {
  const ask = await Swal.fire({
    title: 'Buka Kunci Pelanggaran?',
    html: `Buka blokir ujian untuk <strong>${escapeHtmlP(nama)}</strong> agar siswa dapat langsung melanjutkan soal?`,
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
    html: `Lepas kunci perangkat HP lama milik <strong>${escapeHtmlP(nama)}</strong>?<br><br><span class="text-success small fw-semibold"><i class="bi bi-shield-check me-1"></i>Tenang: Jawaban ujian yang sudah dipilih siswa TIDAK akan hilang.</span>`,
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
    Swal.fire('Berhasil!', `Siswa "${nama}" kini dapat login di HP baru dan melanjutkan ujiannya.`, 'success');
    await refreshProctorData(false);
  } catch (err) {
    Swal.fire('Gagal Pindah HP', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function proctorResetStudentSesi(pesertaId, nama, shardId = '') {
  const ask = await Swal.fire({
    title: 'Reset Sesi Siswa Ini?',
    html: `Sesi ujian atas nama <strong>${escapeHtmlP(nama)}</strong> akan dikembalikan ke <strong>Belum Ujian</strong> dan diulang dari awal.<br><br><small class="text-danger fw-semibold">Gunakan hanya jika siswa mengalami kendala dan harus mengulang.</small>`,
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
    html: `Akhiri ujian atas nama <strong>${escapeHtmlP(nama)}</strong> dan simpan nilainya berdasarkan jawaban yang sudah masuk?`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#0d6efd',
    confirmButtonText: 'Ya, Selesaikan',
    cancelButtonText: 'Batal'
  });
  if (!ask.isConfirmed) return;

  Swal.fire({ title: 'Menyimpan Nilai...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  try {
    const res = await DB.paksaSelesaiSatuPeserta(p);
    Swal.fire('Ujian Diselesaikan', `Jawaban "${nama}" (${res.paket}) berhasil dikumpulkan.`, 'success');
    await refreshProctorData(false);
  } catch (err) {
    Swal.fire('Gagal Paksa Selesai', err.message || 'Terjadi kesalahan.', 'error');
  }
}

async function copyProctorAttendanceWA() {
  const scoped = getScopedStudentsForProctor();
  if (scoped.length === 0) {
    Swal.fire('Pilih Kelas Dulu', 'Ketuk kelas yang sedang diawasi terlebih dahulu.', 'info');
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
    selectedSesi ? `Sesi: ${selectedSesi}` : ''
  ].filter(Boolean).join(' | ');

  const nowStr = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const lines = [
    `*LAPORAN KEHADIRAN RUANG CBT*`,
    `📅 Waktu: ${nowStr}`,
    proctorName ? `👤 Pengawas: ${proctorName}` : '',
    `🏫 ${lokasiStr}`,
    ``,
    `📊 *Ringkasan (${scoped.length} Siswa):*`,
    `✅ Hadir: *${hadir.length}* (${selesai.length} selesai)`,
    `⏳ Belum Masuk: *${belum.length}*`
  ].filter(x => x !== '');

  if (belum.length > 0) {
    lines.push(``, `*Daftar Siswa Belum Masuk (${belum.length}):*`);
    belum.slice(0, 40).forEach((b, i) => {
      lines.push(`${i + 1}. ${b.nama_lengkap} (${b.kelas || '-'})`);
    });
    if (belum.length > 40) lines.push(`...dan ${belum.length - 40} lainnya.`);
  } else {
    lines.push(``, `🎉 *Seluruh siswa hadir 100%!*`);
  }

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    Swal.fire({ icon: 'success', title: 'Laporan Absensi Disalin!', text: 'Silakan Paste ke grup WhatsApp Panitia CBT.', timer: 2000, showConfirmButton: false });
  } catch (e) {
    Swal.fire({ title: 'Salin Laporan', input: 'textarea', inputValue: text });
  }
}

window.refreshProctorData = refreshProctorData;
window.toggleWatchedKelas = toggleWatchedKelas;
window.setPickerJurusanFilter = setPickerJurusanFilter;
window.onRuangSelectChange = onRuangSelectChange;
window.onSesiSelectChange = onSesiSelectChange;
window.resetAllSelectedScope = resetAllSelectedScope;
window.setKelasPickerVisible = setKelasPickerVisible;
window.toggleKelasPickerBox = toggleKelasPickerBox;
window.saveProctorName = saveProctorName;
window.setProctorStatusFilter = setProctorStatusFilter;
window.renderWatchedStudents = renderWatchedStudents;
window.toggleProctorAutoRefresh = toggleProctorAutoRefresh;
window.proctorUnlockStudent = proctorUnlockStudent;
window.proctorResetDevice = proctorResetDevice;
window.proctorResetStudentSesi = proctorResetStudentSesi;
window.proctorForceFinishStudent = proctorForceFinishStudent;
window.copyProctorAttendanceWA = copyProctorAttendanceWA;
