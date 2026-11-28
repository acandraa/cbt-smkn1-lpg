// Aplikasi Pengawas Ruang CBT — Langsung Pilih Kelas / Multi-Kelas Tanpa Login & Tanpa Setting Admin

const PENGAWAS_STATE_KEY = 'CBT_PENGAWAS_WATCH_STATE_V2';

let proctorAllPeserta = [];
let proctorAllPaket = [];
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

    const [pesertaData, paketData, settingsData, masterCat, kelasTbl, jurusanTbl] = await Promise.all([
      DB.getPesertaList({ forceAllShards: true }),
      (typeof DB.getPaketList === 'function' ? DB.getPaketList().catch(() => []) : Promise.resolve([])),
      DB.getSettings().catch(() => null),
      (typeof DB.getMasterCatalog === 'function' ? DB.getMasterCatalog().catch(() => null) : Promise.resolve(null)),
      (typeof DB.getKelasList === 'function' ? DB.getKelasList().catch(() => []) : Promise.resolve([])),
      (typeof DB.getJurusanList === 'function' ? DB.getJurusanList().catch(() => []) : Promise.resolve([]))
    ]);

    proctorAllPeserta = Array.isArray(pesertaData) ? pesertaData : [];
    proctorAllPaket = Array.isArray(paketData) ? paketData : [];
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
    renderProctorActiveMapelBanner();
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

// ==================== DETEKSI MATA PELAJARAN AKTIF UNTUK PENGAWAS ====================

function normalizeJurusanAliasProctor(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s || s === 'semua' || s === 'semua jurusan') return 'semua';
  if (s === 'akl' || s === 'akuntansi' || s.startsWith('akuntansi ')) return 'akl';
  if (s === 'tkj' || s === 'tjkt') return 'tkj';
  if (s === 'tkro' || s === 'tkr') return 'tkro';
  if (s === 'tbsm' || s === 'tsm') return 'tbsm';
  return s;
}

function checkKelasMatchProctor(pKelas, targetKelas) {
  if (!pKelas || pKelas === '' || pKelas.toLowerCase() === 'semua') {
    return { match: true, specificity: 0 };
  }
  if (!targetKelas) return { match: false, specificity: 0 };

  const s = String(targetKelas).toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = String(pKelas).toLowerCase().split(',').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);

  if (parts.includes(s)) return { match: true, specificity: 3 };

  const specificGrades = new Set();
  for (const part of parts) {
    if (part.startsWith('tingkat:') || part.startsWith('tingkat ')) continue;
    if (['x', 'xi', 'xii', '10', '11', '12'].includes(part)) continue;
    const pTokens = part.split(/[\s\-_]+/);
    let g = pTokens[0] || '';
    if (g === 'kelas' && pTokens.length > 1) g = pTokens[1];
    if (['x', 'xi', 'xii', '10', '11', '12'].includes(g)) specificGrades.add(g);
  }

  const sTokens = s.split(/[\s\-_]+/);
  let sTingkat = sTokens[0] || '';
  if (sTingkat === 'kelas' && sTokens.length > 1) sTingkat = sTokens[1];

  for (const part of parts) {
    let targetTingkat = '';
    if (part.startsWith('tingkat:')) targetTingkat = part.replace('tingkat:', '').trim();
    else if (part.startsWith('tingkat ')) targetTingkat = part.replace('tingkat ', '').trim();
    else if (['x', 'xi', 'xii', '10', '11', '12'].includes(part)) targetTingkat = part;

    if (targetTingkat && specificGrades.has(targetTingkat)) continue;
    if (targetTingkat && sTingkat === targetTingkat) return { match: true, specificity: 2 };
  }

  return { match: false, specificity: 0 };
}

function formatPaketTimeRange(p) {
  if (!p || !p.jadwal_mulai) return '';
  const now = new Date();
  const start = new Date(p.jadwal_mulai);
  const end = p.jadwal_selesai ? new Date(p.jadwal_selesai) : null;
  if (isNaN(start.getTime())) return '';

  const sameDayStart = start.toDateString() === now.toDateString();
  const tOpts = { hour: '2-digit', minute: '2-digit' };
  const dOpts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  const sStr = start.toLocaleString('id-ID', sameDayStart ? tOpts : dOpts);

  if (!end || isNaN(end.getTime()) || end.getFullYear() > 2090) {
    return `Mulai ${sStr}`;
  }
  const sameDayEnd = end.toDateString() === start.toDateString();
  const eStr = end.toLocaleString('id-ID', sameDayEnd ? tOpts : dOpts);
  return `${sStr} – ${eStr}`;
}

