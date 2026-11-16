// Ujian (Student Exam Portal) Controller

let studentProfile = null;
let currentIndex = 0;
let totalSoalCount = 0;

let allQuestions = [];
let savedAnswers = {}; // { soalId: { jawaban: 'A', ragu_ragu: false } }
let hasPendingSync = false;
let isSyncingInProgress = false;
let batchSyncInterval = null;
let debouncedSyncTimer = null;

let timerInterval = null;
let examTimerEndTimestamp = null;
let passingGradeVal = 60.00;
let tampilkanNilaiVal = true;
let currentActivePaket = null;

function getLocalAnswerStorageKey() {
  if (!studentProfile || !currentActivePaket) return null;
  return `CBT_LOCAL_ANS_${studentProfile.id}_${currentActivePaket.id}`;
}

function saveAnswersToLocalStorage() {
  const key = getLocalAnswerStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(savedAnswers));
  } catch (err) {
    console.warn("Gagal menyimpan ke localStorage:", err);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Validate student session via DB adapter (supports local mock & cloud)
  const authSession = await DB.checkSession('peserta');
  if (!authSession) return;

  studentProfile = authSession.profile;
  violationCount = parseInt(studentProfile.pelanggaran || 0);

  // Initialize Participant Dashboard fields
  document.getElementById('dash-avatar').innerText = studentProfile.nama_lengkap.charAt(0).toUpperCase();
  document.getElementById('dash-nama').innerText = studentProfile.nama_lengkap;
  document.getElementById('dash-username').innerText = studentProfile.username;
  document.getElementById('dash-jurusan').innerText = studentProfile.jurusan || '-';
  document.getElementById('dash-kelas').innerText = studentProfile.kelas || '-';
  document.getElementById('dash-ruang').innerText = studentProfile.ruang || '-';
  document.getElementById('dash-sesi').innerText = studentProfile.sesi || '-';
  document.getElementById('dash-status').innerText = studentProfile.status_ujian;

  // Sync statuses style
  let statusBadge = document.getElementById('dash-status');
  statusBadge.className = "badge";
  if (studentProfile.status_ujian === 'Belum Ujian') statusBadge.classList.add('bg-secondary');
  if (studentProfile.status_ujian === 'Sedang Ujian') statusBadge.classList.add('bg-warning', 'text-dark');
  if (studentProfile.status_ujian === 'Sudah Ujian') statusBadge.classList.add('bg-success');

  // Load Exam stats and existing results
  await loadExamSetupAndVerify();

  // Hide loading spinner
  document.getElementById('loading-overlay').classList.add('d-none');
});

// Helper: Mengecek apakah paket kelas cocok dengan kelas siswa (mendukung Tingkat X, XI, XII, daftar kelas, atau rombel spesifik)
function checkKelasMatch(pKelas, studentKelas) {
  if (!pKelas || pKelas === "" || pKelas.toLowerCase() === "semua") {
    return { match: true, specificity: 0 };
  }
  if (!studentKelas) return { match: false, specificity: 0 };

  const p = pKelas.toLowerCase().trim();
  const s = studentKelas.toLowerCase().trim();

  // 1. Cocok persis (cth: "x tkj 1" === "x tkj 1")
  if (p === s) {
    return { match: true, specificity: 3 };
  }

  // 2. Jika paket berisi daftar rombel dipisah koma (cth: "x tkj 1, x tkj 2")
  const parts = p.split(',').map(x => x.trim());
  if (parts.includes(s)) {
    return { match: true, specificity: 3 };
  }

  // 3. Cocok per Tingkat / Jenjang Angkatan (cth: "tingkat:x", "tingkat:xi", "tingkat:xii", atau "x", "xi", "xii")
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

    if (sTingkat === targetTingkat) {
      return { match: true, specificity: 2 };
    }
  }

  return { match: false, specificity: 0 };
}

// -------------------------------------------------------------
// MODUL UJIAN AGAMA & MULTI-PAKET AKTIF
// -------------------------------------------------------------

let candidateActivePakets = []; // Seluruh paket yang aktif saat ini untuk rombel siswa
let candidateAgamaPakets = [];   // Khusus paket ujian agama aktif
let chosenAgamaKey = null;       // Pilihan agama siswa (misal: 'islam', 'kristen')

// Daftar 6 agama resmi di Indonesia dengan ikon & kata kunci pencocokan nama paket
const AGAMA_DEFINITIONS = [
  { key: 'islam', name: 'Pendidikan Agama Islam (PAI)', icon: 'bi-moon-stars-fill', iconText: '🕌', color: 'success', keywords: ['islam', 'pai', 'paibp'] },
  { key: 'kristen', name: 'Pendidikan Agama Kristen', icon: 'bi-cross', iconText: '✝️', color: 'primary', keywords: ['kristen', 'protestan', 'pakp', 'pak'] },
  { key: 'katolik', name: 'Pendidikan Agama Katolik', icon: 'bi-hospital', iconText: '⛪', color: 'danger', keywords: ['katolik'] },
  { key: 'hindu', name: 'Pendidikan Agama Hindu', iconText: '🕉️', color: 'warning', keywords: ['hindu', 'pah'] },
  { key: 'buddha', name: 'Pendidikan Agama Buddha', iconText: '☸️', color: 'info', keywords: ['buddha', 'budha'] },
  { key: 'konghucu', name: 'Pendidikan Agama Konghucu', iconText: '☯️', color: 'secondary', keywords: ['konghucu', 'khonghucu'] }
];

// Deteksi apakah nama paket adalah mata pelajaran Agama
function isAgamaPaket(namaPaket) {
  if (!namaPaket) return false;
  const n = namaPaket.toLowerCase();
  return n.includes('agama') || 
         n.includes('pai') || 
         n.includes('paibp') || 
         n.includes('pakp') || 
         n.includes('kristen') || 
         n.includes('katolik') || 
         n.includes('hindu') || 
         n.includes('buddha') || 
         n.includes('konghucu');
}

// Deteksi kategori agama dari nama paket
function detectAgamaCategory(namaPaket) {
  if (!namaPaket) return null;
  const n = namaPaket.toLowerCase();
  for (const a of AGAMA_DEFINITIONS) {
    if (a.keywords.some(kw => n.includes(kw))) {
      return a;
    }
  }
  return null;
}

// Helper: Mencocokkan seluruh paket soal aktif untuk siswa berdasarkan jadwal, jurusan, dan kelas
function findAllActivePaketsForStudent(allPaket, profile) {
  if (!allPaket || allPaket.length === 0 || !profile) return [];
  const now = new Date();
  const studentJurusan = (profile.jurusan || "").toLowerCase().trim();
  const studentKelas = (profile.kelas || "").toLowerCase().trim();

  const matching = [];

  for (const p of allPaket) {
    if (!p.jadwal_mulai) continue;
    const start = new Date(p.jadwal_mulai);
    const end = p.jadwal_selesai ? new Date(p.jadwal_selesai) : new Date('2099-12-31');

    if (now >= start && now <= end) {
      const pJurusan = (p.jurusan || "").toLowerCase().trim();
      const jurusanMatch = (pJurusan === "" || pJurusan === "semua" || pJurusan === studentJurusan);
      const kelasResult = checkKelasMatch(p.kelas, studentKelas);

      if (jurusanMatch && kelasResult.match) {
        let score = 0;
        if (pJurusan && pJurusan !== "semua" && pJurusan === studentJurusan) score += 4;
        score += kelasResult.specificity;
        matching.push({ ...p, matchScore: score });
      }
    }
  }

  // Prioritaskan yang memiliki skor kecocokan tertinggi
  matching.sort((a, b) => b.matchScore - a.matchScore);
  return matching;
}

