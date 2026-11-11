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

// Helper: Mencocokkan paket soal aktif terbaik berdasarkan jadwal, jurusan, dan kelas siswa
function findActivePaketForStudent(allPaket, profile) {
  if (!allPaket || allPaket.length === 0 || !profile) return null;
  const now = new Date();
  const studentJurusan = (profile.jurusan || "").toLowerCase().trim();
  const studentKelas = (profile.kelas || "").toLowerCase().trim();

  let bestPaket = null;
  let bestScore = -1;

  for (const p of allPaket) {
    if (!p.jadwal_mulai) continue;
    const start = new Date(p.jadwal_mulai);
    const end = p.jadwal_selesai ? new Date(p.jadwal_selesai) : new Date('2099-12-31');

    if (now >= start && now <= end) {
      const pJurusan = (p.jurusan || "").toLowerCase().trim();
      const jurusanMatch = (pJurusan === "" || pJurusan === "semua" || pJurusan === studentJurusan);
      const kelasResult = checkKelasMatch(p.kelas, studentKelas);

      if (jurusanMatch && kelasResult.match) {
        // Prioritas kecocokan:
        // - Spesifik Jurusan: +4
        // - Rombel Persis: +3
        // - Tingkat Angkatan (X, XI, XII): +2
        // - Umum / Sekolah: 0
        let score = 0;
        if (pJurusan && pJurusan !== "semua" && pJurusan === studentJurusan) score += 4;
        score += kelasResult.specificity;

        if (score > bestScore) {
          bestScore = score;
          bestPaket = p;
        }
      }
    }
  }

  return bestPaket;
}

// Load config settings and verify if they can start the exam
async function loadExamSetupAndVerify() {
  try {
    // 0. Check if student is locked by Admin
    if (studentProfile.is_locked) {
      document.getElementById('dash-soal-count').innerText = "0";
      document.getElementById('dash-duration').innerText = "0";
      const dashPassing = document.getElementById('dash-passing');
      if (dashPassing) dashPassing.innerText = "-";
      
      const dashJadwal = document.getElementById('dash-jadwal');
      if (dashJadwal) {
        dashJadwal.innerText = "Akses Ujian Diblokir karena Indikasi Kecurangan";
        dashJadwal.classList.add('text-danger', 'fw-bold');
      }

      document.getElementById('btn-mulai-ujian').disabled = true;
      document.getElementById('btn-mulai-ujian').innerHTML = `<i class="bi bi-lock-fill"></i> Ujian Terkunci`;
      document.getElementById('btn-mulai-ujian').classList.replace('btn-primary-custom', 'btn-danger');
      document.getElementById('view-dashboard').classList.remove('d-none');
      return;
    }

    // 1. Find active Paket Soal based on current time, jurusan, and kelas
    const allPaket = await DB.getPaketList();
    const activePaket = findActivePaketForStudent(allPaket, studentProfile);
    currentActivePaket = activePaket;

    let questions = [];
    if (activePaket) {
      questions = await DB.getSoalByPaket(activePaket.id);
    }
    
    totalSoalCount = questions.length;
    document.getElementById('dash-soal-count').innerText = totalSoalCount;

    // 2. Get settings
    const settings = await DB.getSettings();

    if (settings) {
      document.getElementById('dash-duration').innerText = settings.durasi_menit;
      const dashPassing = document.getElementById('dash-passing');
      if (dashPassing) dashPassing.innerText = "-";
      if (settings.tampilkan_nilai !== undefined) {
        tampilkanNilaiVal = settings.tampilkan_nilai;
      }
    }
    
    // Display Schedule Info
    const dashJadwal = document.getElementById('dash-jadwal');
    if (!activePaket) {
      if (dashJadwal) dashJadwal.innerText = "Tidak Ada Ujian Aktif Saat Ini";
    } else {
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
    }

    // 3. Check if exam results already exist for this student & paket
    const existingHasil = await DB.checkExistingHasil(studentProfile.id, activePaket ? activePaket.id : null);

    if (existingHasil) {
      // Locking exam, show completed banner with Mapel info and logout button, NO SCORE
      const mapelName = activePaket && activePaket.nama_paket ? activePaket.nama_paket : 'mata pelajaran ini';
      const completedTextEl = document.getElementById('completed-alert-text');
      if (completedTextEl) {
        completedTextEl.innerHTML = `Selamat, Anda telah menyelesaikan ujian <strong>${escapeHtml(mapelName)}</strong>. Terima kasih telah mengikuti ujian dengan tertib.`;
      }

      document.getElementById('alert-already-done').classList.remove('d-none');
      document.getElementById('btn-mulai-ujian').disabled = true;
      document.getElementById('btn-mulai-ujian').innerHTML = `<i class="bi bi-check-circle me-1"></i> Ujian Sudah Selesai`;
      document.getElementById('btn-mulai-ujian').classList.replace('btn-primary-custom', 'btn-secondary');
      
      // Update local profile status if synced wrong
      if (studentProfile.status_ujian !== 'Sudah Ujian') {
        await DB.updateStatusUjian(studentProfile.id, 'Sudah Ujian');
        document.getElementById('dash-status').innerText = 'Sudah Ujian';
        document.getElementById('dash-status').className = 'badge bg-success';
      }
    } else {
      // Verify schedules window
      if (!activePaket) {
        document.getElementById('btn-mulai-ujian').disabled = true;
        document.getElementById('btn-mulai-ujian').innerHTML = `Ujian Belum Tersedia`;
        document.getElementById('btn-mulai-ujian').classList.replace('btn-primary-custom', 'btn-secondary');
      } else if (questions.length === 0) {
        document.getElementById('btn-mulai-ujian').disabled = true;
        document.getElementById('btn-mulai-ujian').innerHTML = `Paket Soal Kosong`;
        document.getElementById('btn-mulai-ujian').classList.replace('btn-primary-custom', 'btn-secondary');
      }

      // Check if student was in-progress and refreshed page
      if (studentProfile.status_ujian === 'Sedang Ujian' && activePaket && questions.length > 0) {
        document.getElementById('btn-mulai-ujian').innerHTML = `Lanjutkan Ujian <i class="bi bi-arrow-right-circle-fill ms-2"></i>`;
      }
    }

    document.getElementById('view-dashboard').classList.remove('d-none');

  } catch (err) {
    console.error("Gagal verifikasi pendaftaran:", err);
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
    if (inputToken.toUpperCase() !== settings.token_ujian.toUpperCase()) {
      Swal.fire('Akses Ditolak', 'Token yang Anda masukkan salah atau sudah kadaluarsa.', 'error');
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
    // 1. Find active Paket Soal
    const allPaket = await DB.getPaketList();
    const activePaket = findActivePaketForStudent(allPaket, studentProfile);

    if (!activePaket) {
      throw new Error("Tidak ada paket ujian yang sedang aktif untuk jurusan & kelas Anda saat ini.");
    }

    currentActivePaket = activePaket;

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
              ragu_ragu: Boolean(ans.ragu_ragu)
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

// -------------------------------------------------------------
// ANTI-CHEAT MECHANICS & FULLSCREEN DETECTION
// -------------------------------------------------------------
let isExamActive = false;
let violationCount = 0;
let fullscreenWarningInterval = null;
let isFullscreenWarningActive = false;

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
  if (!isExamActive || !isFullscreenSupported()) return;

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
    }
    return;
  }

  // Jika keluar dari layar penuh saat ujian aktif dan belum ada peringatan berjalan
  if (!isFs && !isFullscreenWarningActive) {
    triggerFullscreenExitCountdown();
  }
}