function formatPaketTargetScope(p) {
  const kRaw = String(p.kelas || '').trim();
  const jRaw = String(p.jurusan || '').trim();
  const parts = [];
  if (kRaw && kRaw.toLowerCase() !== 'semua') {
    const kFmt = kRaw.split(',').map(x => {
      const t = x.trim();
      return t.toUpperCase().startsWith('TINGKAT:') ? `Kelas ${t.split(':')[1].toUpperCase()}` : t.toUpperCase();
    }).join(', ');
    parts.push(kFmt);
  } else {
    parts.push('Semua Kelas');
  }
  if (jRaw && jRaw.toLowerCase() !== 'semua') {
    parts.push(jRaw.toUpperCase());
  }
  return parts.join(' • ');
}

function getAllActiveAndUpcomingPakets() {
  const now = new Date();
  const active = [];
  const upcoming = [];

  (proctorAllPaket || []).forEach(p => {
    if (!p || !p.jadwal_mulai) return;
    const start = new Date(p.jadwal_mulai);
    const end = p.jadwal_selesai ? new Date(p.jadwal_selesai) : new Date('2099-12-31');
    if (isNaN(start.getTime())) return;

    const cleanName = String(p.nama_paket || 'Mata Pelajaran').replace(/\s+/g, ' ').trim();
    const enriched = { ...p, _cleanName: cleanName, _startMs: start.getTime(), _endMs: end.getTime() };

    if (now >= start && now <= end) {
      active.push(enriched);
    } else if (start > now && (start.getTime() - now.getTime()) <= 18 * 3600 * 1000) {
      upcoming.push(enriched);
    }
  });

  active.sort((a, b) => a._cleanName.localeCompare(b._cleanName, undefined, { numeric: true }));
  upcoming.sort((a, b) => a._startMs - b._startMs);
  return { active, upcoming };
}

function getMatchingPaketsForKelas(kelasUpper, paketPool) {
  const kNorm = String(kelasUpper || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!kNorm) return [];

  // Cari jurusan dari siswa di kelas ini atau infer dari nama kelas
  let jurGuess = '';
  const sampleStudent = proctorAllPeserta.find(p => String(p.kelas || '').replace(/\s+/g, ' ').trim().toUpperCase() === kNorm && p.jurusan);
  if (sampleStudent) jurGuess = sampleStudent.jurusan;
  else jurGuess = inferJurusanFromKelasName(kNorm, null);
  const sJur = normalizeJurusanAliasProctor(jurGuess);

  return (paketPool || []).filter(p => {
    const pJur = String(p.jurusan || '').toLowerCase().trim();
    const jurParts = pJur.split(',').map(x => normalizeJurusanAliasProctor(x)).filter(Boolean);
    const jurMatch = !pJur || pJur === 'semua' || jurParts.includes('semua') || !sJur || sJur === 'semua' || jurParts.includes(sJur);
    const kRes = checkKelasMatchProctor(p.kelas, kNorm);
    return (jurMatch || kRes.specificity === 3) && kRes.match;
  });
}

function summarizePaketNamesCompact(pakets) {
  if (!pakets || pakets.length === 0) return '';
  const uniqueNames = Array.from(new Set(pakets.map(p => p._cleanName)));
  if (uniqueNames.length <= 2) return uniqueNames.join(' / ');

  // Jika merupakan varian beberapa agama pada mapel yang sama (misal PAI / Kepramukaan Islam, Protestan, Katolik, Hindu)
  const stripped = uniqueNames.map(n =>
    n.replace(/\b(islam|muslim|kristen|protestan|potestan|katolik|katholik|katoiik|hindu|hlndu|buddha|budha|konghucu|khonghucu)\b/gi, '')
     .replace(/\s+/g, ' ').replace(/\-\s*$/, '').trim()
  );
  const uniqueBase = Array.from(new Set(stripped.map(s => s.toUpperCase())));
  if (uniqueBase.length === 1 && stripped[0]) {
    return `${stripped[0]} (${uniqueNames.length} Paket Agama)`;
  }
  return `${uniqueNames.slice(0, 2).join(', ')} (+${uniqueNames.length - 2} lainnya)`;
}