// Render Opsi Pemilihan Agama di Dashboard Siswa
function renderAgamaSelector(agamaPakets) {
  const container = document.getElementById('card-pilih-agama');
  const listEl = document.getElementById('list-opsi-agama');
  const countBadge = document.getElementById('badge-agama-count');
  if (!container || !listEl) return;

  if (!agamaPakets || agamaPakets.length === 0) {
    container.classList.add('d-none');
    return;
  }

  container.classList.remove('d-none');
  if (countBadge) countBadge.innerText = `${agamaPakets.length} Paket Agama Tersedia`;

  // Cek preferensi agama yang pernah dipilih sebelumnya dari localStorage
  const savedAgama = localStorage.getItem(`CBT_STUDENT_AGAMA_${studentProfile.id}`);
  if (savedAgama) {
    chosenAgamaKey = savedAgama;
  }

  listEl.innerHTML = '';

  AGAMA_DEFINITIONS.forEach(def => {
    // Cari apakah paket soal agama ini dijadwalkan oleh admin
    const matchedPaket = agamaPakets.find(p => {
      const cat = detectAgamaCategory(p.nama_paket);
      return cat && cat.key === def.key;
    });

    const isAvailable = Boolean(matchedPaket);
    const isSelected = chosenAgamaKey === def.key || (!chosenAgamaKey && isAvailable && def.key === 'islam');
    if (isSelected && isAvailable) {
      chosenAgamaKey = def.key;
    }

    const cardCol = document.createElement('div');
    cardCol.className = 'col-md-6 col-12';
    
    const iconDisplay = def.iconText ? `<span class="fs-5 me-2">${def.iconText}</span>` : `<i class="bi ${def.icon} fs-5 me-2 text-${def.color}"></i>`;

    if (isAvailable) {
      cardCol.innerHTML = `
        <div class="card p-3 border rounded-3 h-100 cursor-pointer shadow-sm transition-all agama-option-card ${isSelected ? 'border-primary bg-primary-subtle' : 'bg-white'}" 
             style="cursor: pointer; transition: all 0.2s ease;"
             onclick="selectStudentAgama('${def.key}')">
          <div class="d-flex align-items-center justify-content-between">
            <div class="d-flex align-items-center">
              ${iconDisplay}
              <div>
                <strong class="text-dark d-block">${def.name}</strong>
                <small class="text-muted">${escapeHtml(matchedPaket.nama_paket)}</small>
              </div>
            </div>
            <div class="form-check m-0">
              <input class="form-check-input" type="radio" name="radioAgama" id="radio-agama-${def.key}" value="${def.key}" ${isSelected ? 'checked' : ''} onchange="selectStudentAgama('${def.key}')">
            </div>
          </div>
        </div>
      `;
    } else {
      cardCol.innerHTML = `
        <div class="card p-3 border rounded-3 h-100 bg-light opacity-50" style="cursor: not-allowed;" title="Paket soal belum dibuat atau belum dijadwalkan oleh sekolah">
          <div class="d-flex align-items-center justify-content-between">
            <div class="d-flex align-items-center">
              ${iconDisplay}
              <div>
                <span class="text-secondary fw-semibold d-block">${def.name}</span>
                <small class="text-muted fst-italic">Belum dijadwalkan</small>
              </div>
            </div>
            <span class="badge bg-secondary-subtle text-secondary small">Kosong</span>
          </div>
        </div>
      `;
    }
    listEl.appendChild(cardCol);
  });
}

// Siswa mengklik salah satu pilihan agama
async function selectStudentAgama(agamaKey) {
  chosenAgamaKey = agamaKey;
  localStorage.setItem(`CBT_STUDENT_AGAMA_${studentProfile.id}`, agamaKey);

  const matchedPaket = candidateAgamaPakets.find(p => {
    const cat = detectAgamaCategory(p.nama_paket);
    return cat && cat.key === agamaKey;
  });

  if (matchedPaket) {
    currentActivePaket = matchedPaket;
    localStorage.setItem(`CBT_SELECTED_PAKET_${studentProfile.id}`, matchedPaket.id);
    await updateDashboardForSelectedPaket(matchedPaket);
    renderAgamaSelector(candidateAgamaPakets);
  }
}

// Render dropdown jika ada beberapa paket non-agama aktif serentak
function renderPaketSelector(pakets) {
  const container = document.getElementById('card-pilih-paket');
  const selEl = document.getElementById('select-active-paket');
  if (!container || !selEl) return;

  if (!pakets || pakets.length <= 1) {
    container.classList.add('d-none');
    return;
  }

  container.classList.remove('d-none');
  selEl.innerHTML = '';
  pakets.forEach((p, idx) => {
    const isSel = currentActivePaket && currentActivePaket.id === p.id ? 'selected' : '';
    selEl.innerHTML += `<option value="${p.id}" ${isSel}>${idx + 1}. ${escapeHtml(p.nama_paket)}</option>`;
  });
}

async function switchActivePaketManually(paketId) {
  const target = candidateActivePakets.find(p => p.id === paketId);
  if (target) {
    currentActivePaket = target;
    localStorage.setItem(`CBT_SELECTED_PAKET_${studentProfile.id}`, target.id);
    await updateDashboardForSelectedPaket(target);
  }
}

// Update tampilan informasi dashboard ketika paket soal berubah / terpilih
async function updateDashboardForSelectedPaket(activePaket) {
  if (!activePaket) return;
  currentActivePaket = activePaket;

  const mapelEl = document.getElementById('dash-mapel');
  if (mapelEl) mapelEl.innerText = activePaket.nama_paket;

  let questions = [];
  try {
    questions = await DB.getSoalByPaket(activePaket.id);
  } catch (e) {
    console.warn("Gagal getSoalByPaket:", e);
  }

  totalSoalCount = questions.length;
  document.getElementById('dash-soal-count').innerText = totalSoalCount;

  // Display Schedule Info
  const dashJadwal = document.getElementById('dash-jadwal');
  let jadwalStr = `${activePaket.nama_paket} (Terbuka)`;
  if (activePaket.jadwal_mulai && activePaket.jadwal_selesai) {
    const start = new Date(activePaket.jadwal_mulai).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    const end = new Date(activePaket.jadwal_selesai).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    jadwalStr = `${activePaket.nama_paket}: ${start} — ${end}`;
  } else if (activePaket.jadwal_mulai) {
    const start = new Date(activePaket.jadwal_mulai).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    jadwalStr = `${activePaket.nama_paket}: Mulai dari ${start}`;
  }
  if (dashJadwal) dashJadwal.innerText = jadwalStr;

  // Cek apakah siswa sudah pernah menyelesaikan paket soal ini sebelumnya
  const existingHasil = await DB.checkExistingHasil(studentProfile.id, activePaket.id);
  const alertDone = document.getElementById('alert-already-done');
  const btnMulai = document.getElementById('btn-mulai-ujian');

  if (existingHasil) {
    const completedTextEl = document.getElementById('completed-alert-text');
    if (completedTextEl) {
      completedTextEl.innerHTML = `Selamat, Anda telah menyelesaikan ujian <strong>${escapeHtml(activePaket.nama_paket)}</strong>. Terima kasih telah mengikuti ujian dengan tertib.`;
    }
    if (alertDone) alertDone.classList.remove('d-none');
    if (btnMulai) {
      btnMulai.disabled = true;
      btnMulai.innerHTML = `<i class="bi bi-check-circle me-1"></i> Ujian Sudah Selesai`;
      btnMulai.className = 'btn btn-secondary w-100 py-3 rounded-3 shadow-sm';
    }
  } else {
    if (alertDone) alertDone.classList.add('d-none');
    if (questions.length === 0) {
      if (btnMulai) {
        btnMulai.disabled = true;
        btnMulai.innerHTML = `Paket Soal Masih Kosong`;
        btnMulai.className = 'btn btn-secondary w-100 py-3 rounded-3 shadow-sm';
      }
    } else {
      if (btnMulai) {
        btnMulai.disabled = false;
        const isSedangUjian = studentProfile.status_ujian === 'Sedang Ujian';
        btnMulai.innerHTML = isSedangUjian
          ? `Lanjutkan Ujian <i class="bi bi-arrow-right-circle-fill ms-2"></i>`
          : `Mulai Ujian <i class="bi bi-play-circle-fill ms-2"></i>`;
        btnMulai.className = 'btn btn-primary-custom text-white w-100 py-3 rounded-3 shadow-sm';
      }
    }
  }
}