function triggerFullscreenExitCountdown() {
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
      <p class="small text-muted mb-0">Segera klik tombol di bawah sebelum waktu habis, atau aktivitas ini akan dicatat sebagai <strong>1 kali pelanggaran</strong>.</p>
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

          // Waktu 10 detik habis -> Catat pelanggaran ke database
          violationCount++;
          if (studentProfile && studentProfile.id) {
            DB.incrementPelanggaran(studentProfile.id).catch(e => console.error("Gagal catat pelanggaran:", e));
          }

          // Tampilkan notifikasi bahwa pelanggaran telah dicatat
          Swal.fire({
            icon: 'error',
            title: 'Waktu Habis! Pelanggaran Dicatat',
            html: `
              <p>Anda tidak kembali ke mode layar penuh tepat waktu.</p>
              <div class="alert alert-danger mb-3 py-2 fw-semibold">
                <i class="bi bi-exclamation-triangle-fill me-1"></i> Pelanggaran ke-${violationCount} telah dicatat oleh sistem keamanan.
              </div>
              <p class="small text-muted mb-0">Klik tombol di bawah untuk kembali ke layar penuh dan melanjutkan ujian.</p>
            `,
            confirmButtonText: '<i class="bi bi-arrows-fullscreen me-2"></i>Masuk Layar Penuh & Lanjutkan',
            confirmButtonColor: '#dc3545',
            allowOutsideClick: false,
            allowEscapeKey: false
          }).then(() => {
            isFullscreenWarningActive = false;
            requestFullscreen();
          });
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
      requestFullscreen();
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

  // Cegah shortcut F12, Ctrl+Shift+I, Ctrl+U, dll
  document.addEventListener('keydown', e => {
    if (isExamActive) {
      if (
        e.key === 'F12' || 
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

  // Deteksi pindah tab
  document.addEventListener('visibilitychange', () => {
    if (isExamActive && document.visibilityState === 'hidden') {
      // Jika countdown keluar fullscreen sedang berjalan, bersihkan agar tidak dobel penalti
      if (fullscreenWarningInterval) {
        clearInterval(fullscreenWarningInterval);
        fullscreenWarningInterval = null;
      }
      isFullscreenWarningActive = false;

      violationCount++;
      
      // Update DB
      if (studentProfile && studentProfile.id) {
        DB.incrementPelanggaran(studentProfile.id).catch(e => console.error("Gagal catat pelanggaran:", e));
      }

      Swal.fire({
        icon: 'warning',
        title: 'Pelanggaran Ujian!',
        html: `
          <p>Anda terdeteksi berpindah tab atau aplikasi. Aktivitas ini dicatat oleh sistem keamanan.</p>
          <div class="alert alert-warning mb-2 py-2 fw-semibold">
            <i class="bi bi-exclamation-triangle-fill me-1"></i> Total Pelanggaran: ${violationCount} kali
          </div>
          <p class="small text-muted mb-0">Klik tombol di bawah untuk melanjutkan ujian dalam mode layar penuh.</p>
        `,
        confirmButtonText: '<i class="bi bi-arrows-fullscreen me-2"></i>Kembali & Lanjutkan Ujian',
        confirmButtonColor: '#0d6efd',
        allowOutsideClick: false,
        allowEscapeKey: false
      }).then(() => {
        requestFullscreen();
      });
    }
  });
}

// Inisialisasi listener keamanan
document.addEventListener("DOMContentLoaded", () => {
  initAntiCheat();
});

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