function getWatchedClassesDistinctList() {
  if (selectedKelasSet.size > 0) {
    return Array.from(selectedKelasSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  if (selectedRuang) {
    const scoped = getScopedStudentsForProctor();
    const setK = new Set(scoped.map(p => String(p.kelas || '').replace(/\s+/g, ' ').trim().toUpperCase()).filter(Boolean));
    return Array.from(setK).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  return [];
}

function renderProctorActiveMapelBanner() {
  const card = document.getElementById('card-proctor-mapel-info');
  const titleEl = document.getElementById('lbl-mapel-banner-title');
  const badgeEl = document.getElementById('badge-mapel-banner-status');
  const bodyEl = document.getElementById('proctor-mapel-banner-body');
  if (!card || !bodyEl) return;

  const { active, upcoming } = getAllActiveAndUpcomingPakets();
  const watchedClasses = getWatchedClassesDistinctList();

  // MODE 1: Pengawas SUDAH memilih kelas/ruang yang diawasi -> Tampilkan spesifik mapel kelas tersebut!
  if (watchedClasses.length > 0) {
    if (titleEl) {
      titleEl.innerHTML = `<i class="bi bi-journal-bookmark-fill"></i><span>MATA PELAJARAN RUANG YANG DIAWASI</span>`;
    }

    const perClassMapel = watchedClasses.map(kls => ({
      kelas: kls,
      activePakets: getMatchingPaketsForKelas(kls, active),
      upcomingPakets: getMatchingPaketsForKelas(kls, upcoming)
    }));

    const anyActive = perClassMapel.some(item => item.activePakets.length > 0);

    if (anyActive) {
      card.classList.remove('is-idle');
      // Cek apakah semua kelas yang diawasi memiliki daftar mapel aktif yang identik
      const signatures = new Set(perClassMapel.map(it => it.activePakets.map(p => p._cleanName).join('||')));
      const allSameMapel = signatures.size === 1;

      const uniqueActiveMapels = new Map();
      perClassMapel.forEach(it => it.activePakets.forEach(p => uniqueActiveMapels.set(p.id || p._cleanName, p)));

      if (badgeEl) {
        badgeEl.className = 'badge bg-success-subtle text-success border border-success-subtle rounded-pill d-inline-flex align-items-center gap-1';
        badgeEl.innerHTML = `<span class="pulse-dot-green"></span> Sedang Berlangsung`;
      }

      if (allSameMapel) {
        const listP = perClassMapel[0].activePakets;
        bodyEl.innerHTML = `
          <div class="d-flex flex-wrap gap-2 mt-1">
            ${listP.map(p => {
              const tStr = formatPaketTimeRange(p);
              return `
                <div class="bg-white border border-primary-subtle rounded-3 px-3 py-2 shadow-sm d-inline-flex flex-column">
                  <span class="fw-bold text-dark" style="font-size: 0.92rem;"><i class="bi bi-book-half text-primary me-1"></i>${escapeHtmlP(p._cleanName)}</span>
                  ${tStr ? `<span class="text-muted" style="font-size: 0.72rem;"><i class="bi bi-clock me-1"></i>Jadwal: ${escapeHtmlP(tStr)}</span>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        `;
      } else {
        // Ruangan campuran beberapa kelas dengan mapel berbeda -> tampilkan per kelas!
        bodyEl.innerHTML = `
          <div class="d-flex flex-column gap-1 mt-1">
            ${perClassMapel.map(it => {
              if (it.activePakets.length === 0) {
                return `
                  <div class="bg-white border rounded-3 px-2 py-1 d-flex align-items-center justify-content-between flex-wrap gap-1">
                    <span class="badge bg-secondary">${escapeHtmlP(it.kelas)}</span>
                    <span class="text-muted fst-italic small">Tidak ada jadwal mapel aktif saat ini</span>
                  </div>
                `;
              }
              const namesHtml = it.activePakets.map(p => {
                const tStr = formatPaketTimeRange(p);
                return `<strong class="text-dark">${escapeHtmlP(p._cleanName)}</strong>${tStr ? ` <span class="text-muted" style="font-size:0.72rem;">(${escapeHtmlP(tStr)})</span>` : ''}`;
              }).join(' <span class="text-muted mx-1">•</span> ');
              return `
                <div class="bg-white border border-primary-subtle rounded-3 px-2 py-1 d-flex align-items-center flex-wrap gap-2">
                  <span class="badge bg-primary">${escapeHtmlP(it.kelas)}</span>
                  <span class="small"><i class="bi bi-book-half text-primary me-1"></i>${namesHtml}</span>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
      return;
    }

    // Tidak ada mapel aktif untuk kelas yang dipilih -> cek apakah ada jadwal segera dimulai hari ini
    card.classList.add('is-idle');
    const upcomingMatchedMap = new Map();
    perClassMapel.forEach(it => it.upcomingPakets.forEach(p => upcomingMatchedMap.set(p.id || p._cleanName, p)));
    const upcomingList = Array.from(upcomingMatchedMap.values());

    if (upcomingList.length > 0) {
      if (badgeEl) {
        badgeEl.className = 'badge bg-warning-subtle text-dark border border-warning rounded-pill';
        badgeEl.innerHTML = `<i class="bi bi-hourglass-split me-1"></i>Menunggu Jam Mulai`;
      }
      bodyEl.innerHTML = `
        <div class="text-dark small mt-1">
          Jadwal berikutnya untuk kelas ini:
          ${upcomingList.slice(0, 3).map(p => `<span class="badge bg-white text-dark border ms-1"><i class="bi bi-clock text-warning me-1"></i>${escapeHtmlP(p._cleanName)} (${escapeHtmlP(formatPaketTimeRange(p))})</span>`).join('')}
        </div>
      `;
    } else {
      if (badgeEl) {
        badgeEl.className = 'badge bg-secondary-subtle text-secondary border rounded-pill';
        badgeEl.innerHTML = `Belum Ada Jadwal Aktif`;
      }
      bodyEl.innerHTML = `<div class="text-muted small">Saat ini belum ada jadwal mata pelajaran yang sedang dibuka untuk kelas <strong>${escapeHtmlP(watchedClasses.join(', '))}</strong>.</div>`;
    }
    return;
  }

  // MODE 2: Pengawas BARU MASUK halaman pengawas (belum memilih kelas) -> Tampilkan seluruh mapel yang sedang aktif saat ini!
  if (titleEl) {
    titleEl.innerHTML = `<i class="bi bi-journal-bookmark-fill"></i><span>MATA PELAJARAN UJIAN SAAT INI</span>`;
  }

  if (active.length > 0) {
    card.classList.remove('is-idle');
    if (badgeEl) {
      badgeEl.className = 'badge bg-success-subtle text-success border border-success-subtle rounded-pill d-inline-flex align-items-center gap-1';
      badgeEl.innerHTML = `<span class="pulse-dot-green"></span> ${active.length} Paket Mapel Aktif`;
    }
    bodyEl.innerHTML = `
      <div class="d-flex flex-wrap gap-2 mt-1">
        ${active.map(p => {
          const scopeStr = formatPaketTargetScope(p);
          const timeStr = formatPaketTimeRange(p);
          return `
            <div class="bg-white border border-primary-subtle rounded-3 px-3 py-2 shadow-sm d-inline-flex flex-column">
              <span class="fw-bold text-dark" style="font-size: 0.88rem;"><i class="bi bi-book-half text-primary me-1"></i>${escapeHtmlP(p._cleanName)}</span>
              <span class="text-muted" style="font-size: 0.71rem;">
                <i class="bi bi-mortarboard me-1"></i>${escapeHtmlP(scopeStr)}${timeStr ? ` • <i class="bi bi-clock ms-1 me-1"></i>${escapeHtmlP(timeStr)}` : ''}
              </span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } else if (upcoming.length > 0) {
    card.classList.add('is-idle');
    if (badgeEl) {
      badgeEl.className = 'badge bg-warning-subtle text-dark border border-warning rounded-pill';
      badgeEl.innerHTML = `<i class="bi bi-hourglass-split me-1"></i>Menunggu Jam Mulai`;
    }
    bodyEl.innerHTML = `
      <div class="text-dark small mt-1">
        Belum masuk jam ujian. Jadwal terdekat:
        ${upcoming.slice(0, 4).map(p => `<span class="badge bg-white text-dark border ms-1">${escapeHtmlP(p._cleanName)} (${escapeHtmlP(formatPaketTargetScope(p))} • ${escapeHtmlP(formatPaketTimeRange(p))})</span>`).join('')}
      </div>
    `;
  } else {
    card.classList.add('is-idle');
    if (badgeEl) {
      badgeEl.className = 'badge bg-secondary-subtle text-secondary border rounded-pill';
      badgeEl.innerHTML = `Tidak Ada Jadwal Aktif`;
    }
    bodyEl.innerHTML = `<div class="text-muted small">Saat ini belum ada jadwal mata pelajaran yang sedang berlangsung.</div>`;
  }
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
  renderProctorActiveMapelBanner();
  renderWatchedStudents();
}

function onRuangSelectChange(val) {
  selectedRuang = String(val || '').trim();
  saveWatchState();
  renderKelasPickerButtons();
  renderProctorActiveMapelBanner();
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
  renderProctorActiveMapelBanner();
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

  // Render badge kelas/ruang aktif + keterangan mapel di subtitle
  const { active: activeGlobalPakets } = getAllActiveAndUpcomingPakets();
  const kelasArr = Array.from(selectedKelasSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const summaryParts = [];
  if (selectedRuang) summaryParts.push(`Ruang ${selectedRuang}`);
  if (kelasArr.length > 0) summaryParts.push(kelasArr.join(', '));
  if (selectedSesi) summaryParts.push(selectedSesi);

  const watchedForSub = getWatchedClassesDistinctList();
  const watchedActiveMap = new Map();
  watchedForSub.forEach(k => getMatchingPaketsForKelas(k, activeGlobalPakets).forEach(p => watchedActiveMap.set(p.id || p._cleanName, p)));
  const compactMapelSub = summarizePaketNamesCompact(Array.from(watchedActiveMap.values()));
  if (compactMapelSub) summaryParts.push(`Mapel: ${compactMapelSub}`);

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

  // Prioritas urutan: 1) Siswa TERKUNCI paling atas, 2) Ada pelanggaran, 3) Kelas (natural sort) & Nama
  filtered.sort((a, b) => {
    const aLock = a.is_locked ? 1 : 0;
    const bLock = b.is_locked ? 1 : 0;
    if (bLock !== aLock) return bLock - aLock;

    const aViol = parseInt(a.pelanggaran || 0);
    const bViol = parseInt(b.pelanggaran || 0);
    if ((bViol > 0 ? 1 : 0) !== (aViol > 0 ? 1 : 0)) return bViol - aViol;

    const kA = String(a.kelas || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const kB = String(b.kelas || '').replace(/\s+/g, ' ').trim().toUpperCase();
    const klsCmp = kA.localeCompare(kB, undefined, { numeric: true });
    if (klsCmp !== 0) return klsCmp;
    return String(a.nama_lengkap || '').localeCompare(String(b.nama_lengkap || ''), undefined, { numeric: true });
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

  let currentGroupKey = null;
  let nomorPerKelas = 0;
  const htmlItems = [];

  filtered.forEach((p) => {
    const pel = parseInt(p.pelanggaran || 0);
    const isLocked = Boolean(p.is_locked);
    const isAlertGroup = isLocked || pel > 0;
    const pKelasNorm = String(p.kelas || 'Tanpa Kelas').replace(/\s+/g, ' ').trim().toUpperCase();
    const groupKey = isAlertGroup ? '__ALERT_PRIORITY__' : `KELAS:${pKelasNorm}`;

    if (currentGroupKey !== groupKey) {
      currentGroupKey = groupKey;
      nomorPerKelas = 0;
      if (isAlertGroup) {
        htmlItems.push(`
          <div class="px-2 py-1 mt-1 rounded-3 bg-danger-subtle border border-danger-subtle text-danger fw-bold small d-flex align-items-center gap-2">
            <i class="bi bi-exclamation-octagon-fill"></i>
            <span>PERLU TINDAKAN PENGAWAS (TERKUNCI / PELANGGARAN)</span>
          </div>
        `);
      } else {
        const klsActivePakets = getMatchingPaketsForKelas(pKelasNorm, activeGlobalPakets);
        const klsMapelText = summarizePaketNamesCompact(klsActivePakets);
        const klsMapelBadge = klsMapelText
          ? `<span class="badge bg-white text-primary border border-primary-subtle fw-semibold text-wrap text-end"><i class="bi bi-book-half me-1"></i>${escapeHtmlP(klsMapelText)}</span>`
          : `<span class="badge bg-light text-muted border fw-normal">Belum ada mapel aktif</span>`;
        htmlItems.push(`
          <div class="px-3 py-2 mt-1 rounded-3 bg-primary-subtle border border-primary-subtle text-primary fw-bold small d-flex align-items-center justify-content-between flex-wrap gap-1">
            <span><i class="bi bi-mortarboard-fill me-2"></i>KELAS: ${escapeHtmlP(pKelasNorm)}</span>
            ${klsMapelBadge}
          </div>
        `);
      }
    }
    nomorPerKelas++;
    const idx = nomorPerKelas - 1;
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

    htmlItems.push(`
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
    `);
  });

  container.innerHTML = htmlItems.join('');
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

  const { active: activeForWa } = getAllActiveAndUpcomingPakets();
  const waMapelMap = new Map();
  kelasUnik.forEach(k => getMatchingPaketsForKelas(k, activeForWa).forEach(p => waMapelMap.set(p.id || p._cleanName, p)));
  const waMapelStr = summarizePaketNamesCompact(Array.from(waMapelMap.values()));

  const nowStr = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const lines = [
    `*LAPORAN KEHADIRAN RUANG CBT*`,
    `📅 Waktu: ${nowStr}`,
    proctorName ? `👤 Pengawas: ${proctorName}` : '',
    waMapelStr ? `📚 Mata Pelajaran: *${waMapelStr}*` : '',
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