// Load config settings and verify if they can start the exam
async function loadExamSetupAndVerify() {
  try {
    // 1. Dapatkan daftar seluruh paket soal yang ada
    const allPaket = await DB.getPaketList();

    // 2. Dapatkan seluruh paket yang aktif & cocok dengan rombel/jurusan siswa saat ini
    candidateActivePakets = findAllActivePaketsForStudent(allPaket, studentProfile);
    candidateAgamaPakets = candidateActivePakets.filter(p => isAgamaPaket(p.nama_paket));

    // 3. Tentukan paket aktif yang akan digunakan:
    // Prioritas 1: Jika siswa sedang dalam pengerjaan (in-progress) di browser ini
    const inProgressId = localStorage.getItem(`CBT_IN_PROGRESS_PAKET_${studentProfile.id}`);
    let activePaket = null;
    if (inProgressId) {
      activePaket = (allPaket || []).find(p => p.id === inProgressId);
    }

    // Prioritas 2: Jika terdeteksi paket Agama aktif
    if (!activePaket && candidateAgamaPakets.length > 0) {
      const savedAgama = localStorage.getItem(`CBT_STUDENT_AGAMA_${studentProfile.id}`);
      if (savedAgama) {
        activePaket = candidateAgamaPakets.find(p => {
          const cat = detectAgamaCategory(p.nama_paket);
          return cat && cat.key === savedAgama;
        });
      }
      if (!activePaket) {
        activePaket = candidateAgamaPakets[0];
      }
      renderAgamaSelector(candidateAgamaPakets);
    } else if (!activePaket && candidateActivePakets.length > 0) {
      activePaket = candidateActivePakets[0];
      if (candidateActivePakets.length > 1) {
        renderPaketSelector(candidateActivePakets);
      }
    }

    currentActivePaket = activePaket;

    // 4. Ambil Pengaturan Umum Ujian (Durasi, Passing Grade, Nilai)
    const settings = await DB.getSettings();
    if (settings) {
      document.getElementById('dash-duration').innerText = settings.durasi_menit;
      const dashPassing = document.getElementById('dash-passing');
      if (dashPassing) dashPassing.innerText = "-";
      if (settings.tampilkan_nilai !== undefined) {
        tampilkanNilaiVal = settings.tampilkan_nilai;
      }
    }

    if (activePaket) {
      await updateDashboardForSelectedPaket(activePaket);
    } else {
      const mapelEl = document.getElementById('dash-mapel');
      if (mapelEl) mapelEl.innerText = "Tidak Ada Ujian Aktif";
      const dashJadwal = document.getElementById('dash-jadwal');
      if (dashJadwal) dashJadwal.innerText = "Tidak Ada Ujian Aktif Saat Ini";
      const btnMulai = document.getElementById('btn-mulai-ujian');
      if (btnMulai) {
        btnMulai.disabled = true;
        btnMulai.innerHTML = `Ujian Belum Tersedia`;
        btnMulai.className = 'btn btn-secondary w-100 py-3 rounded-3 shadow-sm';
      }
    }

    // 5. Cek apakah siswa terkunci karena mencapai kelipatan 3x pelanggaran
    if (studentProfile.is_locked) {
      const dashJadwal = document.getElementById('dash-jadwal');
      if (dashJadwal) {
        dashJadwal.innerText = `Akses Ujian Terkunci (${violationCount}x Pelanggaran) — Wajib Token Pembebas`;
        dashJadwal.classList.add('text-danger', 'fw-bold');
      }
      const btnMulai = document.getElementById('btn-mulai-ujian');
      if (btnMulai) {
        btnMulai.disabled = false;
        btnMulai.innerHTML = `<i class="bi bi-key-fill me-2"></i>Masukkan Token Pembebas`;
        btnMulai.className = 'btn btn-danger w-100 py-3 rounded-3 shadow-sm';
        btnMulai.onclick = () => {
          showTokenPembebasModal(() => {
            window.location.reload();
          });
        };
      }
      document.getElementById('view-dashboard').classList.remove('d-none');
      setTimeout(() => {
        showTokenPembebasModal(() => {
          window.location.reload();
        });
      }, 300);
      return;
    }

    document.getElementById('view-dashboard').classList.remove('d-none');
  } catch (err) {
    console.error("Gagal verifikasi pendaftaran:", err);
    document.getElementById('view-dashboard').classList.remove('d-none');
  }
}

// -------------------------------------------------------------
// PDF CARD GENERATION
// -------------------------------------------------------------

function cetakKartuPesertaPDF() {
  Swal.fire({
    title: 'Mempersiapkan PDF...',
    text: 'Sedang memproses kartu peserta ujian...',
    allowOutsideClick: false,
    didOpen: () => { Swal.showLoading(); }
  });

  // Populate hidden print fields
  document.getElementById('pdf-username').innerText = studentProfile.username || '-';
  document.getElementById('pdf-nama').innerText = (studentProfile.nama_lengkap || '').toUpperCase();
  document.getElementById('pdf-jurusan').innerText = studentProfile.jurusan || '-';
  document.getElementById('pdf-kelas').innerText = studentProfile.kelas || '-';
  document.getElementById('pdf-ruang').innerText = studentProfile.ruang || '-';
  document.getElementById('pdf-sesi').innerText = studentProfile.sesi || '-';
  
  // Set QR code source link
  const qrImg = document.getElementById('pdf-qr-img');
  if (qrImg) {
    qrImg.onerror = function() { this.style.display = 'none'; };
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(studentProfile.username || '')}`;
  }

  // Let image load before PDF save
  setTimeout(() => {
    const element = document.getElementById('kartu-peserta-print-template');
    if (!element) {
      Swal.fire('Gagal', 'Template kartu tidak ditemukan.', 'error');
      return;
    }
    element.classList.remove('d-none'); // show briefly for capture

    const opt = {
      margin:       10,
      filename:     `Kartu_Peserta_${studentProfile.username || 'CBT'}.pdf`,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true, logging: false },
      jsPDF:        { unit: 'mm', format: 'a5', orientation: 'landscape' }
    };

    if (typeof html2pdf !== 'undefined') {
      html2pdf().set(opt).from(element).save().then(() => {
        element.classList.add('d-none'); // hide back
        Swal.close();
      }).catch(err => {
        element.classList.add('d-none');
        console.warn('html2pdf failed, fallback to print:', err);
        window.print();
        Swal.close();
      });
    } else {
      element.classList.add('d-none');
      window.print();
      Swal.close();
    }
  }, 600);
}

// -------------------------------------------------------------
// ACTIVE EXAM PENGGERAK
// -------------------------------------------------------------

async function mulaiUjianCBT() {
  const settings = await DB.getSettings();

  // Konfirmasi Mata Pelajaran Agama jika paket ini adalah ujian Agama
  if (currentActivePaket && isAgamaPaket(currentActivePaket.nama_paket)) {
    const cat = detectAgamaCategory(currentActivePaket.nama_paket);
    const agamaLabel = cat ? cat.name : currentActivePaket.nama_paket;
    const confirmAgama = await Swal.fire({
      icon: 'question',
      title: 'Konfirmasi Mata Pelajaran Agama',
      html: `
        <div class="text-start small">
          <p class="mb-2">Anda akan memulai ujian mata pelajaran:</p>
          <div class="p-3 bg-light border rounded mb-3">
            <h6 class="fw-bold text-primary mb-1">${escapeHtml(currentActivePaket.nama_paket)}</h6>
            <div class="text-success fw-semibold"><i class="bi bi-shield-check me-1"></i>Kategori: ${escapeHtml(agamaLabel)}</div>
            <div class="text-muted mt-1">Jumlah Soal: <strong>${totalSoalCount} Butir</strong> | Durasi: <strong>${document.getElementById('dash-duration').innerText} Menit</strong></div>
          </div>
          <p class="text-danger fw-semibold mb-0">
            <i class="bi bi-exclamation-triangle-fill me-1"></i>
            Pastikan agama yang Anda pilih sudah sesuai. Soal ujian akan disesuaikan dengan agama yang Anda pilih.
          </p>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: '<i class="bi bi-play-circle-fill me-1"></i> Ya, Mulai Kerjakan',
      cancelButtonText: 'Ganti Pilihan Agama',
      confirmButtonColor: '#1e3c72'
    });

    if (!confirmAgama.isConfirmed) {
      document.getElementById('card-pilih-agama')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
  }

  if (settings && settings.token_aktif) {
    const { value: inputToken } = await Swal.fire({
      title: 'Masukkan Token Ujian',
      input: 'text',
      inputLabel: 'Silakan minta token aktif kepada pengawas ujian.',
      inputPlaceholder: 'Ketik Token...',
      showCancelButton: true,
      confirmButtonText: 'Verifikasi & Mulai',
      cancelButtonText: 'Batal'
    });

    if (!inputToken) return;
    if (!DB.isValidExamToken(inputToken, settings)) {
      Swal.fire('Akses Ditolak', 'Token yang Anda masukkan salah atau sudah kadaluarsa (berganti setiap 3 menit).', 'error');
      return;
    }
  } else {
    const result = await Swal.fire({
      title: 'Mulai Ujian?',
      text: 'Apakah Anda yakin ingin memulai ujian seleksi ini sekarang? Waktu pengerjaan akan dihitung mundur secara otomatis.',
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#0d6efd',
      cancelButtonColor: '#6c757d',
      confirmButtonText: 'Ya, Mulai!',
      cancelButtonText: 'Batal'
    });

    if (!result.isConfirmed) return;
  }

  document.getElementById('loading-overlay').classList.remove('d-none');
  document.querySelector('#loading-overlay h5').innerText = "Menyiapkan Lembar Soal Ujian...";
  
  // Anti-Spike Jitter: jeda acak 200ms - 1500ms untuk mengurai lonjakan serentak 700 peserta
  const jitterMs = Math.floor(Math.random() * 1300) + 200;
  await new Promise(r => setTimeout(r, jitterMs));
  
  try {
    // 1. Ambil paket yang sedang dipilih atau aktif
    let activePaket = currentActivePaket;
    if (!activePaket) {
      const allPaket = await DB.getPaketList();
      const candidates = findAllActivePaketsForStudent(allPaket, studentProfile);
      activePaket = candidates[0] || null;
    }

    if (!activePaket) {
      throw new Error("Tidak ada paket ujian yang sedang aktif untuk jurusan & kelas Anda saat ini.");
    }

    currentActivePaket = activePaket;
    localStorage.setItem(`CBT_IN_PROGRESS_PAKET_${studentProfile.id}`, activePaket.id);

    // 2. Fetch questions for the active paket
    let questions = await DB.getSoalByPaket(activePaket.id);

    if (!questions || questions.length === 0) {
      throw new Error("Bank soal ujian untuk paket ini masih kosong. Hubungi panitia.");
    }
    
    // Acak soal jika diaktifkan di pengaturan
    if (settings && settings.acak_soal) {
      for (let i = questions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [questions[i], questions[j]] = [questions[j], questions[i]];
      }
    }

    allQuestions = questions;
    totalSoalCount = questions.length;

    // 2. Fetch or create starting status
    if (studentProfile.status_ujian !== 'Sedang Ujian') {
      await DB.updateStatusUjian(studentProfile.id, 'Sedang Ujian');
      studentProfile.status_ujian = 'Sedang Ujian';
    }

    // 3. Restore answers: Prioritaskan Cache Lokal (LocalStorage-First)
    const localKey = getLocalAnswerStorageKey();
    const cachedLocalStr = localKey ? localStorage.getItem(localKey) : null;
    let cachedAnswers = null;
    if (cachedLocalStr) {
      try { cachedAnswers = JSON.parse(cachedLocalStr); } catch (e) {}
    }

    savedAnswers = {};
    if (cachedAnswers && typeof cachedAnswers === 'object' && Object.keys(cachedAnswers).length > 0) {
      savedAnswers = cachedAnswers;
    } else {
      // Fallback ke database jika lokal belum ada (misal login pertama kali atau ganti perangkat)
      try {
        const userAnswers = await DB.getJawabanList(studentProfile.id);
        if (userAnswers && userAnswers.length > 0) {
          userAnswers.forEach(ans => {
            savedAnswers[ans.soal_id] = {
              jawaban: ans.jawaban,
              ragu_ragu: Boolean(ans.ragu_ragu),
              answered_at: ans.created_at ? new Date(ans.created_at).getTime() : Date.now()
            };
          });
          saveAnswersToLocalStorage();
        }
      } catch (e) {
        console.warn("Gagal fetch jawaban dari DB saat start:", e);
      }
    }

    // 4. Setup timer with anti-refresh preservation
    const durationMinutes = parseInt(document.getElementById('dash-duration').innerText);
    const savedEnd = localStorage.getItem(`CBT_TIMER_END_${studentProfile.id}`);
    
    if (savedEnd) {
      examTimerEndTimestamp = parseInt(savedEnd);
    } else {
      examTimerEndTimestamp = Date.now() + durationMinutes * 60 * 1000;
      localStorage.setItem(`CBT_TIMER_END_${studentProfile.id}`, examTimerEndTimestamp);
    }

    runTimer();

    // 5. Switch layouts
    document.getElementById('view-dashboard').classList.add('d-none');
    document.getElementById('view-exam').classList.remove('d-none');
    
    // Tampilkan nama mata pelajaran di header ujian
    const mapelBadge = document.getElementById('exam-mapel-badge');
    if (mapelBadge && currentActivePaket) {
      mapelBadge.innerText = currentActivePaket.nama_paket;
    }

    // Aktifkan mode ujian & layar penuh
    isExamActive = true;
    requestFullscreen();
    document.body.classList.add('exam-active');

    // Aktifkan timer sinkronisasi latar belakang (Background Batch Sync)
    startBatchSyncTimer();

    // Load first question
    currentIndex = 0;
    renderQuestion();
    renderQuestionNavGrid();

    document.getElementById('loading-overlay').classList.add('d-none');
  } catch (err) {
    document.getElementById('loading-overlay').classList.add('d-none');
    Swal.fire('Gagal Memulai Ujian', err.message || 'Terjadi kesalahan.', 'error');
  }
}

// Countdown timer loop
function runTimer() {
  if (timerInterval) clearInterval(timerInterval);

  const countdownText = document.getElementById('countdown-timer');
  const timerBox = document.getElementById('timer-box');

  timerInterval = setInterval(() => {
    const msRemaining = examTimerEndTimestamp - Date.now();
    
    if (msRemaining <= 0) {
      clearInterval(timerInterval);
      countdownText.innerText = "00:00:00";
      Swal.fire({
        title: 'Waktu Ujian Habis!',
        text: 'Waktu pengerjaan Anda telah selesai. Jawaban Anda akan dikirimkan otomatis oleh sistem.',
        icon: 'warning',
        allowOutsideClick: false,
        showConfirmButton: true,
        confirmButtonText: 'Kirim Jawaban'
      }).then(() => {
        submitUjianFinal();
      });
      return;
    }

    const totalSecs = Math.floor(msRemaining / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;

    const hStr = hours.toString().padStart(2, '0');
    const mStr = mins.toString().padStart(2, '0');
    const sStr = secs.toString().padStart(2, '0');

    countdownText.innerText = `${hStr}:${mStr}:${sStr}`;

    if (totalSecs < 300) {
      timerBox.classList.replace('timer-normal', 'timer-hud');
    } else {
      timerBox.classList.replace('timer-hud', 'timer-normal');
    }
  }, 1000);
}

// -------------------------------------------------------------
// EXAM LAYOUT & NAVIGATION RENDERERS
// -------------------------------------------------------------

function renderQuestion() {
  if (allQuestions.length === 0) return;

  const s = allQuestions[currentIndex];
  document.getElementById('exam-soal-index').innerText = `Soal ${currentIndex + 1} dari ${totalSoalCount}`;
  document.getElementById('exam-pertanyaan').innerText = `${s.nomor || (currentIndex + 1)}. ${s.pertanyaan}`;

  const imgEl = document.getElementById('exam-gambar');
  if (s.gambar) {
    imgEl.src = s.gambar;
    imgEl.classList.remove('d-none');
  } else {
    imgEl.src = "";
    imgEl.classList.add('d-none');
  }

  const isFlagged = savedAnswers[s.id] ? savedAnswers[s.id].ragu_ragu : false;
  document.getElementById('check-ragu').checked = isFlagged;

  const container = document.getElementById('exam-options-container');
  container.innerHTML = '';

  const activeAns = savedAnswers[s.id] ? savedAnswers[s.id].jawaban : null;
  const isBs = !s.opsi_c && !s.opsi_d;
  const optionList = [
    { key: 'A', label: s.opsi_a },
    { key: 'B', label: s.opsi_b }
  ];

  if (!isBs) {
    if (s.opsi_c) optionList.push({ key: 'C', label: s.opsi_c });
    if (s.opsi_d) optionList.push({ key: 'D', label: s.opsi_d });
    if (s.opsi_e) optionList.push({ key: 'E', label: s.opsi_e });
  }

  optionList.forEach(opt => {
    const isSelected = activeAns === opt.key;
    const selectedClass = isSelected ? 'selected' : '';

    container.innerHTML += `
      <div class="option-item ${selectedClass}" onclick="selectOption('${opt.key}')">
        <span class="option-badge">${opt.key}</span>
        <span>${opt.label}</span>
      </div>
    `;
  });

  document.getElementById('btn-prev-soal').disabled = currentIndex === 0;
  
  if (currentIndex === totalSoalCount - 1) {
    document.getElementById('btn-next-soal').classList.add('d-none');
    document.getElementById('btn-submit-ujian').classList.remove('d-none');
  } else {
    document.getElementById('btn-next-soal').classList.remove('d-none');
    document.getElementById('btn-submit-ujian').classList.add('d-none');
  }
}

function renderQuestionNavGrid() {
  const grid = document.getElementById('exam-nav-grid');
  grid.innerHTML = '';

  allQuestions.forEach((s, idx) => {
    const ans = savedAnswers[s.id];
    let stateClass = "";

    if (idx === currentIndex) {
      stateClass = "active";
    } else if (ans && ans.ragu_ragu) {
      stateClass = "flagged";
    } else if (ans && ans.jawaban) {
      stateClass = "answered";
    }

    grid.innerHTML += `
      <button class="question-nav-btn ${stateClass}" onclick="selectQuestion(${idx})">
        ${s.nomor || (idx + 1)}
      </button>
    `;
  });
}

function selectQuestion(idx) {
  currentIndex = idx;
  renderQuestion();
  renderQuestionNavGrid();
}

function prevSoal() {
  if (currentIndex > 0) selectQuestion(currentIndex - 1);
}

function nextSoal() {
  if (currentIndex < totalSoalCount - 1) selectQuestion(currentIndex + 1);
}

// -------------------------------------------------------------
// LOCAL-FIRST ANSWERING & BACKGROUND BATCH SYNC
// -------------------------------------------------------------

function selectOption(optKey) {
  if (allQuestions.length === 0) return;

  const s = allQuestions[currentIndex];
  const ragu = document.getElementById('check-ragu').checked;

  if (!savedAnswers[s.id]) {
    savedAnswers[s.id] = {};
  }
  
  savedAnswers[s.id].jawaban = optKey;
  savedAnswers[s.id].ragu_ragu = ragu;
  savedAnswers[s.id].answered_at = Date.now();

  // 1. Simpan seketika di localStorage (0ms, nol beban server, anti-hilang)
  saveAnswersToLocalStorage();

  // 2. Render perubahan visual langsung
  renderQuestion();
  renderQuestionNavGrid();

  // 3. Tandai ada jawaban baru & jadwalkan background sync
  markAnswerUpdated();
}

function toggleRaguRagu(checkbox) {
  if (allQuestions.length === 0) return;

  const s = allQuestions[currentIndex];
  
  if (!savedAnswers[s.id]) {
    savedAnswers[s.id] = { jawaban: null };
  }

  savedAnswers[s.id].ragu_ragu = checkbox.checked;
  if (!savedAnswers[s.id].answered_at) {
    savedAnswers[s.id].answered_at = Date.now();
  }

  saveAnswersToLocalStorage();
  renderQuestionNavGrid();
  markAnswerUpdated();
}

function markAnswerUpdated() {
  hasPendingSync = true;
  const syncIcon = document.getElementById('sync-icon');
  const syncText = document.getElementById('sync-text');
  if (syncIcon && syncText) {
    syncIcon.className = "bi bi-check2-circle text-success";
    syncText.innerText = "Tersimpan di perangkat";
  }

  // Debounce sync: jika siswa jeda klik selama 4 detik, kirim batch ke server
  if (debouncedSyncTimer) clearTimeout(debouncedSyncTimer);
  debouncedSyncTimer = setTimeout(() => {
    if (isExamActive && hasPendingSync && !isSyncingInProgress) {
      syncAnswersBatchToServer();
    }
  }, 4000);
}

function startBatchSyncTimer() {
  if (batchSyncInterval) clearInterval(batchSyncInterval);
  batchSyncInterval = setInterval(() => {
    if (isExamActive && hasPendingSync && !isSyncingInProgress) {
      syncAnswersBatchToServer();
    }
  }, 25000); // Sinkronisasi otomatis setiap 25 detik
}

async function syncAnswersBatchToServer(isFinal = false) {
  if (!studentProfile || (!isExamActive && !isFinal)) return;
  if (isSyncingInProgress) return;

  const answerKeys = Object.keys(savedAnswers);
  if (answerKeys.length === 0) {
    hasPendingSync = false;
    return;
  }

  const syncIcon = document.getElementById('sync-icon');
  const syncText = document.getElementById('sync-text');

  // Jika koneksi internet siswa offline, data tetap aman di lokal
  if (!navigator.onLine) {
    if (syncIcon && syncText) {
      syncIcon.className = "bi bi-wifi-off text-warning";
      syncText.innerText = "Offline (Tersimpan aman di perangkat)";
    }
    return;
  }

  isSyncingInProgress = true;
  if (syncIcon && syncText) {
    syncIcon.className = "spinner-border spinner-border-sm text-primary";
    syncText.innerText = "Menyinkron ke server...";
  }

  try {
    const payload = answerKeys.map(sId => {
      const item = savedAnswers[sId];
      const s = allQuestions.find(q => q.id === sId);
      const isCorrect = s ? s.jawaban_benar === item.jawaban : false;
      return {
        soal_id: sId,
        jawaban: item.jawaban,
        ragu_ragu: Boolean(item.ragu_ragu),
        benar: isCorrect
      };
    });

    await DB.syncJawabanBatch(studentProfile.id, payload);
    hasPendingSync = false;

    if (syncIcon && syncText) {
      syncIcon.className = "bi bi-cloud-check-fill text-primary";
      syncText.innerText = "Tersinkron ke server";
    }
  } catch (err) {
    console.warn("Gagal batch sync jawaban (akan dicoba lagi nanti):", err);
    if (syncIcon && syncText) {
      syncIcon.className = "bi bi-exclamation-circle text-warning";
      syncText.innerText = "Tersimpan lokal (Akan disinkronkan)";
    }
  } finally {
    isSyncingInProgress = false;
  }
}

// -------------------------------------------------------------
// EXAM FINAL SUBMISSIONS
// -------------------------------------------------------------

function confirmSelesaiUjian() {
  let unanswered = 0;
  allQuestions.forEach(s => {
    if (!savedAnswers[s.id] || !savedAnswers[s.id].jawaban) {
      unanswered++;
    }
  });

  let modalText = "Apakah Anda yakin ingin menyelesaikan ujian seleksi masuk ini?";
  if (unanswered > 0) {
    modalText = `PERHATIAN: Masih terdapat ${unanswered} soal yang belum Anda isi jawabannya! Apakah Anda yakin ingin menyelesaikan ujian sekarang?`;
  }

  Swal.fire({
    title: 'Selesaikan Ujian?',
    text: modalText,
    icon: unanswered > 0 ? 'warning' : 'question',
    showCancelButton: true,
    confirmButtonColor: '#198754',
    cancelButtonColor: '#6c757d',
    confirmButtonText: 'Ya, Selesai!',
    cancelButtonText: 'Periksa Lagi'
  }).then((res1) => {
    if (!res1.isConfirmed) return;

    Swal.fire({
      title: 'Konfirmasi Terakhir',
      text: 'Jawaban yang sudah dikirim tidak dapat diubah kembali. Kirim sekarang?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#198754',
      cancelButtonColor: '#6c757d',
      confirmButtonText: 'Kirim Jawaban Akhir',
      cancelButtonText: 'Batal'
    }).then((res2) => {
      if (res2.isConfirmed) {
        submitUjianFinal();
      }
    });
  });
}

async function submitUjianFinal() {
  if (timerInterval) clearInterval(timerInterval);
  if (batchSyncInterval) clearInterval(batchSyncInterval);
  if (debouncedSyncTimer) clearTimeout(debouncedSyncTimer);
  
  // Nonaktifkan mode ujian & layar penuh
  isExamActive = false;
  if (fullscreenWarningInterval) {
    clearInterval(fullscreenWarningInterval);
    fullscreenWarningInterval = null;
  }
  isFullscreenWarningActive = false;
  exitFullscreen();
  document.body.classList.remove('exam-active');

  document.getElementById('loading-overlay').classList.remove('d-none');
  document.querySelector('#loading-overlay h5').innerText = "Menyimpan & Mengkalkulasi Hasil Ujian...";

  try {
    // 1. Force final batch sync jawaban ke server sebelum submit
    await syncAnswersBatchToServer(true);

    let correctCount = 0;
    let wrongCount = 0;

    allQuestions.forEach(s => {
      const userAns = savedAnswers[s.id];
      if (userAns && userAns.jawaban === s.jawaban_benar) {
        correctCount++;
      } else {
        wrongCount++;
      }
    });

    const finalScore = parseFloat(((correctCount / totalSoalCount) * 100).toFixed(2));
    const passStatus = 'Selesai';

    const duration = parseInt(document.getElementById('dash-duration').innerText);
    const startStr = new Date(examTimerEndTimestamp - (duration * 60 * 1000)).toISOString();
    const endStr = new Date().toISOString();

    const currentPaketId = currentActivePaket ? currentActivePaket.id : null;
    await DB.insertHasil(studentProfile.id, correctCount, wrongCount, finalScore, passStatus, startStr, endStr, currentPaketId);
    await DB.updateStatusUjian(studentProfile.id, 'Sudah Ujian');

    localStorage.removeItem(`CBT_TIMER_END_${studentProfile.id}`);
    localStorage.removeItem(`CBT_IN_PROGRESS_PAKET_${studentProfile.id}`);
    const localKey = getLocalAnswerStorageKey();
    if (localKey) localStorage.removeItem(localKey);

    document.getElementById('loading-overlay').classList.add('d-none');

    const mapelName = currentActivePaket && currentActivePaket.nama_paket ? currentActivePaket.nama_paket : 'Ujian';

    Swal.fire({
      icon: 'success',
      title: 'Ujian Selesai!',
      html: `
        <div class="py-2 text-center">
          <p class="fs-5 mb-2">Selamat, Anda telah menyelesaikan ujian <strong>${escapeHtml(mapelName)}</strong>.</p>
          <p class="text-muted small mb-0">Seluruh jawaban Anda telah berhasil tersimpan di sistem. Terima kasih telah mengikuti ujian dengan tertib dan jujur.</p>
        </div>
      `,
      confirmButtonText: '<i class="bi bi-box-arrow-left me-2"></i>Kembali ke Login',
      confirmButtonColor: '#0d6efd',
      allowOutsideClick: false,
      allowEscapeKey: false
    }).then(() => {
      Auth.logout();
    });

  } catch (err) {
    document.getElementById('loading-overlay').classList.add('d-none');
    Swal.fire('Koreksi Gagal', err.message || 'Terjadi kesalahan sistem saat mengirim jawaban.', 'error');
  }
}

// Bind methods
window.mulaiUjianCBT = mulaiUjianCBT;
window.cetakKartuPesertaPDF = cetakKartuPesertaPDF;
window.selectQuestion = selectQuestion;
window.prevSoal = prevSoal;
window.nextSoal = nextSoal;
window.selectOption = selectOption;
window.toggleRaguRagu = toggleRaguRagu;
window.confirmSelesaiUjian = confirmSelesaiUjian;
window.selectStudentAgama = selectStudentAgama;
window.switchActivePaketManually = switchActivePaketManually;

// -------------------------------------------------------------
// ANTI-CHEAT MECHANICS & FULLSCREEN DETECTION (3X PELANGGARAN -> TOKEN PEMBEBAS)
// -------------------------------------------------------------
const MAX_PELANGGARAN = 3;
let isExamActive = false;
let violationCount = 0;
let fullscreenWarningInterval = null;
let isFullscreenWarningActive = false;
let isTokenPembebasModalOpen = false;

// Pelindung Anti-Intip & Deteksi Kehilangan Fokus (Sidebar / Floating App / Split-Screen)
let lastViolationTimestamp = 0;
let blurGraceTimer = null;
let securityWatchdogInterval = null;

// Helper: Deteksi apakah browser sedang berada dalam mode Layar Belah (Split Screen) atau Jendela Mengambang (Floating Window)
function isSplitScreenOrMultiWindow() {
  if (!window.screen) return false;

  const ua = navigator.userAgent || '';
  const isIPhone = /iPhone|iPod/i.test(ua);
  // iPhone TIDAK MEMILIKI fitur Split-Screen bawaan Apple iOS (fitur Split View hanya ada di iPadOS).
  // Bilah URL Safari di bagian bawah iPhone membuat hRatio sekitar 0.76 - 0.79 secara alami,
  // sehingga deteksi rasio split-screen tidak berlaku untuk iPhone (keamanan iPhone ditangani penuh via blur, visibility, & Guided Access).
  if (isIPhone) {
    return false;
  }

  const sW = window.screen.width || 0;
  const sH = window.screen.height || 0;
  if (!sW || !sH) return false;

  const wW = window.innerWidth || document.documentElement.clientWidth || 0;
  const wH = window.innerHeight || document.documentElement.clientHeight || 0;

  // 1. Orientasi Layar Portrait (Berdiri)
  if (sH >= sW) {
    const hRatio = wH / sH;
    const wRatio = wW / sW;
    // Pada Android / iPad / PC: jika tinggi < 75% atau lebar < 80%, pasti layar belah atau floating window!
    if (hRatio < 0.75 || wRatio < 0.80) {
      return true;
    }
  } else {
    // 2. Orientasi Layar Landscape (Mendatar)
    const wRatio = wW / sW;
    const hRatio = wH / sH;
    if (wRatio < 0.75 || hRatio < 0.75) {
      return true;
    }
  }

  return false;
}

function showSecurityBlackout(customReason = '', isSplitMode = false) {
  const shield = document.getElementById('security-blackout-shield');
  const isSplit = isSplitMode || isSplitScreenOrMultiWindow();

  if (shield) {
    shield.classList.remove('d-none');
    const badge = document.getElementById('security-blackout-badge');
    const title = document.getElementById('security-blackout-title');
    const desc = document.getElementById('security-blackout-desc');
    const splitAlert = document.getElementById('security-splitscreen-instruction');

    if (isSplit) {
      if (title) title.innerText = 'Layar Belah (Split Screen) Terdeteksi!';
      if (badge) badge.innerHTML = `<i class="bi bi-layout-split me-1"></i> Mode Layar Belah Dilarang!`;
      if (desc) desc.innerText = 'Portal ujian mendeteksi layar ponsel Anda sedang dibagi dengan aplikasi lain (seperti Gemini, Google, atau Catatan).';
      if (splitAlert) splitAlert.classList.remove('d-none');
    } else {
      if (title) title.innerText = 'Layar Ujian Disamarkan!';
      if (badge && customReason) {
        badge.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-1"></i> ${escapeHtml(customReason)}`;
      }
      if (splitAlert) splitAlert.classList.add('d-none');
    }
  }
  const viewExam = document.getElementById('view-exam');
  if (viewExam) {
    viewExam.style.filter = 'blur(30px) grayscale(100%)';
    viewExam.style.pointerEvents = 'none';
  }
}

function hideSecurityBlackout() {
  const shield = document.getElementById('security-blackout-shield');
  if (shield) shield.classList.add('d-none');
  const viewExam = document.getElementById('view-exam');
  if (viewExam) {
    viewExam.style.filter = '';
    viewExam.style.pointerEvents = '';
  }
}

function verifyAndDismissSecurityBlackout() {
  if (!isExamActive) {
    hideSecurityBlackout();
    return;
  }

  // Cek apakah masih dalam mode split screen / multi-window
  if (isSplitScreenOrMultiWindow()) {
    showSecurityBlackout('Layar Belah Masih Aktif! Tutup aplikasi lain terlebih dahulu.', true);
    handleViolationRecorded('Mencoba melanjutkan ujian dalam mode Layar Belah (Split Screen). Tutup aplikasi lain terlebih dahulu!');
    return;
  }

  // Jika sudah satu layar penuh, buka penyamar dan masuk fullscreen
  hideSecurityBlackout();
  requestFullscreen();
  window.focus();

  // Verifikasi ulang setelah 400ms
  setTimeout(() => {
    if (!isExamActive || isTokenPembebasModalOpen) return;
    if (isSplitScreenOrMultiWindow()) {
      showSecurityBlackout('Layar Belah Masih Terdeteksi!', true);
    }
  }, 400);
}

function dismissSecurityBlackout() {
  verifyAndDismissSecurityBlackout();
}

function handleWindowBlurDetected() {
  if (!isExamActive || isTokenPembebasModalOpen) return;

  // 1. Langsung samarkan tampilan soal seketika (Anti-Intip 0 detik)
  //    Menutup celah: Gemini Assistant overlay yang dipanggil lewat tahan tombol Power / tombol Home tengah
  showSecurityBlackout('Terdeteksi Asisten AI / Jendela Mengambang / Aplikasi Lain');

  // 2. Berikan toleransi singkat (1.0 detik) untuk memastikan ini bukan sentuhan tepi kilat
  if (blurGraceTimer) clearTimeout(blurGraceTimer);
  blurGraceTimer = setTimeout(() => {
    blurGraceTimer = null;
    if (!isExamActive || isTokenPembebasModalOpen) return;

    // Cek apakah fokus jendela memang terputus (Gemini/sidebar/floating window sedang aktif)
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    if (!hasFocus || document.visibilityState === 'hidden' || isSplitScreenOrMultiWindow()) {
      handleViolationRecorded('Terdeteksi aplikasi lain atau Asisten AI (Gemini / Google / Floating Window) aktif di atas lembar ujian.');
    }
  }, 1000);
}

function handleWindowFocusGained() {
  if (!isExamActive) return;
  // Jika fokus kembali sebelum jeda 1.0 detik berakhir, batalkan pencatatan pelanggaran
  if (blurGraceTimer) {
    clearTimeout(blurGraceTimer);
    blurGraceTimer = null;
  }
  // PENTING: Jangan buka penyamar jika layar ponsel masih dalam kondisi split-screen!
  if (isSplitScreenOrMultiWindow()) {
    showSecurityBlackout('Mode Layar Belah Masih Aktif!', true);
    return;
  }
  // Jika tidak ada modal peringatan Swal yang sedang terbuka, normalkan kembali tampilan
  if (!Swal.isVisible() && !isTokenPembebasModalOpen && !isFullscreenWarningActive) {
    hideSecurityBlackout();
  }
}

function handleViewportResizeSecurity() {
  if (!isExamActive || isTokenPembebasModalOpen) return;
  // Deteksi mode Layar Belah (Split Screen) di ponsel Android
  if (isSplitScreenOrMultiWindow()) {
    showSecurityBlackout('Terdeteksi Mode Layar Belah (Split Screen)', true);
    handleViolationRecorded('Terdeteksi mode Layar Belah (Split Screen). Ujian wajib dikerjakan dalam satu layar penuh.');
  }
}

/**
 * Hukuman Pelanggaran: Reset 3 butir jawaban terakhir yang telah dikerjakan peserta.
 * Dieksekusi otomatis ketika Token Pembebas dari Pengawas berhasil dimasukkan setelah ujian terkunci.
 * @param {number} count Jumlah butir jawaban yang direset (default: 3)
 * @returns {Promise<Array<{nomor: number, soalId: string}>>} Daftar soal yang direset
 */
async function resetPunishmentAnswers(count = 3) {
  if (!allQuestions || allQuestions.length === 0 || !savedAnswers) {
    return [];
  }

  // 1. Kumpulkan seluruh butir soal yang SUDAH dijawab (jawaban tidak null/kosong)
  const answeredList = [];
  allQuestions.forEach((q, idx) => {
    const ans = savedAnswers[q.id];
    if (ans && ans.jawaban !== null && ans.jawaban !== undefined && ans.jawaban !== '') {
      answeredList.push({
        soalId: q.id,
        nomor: idx + 1,
        answeredAt: ans.answered_at || ((idx + 1) * 1000)
      });
    }
  });

  if (answeredList.length === 0) {
    return [];
  }

  // 2. Urutkan dari yang paling baru dikerjakan (timestamp tertinggi)
  answeredList.sort((a, b) => b.answeredAt - a.answeredAt);

  // 3. Ambil maksimal 'count' soal (default 3 butir)
  const toReset = answeredList.slice(0, count);
  const resetIds = toReset.map(item => item.soalId);

  // 4. Hapus dari savedAnswers di memori
  resetIds.forEach(id => {
    delete savedAnswers[id];
  });

  // 5. Simpan ulang ke localStorage seketika
  saveAnswersToLocalStorage();

  // 6. Hapus dari database server (MySQL / Supabase / Mock)
  if (studentProfile && studentProfile.id) {
    try {
      if (typeof DB.deleteJawabanSoalIds === 'function') {
        await DB.deleteJawabanSoalIds(studentProfile.id, resetIds);
      }
    } catch (err) {
      console.warn("Gagal menghapus jawaban hukuman di server:", err);
    }
  }

  // 7. Render ulang navigasi grid soal
  renderQuestionNavGrid();

  // 8. Jika soal yang saat ini sedang aktif di layar termasuk yang direset, render ulang tampilan soal
  const currentSoal = allQuestions[currentIndex];
  if (currentSoal && resetIds.includes(currentSoal.id)) {
    renderQuestion();
  }

  return toReset;
}

function showTokenPembebasModal(onUnlockedCallback) {
  if (isTokenPembebasModalOpen) return;
  isTokenPembebasModalOpen = true;
  if (fullscreenWarningInterval) {
    clearInterval(fullscreenWarningInterval);
    fullscreenWarningInterval = null;
  }
  isFullscreenWarningActive = false;

  Swal.fire({
    icon: 'error',
    title: `Ujian Terkunci! (${violationCount || MAX_PELANGGARAN}x Pelanggaran)`,
    html: `
      <div class="text-center">
        <p class="mb-2">Anda telah melakukan <strong>${violationCount || MAX_PELANGGARAN} kali pelanggaran</strong> keamanan ujian (kelipatan ${MAX_PELANGGARAN}x pelanggaran).</p>
        <div class="alert alert-danger py-2 px-3 small fw-semibold mb-3">
          <i class="bi bi-shield-lock-fill me-1"></i> Untuk dapat melanjutkan pengerjaan ujian, silakan panggil <strong>Pengawas Ujian</strong> dan masukkan <strong>Token Pembebas</strong> di bawah ini.
        </div>
      </div>
    `,
    input: 'text',
    inputPlaceholder: 'Masukkan Token Pembebas...',
    inputAttributes: {
      autocapitalize: 'characters',
      autocomplete: 'off',
      style: 'text-align: center; font-weight: bold; font-size: 1.2rem; letter-spacing: 3px; text-transform: uppercase;'
    },
    showCancelButton: true,
    confirmButtonText: '<i class="bi bi-unlock-fill me-1"></i> Buka Kunci & Lanjutkan',
    confirmButtonColor: '#198754',
    cancelButtonText: '<i class="bi bi-box-arrow-left me-1"></i> Keluar (Logout)',
    cancelButtonColor: '#6c757d',
    allowOutsideClick: false,
    allowEscapeKey: false,
    showLoaderOnConfirm: true,
    preConfirm: async (tokenVal) => {
      if (!tokenVal || !tokenVal.trim()) {
        Swal.showValidationMessage('Token Pembebas wajib diisi!');
        return false;
      }
      try {
        await DB.unlockPesertaByToken(studentProfile.id, tokenVal);
        return true;
      } catch (err) {
        Swal.showValidationMessage(err.message || 'Token Pembebas salah atau tidak valid!');
        return false;
      }
    }
  }).then(async (result) => {
    isTokenPembebasModalOpen = false;
    if (result.isConfirmed) {
      if (studentProfile) {
        studentProfile.is_locked = false;
      }

      // Eksekusi hukuman: Reset 3 butir jawaban terakhir yang telah dijawab siswa
      const resetItems = await resetPunishmentAnswers(3);
      const resetNomors = resetItems.map(item => item.nomor).sort((a, b) => a - b);

      let punishmentHtml = '';
      if (resetNomors.length > 0) {
        punishmentHtml = `
          <div class="alert alert-danger text-start mt-3 mb-0 p-3 border-danger shadow-sm rounded-3">
            <div class="d-flex align-items-center mb-1">
              <i class="bi bi-exclamation-octagon-fill text-danger me-2 fs-5"></i>
              <strong class="text-danger">Sanksi Pengurangan Jawaban:</strong>
            </div>
            <p class="small mb-2">Sebagai hukuman atas akumulasi <strong>${violationCount}x pelanggaran keamanan</strong>, sistem telah <strong>mereset ${resetNomors.length} butir jawaban terakhir Anda</strong>:</p>
            <div class="badge bg-danger text-wrap text-start fs-6 py-2 px-3 w-100 mb-2">
              <i class="bi bi-arrow-counterclockwise me-1"></i> Jawaban Direset: <strong>Soal Nomor ${resetNomors.join(', ')}</strong>
            </div>
            <p class="small text-muted mb-0"><i class="bi bi-info-circle me-1"></i>Jawaban pada butir nomor tersebut telah dikosongkan. Silakan periksa kembali dan kerjakan dengan tertib!</p>
          </div>
        `;
      } else {
        punishmentHtml = `
          <div class="alert alert-warning text-start mt-3 mb-0 p-2">
            <small><i class="bi bi-info-circle me-1"></i>Catatan: Anda belum mengisi jawaban soal, sehingga tidak ada butir jawaban yang direset sebagai hukuman.</small>
          </div>
        `;
      }

      Swal.fire({
        icon: 'warning',
        title: 'Kunci Ujian Berhasil Dibuka!',
        html: `
          <div class="text-center">
            <p class="mb-1 text-success fw-bold"><i class="bi bi-check-circle-fill me-1"></i> Token Pembebas Valid!</p>
            <p class="text-muted small mb-0">Ujian telah dibuka kembali oleh Pengawas. (Total pelanggaran tercatat: <strong>${violationCount}x</strong>)</p>
            ${punishmentHtml}
          </div>
        `,
        confirmButtonText: '<i class="bi bi-pencil-square me-2"></i> Mengerti & Lanjutkan Ujian',
        confirmButtonColor: '#0d6efd',
        allowOutsideClick: false,
        allowEscapeKey: false
      }).then(() => {
        if (typeof onUnlockedCallback === 'function') {
          onUnlockedCallback();
        } else if (isExamActive) {
          requestFullscreen();
        }
      });
    } else if (result.dismiss === Swal.DismissReason.cancel) {
      Auth.logout();
    }
  });
}

function handleViolationRecorded(reasonText) {
  if (isTokenPembebasModalOpen) return;

  // Cegah duplikasi pencatatan pelanggaran beruntun dalam jeda 2.5 detik
  const now = Date.now();
  if (now - lastViolationTimestamp < 2500) {
    return;
  }
  lastViolationTimestamp = now;

  // Pastikan penyamar layar aktif selama dialog peringatan berlangsung
  showSecurityBlackout(reasonText, isSplitScreenOrMultiWindow());

  violationCount++;
  if (studentProfile) {
    studentProfile.pelanggaran = violationCount;
    if (studentProfile.id) {
      DB.incrementPelanggaran(studentProfile.id).catch(e => console.error("Gagal catat pelanggaran:", e));
    }
  }

  if (violationCount > 0 && violationCount % MAX_PELANGGARAN === 0) {
    if (studentProfile) studentProfile.is_locked = true;
    showTokenPembebasModal(() => {
      if (isSplitScreenOrMultiWindow()) {
        showSecurityBlackout('Tutup layar belah untuk melanjutkan ujian.', true);
      } else {
        hideSecurityBlackout();
        requestFullscreen();
        window.focus();
      }
    });
    return;
  }

  const sisa = MAX_PELANGGARAN - (violationCount % MAX_PELANGGARAN);
  const nextLockAt = violationCount + sisa;
  Swal.fire({
    icon: 'warning',
    title: `Pelanggaran Ke-${violationCount} Tercatat!`,
    html: `
      <p class="fw-semibold text-danger mb-2">${escapeHtml(reasonText)}</p>
      <div class="alert alert-warning mb-2 py-2 fw-semibold">
        <i class="bi bi-exclamation-triangle-fill me-1"></i> Total Pelanggaran: <strong>${violationCount} kali</strong> (Sisa toleransi sebelum terkunci: ${sisa}x lagi)
      </div>
      <p class="small text-danger fw-semibold mb-1">Peringatan: Pada pelanggaran ke-${nextLockAt} (kelipatan 3), ujian akan otomatis terkunci dan wajib meminta Token Pembebas dari Pengawas!</p>
      <p class="small text-muted mb-0">Klik tombol di bawah untuk melanjutkan ujian dalam mode layar penuh.</p>
    `,
    confirmButtonText: '<i class="bi bi-arrows-fullscreen me-2"></i>Kembali & Lanjutkan Ujian',
    confirmButtonColor: '#0d6efd',
    allowOutsideClick: false,
    allowEscapeKey: false
  }).then(() => {
    isFullscreenWarningActive = false;
    // PENTING: Jika siswa masih dalam mode split-screen, jangan buka penyamar! Tetapkan penyamar terkunci!
    if (isSplitScreenOrMultiWindow()) {
      showSecurityBlackout('Tutup Layar Belah Terlebih Dahulu!', true);
    } else {
      hideSecurityBlackout();
      requestFullscreen();
      window.focus();
    }
  });
}

function isFullscreenSupported() {
  const elem = document.documentElement;
  return Boolean(
    elem.requestFullscreen ||
    elem.webkitRequestFullscreen ||
    elem.mozRequestFullScreen ||
    elem.msRequestFullscreen
  );
}

function checkIsFullscreen() {
  return Boolean(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

function requestFullscreen() {
  const elem = document.documentElement;
  try {
    if (elem.requestFullscreen) {
      return elem.requestFullscreen().catch(() => {});
    } else if (elem.webkitRequestFullscreen) {
      return elem.webkitRequestFullscreen();
    } else if (elem.mozRequestFullScreen) {
      return elem.mozRequestFullScreen();
    } else if (elem.msRequestFullscreen) {
      return elem.msRequestFullscreen();
    }
  } catch (err) {
    console.warn("Fullscreen request error:", err);
  }
}

function exitFullscreen() {
  if (!checkIsFullscreen()) return;
  try {
    if (document.exitFullscreen) {
      return document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      return document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      return document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      return document.msExitFullscreen();
    }
  } catch (err) {
    console.warn("Fullscreen exit error:", err);
  }
}

function handleFullscreenChange() {
  if (!isExamActive || !isFullscreenSupported() || isTokenPembebasModalOpen) return;

  const isFs = checkIsFullscreen();

  // Jika siswa kembali ke layar penuh saat peringatan aktif, batalkan countdown dan tutup alert
  if (isFs) {
    if (isFullscreenWarningActive) {
      if (fullscreenWarningInterval) {
        clearInterval(fullscreenWarningInterval);
        fullscreenWarningInterval = null;
      }
      isFullscreenWarningActive = false;
      Swal.close();
      hideSecurityBlackout();
    }
    return;
  }

  // Jika keluar dari layar penuh saat ujian aktif dan belum ada peringatan berjalan
  if (!isFs && !isFullscreenWarningActive) {
    showSecurityBlackout('Keluar dari Mode Layar Penuh');
    triggerFullscreenExitCountdown();
  }
}

function triggerFullscreenExitCountdown() {
  if (isTokenPembebasModalOpen) return;
  isFullscreenWarningActive = true;
  let secondsLeft = 10;

  Swal.fire({
    icon: 'warning',
    title: 'Peringatan: Keluar Layar Penuh!',
    html: `
      <p class="mb-2">Anda terdeteksi keluar dari mode layar penuh (<em>Fullscreen</em>).</p>
      <div class="p-3 my-3 rounded bg-light border border-warning text-center">
        <div class="small text-muted mb-1">Batas waktu untuk kembali ke layar penuh:</div>
        <div class="display-6 fw-bold text-danger font-monospace" id="fs-countdown-display">10 detik</div>
      </div>
      <p class="small text-muted mb-0">Segera klik tombol di bawah sebelum waktu habis, atau aktivitas ini akan dicatat sebagai <strong>1 kali pelanggaran</strong> (Maksimal ${MAX_PELANGGARAN}x pelanggaran).</p>
    `,
    confirmButtonText: '<i class="bi bi-arrows-fullscreen me-2"></i>Kembali ke Layar Penuh',
    confirmButtonColor: '#0d6efd',
    allowOutsideClick: false,
    allowEscapeKey: false,
    didOpen: () => {
      const displayEl = document.getElementById('fs-countdown-display');
      if (fullscreenWarningInterval) clearInterval(fullscreenWarningInterval);

      fullscreenWarningInterval = setInterval(() => {
        secondsLeft--;
        if (displayEl) {
          displayEl.innerText = `${secondsLeft} detik`;
        }

        if (secondsLeft <= 0) {
          clearInterval(fullscreenWarningInterval);
          fullscreenWarningInterval = null;
          isFullscreenWarningActive = false;

          // Waktu 10 detik habis -> Catat pelanggaran (dan kunci jika sudah 3x)
          handleViolationRecorded('Anda tidak kembali ke mode layar penuh tepat waktu.');
        }
      }, 1000);
    }
  }).then((result) => {
    if (result.isConfirmed) {
      if (fullscreenWarningInterval) {
        clearInterval(fullscreenWarningInterval);
        fullscreenWarningInterval = null;
      }
      isFullscreenWarningActive = false;
      hideSecurityBlackout();
      requestFullscreen();
      window.focus();
    }
  });
}

function initAntiCheat() {
  // Cegah klik kanan
  document.addEventListener('contextmenu', e => {
    if (isExamActive) e.preventDefault();
  });
  
  // Cegah copy paste
  ['copy', 'cut', 'paste', 'selectstart'].forEach(evt => {
    document.addEventListener(evt, e => {
      if (isExamActive) e.preventDefault();
    });
  });

  // Cegah shortcut F12, Ctrl+Shift+I, Ctrl+U, PrintScreen, dll
  document.addEventListener('keydown', e => {
    if (isExamActive) {
      if (
        e.key === 'F12' || 
        e.key === 'PrintScreen' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) || 
        (e.ctrlKey && (e.key === 'U' || e.key === 'P' || e.key === 'S'))
      ) {
        e.preventDefault();
      }
    }
  });

  // Deteksi keluar layar penuh (Fullscreen Exit Detection)
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, handleFullscreenChange);
  });

  // Deteksi pindah tab atau aplikasi diminimize
  document.addEventListener('visibilitychange', () => {
    if (isExamActive && document.visibilityState === 'hidden' && !isTokenPembebasModalOpen) {
      // Jika countdown keluar fullscreen sedang berjalan, bersihkan agar tidak dobel penalti
      if (fullscreenWarningInterval) {
        clearInterval(fullscreenWarningInterval);
        fullscreenWarningInterval = null;
      }
      isFullscreenWarningActive = false;
      showSecurityBlackout('Berpindah Tab atau Aplikasi');
      handleViolationRecorded('Anda terdeteksi berpindah tab atau aplikasi. Aktivitas ini dicatat oleh sistem keamanan.');
    }
  });

  // 1. Deteksi kehilangan fokus jendela (Jendela Mengambang / Floating App, Sidebar Pintar, Notifikasi)
  window.addEventListener('blur', handleWindowBlurDetected);
  window.addEventListener('focus', handleWindowFocusGained);

  // 2. Deteksi perubahan viewport (Mode Split Screen / Layar Belah)
  window.addEventListener('resize', handleViewportResizeSecurity);

  // 3. Watchdog pengawas independen (cek berkala setiap 1000ms saat ujian aktif)
  if (securityWatchdogInterval) clearInterval(securityWatchdogInterval);
  securityWatchdogInterval = setInterval(() => {
    if (!isExamActive || isTokenPembebasModalOpen) return;

    // Prioritas Utama: Cek apakah berada dalam mode Layar Belah (Split Screen) atau Floating Window
    if (isSplitScreenOrMultiWindow()) {
      showSecurityBlackout('Terdeteksi Mode Layar Belah (Split Screen)', true);
      if (!Swal.isVisible() && !isFullscreenWarningActive) {
        handleViolationRecorded('Terdeteksi mode Layar Belah (Split Screen). Ujian wajib dikerjakan dalam satu layar penuh.');
      }
      return;
    }

    if (Swal.isVisible() || isFullscreenWarningActive) return;

    // Cek fokus dokumen (menutup celah: Gemini Assistant overlay yang dipanggil lewat tombol Power / Home)
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
      handleWindowBlurDetected();
      return;
    }

    // Cek status fullscreen
    if (isFullscreenSupported() && !checkIsFullscreen()) {
      handleFullscreenChange();
    }
  }, 1000);
}

// Inisialisasi listener keamanan
document.addEventListener("DOMContentLoaded", () => {
  initAntiCheat();
});

window.verifyAndDismissSecurityBlackout = verifyAndDismissSecurityBlackout;
window.dismissSecurityBlackout = verifyAndDismissSecurityBlackout;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
