// Database & Auth Adapter Layer (Supabase / LocalStorage Fallback)

const DB = {
  // Check if we are in PHP + MySQL Mode (hosting biasa / phpMyAdmin)
  isPhp() {
    return !!(window.CBT_CONFIG && window.CBT_CONFIG.backend === 'php');
  },

  // Check if we are in Local/Demo Mode or Cloud/Supabase Mode
  isLocal() {
    return !this.isPhp() && !window.supabaseClient;
  },

  // Check if we are in Unified Multi-Shard Mode
  isUnifiedSupabaseMode() {
    return !!(window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode());
  },

  // Durasi rotasi otomatis Token Pembebas: 3 menit (180.000 ms)
  TOKEN_INTERVAL_MS: 3 * 60 * 1000,

  // Generator deterministik Token Pembebas per slot 3 menit
  generateTimeSlotToken(slotIndex) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let h = (slotIndex ^ 0x5bd1e995) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    let token = '';
    let seed = h;
    for (let i = 0; i < 6; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      token += chars[seed % chars.length];
    }
    return token;
  },

  // Ambil token aktif beserta sisa waktu menuju rotasi 3 menit berikutnya
  getActiveTokenState(settings) {
    const now = Date.now();
    const interval = this.TOKEN_INTERVAL_MS;
    if (settings && settings.token_ujian && settings.updated_at) {
      const updatedMs = new Date(settings.updated_at).getTime();
      const elapsed = now - updatedMs;
      if (!isNaN(updatedMs) && elapsed >= 0 && elapsed < interval) {
        return {
          token: String(settings.token_ujian).trim().toUpperCase(),
          remainingMs: interval - elapsed,
          slotIndex: Math.floor(now / interval),
          isCustomRecent: true
        };
      }
    }
    const currentSlot = Math.floor(now / interval);
    const slotEndMs = (currentSlot + 1) * interval;
    return {
      token: this.generateTimeSlotToken(currentSlot),
      remainingMs: slotEndMs - now,
      slotIndex: currentSlot,
      isCustomRecent: false
    };
  },

  // Validasi apakah input token sesuai dengan Token 3 Menit Aktif
  isValidExamToken(inputToken, settings) {
    const cleanInput = (inputToken || '').trim().toUpperCase();
    if (!cleanInput) return false;
    const now = Date.now();
    const interval = this.TOKEN_INTERVAL_MS;

    // 1. Jika ada token kustom (tombol Acak) di database yang diperbarui dalam <= 3 menit terakhir (+30d toleransi)
    if (settings && settings.token_ujian && settings.updated_at) {
      const updatedMs = new Date(settings.updated_at).getTime();
      const elapsed = now - updatedMs;
      if (!isNaN(updatedMs) && elapsed >= -30000 && elapsed <= interval + 30000) {
        if (cleanInput === String(settings.token_ujian).trim().toUpperCase()) {
          return true;
        }
      }
    }

    // 2. Cek token otomatis slot 3 menit berjalan
    const currentSlot = Math.floor(now / interval);
    if (cleanInput === this.generateTimeSlotToken(currentSlot)) {
      return true;
    }

    // 3. Toleransi 45 detik awal pergantian slot (jika pengawas baru membacakan token sesaat sebelum berganti)
    if ((now % interval) < 45000) {
      if (cleanInput === this.generateTimeSlotToken(currentSlot - 1)) {
        return true;
      }
    }

    // 4. Toleransi 15 detik selisih jam perangkat siswa yang sedikit lebih cepat
    if ((interval - (now % interval)) < 15000) {
      if (cleanInput === this.generateTimeSlotToken(currentSlot + 1)) {
        return true;
      }
    }

    return false;
  },

  // Auto-heal admin session jika sebuah shard belum memiliki sesi admin terautentikasi
  async ensureAdminAuth(client) {
    const target = client || window.supabaseClient;
    if (!target || !target.auth) return false;
    try {
      const { data } = await target.auth.getSession();
      const curEmail = String(data?.session?.user?.email || '').toLowerCase();
      if (!data || !data.session || !curEmail.includes('admin')) {
        let syncCreds = null;
        try { syncCreds = JSON.parse(sessionStorage.getItem('CBT_ADMIN_AUTH_SYNC') || 'null'); } catch (e) {}
        const email = (syncCreds && syncCreds.email) || 'admin@smkn1lempuing.sch.id';
        const pass = (syncCreds && syncCreds.password) || 'admin123';
        const res = await target.auth.signInWithPassword({ email, password: pass });
        return !(res && res.error);
      }
      return true;
    } catch (e) {
      console.warn("Auto-reauth failed:", e.message);
      return false;
    }
  },

  // Jalankan query Supabase dengan proteksi auto-retry jika terkena RLS 42501
  async executeWithAdminAuth(client, operationFn) {
    const target = client || window.supabaseClient;
    if (!target) return null;
    try {
      return await operationFn(target);
    } catch (err) {
      const msg = (err && (err.message || '')) + ' ' + (err && (err.details || ''));
      const isRls = (err && err.code === '42501') || msg.toLowerCase().includes('row-level security') || msg.toLowerCase().includes('violates');
      if (isRls && target.auth) {
        console.warn("[CBT] Terdeteksi blok RLS Supabase. Melakukan auto-reauth admin dan mencoba ulang...");
        await this.ensureAdminAuth(target);
        return await operationFn(target);
      }
      throw err;
    }
  },

  // Helper: call PHP REST API (mode "php")
  async api(action, params = {}) {
    const url = (window.CBT_CONFIG && window.CBT_CONFIG.apiUrl) || 'api/index.php';
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...params })
      });
    } catch (e) {
      throw new Error("Tidak dapat terhubung ke server. Periksa koneksi internet Anda.");
    }

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(`Respon server tidak valid (HTTP ${res.status}). Pastikan PHP aktif di hosting.`);
    }

    if (!res.ok || (json && json.error)) {
      const err = new Error((json && json.error) || `Terjadi kesalahan server (HTTP ${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return json ? json.data : null;
  },

  // Helper: Ambil client Supabase berdasarkan Shard ID (atau client aktif)
  getClientForShard(shardId) {
    if (shardId && window.getSupabaseShards) {
      const s = window.getSupabaseShards().find(x => String(x.id) === String(shardId));
      if (s && s.client) return s.client;
    }
    return window.supabaseClient;
  },

  // Helper: Generate Mock UUIDs
  uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  // Helper: SHA-256 for local checks
  async sha256(message) {
    if (!message) return "";
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  // Initialize Seeds for Local Database
  initLocalData() {
    if (!localStorage.getItem('CBT_LOCAL_PESERTA')) {
      const mockPeserta = [
        {
          id: "peserta-uuid-1",
          username: "U001",
          nama_lengkap: "Budi Santoso",
          jurusan: "TKJ",
          kelas: "X TKJ 1",
          ruang: "Ruang 1",
          sesi: "Sesi 1",
          password_hash: "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f", // "123456"
          status_ujian: "Belum Ujian",
          pelanggaran: 0,
          is_locked: false,
          created_at: new Date().toISOString()
        },
        {
          id: "peserta-uuid-2",
          username: "U002",
          nama_lengkap: "Siti Aminah",
          jurusan: "RPL",
          kelas: "X RPL 2",
          ruang: "Ruang 2",
          sesi: "Sesi 2",
          password_hash: "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f", // "123456"
          status_ujian: "Belum Ujian",
          pelanggaran: 0,
          is_locked: false,
          created_at: new Date().toISOString()
        },
        {
          id: "peserta-uuid-3",
          username: "U003",
          nama_lengkap: "Agus Setiawan",
          jurusan: "Multimedia",
          kelas: "XI MM 1",
          ruang: "Ruang 1",
          sesi: "Sesi 1",
          password_hash: "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f", // "123456"
          status_ujian: "Belum Ujian",
          pelanggaran: 0,
          is_locked: false,
          created_at: new Date().toISOString()
        }
      ];
      localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(mockPeserta));
    }

    if (!localStorage.getItem('CBT_LOCAL_PAKET')) {
      const mockPaket = [
        {
          id: "paket-uuid-1",
          nama_paket: "Paket Matematika - Sesi 1",
          jadwal_mulai: null,
          jadwal_selesai: null,
          created_at: new Date().toISOString()
        },
        {
          id: "paket-uuid-2",
          nama_paket: "Paket Bahasa Indonesia - Umum",
          jadwal_mulai: null,
          jadwal_selesai: null,
          created_at: new Date().toISOString()
        }
      ];
      localStorage.setItem('CBT_LOCAL_PAKET', JSON.stringify(mockPaket));
    }

    if (!localStorage.getItem('CBT_LOCAL_SOAL')) {
      const mockSoal = [
        {
          id: "soal-uuid-1",
          paket_soal_id: "paket-uuid-1",
          nomor: 1,
          pertanyaan: "Siapakah presiden pertama Republik Indonesia?",
          opsi_a: "Ir. Soekarno",
          opsi_b: "Drs. Mohammad Hatta",
          opsi_c: "Soeharto",
          opsi_d: "B.J. Habibie",
          jawaban_benar: "A",
          bobot: 1,
          created_at: new Date().toISOString()
        },
        {
          id: "soal-uuid-2",
          paket_soal_id: "paket-uuid-1",
          nomor: 2,
          pertanyaan: "Manakah kota berikut yang merupakan ibu kota Provinsi Sumatera Selatan?",
          opsi_a: "Bandung",
          opsi_b: "Palembang",
          opsi_c: "Medan",
          opsi_d: "Surabaya",
          jawaban_benar: "B",
          bobot: 1,
          created_at: new Date().toISOString()
        },
        {
          id: "soal-uuid-3",
          paket_soal_id: "paket-uuid-2",
          nomor: 3,
          pertanyaan: "Hasil dari 12 dikali dengan 12 adalah 144.",
          opsi_a: "Benar",
          opsi_b: "Salah",
          opsi_c: null,
          opsi_d: null,
          jawaban_benar: "A",
          bobot: 1,
          created_at: new Date().toISOString()
        },
        {
          id: "soal-uuid-4",
          paket_soal_id: "paket-uuid-2",
          nomor: 4,
          pertanyaan: "Lambang negara Indonesia adalah burung Garuda.",
          opsi_a: "Benar",
          opsi_b: "Salah",
          opsi_c: null,
          opsi_d: null,
          jawaban_benar: "A",
          bobot: 1,
          created_at: new Date().toISOString()
        },
        {
          id: "soal-uuid-5",
          paket_soal_id: "paket-uuid-2",
          nomor: 5,
          pertanyaan: "Gunung tertinggi di Pulau Jawa adalah Gunung...",
          opsi_a: "Merapi",
          opsi_b: "Slamet",
          opsi_c: "Semeru",
          opsi_d: "Bromo",
          jawaban_benar: "C",
          bobot: 2,
          created_at: new Date().toISOString()
        }
      ];
      localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(mockSoal));
    }

    if (!localStorage.getItem('CBT_LOCAL_PENGATURAN')) {
      const mockPengaturan = {
        id: 1,
        durasi_menit: 15,
        passing_grade: 60.00,
        tampilkan_nilai: true,
        token_ujian: 'CBT123',
        token_aktif: false,
        acak_soal: true,
        created_at: new Date().toISOString()
      };
      localStorage.setItem('CBT_LOCAL_PENGATURAN', JSON.stringify(mockPengaturan));
    }

    if (!localStorage.getItem('CBT_LOCAL_HASIL')) {
      localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify([]));
    }

    if (!localStorage.getItem('CBT_LOCAL_JAWABAN')) {
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify([]));
    }

    if (!localStorage.getItem('CBT_LOCAL_JURUSAN')) {
      const mockJurusan = [
        { id: "jurusan-uuid-1", nama_jurusan: "TKJ", created_at: new Date().toISOString() },
        { id: "jurusan-uuid-2", nama_jurusan: "RPL", created_at: new Date().toISOString() },
        { id: "jurusan-uuid-3", nama_jurusan: "Multimedia", created_at: new Date().toISOString() }
      ];
      localStorage.setItem('CBT_LOCAL_JURUSAN', JSON.stringify(mockJurusan));
    }

    if (!localStorage.getItem('CBT_LOCAL_KELAS')) {
      const mockKelas = [
        { id: "kelas-uuid-1", nama_kelas: "X TKJ 1", created_at: new Date().toISOString() },
        { id: "kelas-uuid-2", nama_kelas: "X TKJ 2", created_at: new Date().toISOString() },
        { id: "kelas-uuid-3", nama_kelas: "X RPL 1", created_at: new Date().toISOString() },
        { id: "kelas-uuid-4", nama_kelas: "X RPL 2", created_at: new Date().toISOString() },
        { id: "kelas-uuid-5", nama_kelas: "XI MM 1", created_at: new Date().toISOString() }
      ];
      localStorage.setItem('CBT_LOCAL_KELAS', JSON.stringify(mockKelas));
    }

    if (!localStorage.getItem('CBT_LOCAL_GURU')) {
      const mockGuru = [
        {
          id: "guru-uuid-1",
          username: "guru_mtk",
          password_hash: "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f", // "123456"
          nama_lengkap: "Bpk. Noferson, S.Pd, Gr, M.Eng.",
          mapel_diampu: "Matematika",
          jurusan_diampu: "TKJ",
          kelas_diampu: "TINGKAT:X",
          paket_ids: '["paket-uuid-1"]',
          created_at: new Date().toISOString()
        }
      ];
      localStorage.setItem('CBT_LOCAL_GURU', JSON.stringify(mockGuru));
    }
  },

  // -------------------------------------------------------------
  // DATA GURU MATA PELAJARAN MANAGEMENT
  // -------------------------------------------------------------
  GURU_SYS_ROW_ID: '00000000-0000-4000-8000-000000000999',
  MASTER_SYS_ROW_ID: '00000000-0000-4000-8000-000000000998',
  PAKET_SYS_ROW_ID: '00000000-0000-4000-8000-000000000997',
  SETTINGS_SYS_ROW_ID: '00000000-0000-4000-8000-000000000996',
  PENGAWAS_SYS_ROW_ID: '00000000-0000-4000-8000-000000000995',

  _defaultPengawasRegistry() {
    return {
      config: {
        pin_umum_aktif: true,
        pin_umum: 'CBT2026',
        izinkan_reset_sesi: true,
        izinkan_paksa_selesai: true
      },
      accounts: [],
      updated_at: null
    };
  },

  async ensureAllShardsAdminAuth() {
    if (this.isLocal() || this.isPhp()) return true;
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    if (shards.length > 1) {
      await Promise.allSettled(shards.map(s => s.client ? this.ensureAdminAuth(s.client) : Promise.resolve(false)));
      if (window.setActiveSupabaseShard) window.setActiveSupabaseShard('all');
      return true;
    }
    if (window.supabaseClient) {
      return await this.ensureAdminAuth(window.supabaseClient);
    }
    return false;
  },

  async _readPengawasRegistryFromSysRow(client) {
    const target = client || window.supabaseClient;
    if (!target) return null;
    try {
      const { data, error } = await target
        .from('soal')
        .select('id, pertanyaan')
        .eq('id', this.PENGAWAS_SYS_ROW_ID)
        .maybeSingle();
      if (error || !data || !data.pertanyaan) return null;
      const parsed = JSON.parse(data.pertanyaan);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  },

  async _writePengawasRegistryToSysRow(client, regObj) {
    const target = client || window.supabaseClient;
    if (!target) return false;
    await this.ensureAdminAuth(target);
    return await this.executeWithAdminAuth(target, async (c) => {
      const payload = {
        id: this.PENGAWAS_SYS_ROW_ID,
        paket_soal_id: null,
        nomor: -995,
        pertanyaan: JSON.stringify(regObj || {}),
        opsi_a: '__CBT_SYS_PENGAWAS__',
        opsi_b: 'SYSTEM',
        opsi_c: null,
        opsi_d: null,
        jawaban_benar: 'SYS',
        bobot: 0
      };
      const { error } = await c.from('soal').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      return true;
    });
  },

  async getPengawasRegistry() {
    const def = this._defaultPengawasRegistry();
    let localCached = null;
    try {
      const raw = localStorage.getItem('CBT_PENGAWAS_REGISTRY_V1');
      if (raw) localCached = JSON.parse(raw);
    } catch (e) {}

    if (this.isLocal() || this.isPhp()) {
      const base = localCached || def;
      return {
        config: { ...def.config, ...(base.config || {}) },
        accounts: Array.isArray(base.accounts) ? base.accounts : [],
        updated_at: base.updated_at || null
      };
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const primary = (shards[0] && shards[0].client) || window.supabaseClient;
    const remote = await this._readPengawasRegistryFromSysRow(primary);
    const chosen = remote || localCached || def;
    const normalized = {
      config: { ...def.config, ...(chosen.config || {}) },
      accounts: Array.isArray(chosen.accounts) ? chosen.accounts : [],
      updated_at: chosen.updated_at || null
    };
    try { localStorage.setItem('CBT_PENGAWAS_REGISTRY_V1', JSON.stringify(normalized)); } catch (e) {}
    return normalized;
  },

  async savePengawasRegistry(regObj) {
    const def = this._defaultPengawasRegistry();
    const clean = {
      config: { ...def.config, ...((regObj && regObj.config) || {}) },
      accounts: Array.isArray(regObj && regObj.accounts) ? regObj.accounts : [],
      updated_at: new Date().toISOString()
    };
    try { localStorage.setItem('CBT_PENGAWAS_REGISTRY_V1', JSON.stringify(clean)); } catch (e) {}

    if (this.isLocal() || this.isPhp()) {
      return clean;
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const clients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : [window.supabaseClient].filter(Boolean);
    await Promise.allSettled(clients.map(c => this._writePengawasRegistryToSysRow(c, clean)));
    return clean;
  },

  async verifyPengawasLogin(kodeInput, namaPengawas = '') {
    const cleanKode = String(kodeInput || '').trim().toUpperCase();
    if (!cleanKode) {
      throw new Error('Kode Akses / PIN Pengawas wajib diisi.');
    }

    const reg = await this.getPengawasRegistry();
    const cfg = reg.config || {};
    const cleanNama = String(namaPengawas || '').trim();

    // 1. Cek daftar akun pengawas per Ruang / Multi-Kelas terlebih dahulu
    const matchedAcc = (reg.accounts || []).find(acc =>
      acc && acc.aktif !== false && String(acc.kode_akses || '').trim().toUpperCase() === cleanKode
    );

    if (matchedAcc) {
      await this.ensureAllShardsAdminAuth();
      return {
        role: 'pengawas',
        accountId: matchedAcc.id,
        kode_akses: matchedAcc.kode_akses,
        nama_akun: matchedAcc.nama_akun || 'Pengawas Ruang',
        nama_pengawas: cleanNama || matchedAcc.nama_akun || 'Pengawas Ruang',
        mode_cakupan: matchedAcc.mode_cakupan || 'fleksibel',
        ruang_list: Array.isArray(matchedAcc.ruang_list) ? matchedAcc.ruang_list : [],
        kelas_list: Array.isArray(matchedAcc.kelas_list) ? matchedAcc.kelas_list : [],
        sesi_filter: matchedAcc.sesi_filter || '',
        config: cfg,
        login_at: new Date().toISOString()
      };
    }

    // 2. Cek PIN Pengawas Umum Sekolah (Mode Fleksibel pilih Ruang / Multi-Kelas di HP)
    if (cfg.pin_umum_aktif && cfg.pin_umum && cleanKode === String(cfg.pin_umum).trim().toUpperCase()) {
      await this.ensureAllShardsAdminAuth();
      return {
        role: 'pengawas',
        accountId: 'PIN_UMUM',
        kode_akses: cleanKode,
        nama_akun: 'Pengawas Ruang (PIN Umum)',
        nama_pengawas: cleanNama || 'Pengawas Ruang',
        mode_cakupan: 'fleksibel',
        ruang_list: [],
        kelas_list: [],
        sesi_filter: '',
        config: cfg,
        login_at: new Date().toISOString()
      };
    }

    throw new Error('Kode Akses / PIN Pengawas salah atau belum diaktifkan oleh Admin.');
  },

  // Paksa selesai 1 peserta secara aman & shard-aware (dipakai Admin maupun Pengawas Ruang)
  async paksaSelesaiSatuPeserta(peserta, allPaketPreloaded = null) {
    if (!peserta || !peserta.id) throw new Error('Data peserta tidak ditemukan.');
    if (peserta.status_ujian === 'Sudah Ujian') {
      throw new Error('Peserta ini sudah menyelesaikan ujian.');
    }

    const normJur = (raw) => {
      const s = String(raw || '').toLowerCase().trim();
      if (!s || s === 'semua' || s === 'semua jurusan') return 'semua';
      if (s === 'akl' || s === 'akuntansi' || s.startsWith('akuntansi ')) return 'akl';
      if (s === 'tkj' || s === 'tjkt') return 'tkj';
      if (s === 'tkro' || s === 'tkr') return 'tkro';
      if (s === 'tbsm' || s === 'tsm') return 'tbsm';
      return s;
    };

    const matchKls = (pKelas, sKelas) => {
      if (!pKelas || pKelas.toLowerCase() === 'semua') return { match: true, specificity: 0 };
      if (!sKelas) return { match: false, specificity: 0 };
      const s = sKelas.toLowerCase().trim();
      const parts = pKelas.toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
      if (parts.includes(s)) return { match: true, specificity: 3 };
      const sTok = s.split(/[\s\-_]+/);
      const sGrade = (sTok[0] === 'kelas' ? sTok[1] : sTok[0]) || '';
      for (const part of parts) {
        const g = part.replace(/^tingkat[:\s]+/, '').trim();
        if (['x', 'xi', 'xii', '10', '11', '12'].includes(g) && g === sGrade) {
          return { match: true, specificity: 2 };
        }
      }
      return { match: false, specificity: 0 };
    };

    const pakets = Array.isArray(allPaketPreloaded) && allPaketPreloaded.length > 0
      ? allPaketPreloaded
      : await this.getPaketList();
    const now = new Date();
    const sJur = normJur(peserta.jurusan);
    const sKls = String(peserta.kelas || '').toLowerCase().trim();

    let bestPaket = null;
    let bestScore = -1;
    for (const pk of (pakets || [])) {
      const pJur = String(pk.jurusan || '').toLowerCase().trim();
      const jurParts = pJur.split(',').map(normJur).filter(Boolean);
      const jurOk = (!pJur || pJur === 'semua' || jurParts.includes('semua') || jurParts.includes(sJur));
      const klsRes = matchKls(pk.kelas, sKls);
      if ((jurOk || klsRes.specificity === 3) && klsRes.match) {
        let sc = klsRes.specificity + ((pJur && pJur !== 'semua' && jurParts.includes(sJur)) ? 4 : 0);
        if (pk.jadwal_mulai) {
          const st = new Date(pk.jadwal_mulai);
          const en = pk.jadwal_selesai ? new Date(pk.jadwal_selesai) : new Date('2099-12-31');
          if (now >= st && now <= en) sc += 50;
        }
        const qCount = Number(pk.total_soal !== undefined ? pk.total_soal : (pk.soal_count || 0)) || 0;
        if (qCount > 0) sc += 100;
        if (sc > bestScore) {
          bestScore = sc;
          bestPaket = pk;
        }
      }
    }

    if (!bestPaket) {
      throw new Error('Tidak ditemukan paket soal yang sesuai dengan kelas & jurusan peserta ini.');
    }

    const questions = await this.getSoalByPaket(bestPaket.id);
    if (!questions || questions.length === 0) {
      throw new Error('Paket soal peserta ini masih kosong (0 butir soal).');
    }

    const shardId = peserta._shardId || peserta._shard_id || null;
    const client = (!this.isLocal() && !this.isPhp()) ? this.getClientForShard(shardId) : null;

    let answers = [];
    if (this.isLocal() || this.isPhp() || !client) {
      answers = (await this.getJawabanList(peserta.id)) || [];
    } else {
      await this.ensureAdminAuth(client);
      const { data: ansData } = await client.from('jawaban_peserta').select('*').eq('peserta_id', peserta.id);
      answers = ansData || [];
    }

    let correct = 0;
    let wrong = 0;
    questions.forEach(s => {
      const userAns = answers.find(a => String(a.soal_id) === String(s.id));
      if (userAns && userAns.jawaban === s.jawaban_benar) correct++;
      else wrong++;
    });

    const finalScore = parseFloat(((correct / questions.length) * 100).toFixed(2));
    const nowIso = new Date().toISOString();

    if (this.isLocal() || this.isPhp() || !client) {
      await this.insertHasil(peserta.id, correct, wrong, finalScore, 'Selesai', nowIso, nowIso, bestPaket.id);
      await this.updateStatusUjian(peserta.id, 'Sudah Ujian');
    } else {
      await this.executeWithAdminAuth(client, async (c) => {
        const hasilRow = {
          id: this.uuidv4(),
          peserta_id: peserta.id,
          paket_soal_id: bestPaket.id,
          jumlah_benar: correct,
          jumlah_salah: wrong,
          nilai: finalScore,
          status_kelulusan: 'Selesai',
          waktu_mulai: nowIso,
          waktu_selesai: nowIso
        };
        const { error: hErr } = await c.from('hasil_ujian').insert(hasilRow);
        if (hErr) throw hErr;

        const useTok = !this._hasNoSessionCol(c);
        const uPayload = useTok
          ? { status_ujian: 'Sudah Ujian', is_locked: false, active_session_token: null }
          : { status_ujian: 'Sudah Ujian', is_locked: false };
        const { error: uErr } = await c.from('peserta').update(uPayload).eq('id', peserta.id);
        if (uErr && useTok && this._isMissingSessionColError(uErr)) {
          this._markNoSessionCol(c);
          await c.from('peserta').update({ status_ujian: 'Sudah Ujian', is_locked: false }).eq('id', peserta.id);
        }
      });
    }

    return { ok: true, paket: bestPaket.nama_paket, benar: correct, salah: wrong, nilai: finalScore };
  },

  async _readSettingsFromSysRow(client) {
    const target = client || window.supabaseClient;
    if (!target) return null;
    try {
      const { data, error } = await target
        .from('soal')
        .select('id, pertanyaan')
        .eq('id', this.SETTINGS_SYS_ROW_ID)
        .maybeSingle();
      if (error || !data || !data.pertanyaan) return null;
      const parsed = JSON.parse(data.pertanyaan);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  },

  async _writeSettingsToSysRow(client, settingsObj) {
    const target = client || window.supabaseClient;
    if (!target) return false;
    await this.ensureAdminAuth(target);
    return await this.executeWithAdminAuth(target, async (c) => {
      const payload = {
        id: this.SETTINGS_SYS_ROW_ID,
        paket_soal_id: null,
        nomor: -996,
        pertanyaan: JSON.stringify(settingsObj || {}),
        opsi_a: '__CBT_SYS_SETTINGS__',
        opsi_b: 'SYSTEM',
        opsi_c: null,
        opsi_d: null,
        jawaban_benar: 'SYS',
        bobot: 0
      };
      const { error } = await c.from('soal').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      return true;
    });
  },

  async _readPaketCatalogFromSysRow(client) {
    const target = client || window.supabaseClient;
    if (!target) return [];
    try {
      const { data, error } = await target
        .from('soal')
        .select('id, pertanyaan')
        .eq('id', this.PAKET_SYS_ROW_ID)
        .maybeSingle();
      if (error || !data || !data.pertanyaan) return [];
      const parsed = JSON.parse(data.pertanyaan);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  },

  async _writePaketCatalogToSysRow(client, paketList) {
    const target = client || window.supabaseClient;
    if (!target) return false;
    await this.ensureAdminAuth(target);
    return await this.executeWithAdminAuth(target, async (c) => {
      const slim = (Array.isArray(paketList) ? paketList : [])
        .filter(p => p && p.id)
        .map(p => ({
          id: p.id,
          nama_paket: p.nama_paket || '',
          jurusan: p.jurusan || null,
          kelas: p.kelas || null,
          jadwal_mulai: p.jadwal_mulai || null,
          jadwal_selesai: p.jadwal_selesai || null,
          created_at: p.created_at || null
        }));
      const payload = {
        id: this.PAKET_SYS_ROW_ID,
        paket_soal_id: null,
        nomor: -997,
        pertanyaan: JSON.stringify(slim),
        opsi_a: '__CBT_SYS_PAKET__',
        opsi_b: 'SYSTEM',
        opsi_c: null,
        opsi_d: null,
        jawaban_benar: 'SYS',
        bobot: 0
      };
      const { error } = await c.from('soal').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      return true;
    });
  },

  async syncPublicPaketCatalog(paketList = []) {
    const list = Array.isArray(paketList) ? paketList.filter(p => p && p.id) : [];
    if (list.length === 0) return [];
    if (this.isLocal()) return list;

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    if (shards.length > 1) {
      await Promise.allSettled(shards.map(s => s.client && this._writePaketCatalogToSysRow(s.client, list)));
    } else if (window.supabaseClient) {
      await this._writePaketCatalogToSysRow(window.supabaseClient, list).catch(() => {});
    }
    return list;
  },

  async getPublicPaketCatalog() {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_PAKET')) || [];
    }
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const clients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : (window.supabaseClient ? [window.supabaseClient] : []);
    const mapById = new Map();
    const results = await Promise.allSettled(clients.map(c => this._readPaketCatalogFromSysRow(c)));
    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        r.value.forEach(item => {
          const key = item && (item.id || (item.nama_paket || '').toUpperCase().trim());
          if (key && !mapById.has(String(key))) {
            mapById.set(String(key), item);
          }
        });
      }
    });
    return Array.from(mapById.values());
  },

  async _readMasterCatalogFromSysRow(client) {
    const target = client || window.supabaseClient;
    if (!target) return { kelas: [], jurusan: [] };
    try {
      const { data, error } = await target
        .from('soal')
        .select('id, pertanyaan')
        .eq('id', this.MASTER_SYS_ROW_ID)
        .maybeSingle();
      if (error || !data || !data.pertanyaan) return { kelas: [], jurusan: [] };
      const parsed = JSON.parse(data.pertanyaan);
      return {
        kelas: Array.isArray(parsed.kelas) ? parsed.kelas : [],
        jurusan: Array.isArray(parsed.jurusan) ? parsed.jurusan : []
      };
    } catch (e) {
      return { kelas: [], jurusan: [] };
    }
  },

  async _writeMasterCatalogToSysRow(client, catalog) {
    const target = client || window.supabaseClient;
    if (!target) return false;
    await this.ensureAdminAuth(target);
    return await this.executeWithAdminAuth(target, async (c) => {
      const payload = {
        id: this.MASTER_SYS_ROW_ID,
        paket_soal_id: null,
        nomor: -998,
        pertanyaan: JSON.stringify({
          kelas: Array.isArray(catalog.kelas) ? catalog.kelas : [],
          jurusan: Array.isArray(catalog.jurusan) ? catalog.jurusan : []
        }),
        opsi_a: '__CBT_SYS_MASTER__',
        opsi_b: 'SYSTEM',
        opsi_c: null,
        opsi_d: null,
        jawaban_benar: 'SYS',
        bobot: 0
      };
      const { error } = await c.from('soal').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      return true;
    });
  },

  // Sinkronisasi daftar master kelas & jurusan dari Panel Admin agar halaman publik daftar-guru.html 100% seragam
  async syncMasterCatalog(kelasNames = [], jurusanNames = []) {
    const cleanKelas = Array.from(new Set(
      (kelasNames || []).flatMap(x => String(x || '').split(',')).map(s => s.trim().toUpperCase())
        .filter(s => s && s !== 'SEMUA' && !s.startsWith('TINGKAT:'))
    )).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const cleanJurusan = Array.from(new Set(
      (jurusanNames || []).flatMap(x => String(x || '').split(',')).map(s => s.trim().toUpperCase())
        .filter(s => s && s !== 'SEMUA')
    )).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const catalog = { kelas: cleanKelas, jurusan: cleanJurusan };

    if (this.isLocal()) {
      localStorage.setItem('CBT_LOCAL_MASTER_CATALOG', JSON.stringify(catalog));
      return catalog;
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    if (shards.length > 1) {
      await Promise.allSettled(shards.map(s => s.client && this._writeMasterCatalogToSysRow(s.client, catalog)));
    } else if (window.supabaseClient) {
      await this._writeMasterCatalogToSysRow(window.supabaseClient, catalog).catch(() => {});
    }
    return catalog;
  },

  async getMasterCatalog() {
    if (this.isLocal()) {
      try {
        const parsed = JSON.parse(localStorage.getItem('CBT_LOCAL_MASTER_CATALOG') || '{}');
        return {
          kelas: Array.isArray(parsed.kelas) ? parsed.kelas : [],
          jurusan: Array.isArray(parsed.jurusan) ? parsed.jurusan : []
        };
      } catch (e) {
        return { kelas: [], jurusan: [] };
      }
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const kSet = new Set();
    const jSet = new Set();

    const clients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : (window.supabaseClient ? [window.supabaseClient] : []);
    const results = await Promise.allSettled(clients.map(c => this._readMasterCatalogFromSysRow(c)));
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        (r.value.kelas || []).forEach(k => { if (k) kSet.add(String(k).trim().toUpperCase()); });
        (r.value.jurusan || []).forEach(j => { if (j) jSet.add(String(j).trim().toUpperCase()); });
      }
    });

    return {
      kelas: Array.from(kSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      jurusan: Array.from(jSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    };
  },

  // Ambil hanya daftar unik kelas & jurusan dari tabel peserta lintas semua shard (tanpa data pribadi siswa)
  async getPublicKelasJurusanFromPeserta() {
    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const kSet = new Set();
      const jSet = new Set();
      list.forEach(p => {
        const k = String(p.kelas || '').trim().toUpperCase();
        const j = String(p.jurusan || '').trim().toUpperCase();
        if (k) kSet.add(k);
        if (j) jSet.add(j);
      });
      return { kelas: Array.from(kSet), jurusan: Array.from(jSet) };
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const clients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : (window.supabaseClient ? [window.supabaseClient] : []);
    const kSet = new Set();
    const jSet = new Set();

    const results = await Promise.allSettled(clients.map(async (c) => {
      const { data, error } = await c.from('peserta').select('kelas, jurusan');
      if (error || !Array.isArray(data)) return [];
      return data;
    }));

    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        r.value.forEach(row => {
          const k = String(row.kelas || '').trim().toUpperCase();
          const j = String(row.jurusan || '').trim().toUpperCase();
          if (k && k !== 'SEMUA' && !k.startsWith('TINGKAT:')) kSet.add(k);
          if (j && j !== 'SEMUA') jSet.add(j);
        });
      }
    });

    return {
      kelas: Array.from(kSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      jurusan: Array.from(jSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    };
  },

  async _readGuruFromSysRow(client) {
    const target = client || window.supabaseClient;
    if (!target) return [];
    try {
      const { data, error } = await target
        .from('soal')
        .select('id, pertanyaan')
        .eq('id', this.GURU_SYS_ROW_ID)
        .maybeSingle();
      if (error || !data || !data.pertanyaan) return [];
      const parsed = JSON.parse(data.pertanyaan);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  },

  async _writeGuruToSysRow(client, guruList) {
    const target = client || window.supabaseClient;
    if (!target) return false;
    await this.ensureAdminAuth(target);
    return await this.executeWithAdminAuth(target, async (c) => {
      const payload = {
        id: this.GURU_SYS_ROW_ID,
        paket_soal_id: null,
        nomor: -999,
        pertanyaan: JSON.stringify(guruList || []),
        opsi_a: '__CBT_SYS_GURU__',
        opsi_b: 'SYSTEM',
        opsi_c: null,
        opsi_d: null,
        jawaban_benar: 'SYS',
        bobot: 0
      };
      const { error } = await c.from('soal').upsert(payload, { onConflict: 'id' });
      if (error) throw error;
      return true;
    });
  },

  async getGuruList() {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_GURU')) || [];
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const primaryClient = (shards[0] && shards[0].client) || window.supabaseClient;
    if (!primaryClient) return [];

    // 1. Baca dari baris registri sistem di tabel soal (mendukung penuh field jurusan_diampu & kelas_diampu tanpa perlu alter SQL)
    const mapByUser = new Map();
    if (shards.length > 1) {
      const results = await Promise.allSettled(shards.map(s => this._readGuruFromSysRow(s.client)));
      results.forEach(r => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          r.value.forEach(g => {
            const key = (g.username || g.id || '').toLowerCase();
            if (key && !mapByUser.has(key)) {
              mapByUser.set(key, g);
            }
          });
        }
      });
    } else {
      const sysList = await this._readGuruFromSysRow(primaryClient);
      (sysList || []).forEach(g => {
        const key = (g.username || g.id || '').toLowerCase();
        if (key && !mapByUser.has(key)) {
          mapByUser.set(key, g);
        }
      });
    }

    // 2. Gabungkan juga dari tabel public.guru jika sudah dibuat di SQL
    try {
      const { data, error } = await primaryClient
        .from('guru')
        .select('*')
        .order('nama_lengkap', { ascending: true });
      if (!error && Array.isArray(data)) {
        data.forEach(g => {
          const key = (g.username || g.id || '').toLowerCase();
          if (key) {
            const existing = mapByUser.get(key) || {};
            mapByUser.set(key, {
              ...g,
              ...existing,
              jurusan_diampu: existing.jurusan_diampu || g.jurusan_diampu || '',
              kelas_diampu: existing.kelas_diampu || g.kelas_diampu || '',
              penugasan_mapel: existing.penugasan_mapel || g.penugasan_mapel || []
            });
          }
        });
      }
    } catch (e) {}

    const list = Array.from(mapByUser.values());
    return list.sort((a, b) => (a.nama_lengkap || '').localeCompare(b.nama_lengkap || ''));
  },

  async saveGuru(id, payload, password = '') {
    const cleanUsername = (payload.username || '').trim().toLowerCase();
    const cleanNama = (payload.nama_lengkap || '').trim();
    const cleanMapel = (payload.mapel_diampu || '').trim();
    const cleanJurusan = (payload.jurusan_diampu || '').trim();
    const cleanKelas = (payload.kelas_diampu || '').trim();
    const paketIdsStr = typeof payload.paket_ids === 'string'
      ? payload.paket_ids
      : JSON.stringify(Array.isArray(payload.paket_ids) ? payload.paket_ids : []);
    const penugasanStr = typeof payload.penugasan_mapel === 'string'
      ? payload.penugasan_mapel
      : JSON.stringify(Array.isArray(payload.penugasan_mapel) ? payload.penugasan_mapel : []);

    if (!cleanUsername || !cleanNama) {
      throw new Error("Username dan Nama Lengkap guru wajib diisi.");
    }

    const passHash = password ? await this.sha256(password) : '';

    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_GURU')) || [];
      const dup = list.find(g => (g.username || '').toLowerCase() === cleanUsername && g.id !== id);
      if (dup) {
        throw new Error(`Username guru '${cleanUsername}' sudah digunakan.`);
      }
      if (id) {
        const idx = list.findIndex(g => g.id === id);
        if (idx === -1) throw new Error("Data guru tidak ditemukan.");
        list[idx] = {
          ...list[idx],
          username: cleanUsername,
          nama_lengkap: cleanNama,
          mapel_diampu: cleanMapel,
          jurusan_diampu: cleanJurusan,
          kelas_diampu: cleanKelas,
          paket_ids: paketIdsStr,
          penugasan_mapel: penugasanStr,
          ...(passHash ? { password_hash: passHash } : {})
        };
        localStorage.setItem('CBT_LOCAL_GURU', JSON.stringify(list));
        return list[idx];
      } else {
        if (!passHash) throw new Error("Password wajib diisi untuk akun guru baru.");
        const newGuru = {
          id: this.uuidv4(),
          username: cleanUsername,
          password_hash: passHash,
          nama_lengkap: cleanNama,
          mapel_diampu: cleanMapel,
          jurusan_diampu: cleanJurusan,
          kelas_diampu: cleanKelas,
          paket_ids: paketIdsStr,
          penugasan_mapel: penugasanStr,
          created_at: new Date().toISOString()
        };
        list.push(newGuru);
        localStorage.setItem('CBT_LOCAL_GURU', JSON.stringify(list));
        return newGuru;
      }
    }

    // Mode Cloud Supabase: ambil daftar saat ini, mutakhirkan, lalu simpan ke tabel guru (jika ada) & baris registri sistem di seluruh shard
    const currentList = await this.getGuruList();
    const dup = currentList.find(g => (g.username || '').toLowerCase() === cleanUsername && g.id !== id);
    if (dup) {
      throw new Error(`Username guru '${cleanUsername}' sudah digunakan.`);
    }

    let savedRecord = null;
    if (id) {
      const idx = currentList.findIndex(g => g.id === id);
      if (idx === -1) throw new Error("Data guru tidak ditemukan.");
      savedRecord = {
        ...currentList[idx],
        username: cleanUsername,
        nama_lengkap: cleanNama,
        mapel_diampu: cleanMapel,
        jurusan_diampu: cleanJurusan,
        kelas_diampu: cleanKelas,
        paket_ids: paketIdsStr,
        penugasan_mapel: penugasanStr,
        ...(passHash ? { password_hash: passHash } : {})
      };
      currentList[idx] = savedRecord;
    } else {
      if (!passHash) throw new Error("Password wajib diisi untuk akun guru baru.");
      savedRecord = {
        id: this.uuidv4(),
        username: cleanUsername,
        password_hash: passHash,
        nama_lengkap: cleanNama,
        mapel_diampu: cleanMapel,
        jurusan_diampu: cleanJurusan,
        kelas_diampu: cleanKelas,
        paket_ids: paketIdsStr,
        penugasan_mapel: penugasanStr,
        created_at: new Date().toISOString()
      };
      currentList.push(savedRecord);
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const targetClients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : [window.supabaseClient].filter(Boolean);

    await Promise.allSettled(targetClients.map(async (client) => {
      // Coba simpan ke tabel native public.guru jika tersedia
      try {
        await this.executeWithAdminAuth(client, async (c) => {
          await c.from('guru').upsert(savedRecord, { onConflict: 'id' });
        });
      } catch (e) {}
      // Selalu sinkronkan ke baris registri sistem agar 100% jalan walau tabel guru belum dibuat
      await this._writeGuruToSysRow(client, currentList);
    }));

    return savedRecord;
  },

  async deleteGuru(id) {
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_GURU')) || [];
      list = list.filter(g => g.id !== id);
      localStorage.setItem('CBT_LOCAL_GURU', JSON.stringify(list));
      return;
    }

    let currentList = await this.getGuruList();
    currentList = currentList.filter(g => g.id !== id);

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const targetClients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : [window.supabaseClient].filter(Boolean);

    await Promise.allSettled(targetClients.map(async (client) => {
      try {
        await this.executeWithAdminAuth(client, async (c) => {
          await c.from('guru').delete().eq('id', id);
        });
      } catch (e) {}
      await this._writeGuruToSysRow(client, currentList);
    }));
  },

  async verifyGuruCredentials(username, password) {
    const cleanUser = (username || '').trim().toLowerCase();
    const list = await this.getGuruList();
    const guru = (list || []).find(g => (g.username || '').trim().toLowerCase() === cleanUser);
    if (!guru) return null;

    const inputHash = await this.sha256(password);
    const storedHash = (guru.password_hash || '').trim();
    if (storedHash === inputHash || storedHash === password) {
      return guru;
    }
    return null;
  },

  // -------------------------------------------------------------
  // MASTER JURUSAN & KELAS MANAGEMENT
  // -------------------------------------------------------------
  async getKelasList() {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_KELAS')) || [];
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        const results = await Promise.allSettled(
          shards.map(s => s.client && s.client.from('kelas').select('*').order('nama_kelas', { ascending: true }))
        );
        const set = new Set();
        const merged = [];
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.data)) {
            r.value.data.forEach(item => {
              const name = (item.nama_kelas || item.nama || '').trim().toUpperCase();
              if (name && !set.has(name)) {
                set.add(name);
                merged.push(item);
              }
            });
          }
        });
        return merged.sort((a, b) => (a.nama_kelas || '').localeCompare(b.nama_kelas || ''));
      }

      if (window.supabaseClient) {
        const { data, error } = await window.supabaseClient
          .from('kelas')
          .select('*')
          .order('nama_kelas', { ascending: true });
        if (error) {
          console.warn("Gagal memuat tabel kelas:", error.message);
          return [];
        }
        return data || [];
      }
      return [];
    }
  },

  async saveKelas(id, namaKelas) {
    const cleanNama = (namaKelas || '').trim().toUpperCase();
    if (!cleanNama) throw new Error("Nama kelas wajib diisi.");

    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_KELAS')) || [];
      if (id) {
        const idx = list.findIndex(k => k.id === id);
        if (idx !== -1) list[idx].nama_kelas = cleanNama;
      } else {
        if (list.some(k => (k.nama_kelas || '').toUpperCase() === cleanNama)) {
          throw new Error(`Kelas '${cleanNama}' sudah ada.`);
        }
        list.push({ id: this.uuidv4(), nama_kelas: cleanNama, created_at: new Date().toISOString() });
      }
      localStorage.setItem('CBT_LOCAL_KELAS', JSON.stringify(list));
      return { nama_kelas: cleanNama };
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        const sharedId = id || this.uuidv4();
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return null;
          return await this.executeWithAdminAuth(shard.client, async (c) => {
            if (id) {
              const { error } = await c.from('kelas').update({ nama_kelas: cleanNama }).eq('id', id);
              if (error) throw error;
            } else {
              const { data: existing } = await c
                .from('kelas')
                .select('id')
                .ilike('nama_kelas', cleanNama)
                .maybeSingle();
              if (!existing) {
                const { error } = await c.from('kelas').insert({ id: sharedId, nama_kelas: cleanNama });
                if (error) throw error;
              }
            }
            return true;
          });
        }));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        return { id: sharedId, nama_kelas: cleanNama };
      }

      if (id) {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { data, error } = await c.from('kelas').update({ nama_kelas: cleanNama }).eq('id', id);
          if (error) throw error;
          return data;
        });
      } else {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { data, error } = await c.from('kelas').insert({ nama_kelas: cleanNama });
          if (error) throw error;
          return data;
        });
      }
    }
  },

  async deleteKelas(id, namaKelas = '') {
    const cleanNama = (namaKelas || '').trim();
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_KELAS')) || [];
      list = list.filter(k => k.id !== id && (!cleanNama || (k.nama_kelas || '').toUpperCase() !== cleanNama.toUpperCase()));
      localStorage.setItem('CBT_LOCAL_KELAS', JSON.stringify(list));
    } else {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
      const deleteOnClient = async (client) => {
        if (!client) return null;
        return await this.executeWithAdminAuth(client, async (c) => {
          if (cleanNama) {
            const { error } = await c.from('kelas').delete().ilike('nama_kelas', cleanNama);
            if (error) throw error;
          }
          if (isUuid) {
            const { error } = await c.from('kelas').delete().eq('id', id);
            if (error) throw error;
          }
          return true;
        });
      };

      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        const results = await Promise.allSettled(shards.map(s => deleteOnClient(s.client)));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        return;
      }

      await deleteOnClient(window.supabaseClient);
    }
  },

  async getJurusanList() {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_JURUSAN')) || [];
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        const results = await Promise.allSettled(
          shards.map(s => s.client && s.client.from('jurusan').select('*').order('nama_jurusan', { ascending: true }))
        );
        const set = new Set();
        const merged = [];
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.data)) {
            r.value.data.forEach(item => {
              const name = (item.nama_jurusan || item.nama || '').trim().toUpperCase();
              if (name && !set.has(name)) {
                set.add(name);
                merged.push(item);
              }
            });
          }
        });
        return merged.sort((a, b) => (a.nama_jurusan || '').localeCompare(b.nama_jurusan || ''));
      }

      if (window.supabaseClient) {
        const { data, error } = await window.supabaseClient
          .from('jurusan')
          .select('*')
          .order('nama_jurusan', { ascending: true });
        if (error) {
          console.warn("Gagal memuat tabel jurusan:", error.message);
          return [];
        }
        return data || [];
      }
      return [];
    }
  },

  async saveJurusan(id, namaJurusan) {
    const cleanNama = (namaJurusan || '').trim().toUpperCase();
    if (!cleanNama) throw new Error("Nama jurusan wajib diisi.");

    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_JURUSAN')) || [];
      if (id) {
        const idx = list.findIndex(j => j.id === id);
        if (idx !== -1) list[idx].nama_jurusan = cleanNama;
      } else {
        if (list.some(j => (j.nama_jurusan || '').toUpperCase() === cleanNama)) {
          throw new Error(`Jurusan '${cleanNama}' sudah ada.`);
        }
        list.push({ id: this.uuidv4(), nama_jurusan: cleanNama, created_at: new Date().toISOString() });
      }
      localStorage.setItem('CBT_LOCAL_JURUSAN', JSON.stringify(list));
      return { nama_jurusan: cleanNama };
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        const sharedId = id || this.uuidv4();
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return null;
          return await this.executeWithAdminAuth(shard.client, async (c) => {
            if (id) {
              const { error } = await c.from('jurusan').update({ nama_jurusan: cleanNama }).eq('id', id);
              if (error) throw error;
            } else {
              const { data: existing } = await c
                .from('jurusan')
                .select('id')
                .ilike('nama_jurusan', cleanNama)
                .maybeSingle();
              if (!existing) {
                const { error } = await c.from('jurusan').insert({ id: sharedId, nama_jurusan: cleanNama });
                if (error) throw error;
              }
            }
            return true;
          });
        }));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        return { id: sharedId, nama_jurusan: cleanNama };
      }

      if (id) {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { data, error } = await c.from('jurusan').update({ nama_jurusan: cleanNama }).eq('id', id);
          if (error) throw error;
          return data;
        });
      } else {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { data, error } = await c.from('jurusan').insert({ nama_jurusan: cleanNama });
          if (error) throw error;
          return data;
        });
      }
    }
  },

  async deleteJurusan(id, namaJurusan = '') {
    const cleanNama = (namaJurusan || '').trim();
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_JURUSAN')) || [];
      list = list.filter(j => j.id !== id && (!cleanNama || (j.nama_jurusan || '').toUpperCase() !== cleanNama.toUpperCase()));
      localStorage.setItem('CBT_LOCAL_JURUSAN', JSON.stringify(list));
    } else {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
      const deleteOnClient = async (client) => {
        if (!client) return null;
        return await this.executeWithAdminAuth(client, async (c) => {
          if (cleanNama) {
            const { error } = await c.from('jurusan').delete().ilike('nama_jurusan', cleanNama);
            if (error) throw error;
          }
          if (isUuid) {
            const { error } = await c.from('jurusan').delete().eq('id', id);
            if (error) throw error;
          }
          return true;
        });
      };

      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        const results = await Promise.allSettled(shards.map(s => deleteOnClient(s.client)));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        return;
      }

      await deleteOnClient(window.supabaseClient);
    }
  },

  // -------------------------------------------------------------
  // EXAM SETTINGS
  // -------------------------------------------------------------
  async getSettings() {
    const defaultSettings = () => ({
      id: 1,
      durasi_menit: 60,
      passing_grade: 60,
      tampilkan_nilai: true,
      token_ujian: this.generateTimeSlotToken(Math.floor(Date.now() / this.TOKEN_INTERVAL_MS)),
      token_aktif: false,
      acak_soal: true,
      updated_at: null
    });

    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_PENGATURAN')) || defaultSettings();
    } else {
      let tableData = null;
      try {
        const { data, error } = await window.supabaseClient
          .from('pengaturan_ujian')
          .select('*')
          .eq('id', 1)
          .maybeSingle();
        if (!error && data) tableData = data;
      } catch (e) {}

      // Baca juga dari baris registri sistem (selalu dapat diakses lintas shard walau tabel pengaturan_ujian kosong / terkena RLS)
      const sysData = await this._readSettingsFromSysRow(window.supabaseClient);

      if (tableData && sysData) {
        const tMs = tableData.updated_at ? new Date(tableData.updated_at).getTime() : 0;
        const sMs = sysData.updated_at ? new Date(sysData.updated_at).getTime() : 0;
        const newer = sMs >= tMs ? { ...tableData, ...sysData } : { ...sysData, ...tableData };
        if (sysData.card_branding && !newer.card_branding) newer.card_branding = sysData.card_branding;
        return newer;
      }
      return sysData || tableData || defaultSettings();
    }
  },

  async saveSettings(durasi, passing, tampilkanNilai, tokenUjian, tokenAktif, acakSoal) {
    const updatedIso = new Date().toISOString();
    if (this.isLocal()) {
      const prev = JSON.parse(localStorage.getItem('CBT_LOCAL_PENGATURAN') || '{}');
      const s = {
        ...prev,
        id: 1,
        durasi_menit: durasi,
        passing_grade: passing,
        tampilkan_nilai: tampilkanNilai,
        token_ujian: tokenUjian || 'CBT123',
        token_aktif: Boolean(tokenAktif),
        acak_soal: acakSoal !== undefined ? Boolean(acakSoal) : true,
        updated_at: updatedIso
      };
      localStorage.setItem('CBT_LOCAL_PENGATURAN', JSON.stringify(s));
      return s;
    } else {
      const payload = {
        id: 1,
        durasi_menit: durasi,
        passing_grade: passing,
        tampilkan_nilai: tampilkanNilai,
        token_ujian: tokenUjian || 'CBT123',
        token_aktif: Boolean(tokenAktif),
        acak_soal: acakSoal !== undefined ? Boolean(acakSoal) : true,
        updated_at: updatedIso
      };

      // Pertahankan card_branding yang sudah tersimpan di SETTINGS_SYS_ROW_ID
      let existingSys = null;
      try { existingSys = await this._readSettingsFromSysRow(window.supabaseClient); } catch (e) {}
      const sysPayload = {
        ...(existingSys || {}),
        ...payload
      };

      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const clients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : [window.supabaseClient].filter(Boolean);

      await Promise.allSettled(clients.map(async (client) => {
        try {
          await this.ensureAdminAuth(client);
          await this.executeWithAdminAuth(client, async (c) => {
            await c.from('pengaturan_ujian').upsert(payload, { onConflict: 'id' });
          });
        } catch (e) {}
        await this._writeSettingsToSysRow(client, sysPayload);
      }));

      return sysPayload;
    }
  },

  async getCardBranding() {
    let localObj = null;
    try {
      const raw = localStorage.getItem('CBT_CETAK_KARTU_BRANDING_V1');
      if (raw) localObj = JSON.parse(raw);
    } catch (e) {}

    if (this.isLocal() || this.isPhp()) {
      return localObj;
    }

    try {
      const sys = await this._readSettingsFromSysRow(window.supabaseClient);
      if (sys && sys.card_branding && typeof sys.card_branding === 'object') {
        if (!localObj) {
          try { localStorage.setItem('CBT_CETAK_KARTU_BRANDING_V1', JSON.stringify(sys.card_branding)); } catch (e) {}
          return sys.card_branding;
        }
        const lMs = localObj.updated_at ? new Date(localObj.updated_at).getTime() : 0;
        const sMs = sys.card_branding.updated_at ? new Date(sys.card_branding.updated_at).getTime() : 0;
        if (sMs > lMs) {
          try { localStorage.setItem('CBT_CETAK_KARTU_BRANDING_V1', JSON.stringify(sys.card_branding)); } catch (e) {}
          return sys.card_branding;
        }
      }
    } catch (e) {}

    return localObj;
  },

  async saveCardBranding(brandingObj) {
    const clean = {
      ...(brandingObj || {}),
      updated_at: new Date().toISOString()
    };
    try {
      localStorage.setItem('CBT_CETAK_KARTU_BRANDING_V1', JSON.stringify(clean));
    } catch (e) {}

    if (this.isLocal() || this.isPhp()) {
      return clean;
    }

    try {
      const existingSys = (await this._readSettingsFromSysRow(window.supabaseClient)) || {};
      const nextSys = {
        ...existingSys,
        card_branding: clean
      };
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const clients = shards.length > 0 ? shards.map(s => s.client).filter(Boolean) : [window.supabaseClient].filter(Boolean);
      await Promise.allSettled(clients.map(c => this._writeSettingsToSysRow(c, nextSys)));
    } catch (e) {
      console.warn('Gagal sinkron branding kartu ke cloud:', e);
    }
    return clean;
  },

  // -------------------------------------------------------------
  // PESERTA (STUDENTS) MANAGEMENT
  // -------------------------------------------------------------
  async getPesertaList(options = {}) {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA'));
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = (options && options.forceAllShards) || (window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode());

      if (isUnified && shards.length > 1) {
        // Tarik data seluruh siswa dari ke-5 server secara paralel
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return [];
          let { data, error } = await shard.client
            .from('peserta')
            .select('*')
            .order('created_at', { ascending: false });
          // Jika terkena RLS atau belum terautentikasi di shard ini, auto-auth lalu coba ulang
          if (error || (options && options.forceAllShards && (!data || data.length === 0))) {
            await this.ensureAdminAuth(shard.client);
            const retry = await shard.client
              .from('peserta')
              .select('*')
              .order('created_at', { ascending: false });
            if (!retry.error) {
              data = retry.data;
              error = null;
            }
          }
          if (error) {
            console.warn(`Gagal mengambil data peserta dari ${shard.name}:`, error);
            return [];
          }
          return (data || []).map(p => ({
            ...p,
            password: p.password_plain || p.password || '',
            _shardId: shard.id,
            _shardName: shard.name
          }));
        }));

        let merged = [];
        results.forEach(res => {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            merged = merged.concat(res.value);
          }
        });
        return merged;
      }

      // Single shard / Server spesifik terpilih
      const { data, error } = await window.supabaseClient
        .from('peserta')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const activeId = window.getActiveSupabaseShardId();
      const activeShard = shards.find(s => String(s.id) === String(activeId));
      const activeName = activeShard ? activeShard.name : '';
      return (data || []).map(p => ({
        ...p,
        password: p.password_plain || p.password || '',
        _shardId: activeId,
        _shardName: activeName
      }));
    }
  },

  async savePesertaLocal(id, payload) {
    const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
    if (id) {
      // Edit
      const idx = list.findIndex(p => p.id === id);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...payload };
      }
    } else {
      // Create new
      payload.id = this.uuidv4();
      payload.created_at = new Date().toISOString();
      list.push(payload);
    }
    localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
    return payload;
  },

  async registerPeserta(username, pass, nama, jurusan, kelas, ruang, sesi) {
    const cleanUsername = String(username || '').trim().replace(/\s+/g, '').toLowerCase();
    const cleanPass = String(pass || '').trim();
    const cleanNama = String(nama || '').trim();
    const cleanJurusan = String(jurusan || '').trim();
    const cleanKelas = String(kelas || '').trim();
    const cleanRuang = String(ruang || '').trim();
    const cleanSesi = String(sesi || '').trim();

    if (!cleanUsername || !cleanPass || !cleanNama) {
      throw new Error("Username, Password, dan Nama Lengkap peserta wajib diisi.");
    }

    if (this.isLocal()) {
      const hash = await this.sha256(cleanPass);
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const existing = list.find(p => (p.username || '').trim().toLowerCase() === cleanUsername);
      const payload = {
        username: cleanUsername,
        password_hash: hash,
        password_plain: cleanPass,
        password: cleanPass,
        nama_lengkap: cleanNama,
        jurusan: cleanJurusan,
        kelas: cleanKelas,
        ruang: cleanRuang,
        sesi: cleanSesi,
        status_ujian: existing ? (existing.status_ujian || 'Belum Ujian') : 'Belum Ujian',
        pelanggaran: existing ? (existing.pelanggaran || 0) : 0,
        is_locked: existing ? Boolean(existing.is_locked) : false
      };
      return await this.savePesertaLocal(existing ? existing.id : null, payload);
    } else {
      // Auto-Routing: Tentukan server tujuan berdasarkan jurusan/sesi
      const targetShard = (window.getShardForPeserta && window.getShardForPeserta(cleanJurusan, cleanSesi)) || null;
      const client = (targetShard && targetShard.client) || window.supabaseClient;

      return await this.executeWithAdminAuth(client, async (c) => {
        const { data, error } = await c.rpc('create_peserta_user', {
          p_username: cleanUsername,
          p_password: cleanPass,
          p_nama_lengkap: cleanNama,
          p_jurusan: cleanJurusan,
          p_kelas: cleanKelas,
          p_ruang: cleanRuang,
          p_sesi: cleanSesi
        });

        if (!error) return data;

        // Jika gagal karena username sudah ada (misal saat import ulang Excel atau ada akun lama berhuruf besar),
        // otomatis perbarui profil & password akun tersebut agar tidak gagal (Upsert & Self-Heal)
        const errMsg = ((error.message || '') + ' ' + (error.details || '')).toLowerCase();
        if (errMsg.includes('duplicate') || errMsg.includes('unique') || errMsg.includes('already exists')) {
          const { data: existing } = await c
            .from('peserta')
            .select('*')
            .ilike('username', cleanUsername)
            .maybeSingle();

          if (existing && existing.id) {
            // Jika username lama mengandung huruf besar/spasi dan belum ujian, buat ulang agar email auth.users huruf kecil
            if (existing.username !== cleanUsername && (!existing.status_ujian || existing.status_ujian === 'Belum Ujian')) {
              await c.rpc('delete_peserta_user', { p_peserta_id: existing.id });
              const { data: recreatedId, error: recErr } = await c.rpc('create_peserta_user', {
                p_username: cleanUsername,
                p_password: cleanPass,
                p_nama_lengkap: cleanNama,
                p_jurusan: cleanJurusan,
                p_kelas: cleanKelas,
                p_ruang: cleanRuang,
                p_sesi: cleanSesi
              });
              if (!recErr) return recreatedId;
            }

            const passHash = await this.sha256(cleanPass);
            await c.from('peserta').update({
              username: cleanUsername,
              password_hash: passHash,
              password_plain: cleanPass,
              nama_lengkap: cleanNama,
              jurusan: cleanJurusan,
              kelas: cleanKelas,
              ruang: cleanRuang,
              sesi: cleanSesi
            }).eq('id', existing.id);

            await c.rpc('update_peserta_password', {
              p_peserta_id: existing.id,
              p_password: cleanPass
            });

            return existing.id;
          }
        }

        throw error;
      });
    }
  },

  async editPesertaProfile(id, payload, pass, shardId = null) {
    const cleanPayload = { ...payload };
    if (cleanPayload.username !== undefined) {
      cleanPayload.username = String(cleanPayload.username || '').trim().replace(/\s+/g, '').toLowerCase();
    }
    if (cleanPayload.nama_lengkap !== undefined) {
      cleanPayload.nama_lengkap = String(cleanPayload.nama_lengkap || '').trim();
    }
    const cleanPass = String(pass || '').trim();

    if (this.isLocal()) {
      if (cleanPass) {
        cleanPayload.password_hash = await this.sha256(cleanPass);
      }
      return await this.savePesertaLocal(id, cleanPayload);
    } else {
      const client = this.getClientForShard(shardId);
      return await this.executeWithAdminAuth(client, async (c) => {
        const { data: oldRow } = await c.from('peserta').select('*').eq('id', id).maybeSingle();

        // Jika username diubah (atau sebelumnya huruf besar) dan ada password baru serta belum ujian,
        // buat ulang auth.users agar email login di Supabase 100% sinkron dengan username baru
        if (
          oldRow &&
          cleanPayload.username &&
          oldRow.username !== cleanPayload.username &&
          cleanPass &&
          (!oldRow.status_ujian || oldRow.status_ujian === 'Belum Ujian')
        ) {
          await c.rpc('delete_peserta_user', { p_peserta_id: id });
          const { data: newId, error: createErr } = await c.rpc('create_peserta_user', {
            p_username: cleanPayload.username,
            p_password: cleanPass,
            p_nama_lengkap: cleanPayload.nama_lengkap || oldRow.nama_lengkap || '',
            p_jurusan: cleanPayload.jurusan !== undefined ? cleanPayload.jurusan : (oldRow.jurusan || ''),
            p_kelas: cleanPayload.kelas !== undefined ? cleanPayload.kelas : (oldRow.kelas || ''),
            p_ruang: cleanPayload.ruang !== undefined ? cleanPayload.ruang : (oldRow.ruang || ''),
            p_sesi: cleanPayload.sesi !== undefined ? cleanPayload.sesi : (oldRow.sesi || '')
          });
          if (createErr) throw createErr;
          return newId;
        }

        if (cleanPass) {
          cleanPayload.password_hash = await this.sha256(cleanPass);
        }

        const { error: profileErr } = await c
          .from('peserta')
          .update(cleanPayload)
          .eq('id', id);
        if (profileErr) throw profileErr;

        if (cleanPass) {
          const { error: passErr } = await c.rpc('update_peserta_password', {
            p_peserta_id: id,
            p_password: cleanPass
          });
          if (passErr) throw passErr;
        }
      });
    }
  },

  async deletePeserta(id, shardId = null) {
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      list = list.filter(p => p.id !== id);
      localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));

      // Cascade deletes answers & scores
      let hasil = JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [];
      hasil = hasil.filter(h => h.peserta_id !== id);
      localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify(hasil));

      let jawaban = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      jawaban = jawaban.filter(j => j.peserta_id !== id);
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(jawaban));
    } else {
      if (shardId) {
        const client = this.getClientForShard(shardId);
        const { error } = await client.rpc('delete_peserta_user', { p_peserta_id: id });
        if (error) throw error;
      } else {
        const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
        if (shards.length > 1) {
          await Promise.allSettled(shards.map(s => s.client && s.client.rpc('delete_peserta_user', { p_peserta_id: id })));
        } else {
          const { error } = await window.supabaseClient.rpc('delete_peserta_user', { p_peserta_id: id });
          if (error) throw error;
        }
      }
    }
  },

  _noSessionColClients: typeof WeakSet !== 'undefined' ? new WeakSet() : null,

  _hasNoSessionCol(client) {
    return Boolean(client && this._noSessionColClients && this._noSessionColClients.has(client));
  },

  _markNoSessionCol(client) {
    if (client && this._noSessionColClients) {
      try { this._noSessionColClients.add(client); } catch (e) {}
    }
  },

  _isMissingSessionColError(err) {
    if (!err) return false;
    const code = String(err.code || '');
    const msg = String(err.message || '') + ' ' + String(err.details || '');
    return code === '42703' || code === 'PGRST204' || msg.toLowerCase().includes('active_session_token');
  },

  // Update status (e.g. 'Sedang Ujian', 'Sudah Ujian')
  async updateStatusUjian(pesertaId, status) {
    const shouldClearSession = (status === 'Sudah Ujian' || status === 'Belum Ujian');
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].status_ujian = status;
        if (shouldClearSession) list[idx].active_session_token = null;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
    } else {
      const target = window.supabaseClient;
      const useTokenCol = shouldClearSession && !this._hasNoSessionCol(target);
      const payload = useTokenCol
        ? { status_ujian: status, active_session_token: null }
        : { status_ujian: status };
      const { error } = await target
        .from('peserta')
        .update(payload)
        .eq('id', pesertaId);
      if (error) {
        if (useTokenCol && this._isMissingSessionColError(error)) {
          this._markNoSessionCol(target);
          const { error: err2 } = await target
            .from('peserta')
            .update({ status_ujian: status })
            .eq('id', pesertaId);
          if (err2) throw err2;
          return;
        }
        throw error;
      }
    }
  },

  // Simpan / bersihkan token sesi aktif perangkat siswa (Single-Device Lock)
  async setPesertaSessionToken(pesertaId, token, clientOverride = null) {
    if (!pesertaId) return { supported: false };
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].active_session_token = token || null;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
      return { supported: true, token: token || null };
    }

    const target = clientOverride || window.supabaseClient;
    if (!target || this._hasNoSessionCol(target)) return { supported: false };

    try {
      const { error } = await target
        .from('peserta')
        .update({ active_session_token: token || null })
        .eq('id', pesertaId);
      if (error) {
        if (this._isMissingSessionColError(error)) {
          this._markNoSessionCol(target);
          return { supported: false };
        }
        // Coba sekali lagi dengan admin auth jika terkena RLS pada fallback session
        const msg = (error.message || '') + ' ' + (error.details || '');
        if (error.code === '42501' || msg.toLowerCase().includes('row-level security')) {
          await this.executeWithAdminAuth(target, async (c) => {
            const { error: e2 } = await c
              .from('peserta')
              .update({ active_session_token: token || null })
              .eq('id', pesertaId);
            if (e2 && !this._isMissingSessionColError(e2)) throw e2;
          });
          return { supported: true, token: token || null };
        }
        console.warn('[CBT Session] Gagal set active_session_token:', error.message);
        return { supported: false };
      }
      return { supported: true, token: token || null };
    } catch (e) {
      if (this._isMissingSessionColError(e)) return { supported: false };
      console.warn('[CBT Session] Error set active_session_token:', e.message);
      return { supported: false };
    }
  },

  // Ambil hanya kolom active_session_token (< 100 byte) untuk verifikasi sesi ganda super ringan
  async getPesertaSessionToken(pesertaId, clientOverride = null) {
    if (!pesertaId) return { supported: false, token: null };
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const found = list.find(p => p.id === pesertaId);
      return { supported: true, token: found ? (found.active_session_token || null) : null };
    }

    const target = clientOverride || window.supabaseClient;
    if (!target || this._hasNoSessionCol(target)) return { supported: false, token: null };

    try {
      const { data, error } = await target
        .from('peserta')
        .select('active_session_token')
        .eq('id', pesertaId)
        .maybeSingle();
      if (error) {
        if (this._isMissingSessionColError(error)) {
          this._markNoSessionCol(target);
          return { supported: false, token: null };
        }
        return { supported: false, token: null };
      }
      if (!data) return { supported: false, token: null };
      return { supported: true, token: data.active_session_token || null };
    } catch (e) {
      return { supported: false, token: null };
    }
  },

  // Ambil status live peserta (< 120 byte) untuk deteksi instan saat di-reset / dibuka kuncinya oleh Pengawas
  async getPesertaLiveState(pesertaId, clientOverride = null) {
    if (!pesertaId) return null;
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const found = list.find(p => p.id === pesertaId);
      if (!found) return null;
      return {
        status_ujian: found.status_ujian || 'Belum Ujian',
        is_locked: Boolean(found.is_locked),
        pelanggaran: parseInt(found.pelanggaran || 0),
        active_session_token: found.active_session_token || null,
        tokenSupported: true
      };
    }

    const target = clientOverride || window.supabaseClient;
    if (!target) return null;

    try {
      // Jika shard ini sudah diketahui belum memiliki kolom active_session_token, langsung query 3 kolom inti (hemat 1 round-trip!)
      if (this._hasNoSessionCol(target)) {
        const { data: dFast, error: eFast } = await target
          .from('peserta')
          .select('status_ujian, is_locked, pelanggaran')
          .eq('id', pesertaId)
          .maybeSingle();
        if (eFast || !dFast) return null;
        return {
          status_ujian: dFast.status_ujian || 'Belum Ujian',
          is_locked: Boolean(dFast.is_locked),
          pelanggaran: parseInt(dFast.pelanggaran || 0),
          active_session_token: null,
          tokenSupported: false
        };
      }

      const { data, error } = await target
        .from('peserta')
        .select('status_ujian, is_locked, pelanggaran, active_session_token')
        .eq('id', pesertaId)
        .maybeSingle();

      if (error) {
        if (this._isMissingSessionColError(error)) {
          this._markNoSessionCol(target);
          const { data: d2, error: e2 } = await target
            .from('peserta')
            .select('status_ujian, is_locked, pelanggaran')
            .eq('id', pesertaId)
            .maybeSingle();
          if (e2 || !d2) return null;
          return {
            status_ujian: d2.status_ujian || 'Belum Ujian',
            is_locked: Boolean(d2.is_locked),
            pelanggaran: parseInt(d2.pelanggaran || 0),
            active_session_token: null,
            tokenSupported: false
          };
        }
        return null;
      }

      if (!data) return null;
      return {
        status_ujian: data.status_ujian || 'Belum Ujian',
        is_locked: Boolean(data.is_locked),
        pelanggaran: parseInt(data.pelanggaran || 0),
        active_session_token: data.active_session_token || null,
        tokenSupported: true
      };
    } catch (e) {
      return null;
    }
  },

  // Reset Login Perangkat (khusus Proktor/Admin: melepas kunci HP lama TANPA menghapus jawaban ujian siswa)
  async resetPesertaLoginSession(pesertaId, shardId = null) {
    if (!pesertaId) return;
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].active_session_token = null;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
      return;
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const targetShards = shardId
      ? shards.filter(s => String(s.id) === String(shardId))
      : (shards.length > 0 ? shards : [{ client: window.supabaseClient }]);

    for (const shard of targetShards) {
      const client = shard.client || window.supabaseClient;
      if (!client) continue;
      await this.setPesertaSessionToken(pesertaId, null, client);
    }
  },

  async incrementPelanggaran(pesertaId) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        const nextCount = (list[idx].pelanggaran || 0) + 1;
        list[idx].pelanggaran = nextCount;
        if (nextCount > 0 && nextCount % 3 === 0) {
          list[idx].is_locked = true;
        }
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
        return nextCount;
      }
      return 0;
    } else {
      const { data } = await window.supabaseClient.from('peserta').select('pelanggaran, is_locked').eq('id', pesertaId).single();
      const current = data ? (data.pelanggaran || 0) : 0;
      const nextCount = current + 1;
      const updatePayload = { pelanggaran: nextCount };
      if (nextCount > 0 && nextCount % 3 === 0) {
        updatePayload.is_locked = true;
      }
      await window.supabaseClient.from('peserta').update(updatePayload).eq('id', pesertaId);
      return nextCount;
    }
  },

  async unlockPesertaByToken(pesertaId, inputToken) {
    const cleanInput = (inputToken || '').trim().toUpperCase();
    if (!cleanInput) {
      throw new Error("Token Pembebas wajib diisi.");
    }
    const settings = await this.getSettings();
    if (!this.isValidExamToken(cleanInput, settings)) {
      throw new Error("Token Pembebas salah atau sudah kadaluarsa (berganti otomatis tiap 3 menit)! Silakan minta token terbaru kepada Pengawas Ujian.");
    }
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].is_locked = false;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
      return true;
    } else {
      const { error } = await window.supabaseClient
        .from('peserta')
        .update({ is_locked: false })
        .eq('id', pesertaId);
      if (error) throw error;
      return true;
    }
  },

  async toggleLockPeserta(pesertaId, isLocked, shardId = null) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].is_locked = isLocked;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
    } else {
      const updatePayload = { is_locked: Boolean(isLocked) };
      if (shardId) {
        const client = this.getClientForShard(shardId);
        await this.ensureAdminAuth(client);
        await this.executeWithAdminAuth(client, async (c) => {
          const { error } = await c.from('peserta').update(updatePayload).eq('id', pesertaId);
          if (error) throw error;
        });
      } else {
        const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
        if (shards.length > 1) {
          await Promise.allSettled(shards.map(async (s) => {
            if (!s.client) return;
            await this.ensureAdminAuth(s.client);
            await this.executeWithAdminAuth(s.client, async (c) => {
              await c.from('peserta').update(updatePayload).eq('id', pesertaId);
            });
          }));
        } else {
          await this.ensureAdminAuth(window.supabaseClient);
          await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
            const { error } = await c.from('peserta').update(updatePayload).eq('id', pesertaId);
            if (error) throw error;
          });
        }
      }
    }
  },

  // -------------------------------------------------------------
  // BANK SOAL (QUESTIONS) MANAGEMENT
  // -------------------------------------------------------------
  async getPaketList() {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_PAKET')) || [];
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();
      if (isUnified && shards.length > 1) {
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return [];
          const { data, error } = await shard.client
            .from('paket_soal')
            .select('*')
            .order('created_at', { ascending: false });
          if (error) return [];
          return data || [];
        }));
        const mapById = new Map();
        results.forEach(res => {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            res.value.forEach(item => {
              const key = item.id || (item.nama_paket || '').toUpperCase().trim();
              if (key && !mapById.has(key)) {
                mapById.set(key, item);
              }
            });
          }
        });
        const list = Array.from(mapById.values());
        if (list.length > 0) return list;
        return await this.getPublicPaketCatalog();
      }
      const { data, error } = await window.supabaseClient
        .from('paket_soal')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) {
        const pubFallback = await this.getPublicPaketCatalog();
        if (pubFallback.length > 0) return pubFallback;
        throw error;
      }
      if (Array.isArray(data) && data.length > 0) return data;
      return await this.getPublicPaketCatalog();
    }
  },

  _compactPaketForVarchar50(payload) {
    const out = { ...payload };
    const compactCsv = (val, maxLen, isKelas) => {
      if (!val || typeof val !== 'string' || val.length <= maxLen) return val;
      const parts = val.split(',').map(s => s.trim()).filter(Boolean);
      if (isKelas && parts.length > 1) {
        const firstT = parts[0].split(/[\s\-_]+/)[0].toUpperCase();
        if (['X', 'XI', 'XII', '10', '11', '12'].includes(firstT) && parts.every(k => k.split(/[\s\-_]+/)[0].toUpperCase() === firstT)) {
          return `TINGKAT:${firstT}`;
        }
      }
      let acc = '';
      for (const p of parts) {
        const next = acc ? `${acc}, ${p}` : p;
        if (next.length > maxLen) break;
        acc = next;
      }
      return acc || val.slice(0, maxLen);
    };
    if (out.kelas) out.kelas = compactCsv(out.kelas, 50, true);
    if (out.jurusan) out.jurusan = compactCsv(out.jurusan, 50, false);
    if (out.nama_paket && out.nama_paket.length > 150) out.nama_paket = out.nama_paket.slice(0, 150);
    return out;
  },

  async savePaket(id, payload) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PAKET')) || [];
      if (id) {
        const idx = list.findIndex(p => p.id === id);
        if (idx !== -1) list[idx] = { ...list[idx], ...payload };
      } else {
        payload.id = this.uuidv4();
        payload.created_at = new Date().toISOString();
        list.push(payload);
      }
      localStorage.setItem('CBT_LOCAL_PAKET', JSON.stringify(list));
      return payload;
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const runUpsert = async (c, isUpdate, targetId, dataObj) => {
        // Pastikan sesi Admin aktif terlebih dahulu karena UPDATE yang diblokir RLS tidak melempar error di PostgREST (hanya mengupdate 0 baris)
        await this.ensureAdminAuth(c);
        try {
          if (isUpdate) {
            const { data: uRows, error } = await c.from('paket_soal').update(dataObj).eq('id', targetId).select('id');
            if (error) throw error;
            if (!Array.isArray(uRows) || uRows.length === 0) {
              // Jika paket belum ada di shard ini, lakukan upsert agar semua shard seragam
              const { error: upErr } = await c.from('paket_soal').upsert({ ...dataObj, id: targetId }, { onConflict: 'id' });
              if (upErr) throw upErr;
            }
          } else {
            const { error } = await c.from('paket_soal').insert(dataObj);
            if (error) throw error;
          }
          return true;
        } catch (err) {
          const msg = String(err && (err.message || err.details || '')).toLowerCase();
          if ((err && err.code === '22001') || msg.includes('value too long for type character varying')) {
            const compactObj = this._compactPaketForVarchar50(dataObj);
            if (isUpdate) {
              const { error: e2 } = await c.from('paket_soal').update(compactObj).eq('id', targetId);
              if (e2) throw e2;
            } else {
              const { error: e2 } = await c.from('paket_soal').insert(compactObj);
              if (e2) throw e2;
            }
            return true;
          }
          throw err;
        }
      };

      if (shards.length > 1) {
        const insertPayload = id ? { ...payload, id } : { ...payload, id: payload.id || this.uuidv4() };
        // Broadcast ke semua server Supabase agar paket soal selalu seragam dengan ID yang sama
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return null;
          return await this.executeWithAdminAuth(shard.client, (c) => runUpsert(c, Boolean(id), id, insertPayload));
        }));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        try {
          const freshList = await this.getPaketList();
          if (Array.isArray(freshList) && freshList.length > 0) await this.syncPublicPaketCatalog(freshList);
        } catch (e) {}
        return insertPayload;
      }
      return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
        await runUpsert(c, Boolean(id), id, payload);
        try {
          const freshList = await this.getPaketList();
          if (Array.isArray(freshList) && freshList.length > 0) await this.syncPublicPaketCatalog(freshList);
        } catch (e) {}
        return payload;
      });
    }
  },

  async deletePaket(id) {
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_PAKET')) || [];
      list = list.filter(p => p.id !== id);
      localStorage.setItem('CBT_LOCAL_PAKET', JSON.stringify(list));

      // Cascade delete soal
      let soal = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      soal = soal.filter(s => s.paket_soal_id !== id);
      localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(soal));
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const doDelete = async (client) => {
        await this.ensureAdminAuth(client);
        return await this.executeWithAdminAuth(client, async (c) => {
          const { error } = await c.from('paket_soal').delete().eq('id', id);
          if (error) throw error;
          return true;
        });
      };
      if (shards.length > 1) {
        await Promise.allSettled(shards.map(s => s.client && doDelete(s.client)));
        try {
          const freshList = await this.getPaketList();
          await this.syncPublicPaketCatalog(freshList || []);
        } catch (e) {}
        return;
      }
      await doDelete(window.supabaseClient);
      try {
        const freshList = await this.getPaketList();
        await this.syncPublicPaketCatalog(freshList || []);
      } catch (e) {}
    }
  },

  async getSoalByPaket(paketId) {
    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      return list
        .filter(s => s.paket_soal_id === paketId && s.id !== this.GURU_SYS_ROW_ID && s.id !== this.MASTER_SYS_ROW_ID && s.id !== this.PAKET_SYS_ROW_ID && s.id !== this.SETTINGS_SYS_ROW_ID && s.id !== this.PENGAWAS_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__' && s.opsi_a !== '__CBT_SYS_MASTER__' && s.opsi_a !== '__CBT_SYS_PAKET__' && s.opsi_a !== '__CBT_SYS_SETTINGS__' && s.opsi_a !== '__CBT_SYS_PENGAWAS__')
        .sort((a,b) => a.nomor - b.nomor);
    } else {
      const { data, error } = await window.supabaseClient
        .from('soal')
        .select('*')
        .eq('paket_soal_id', paketId)
        .order('nomor', { ascending: true });
      if (error) throw error;
      return (data || []).filter(s => s.id !== this.GURU_SYS_ROW_ID && s.id !== this.MASTER_SYS_ROW_ID && s.id !== this.PAKET_SYS_ROW_ID && s.id !== this.SETTINGS_SYS_ROW_ID && s.id !== this.PENGAWAS_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__' && s.opsi_a !== '__CBT_SYS_MASTER__' && s.opsi_a !== '__CBT_SYS_PAKET__' && s.opsi_a !== '__CBT_SYS_SETTINGS__' && s.opsi_a !== '__CBT_SYS_PENGAWAS__' && s.nomor !== -999 && s.nomor !== -998 && s.nomor !== -997 && s.nomor !== -996 && s.nomor !== -995);
    }
  },

  async saveSoal(id, payload) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      if (id) {
        const idx = list.findIndex(s => s.id === id);
        if (idx !== -1) {
          list[idx] = { ...list[idx], ...payload };
        }
      } else {
        payload.id = this.uuidv4();
        payload.created_at = new Date().toISOString();
        list.push(payload);
      }
      localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(list));
      return payload;
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const insertPayload = id ? payload : { ...payload, id: payload.id || this.uuidv4() };

      const doSave = async (client, data) => {
        return await this.executeWithAdminAuth(client, async (c) => {
          try {
            if (id) {
              const { error } = await c.from('soal').update(data).eq('id', id);
              if (error) throw error;
            } else {
              const { error } = await c.from('soal').insert(data);
              if (error) throw error;
            }
          } catch (err) {
            // Jika kolom opsi_e belum dibuat di database Supabase oleh pengguna, fallback simpan tanpa opsi_e
            const msg = (err && (err.message || '')) + ' ' + (err && (err.details || ''));
            if (msg.includes('opsi_e')) {
              console.warn("[CBT] Kolom 'opsi_e' belum dibuat di Supabase. Menyimpan soal tanpa kolom opsi_e...");
              const fallbackData = { ...data };
              delete fallbackData.opsi_e;
              if (id) {
                const { error } = await c.from('soal').update(fallbackData).eq('id', id);
                if (error) throw error;
              } else {
                const { error } = await c.from('soal').insert(fallbackData);
                if (error) throw error;
              }
              return true;
            }
            throw err;
          }
          return true;
        });
      };

      if (shards.length > 1) {
        const results = await Promise.allSettled(shards.map(shard => shard.client ? doSave(shard.client, insertPayload) : null));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        return insertPayload;
      }

      await doSave(window.supabaseClient, insertPayload);
      return insertPayload;
    }
  },

  async deleteSoal(id) {
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      list = list.filter(s => s.id !== id);
      localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(list));
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const doDelete = async (client) => {
        return await this.executeWithAdminAuth(client, async (c) => {
          const { error } = await c.from('soal').delete().eq('id', id);
          if (error) throw error;
          return true;
        });
      };
      if (shards.length > 1) {
        await Promise.allSettled(shards.map(s => s.client && doDelete(s.client)));
        return;
      }
      await doDelete(window.supabaseClient);
    }
  },

  async bulkInsertSoal(soalList) {
    const preparedList = (soalList || []).map(s => ({
      ...s,
      id: s.id || this.uuidv4(),
      created_at: s.created_at || new Date().toISOString()
    }));
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      list.push(...preparedList);
      localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(list));
      return preparedList;
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];

      const doBulk = async (client, list) => {
        return await this.executeWithAdminAuth(client, async (c) => {
          try {
            const { error } = await c.from('soal').insert(list);
            if (error) throw error;
          } catch (err) {
            const msg = (err && (err.message || '')) + ' ' + (err && (err.details || ''));
            if (msg.includes('opsi_e')) {
              console.warn("[CBT] Kolom 'opsi_e' belum dibuat di Supabase. Menyimpan bulk soal tanpa opsi_e...");
              const fallbackList = list.map(item => {
                const copy = { ...item };
                delete copy.opsi_e;
                return copy;
              });
              const { error } = await c.from('soal').insert(fallbackList);
              if (error) throw error;
              return true;
            }
            throw err;
          }
          return true;
        });
      };

      if (shards.length > 1) {
        await Promise.allSettled(shards.map(s => s.client && doBulk(s.client, preparedList)));
        return preparedList;
      }
      await doBulk(window.supabaseClient, preparedList);
      return preparedList;
    }
  },

  // -------------------------------------------------------------
  // HARI EXAM RESULTS (HASIL UJIAN)
  // -------------------------------------------------------------
  async getHasilList() {
    if (this.isLocal()) {
      this.initLocalData();
      const hasil = JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [];
      const peserta = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const paket = JSON.parse(localStorage.getItem('CBT_LOCAL_PAKET')) || [];
      
      // Mimic Joined Supabase results mapping
      return hasil.map(h => {
        const p = peserta.find(item => item.id === h.peserta_id);
        const pk = paket.find(item => item.id === h.paket_soal_id);
        return {
          ...h,
          nama_mapel: pk ? pk.nama_paket : (h.nama_mapel || 'Umum'),
          peserta: p ? {
            id: p.id,
            username: p.username,
            nama_lengkap: p.nama_lengkap,
            kelas: p.kelas,
            jurusan: p.jurusan
          } : null
        };
      });
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        // Tarik data seluruh hasil ujian dari ke-5 server secara paralel beserta nama mapel (paket_soal)
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return [];
          const { data, error } = await shard.client
            .from('hasil_ujian')
            .select(`
              id,
              peserta_id,
              paket_soal_id,
              jumlah_benar,
              jumlah_salah,
              nilai,
              status_kelulusan,
              waktu_selesai,
              peserta:peserta_id (
                id,
                username,
                nama_lengkap,
                kelas,
                jurusan
              ),
              paket_soal:paket_soal_id (
                id,
                nama_paket
              )
            `)
            .order('nilai', { ascending: false });
          if (error) {
            console.warn(`Gagal mengambil hasil ujian dari ${shard.name}:`, error);
            return [];
          }
          return (data || []).map(h => ({
            ...h,
            nama_mapel: (h.paket_soal && h.paket_soal.nama_paket) ? h.paket_soal.nama_paket : (h.nama_mapel || 'Umum'),
            _shardId: shard.id,
            _shardName: shard.name
          }));
        }));

        let merged = [];
        results.forEach(res => {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            merged = merged.concat(res.value);
          }
        });
        merged.sort((a, b) => (parseFloat(b.nilai) || 0) - (parseFloat(a.nilai) || 0));
        return merged;
      }

      const { data, error } = await window.supabaseClient
        .from('hasil_ujian')
        .select(`
          id,
          peserta_id,
          paket_soal_id,
          jumlah_benar,
          jumlah_salah,
          nilai,
          status_kelulusan,
          waktu_selesai,
          peserta:peserta_id (
            id,
            username,
            nama_lengkap,
            kelas,
            jurusan
          ),
          paket_soal:paket_soal_id (
            id,
            nama_paket
          )
        `)
        .order('nilai', { ascending: false });
      if (error) throw error;
      const activeId = window.getActiveSupabaseShardId();
      const activeShard = shards.find(s => String(s.id) === String(activeId));
      const activeName = activeShard ? activeShard.name : '';
      return (data || []).map(h => ({
        ...h,
        nama_mapel: (h.paket_soal && h.paket_soal.nama_paket) ? h.paket_soal.nama_paket : (h.nama_mapel || 'Umum'),
        _shardId: activeId,
        _shardName: activeName
      }));
    }
  },

  async checkExistingHasil(pesertaId, paketSoalId = null) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [];
      return list.find(h => h.peserta_id === pesertaId && (!paketSoalId || h.paket_soal_id === paketSoalId)) || null;
    } else {
      let query = window.supabaseClient
        .from('hasil_ujian')
        .select('*')
        .eq('peserta_id', pesertaId);
      if (paketSoalId) {
        query = query.eq('paket_soal_id', paketSoalId);
      }
      const { data, error } = await query.limit(1);
      if (error) throw error;
      return (data && data.length > 0) ? data[0] : null;
    }
  },

  async insertHasil(pesertaId, benar, salah, nilai, status, start, end, paketSoalId = null) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [];
      
      // Prevent duplicates per paket
      const exists = list.findIndex(h => h.peserta_id === pesertaId && (!paketSoalId || h.paket_soal_id === paketSoalId));
      const payload = {
        id: this.uuidv4(),
        peserta_id: pesertaId,
        paket_soal_id: paketSoalId,
        jumlah_benar: benar,
        jumlah_salah: salah,
        nilai: nilai,
        status_kelulusan: status,
        waktu_mulai: start,
        waktu_selesai: end,
        created_at: new Date().toISOString()
      };

      if (exists !== -1) {
        list[exists] = payload;
      } else {
        list.push(payload);
      }
      localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify(list));
      return payload;
    } else {
      const insertPayload = {
        peserta_id: pesertaId,
        paket_soal_id: paketSoalId || null,
        jumlah_benar: benar,
        jumlah_salah: salah,
        nilai: nilai,
        status_kelulusan: status,
        waktu_mulai: start,
        waktu_selesai: end
      };
      const { data, error } = await window.supabaseClient
        .from('hasil_ujian')
        .insert(insertPayload);
      if (error) {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { data: retryData, error: retryErr } = await c.from('hasil_ujian').insert(insertPayload);
          if (retryErr) throw retryErr;
          return retryData;
        });
      }
      return data;
    }
  },

  async resetHasilUjian(hasilId, pesertaId, shardId = null) {
    if (this.isLocal()) {
      // 1. Wipe hasil
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [];
      list = list.filter(h => h.id !== hasilId);
      localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify(list));

      // 2. Wipe answers
      let answers = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      answers = answers.filter(a => a.peserta_id !== pesertaId);
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(answers));

      // 3. Set status
      await this.updateStatusUjian(pesertaId, 'Belum Ujian');
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const targetShards = shardId ? shards.filter(s => String(s.id) === String(shardId)) : (shards.length > 0 ? shards : [{ client: window.supabaseClient }]);
      await Promise.allSettled(targetShards.map(async (shard) => {
        const client = shard.client || window.supabaseClient;
        if (!client) return;
        await this.ensureAdminAuth(client);
        await this.executeWithAdminAuth(client, async (c) => {
          if (hasilId) await c.from('hasil_ujian').delete().eq('id', hasilId);
          if (pesertaId) {
            await c.from('jawaban_peserta').delete().eq('peserta_id', pesertaId);
            const useTok = !this._hasNoSessionCol(c);
            const uPayload = useTok
              ? { status_ujian: 'Belum Ujian', pelanggaran: 0, is_locked: false, active_session_token: null }
              : { status_ujian: 'Belum Ujian', pelanggaran: 0, is_locked: false };
            const { error: uErr } = await c.from('peserta').update(uPayload).eq('id', pesertaId);
            if (uErr && useTok && this._isMissingSessionColError(uErr)) {
              this._markNoSessionCol(c);
              await c.from('peserta').update({ status_ujian: 'Belum Ujian', pelanggaran: 0, is_locked: false }).eq('id', pesertaId);
            }
          }
        });
      }));
    }
  },

  async resetPesertaSesi(pesertaId, shardId = null) {
    if (this.isLocal()) {
      let answers = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      answers = answers.filter(a => a.peserta_id !== pesertaId);
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(answers));

      let hasil = JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [];
      hasil = hasil.filter(h => h.peserta_id !== pesertaId);
      localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify(hasil));

      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].status_ujian = 'Belum Ujian';
        list[idx].pelanggaran = 0;
        list[idx].is_locked = false;
        list[idx].active_session_token = null;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const targetShards = shardId ? shards.filter(s => String(s.id) === String(shardId)) : (shards.length > 0 ? shards : [{ client: window.supabaseClient }]);
      await Promise.allSettled(targetShards.map(async (shard) => {
        const client = shard.client || window.supabaseClient;
        if (!client) return;
        await this.ensureAdminAuth(client);
        await this.executeWithAdminAuth(client, async (c) => {
          await c.from('jawaban_peserta').delete().eq('peserta_id', pesertaId);
          await c.from('hasil_ujian').delete().eq('peserta_id', pesertaId);
          const { error: uErr } = await c.from('peserta').update({
            status_ujian: 'Belum Ujian',
            pelanggaran: 0,
            is_locked: false,
            active_session_token: null
          }).eq('id', pesertaId);
          if (uErr && this._isMissingSessionColError(uErr)) {
            await c.from('peserta').update({
              status_ujian: 'Belum Ujian',
              pelanggaran: 0,
              is_locked: false
            }).eq('id', pesertaId);
          }
        });
      }));
    }
  },

  async bukaSesiMapelBaru() {
    return await this.resetSemuaPeserta({ mode: 'sesi_aman', pesertaIds: null });
  },

  async bersihkanHasilSimulasi() {
    return await this.resetSemuaPeserta({ mode: 'reset_total', pesertaIds: null });
  },

  /**
   * Reset Massal Peserta Ujian (mendukung Multi-Shard Supabase, Local, & PHP)
   * @param {Object} options
   * @param {'sesi_aman'|'login_lock'|'reset_total'} options.mode
   *   - 'login_lock' : Lepas kunci login perangkat & buka blokir pelanggaran (jawaban & nilai tetap utuh)
   *   - 'sesi_aman'  : Kembalikan status ke 'Belum Ujian', buka kunci, & hapus jawaban sementara (nilai di hasil_ujian tetap utuh)
   *   - 'reset_total': Hapus hasil_ujian + jawaban_peserta & kembalikan status seluruh peserta ke 'Belum Ujian' (akun peserta tetap utuh)
   * @param {Array<string>|null} options.pesertaIds Jika diisi array ID, hanya mereset peserta tersebut; jika null, mereset seluruh peserta.
   */
  async resetSemuaPeserta(options = {}) {
    const mode = options.mode || 'sesi_aman';
    const subsetIds = Array.isArray(options.pesertaIds) && options.pesertaIds.length > 0
      ? Array.from(new Set(options.pesertaIds.map(id => String(id).trim()).filter(Boolean)))
      : null;

    if (this.isLocal()) {
      const idSet = subsetIds ? new Set(subsetIds) : null;
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      list.forEach(p => {
        if (idSet && !idSet.has(String(p.id))) return;
        if (mode !== 'login_lock') {
          p.status_ujian = 'Belum Ujian';
        }
        p.pelanggaran = 0;
        p.is_locked = false;
        p.active_session_token = null;
      });
      localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));

      if (mode === 'sesi_aman' || mode === 'reset_total') {
        if (idSet) {
          const answers = (JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [])
            .filter(a => !idSet.has(String(a.peserta_id)));
          localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(answers));
        } else {
          localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify([]));
        }
      }

      if (mode === 'reset_total') {
        if (idSet) {
          const hasil = (JSON.parse(localStorage.getItem('CBT_LOCAL_HASIL')) || [])
            .filter(h => !idSet.has(String(h.peserta_id)));
          localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify(hasil));
        } else {
          localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify([]));
        }
      }
      return { ok: true, mode, count: subsetIds ? subsetIds.length : list.length };
    }

    if (this.isPhp()) {
      return DB_PHP.resetSemuaPeserta.call(this, options);
    }

    // Mode Supabase (Multi-Shard atau Single Shard) dengan autentikasi Admin penuh di tiap server
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const targetShards = shards.length > 0 ? shards : [{ client: window.supabaseClient }];
    const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

    const chunkArray = (arr, size = 100) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
      }
      return out;
    };

    const pesertaPayloadWithToken = mode === 'login_lock'
      ? { pelanggaran: 0, is_locked: false, active_session_token: null }
      : { status_ujian: 'Belum Ujian', pelanggaran: 0, is_locked: false, active_session_token: null };

    const pesertaPayloadFallback = mode === 'login_lock'
      ? { pelanggaran: 0, is_locked: false }
      : { status_ujian: 'Belum Ujian', pelanggaran: 0, is_locked: false };

    await Promise.allSettled(targetShards.map(async (shard) => {
      const client = shard.client || window.supabaseClient;
      if (!client) return;
      await this.ensureAdminAuth(client);
      await this.executeWithAdminAuth(client, async (c) => {
        if (subsetIds) {
          const chunks = chunkArray(subsetIds, 100);
          for (const ids of chunks) {
            if (mode === 'reset_total') {
              try { await c.from('hasil_ujian').delete().in('peserta_id', ids); } catch (e) {}
            }
            if (mode === 'sesi_aman' || mode === 'reset_total') {
              try { await c.from('jawaban_peserta').delete().in('peserta_id', ids); } catch (e) {}
            }
            const { error: uErr } = await c.from('peserta').update(pesertaPayloadWithToken).in('id', ids);
            if (uErr && this._isMissingSessionColError(uErr)) {
              await c.from('peserta').update(pesertaPayloadFallback).in('id', ids);
            }
          }
        } else {
          if (mode === 'reset_total') {
            try { await c.from('hasil_ujian').delete().neq('id', ZERO_UUID); } catch (e) {}
          }
          if (mode === 'sesi_aman' || mode === 'reset_total') {
            try { await c.from('jawaban_peserta').delete().neq('id', ZERO_UUID); } catch (e) {}
          }
          const { error: uErr } = await c.from('peserta').update(pesertaPayloadWithToken).neq('id', ZERO_UUID);
          if (uErr && this._isMissingSessionColError(uErr)) {
            await c.from('peserta').update(pesertaPayloadFallback).neq('id', ZERO_UUID);
          }
        }
      });
    }));

    return { ok: true, mode };
  },

  // -------------------------------------------------------------
  // STUDENT ANSWERS (JAWABAN PESERTA)
  // -------------------------------------------------------------
  async getJawabanList(pesertaId) {
    if (this.isLocal()) {
      const answers = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      return answers.filter(a => a.peserta_id === pesertaId);
    } else {
      const { data, error } = await window.supabaseClient
        .from('jawaban_peserta')
        .select('*')
        .eq('peserta_id', pesertaId);
      if (error) throw error;
      return data;
    }
  },

  async syncJawaban(pesertaId, soalId, option, isCorrect, isRagu) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      const idx = list.findIndex(a => a.peserta_id === pesertaId && a.soal_id === soalId);
      const payload = {
        id: this.uuidv4(),
        peserta_id: pesertaId,
        soal_id: soalId,
        jawaban: option,
        benar: isCorrect,
        ragu_ragu: isRagu,
        created_at: new Date().toISOString()
      };

      if (idx !== -1) {
        list[idx] = payload;
      } else {
        list.push(payload);
      }
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(list));
      return payload;
    } else {
      const upsertPayload = {
        peserta_id: pesertaId,
        soal_id: soalId,
        jawaban: option,
        benar: isCorrect,
        ragu_ragu: isRagu,
        created_at: new Date().toISOString()
      };
      const { data, error } = await window.supabaseClient
        .from('jawaban_peserta')
        .upsert(upsertPayload, { onConflict: 'peserta_id,soal_id' });
      if (error) {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { data: retryData, error: retryErr } = await c
            .from('jawaban_peserta')
            .upsert(upsertPayload, { onConflict: 'peserta_id,soal_id' });
          if (retryErr) throw retryErr;
          return retryData;
        });
      }
      return data;
    }
  },

  async syncJawabanBatch(pesertaId, answersArray) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      answersArray.forEach(ans => {
        const idx = list.findIndex(a => a.peserta_id === pesertaId && a.soal_id === ans.soal_id);
        const payload = {
          id: this.uuidv4(),
          peserta_id: pesertaId,
          soal_id: ans.soal_id,
          jawaban: ans.jawaban,
          benar: ans.benar || false,
          ragu_ragu: ans.ragu_ragu || false,
          created_at: new Date().toISOString()
        };
        if (idx !== -1) {
          list[idx] = payload;
        } else {
          list.push(payload);
        }
      });
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(list));
      return { ok: true, count: answersArray.length };
    } else {
      const payloads = answersArray.map(ans => ({
        peserta_id: pesertaId,
        soal_id: ans.soal_id,
        jawaban: ans.jawaban,
        benar: ans.benar || false,
        ragu_ragu: ans.ragu_ragu || false,
        created_at: new Date().toISOString()
      }));
      const { data, error } = await window.supabaseClient
        .from('jawaban_peserta')
        .upsert(payloads, { onConflict: 'peserta_id,soal_id' });
      if (error) {
        await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { error: retryErr } = await c
            .from('jawaban_peserta')
            .upsert(payloads, { onConflict: 'peserta_id,soal_id' });
          if (retryErr) throw retryErr;
        });
      }
      return { ok: true, count: answersArray.length };
    }
  },

  async deleteJawabanSoalIds(pesertaId, soalIds) {
    if (!soalIds || !soalIds.length) return { ok: true, deleted: 0 };
    if (this.isLocal()) {
      let list = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      const idSet = new Set(soalIds.map(String));
      list = list.filter(a => !(a.peserta_id === pesertaId && idSet.has(String(a.soal_id))));
      localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(list));
      return { ok: true, deleted: soalIds.length };
    }
    if (window.supabaseClient) {
      try {
        await window.supabaseClient
          .from('jawaban_peserta')
          .delete()
          .eq('peserta_id', pesertaId)
          .in('soal_id', soalIds);
      } catch (err) {
        console.warn("Gagal hapus jawaban_peserta di Supabase:", err);
      }
      return { ok: true, deleted: soalIds.length };
    }
    return { ok: true, deleted: soalIds.length };
  },

  // -------------------------------------------------------------
  // LOGIN / AUTH SIMULATION (LOCAL OR CLOUD)
  // -------------------------------------------------------------
  async loginAdmin(email, password) {
    if (this.isLocal()) {
      sessionStorage.removeItem('CBT_GURU_SESSION');
      // Mock local admin check
      if (email === 'admin@smkn1lempuing.sch.id' && password === 'admin123') {
        const adminUser = { id: 'admin-uuid-local', email: email, role: 'admin' };
        sessionStorage.setItem('CBT_SESSION', JSON.stringify(adminUser));
        return adminUser;
      } else {
        throw new Error("Email atau Password Admin salah (Demo mode admin: admin@smkn1lempuing.sch.id / admin123).");
      }
    } else {
      return await Auth.loginAdmin(email, password);
    }
  },

  async loginGuru(username, password) {
    if (this.isLocal()) {
      this.initLocalData();
      const guru = await this.verifyGuruCredentials(username, password);
      if (!guru) {
        throw new Error("Username atau Password Guru salah (Demo mode: guru_mtk / 123456).");
      }
      const guruSession = {
        id: guru.id,
        username: guru.username,
        email: `${guru.username}@guru.smkn1lempuing.sch.id`,
        nama_lengkap: guru.nama_lengkap,
        mapel_diampu: guru.mapel_diampu,
        jurusan_diampu: guru.jurusan_diampu || '',
        kelas_diampu: guru.kelas_diampu || '',
        paket_ids: guru.paket_ids || '[]',
        role: 'guru'
      };
      sessionStorage.setItem('CBT_SESSION', JSON.stringify(guruSession));
      sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(guruSession));
      return guruSession;
    } else {
      return await Auth.loginGuru(username, password);
    }
  },

  async loginPeserta(username, password, options = {}) {
    if (this.isLocal()) {
      this.initLocalData();
      const cleanUser = String(username || '').trim().replace(/\s+/g, '').toLowerCase();
      const cleanPass = String(password || '').trim();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const student = list.find(p => String(p.username || '').trim().replace(/\s+/g, '').toLowerCase() === cleanUser);
      if (!student) {
        throw new Error("Nomor Peserta tidak ditemukan.");
      }

      const inputHash = await this.sha256(cleanPass);
      const rawHash = await this.sha256(String(password || ''));
      if (student.password_hash !== inputHash && student.password_hash !== rawHash && student.password_hash !== cleanPass) {
        throw new Error("Password Peserta salah (Demo mode password: '123456').");
      }

      // Cek Single-Device Session Lock (Mode Lokal)
      if (typeof Auth !== 'undefined' && typeof Auth.validateSingleDeviceLock === 'function') {
        const lockCheck = Auth.validateSingleDeviceLock(student, options);
        if (lockCheck.blocked) {
          throw lockCheck.error;
        }
        student.active_session_token = lockCheck.newToken;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
        sessionStorage.setItem('CBT_ACTIVE_SESSION_TOKEN', lockCheck.newToken);
      }

      const sessionObj = { id: student.id, email: `${cleanUser}@cbt.smkn1lempuing.sch.id`, role: 'peserta', profile: student };
      sessionStorage.setItem('CBT_SESSION', JSON.stringify(sessionObj));
      return sessionObj;
    } else {
      return await Auth.loginPeserta(username, password, options);
    }
  },

  async checkSession(role) {
    if (this.isLocal()) {
      const sess = sessionStorage.getItem('CBT_SESSION') || sessionStorage.getItem('CBT_GURU_SESSION');
      const loginPage = role === 'admin' ? 'login-admin.html' : 'index.html';
      if (!sess) {
        window.location.href = loginPage;
        return null;
      }
      const user = JSON.parse(sess);
      if (role === 'admin' && (user.role === 'admin' || user.role === 'guru')) {
        return user;
      }
      if (user.role !== role) {
        window.location.href = `${loginPage}?error=unauthorized_${role}`;
        return null;
      }
      return user.role === 'peserta' ? { user: user, profile: user.profile } : user;
    } else {
      return await Auth.checkSession(role);
    }
  },

  async logout() {
    sessionStorage.removeItem('CBT_SESSION');
    sessionStorage.removeItem('CBT_GURU_SESSION');
    sessionStorage.removeItem('CBT_PESERTA_FALLBACK_SESSION');
    sessionStorage.removeItem('CBT_PESERTA_PROFILE_CACHE');
    await Auth.logout();
  },

  // -------------------------------------------------------------
  // EXTRA HELPERS (backup / bulk operations)
  // -------------------------------------------------------------
  async getSoalList(options = {}) {
    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      return list.filter(s => s.id !== this.GURU_SYS_ROW_ID && s.id !== this.MASTER_SYS_ROW_ID && s.id !== this.PAKET_SYS_ROW_ID && s.id !== this.SETTINGS_SYS_ROW_ID && s.id !== this.PENGAWAS_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__' && s.opsi_a !== '__CBT_SYS_MASTER__' && s.opsi_a !== '__CBT_SYS_PAKET__' && s.opsi_a !== '__CBT_SYS_SETTINGS__' && s.opsi_a !== '__CBT_SYS_PENGAWAS__' && s.nomor !== -999 && s.nomor !== -998 && s.nomor !== -997 && s.nomor !== -996 && s.nomor !== -995);
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const mergeAll = Boolean(options && options.forceAllShards) && shards.length > 1;
      const isSys = (s) => !s || s.id === this.GURU_SYS_ROW_ID || s.id === this.MASTER_SYS_ROW_ID || s.id === this.PAKET_SYS_ROW_ID || s.id === this.SETTINGS_SYS_ROW_ID || s.id === this.PENGAWAS_SYS_ROW_ID || s.opsi_a === '__CBT_SYS_GURU__' || s.opsi_a === '__CBT_SYS_MASTER__' || s.opsi_a === '__CBT_SYS_PAKET__' || s.opsi_a === '__CBT_SYS_SETTINGS__' || s.opsi_a === '__CBT_SYS_PENGAWAS__' || (typeof s.nomor === 'number' && s.nomor <= -990);

      if (mergeAll) {
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return [];
          const { data, error } = await shard.client.from('soal').select('*').order('nomor', { ascending: true });
          if (error) return [];
          return (data || []).filter(s => !isSys(s));
        }));
        const byId = new Map();
        results.forEach(res => {
          if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            res.value.forEach(s => {
              if (s && s.id && !byId.has(String(s.id))) byId.set(String(s.id), s);
            });
          }
        });
        return Array.from(byId.values()).sort((a, b) => (a.nomor || 0) - (b.nomor || 0));
      }

      const { data, error } = await window.supabaseClient
        .from('soal')
        .select('*')
        .order('nomor', { ascending: true });
      if (error) throw error;
      return (data || []).filter(s => !isSys(s));
    }
  },

  async deleteAllPeserta(list) {
    if (this.isLocal()) {
      localStorage.removeItem('CBT_LOCAL_PESERTA');
      localStorage.removeItem('CBT_LOCAL_HASIL');
      localStorage.removeItem('CBT_LOCAL_JAWABAN');
    } else {
      // Since there's no bulk delete RPC, loop through all participants
      for (const p of (list || [])) {
        await this.deletePeserta(p.id, p._shardId || null);
      }
    }
  },

  // Hitung rencana distribusi peserta ke beberapa server (default 5 server)
  computePesertaShardDistribution(pesertaList = [], strategy = 'auto_jurusan', shardsInput = null) {
    const rawShards = Array.isArray(shardsInput) && shardsInput.length > 0
      ? shardsInput
      : ((window.getSupabaseShards && window.getSupabaseShards()) || []);
    const shards = rawShards.length > 0
      ? rawShards
      : [{ id: 1, name: 'Server Utama', client: window.supabaseClient }];

    const buckets = shards.map((s, idx) => ({
      shardIndex: idx,
      shardId: s.id || (idx + 1),
      shardName: s.name || `Server ${idx + 1}`,
      shard: s,
      items: []
    }));

    const list = Array.isArray(pesertaList) ? pesertaList : [];
    if (list.length === 0) return buckets;

    if (strategy === 'preserve_shard') {
      const byId = new Map(buckets.map(b => [String(b.shardId), b]));
      list.forEach((p, i) => {
        const sid = p && (p._shardId || p.shard_id);
        if (sid && byId.has(String(sid))) {
          byId.get(String(sid)).items.push(p);
        } else {
          const autoTarget = (window.getShardForPeserta && window.getShardForPeserta(p.jurusan, p.sesi)) || null;
          const b = (autoTarget && byId.get(String(autoTarget.id))) || buckets[i % buckets.length];
          b.items.push(p);
        }
      });
      return buckets;
    }

    if (strategy === 'balanced_even') {
      // Kelompokkan per kelas agar 1 rombel tetap utuh di 1 server, lalu alokasikan ke server dengan beban paling sedikit
      const classGroups = new Map();
      list.forEach(p => {
        const kKey = String(p.kelas || p.jurusan || 'UMUM').replace(/\s+/g, ' ').trim().toUpperCase();
        if (!classGroups.has(kKey)) classGroups.set(kKey, []);
        classGroups.get(kKey).push(p);
      });
      const sortedGroups = Array.from(classGroups.entries())
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], undefined, { numeric: true }));

      const idealPerServer = Math.ceil(list.length / buckets.length);
      sortedGroups.forEach(([, groupStudents]) => {
        let minBucket = buckets[0];
        for (let i = 1; i < buckets.length; i++) {
          if (buckets[i].items.length < minBucket.items.length) {
            minBucket = buckets[i];
          }
        }
        // Pertahankan 1 rombel utuh di 1 server selama tidak membuat beban server tersebut timpang jauh di atas rata-rata
        if (buckets.length <= 1 || (minBucket.items.length + groupStudents.length) <= idealPerServer + 2) {
          minBucket.items.push(...groupStudents);
        } else {
          groupStudents.forEach(st => {
            let bLeast = buckets[0];
            for (let i = 1; i < buckets.length; i++) {
              if (buckets[i].items.length < bLeast.items.length) bLeast = buckets[i];
            }
            bLeast.items.push(st);
          });
        }
      });
      return buckets;
    }

    // Default: 'auto_jurusan' — cocokkan dengan aturan jurusan/sesi di config.js; sisanya dibagi rata ke server paling kosong!
    const byId = new Map(buckets.map(b => [String(b.shardId), b]));
    const unmatchedByKelas = new Map();
    const matchByExplicitKeywords = (p) => {
      if (buckets.length <= 1) return buckets[0];
      const j = String(p.jurusan || '').toUpperCase();
      const s = String(p.sesi || '').toUpperCase();
      for (const b of buckets) {
        const sName = (b.shardName || '').toUpperCase();
        if (j) {
          if (j.includes('TKJ') && sName.includes('TKJ')) return b;
          if (j.includes('ATP') && sName.includes('ATP')) return b;
          if (j.includes('TKRO') && sName.includes('TKRO')) return b;
          if (j.includes('TBSM') && sName.includes('TBSM')) return b;
          if ((j.includes('AKL') || j.includes('AKUN')) && (sName.includes('AKL') || sName.includes('AKUN'))) return b;
          if (j.includes('MM') && sName.includes('MM')) return b;
          if (j.includes('RPL') && sName.includes('RPL')) return b;
        }
      }
      for (const b of buckets) {
        const sName = (b.shardName || '').toUpperCase();
        if (s && sName.includes(s)) return b;
      }
      return null;
    };

    list.forEach(p => {
      const matched = matchByExplicitKeywords(p);
      if (matched) {
        matched.items.push(p);
      } else {
        const kKey = String(p.kelas || p.jurusan || 'LAINNYA').replace(/\s+/g, ' ').trim().toUpperCase();
        if (!unmatchedByKelas.has(kKey)) unmatchedByKelas.set(kKey, []);
        unmatchedByKelas.get(kKey).push(p);
      }
    });

    // Untuk siswa yang jurusannya belum ada di nama server, sebarkan merata ke server yang paling sedikit bebannya
    Array.from(unmatchedByKelas.values()).forEach(groupStudents => {
      let minBucket = buckets[0];
      for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].items.length < minBucket.items.length) minBucket = buckets[i];
      }
      minBucket.items.push(...groupStudents);
    });

    // Pastikan shard id map tetap valid bila dipanggil eksternal
    void byId;
    return buckets;
  },

  // Kumpulkan cadangan SELURUH DATA dari seluruh server (5 shard sekaligus)
  async collectFullBackupData(options = {}, onProgress = null) {
    const includeAnswers = options.includeAnswers !== false;
    const includeHasil = options.includeHasil !== false;
    const report = (pct, msg) => {
      if (typeof onProgress === 'function') onProgress(pct, msg);
    };

    report(5, 'Mengautentikasi akses ke seluruh server...');
    await this.ensureAllShardsAdminAuth();

    report(15, 'Mengambil Master Jurusan, Kelas, Guru & Pengaturan...');
    const [jurusan, kelas, guru, paket, settings, branding, masterCat, pengawasReg] = await Promise.all([
      this.getJurusanList().catch(() => []),
      this.getKelasList().catch(() => []),
      this.getGuruList().catch(() => []),
      this.getPaketList().catch(() => []),
      this.getSettings().catch(() => null),
      this.getCardBranding().catch(() => null),
      this.getMasterCatalog().catch(() => ({ kelas: [], jurusan: [] })),
      this.getPengawasRegistry().catch(() => null)
    ]);

    report(35, 'Mengambil seluruh Bank Soal dari server...');
    const soal = await this.getSoalList({ forceAllShards: true }).catch(() => []);

    report(55, 'Mengambil seluruh Data Peserta dari ke-5 server...');
    const pesertaRaw = await this.getPesertaList({ forceAllShards: true }).catch(() => []);
    const pesertaById = new Map();
    const peserta = (pesertaRaw || []).map(p => {
      if (p && p.id) pesertaById.set(String(p.id), p);
      return {
        id: p.id,
        username: p.username,
        nama_lengkap: p.nama_lengkap,
        password_plain: p.password_plain || p.password || '',
        password_hash: p.password_hash || '',
        jurusan: p.jurusan || '',
        kelas: p.kelas || '',
        ruang: p.ruang || '',
        sesi: p.sesi || '',
        status_ujian: p.status_ujian || 'Belum Ujian',
        pelanggaran: parseInt(p.pelanggaran || 0),
        is_locked: Boolean(p.is_locked),
        created_at: p.created_at || null,
        _shardId: p._shardId || null,
        _shardName: p._shardName || ''
      };
    });

    let hasil = [];
    if (includeHasil) {
      report(72, 'Mengambil Rekap Hasil Ujian dari seluruh server...');
      const hasilRaw = await this.getHasilList().catch(() => []);
      hasil = (hasilRaw || []).map(h => {
        const pInfo = h.peserta || pesertaById.get(String(h.peserta_id)) || {};
        return {
          ...h,
          peserta_username: pInfo.username || '',
          peserta: h.peserta || (pInfo.username ? {
            id: pInfo.id,
            username: pInfo.username,
            nama_lengkap: pInfo.nama_lengkap,
            kelas: pInfo.kelas,
            jurusan: pInfo.jurusan
          } : null)
        };
      });
    }

    let jawaban_peserta = [];
    if (includeAnswers) {
      report(85, 'Mengambil detail jawaban peserta dari seluruh server...');
      if (this.isLocal()) {
        jawaban_peserta = JSON.parse(localStorage.getItem('CBT_LOCAL_JAWABAN')) || [];
      } else if (!this.isPhp()) {
        const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
        const targetShards = shards.length > 0 ? shards : [{ id: 1, name: 'Server Utama', client: window.supabaseClient }];
        const resArr = await Promise.allSettled(targetShards.map(async (sh) => {
          if (!sh.client) return [];
          await this.ensureAdminAuth(sh.client);
          const { data, error } = await sh.client.from('jawaban_peserta').select('*');
          if (error || !Array.isArray(data)) return [];
          return data.map(row => ({
            ...row,
            peserta_username: (pesertaById.get(String(row.peserta_id)) || {}).username || '',
            _shardId: sh.id || null
          }));
        }));
        resArr.forEach(r => {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            jawaban_peserta = jawaban_peserta.concat(r.value);
          }
        });
      }
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const shardSummary = shards.map(sh => ({
      id: sh.id,
      name: sh.name,
      url: sh.url,
      peserta_count: peserta.filter(p => String(p._shardId) === String(sh.id)).length,
      hasil_count: hasil.filter(h => String(h._shardId) === String(sh.id)).length
    }));

    report(98, 'Menyusun berkas cadangan lengkap...');
    return {
      version: '2.0',
      timestamp: new Date().toISOString(),
      school: 'SMK Negeri 1 Lempuing',
      backend: this.isPhp() ? 'php' : (this.isLocal() ? 'local' : 'supabase-multi-shard'),
      shard_summary: shardSummary,
      data: {
        peserta,
        paket_soal: paket || [],
        jurusan: jurusan || [],
        kelas: kelas || [],
        guru: guru || [],
        soal: soal || [],
        hasil_ujian: hasil || [],
        jawaban_peserta: jawaban_peserta || [],
        pengaturan_ujian: settings ? [settings] : [],
        card_branding: branding || null,
        master_catalog: masterCat || { kelas: [], jurusan: [] },
        pengawas_registry: pengawasReg || null
      }
    };
  },

  async restoreBackup(backupData, options = {}, onProgress = null) {
    const opts = {
      restoreMaster: options.restoreMaster !== false,
      restoreBankSoal: options.restoreBankSoal !== false,
      restorePeserta: options.restorePeserta !== false,
      restoreHasil: options.restoreHasil !== false,
      restoreAnswers: Boolean(options.restoreAnswers),
      clearExisting: options.clearExisting !== false,
      preserveStudentStatus: Boolean(options.preserveStudentStatus),
      distributionStrategy: options.distributionStrategy || 'auto_jurusan',
      defaultPassword: String(options.defaultPassword || '123456').trim() || '123456'
    };

    const report = (pct, msg) => {
      if (typeof onProgress === 'function') onProgress(pct, msg);
    };

    if (this.isLocal()) {
      report(20, 'Memulihkan data ke penyimpanan lokal browser...');
      if (opts.restoreBankSoal) {
        localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(backupData.soal || []));
        if (Array.isArray(backupData.paket_soal)) {
          localStorage.setItem('CBT_LOCAL_PAKET', JSON.stringify(backupData.paket_soal));
        }
      }
      if (opts.restoreMaster) {
        if (Array.isArray(backupData.jurusan)) localStorage.setItem('CBT_LOCAL_JURUSAN', JSON.stringify(backupData.jurusan));
        if (Array.isArray(backupData.kelas)) localStorage.setItem('CBT_LOCAL_KELAS', JSON.stringify(backupData.kelas));
        if (Array.isArray(backupData.guru)) localStorage.setItem('CBT_LOCAL_GURU', JSON.stringify(backupData.guru));
        if (Array.isArray(backupData.pengaturan_ujian) && backupData.pengaturan_ujian.length > 0) {
          localStorage.setItem('CBT_LOCAL_PENGATURAN', JSON.stringify(backupData.pengaturan_ujian[0]));
        }
        if (backupData.card_branding) {
          localStorage.setItem('CBT_CETAK_KARTU_BRANDING_V1', JSON.stringify(backupData.card_branding));
        }
      }
      if (opts.restorePeserta && Array.isArray(backupData.peserta)) {
        const cleanPeserta = backupData.peserta.map(p => ({
          ...p,
          password_plain: p.password_plain || p.password || opts.defaultPassword,
          password: p.password_plain || p.password || opts.defaultPassword,
          status_ujian: opts.preserveStudentStatus ? (p.status_ujian || 'Belum Ujian') : 'Belum Ujian',
          pelanggaran: opts.preserveStudentStatus ? parseInt(p.pelanggaran || 0) : 0,
          is_locked: opts.preserveStudentStatus ? Boolean(p.is_locked) : false
        }));
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(cleanPeserta));
      }
      if (opts.restoreHasil && Array.isArray(backupData.hasil_ujian)) {
        localStorage.setItem('CBT_LOCAL_HASIL', JSON.stringify(backupData.hasil_ujian));
      }
      if (opts.restoreAnswers && Array.isArray(backupData.jawaban_peserta)) {
        localStorage.setItem('CBT_LOCAL_JAWABAN', JSON.stringify(backupData.jawaban_peserta));
      }
      report(100, 'Pemulihan lokal selesai.');
      return { ok: true, shardReports: [{ id: 1, name: 'Lokal Browser', pesertaOk: (backupData.peserta || []).length, pesertaFail: 0 }] };
    }

    // Mode Supabase (Single atau Multi-Shard 5 Server sekaligus!)
    const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
    const sysIds = [
      this.GURU_SYS_ROW_ID,
      this.MASTER_SYS_ROW_ID,
      this.PAKET_SYS_ROW_ID,
      this.SETTINGS_SYS_ROW_ID,
      this.PENGAWAS_SYS_ROW_ID
    ].filter(Boolean);

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const targetShards = shards.length > 0
      ? shards.filter(s => s && s.client)
      : (window.supabaseClient ? [{ id: 1, name: 'Server Utama', client: window.supabaseClient }] : []);

    if (targetShards.length === 0) {
      throw new Error('Tidak ada server database Supabase yang aktif untuk dipulihkan.');
    }

    const chunkArr = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    report(5, `Menghubungkan & mengautentikasi ${targetShards.length} server sekaligus...`);
    await this.ensureAllShardsAdminAuth();

    // ---------------------------------------------------------
    // LANGKAH 1: SINKRONKAN MASTER DATA & PENGATURAN KE SEMUA SERVER (5 SERVER)
    // ---------------------------------------------------------
    if (opts.restoreMaster) {
      report(14, `Memulihkan Jurusan, Kelas, Guru & Pengaturan ke ${targetShards.length} server...`);
      const jurRows = (Array.isArray(backupData.jurusan) ? backupData.jurusan : [])
        .map(j => ({
          id: j.id || this.uuidv4(),
          nama_jurusan: String(j.nama_jurusan || j.nama || j.kode || '').trim().toUpperCase()
        }))
        .filter(j => j.nama_jurusan);

      const klsRows = (Array.isArray(backupData.kelas) ? backupData.kelas : [])
        .map(k => ({
          id: k.id || this.uuidv4(),
          nama_kelas: String(k.nama_kelas || k.nama || '').trim().toUpperCase()
        }))
        .filter(k => k.nama_kelas);

      const guruList = Array.isArray(backupData.guru) ? backupData.guru : [];
      const setArr = Array.isArray(backupData.pengaturan_ujian) ? backupData.pengaturan_ujian : [];
      const s0 = setArr[0] || null;

      await Promise.allSettled(targetShards.map(async (sh) => {
        await this.executeWithAdminAuth(sh.client, async (c) => {
          if (jurRows.length > 0) {
            if (opts.clearExisting) {
              try { await c.from('jurusan').delete().neq('id', ZERO_UUID); } catch (e) {}
            }
            for (const row of jurRows) {
              try {
                await c.from('jurusan').upsert(row, { onConflict: 'nama_jurusan' });
              } catch (e) {
                try { await c.from('jurusan').insert(row); } catch (e2) {}
              }
            }
          }

          if (klsRows.length > 0) {
            if (opts.clearExisting) {
              try { await c.from('kelas').delete().neq('id', ZERO_UUID); } catch (e) {}
            }
            for (const row of klsRows) {
              try {
                await c.from('kelas').upsert(row, { onConflict: 'nama_kelas' });
              } catch (e) {
                try { await c.from('kelas').insert(row); } catch (e2) {}
              }
            }
          }

          if (guruList.length > 0) {
            if (opts.clearExisting) {
              try { await c.from('guru').delete().neq('id', ZERO_UUID); } catch (e) {}
            }
            for (const g of guruList) {
              try {
                await c.from('guru').upsert({
                  id: g.id || this.uuidv4(),
                  username: String(g.username || '').trim().toLowerCase(),
                  password_hash: g.password_hash || '',
                  nama_lengkap: g.nama_lengkap || '',
                  mapel_diampu: g.mapel_diampu || '',
                  jurusan_diampu: g.jurusan_diampu || '',
                  kelas_diampu: g.kelas_diampu || '',
                  paket_ids: typeof g.paket_ids === 'string' ? g.paket_ids : JSON.stringify(g.paket_ids || []),
                  penugasan_mapel: typeof g.penugasan_mapel === 'string' ? g.penugasan_mapel : JSON.stringify(g.penugasan_mapel || [])
                }, { onConflict: 'id' });
              } catch (e) {}
            }
            try { await this._writeGuruToSysRow(c, guruList); } catch (e) {}
          }

          if (s0) {
            const setPayload = {
              id: 1,
              durasi_menit: Number(s0.durasi_menit) || 60,
              passing_grade: Number(s0.passing_grade) || 60,
              tampilkan_nilai: s0.tampilkan_nilai !== undefined ? Boolean(s0.tampilkan_nilai) : true,
              token_ujian: s0.token_ujian || 'CBT123',
              token_aktif: Boolean(s0.token_aktif),
              acak_soal: s0.acak_soal !== undefined ? Boolean(s0.acak_soal) : true,
              updated_at: s0.updated_at || new Date().toISOString()
            };
            try { await c.from('pengaturan_ujian').upsert(setPayload, { onConflict: 'id' }); } catch (e) {}
            const sysSet = {
              ...setPayload,
              card_branding: backupData.card_branding || s0.card_branding || null
            };
            try { await this._writeSettingsToSysRow(c, sysSet); } catch (e) {}
          } else if (backupData.card_branding) {
            try {
              const curSys = (await this._readSettingsFromSysRow(c)) || {};
              await this._writeSettingsToSysRow(c, { ...curSys, card_branding: backupData.card_branding });
            } catch (e) {}
          }

          if (backupData.master_catalog) {
            try { await this._writeMasterCatalogToSysRow(c, backupData.master_catalog); } catch (e) {}
          }
          if (backupData.pengawas_registry) {
            try { await this._writePengawasRegistryToSysRow(c, backupData.pengawas_registry); } catch (e) {}
          }
        });
      }));
    }

    // ---------------------------------------------------------
    // LANGKAH 2: SINKRONKAN PAKET SOAL & BANK SOAL KE SEMUA SERVER (5 SERVER)
    // ---------------------------------------------------------
    const validPaketIdSet = new Set();
    if (opts.restoreBankSoal) {
      const paketList = Array.isArray(backupData.paket_soal) ? backupData.paket_soal : [];
      const soalList = Array.isArray(backupData.soal) ? backupData.soal : [];

      report(28, `Menyebarkan ${paketList.length} Paket & ${soalList.length} Butir Soal ke ${targetShards.length} server...`);

      const cleanPakets = paketList
        .filter(p => p && p.nama_paket)
        .map(p => {
          const pid = p.id || this.uuidv4();
          validPaketIdSet.add(String(pid));
          return this._compactPaketForVarchar50({
            id: pid,
            nama_paket: p.nama_paket,
            jurusan: p.jurusan || null,
            kelas: p.kelas || null,
            jadwal_mulai: p.jadwal_mulai || null,
            jadwal_selesai: p.jadwal_selesai || null,
            created_at: p.created_at || new Date().toISOString()
          });
        });

      await Promise.allSettled(targetShards.map(async (sh) => {
        await this.executeWithAdminAuth(sh.client, async (c) => {
          if (opts.clearExisting) {
            // Hapus hanya soal asli (>= 0 / bukan baris registri sistem -999..-995) secara bertahap
            try {
              const { data: existingSoalIds } = await c.from('soal').select('id, nomor');
              const delIds = (existingSoalIds || [])
                .filter(row => row && row.id && !sysIds.includes(row.id) && (row.nomor === null || row.nomor >= 0))
                .map(row => row.id);
              for (const batch of chunkArr(delIds, 100)) {
                await c.from('soal').delete().in('id', batch);
              }
            } catch (e) {}

            if (cleanPakets.length > 0) {
              try { await c.from('paket_soal').delete().neq('id', ZERO_UUID); } catch (e) {}
            }
          }

          if (cleanPakets.length > 0) {
            for (const pkChunk of chunkArr(cleanPakets, 50)) {
              const { error: pkErr } = await c.from('paket_soal').upsert(pkChunk, { onConflict: 'id' });
              if (pkErr) throw pkErr;
            }
            try { await this._writePaketCatalogToSysRow(c, cleanPakets); } catch (e) {}
          }

          // Cek paket yang tersedia di server ini untuk menjamin foreign key soal valid
          const { data: existingPk } = await c.from('paket_soal').select('id');
          const serverPkSet = new Set((existingPk || []).map(x => String(x.id)));

          if (soalList.length > 0) {
            const cleanSoal = soalList
              .filter(s => s && !sysIds.includes(s.id) && (s.nomor === null || s.nomor === undefined || s.nomor >= 0))
              .map(s => {
                const sid = s.id || this.uuidv4();
                const row = {
                  id: sid,
                  paket_soal_id: (s.paket_soal_id && serverPkSet.has(String(s.paket_soal_id))) ? s.paket_soal_id : null,
                  nomor: s.nomor !== undefined ? s.nomor : 1,
                  pertanyaan: s.pertanyaan || '-',
                  opsi_a: s.opsi_a || '-',
                  opsi_b: s.opsi_b || '-',
                  opsi_c: s.opsi_c !== undefined ? s.opsi_c : null,
                  opsi_d: s.opsi_d !== undefined ? s.opsi_d : null,
                  opsi_e: s.opsi_e !== undefined ? s.opsi_e : null,
                  jawaban_benar: s.jawaban_benar || 'A',
                  bobot: parseInt(s.bobot || 1) || 1,
                  gambar: s.gambar || null
                };
                return row;
              });

            // Chunk kecil (15 baris) agar aman bila terdapat soal bergambar Base64
            for (const sBatch of chunkArr(cleanSoal, 15)) {
              try {
                const { error: sErr } = await c.from('soal').upsert(sBatch, { onConflict: 'id' });
                if (sErr) throw sErr;
              } catch (err) {
                const msg = ((err && err.message) || '') + ' ' + ((err && err.details) || '');
                if (msg.includes('opsi_e')) {
                  const noOptE = sBatch.map(item => {
                    const copy = { ...item };
                    delete copy.opsi_e;
                    return copy;
                  });
                  const { error: e2 } = await c.from('soal').upsert(noOptE, { onConflict: 'id' });
                  if (e2) throw e2;
                } else {
                  throw err;
                }
              }
            }
          }
        });
      }));
    }

    // ---------------------------------------------------------
    // LANGKAH 3: BAGI & PULIHKAN DATA PESERTA KE 5 SERVER SEKALIGUS
    // ---------------------------------------------------------
    const shardReports = targetShards.map((sh, idx) => ({
      shardIndex: idx,
      id: sh.id || (idx + 1),
      name: sh.name || `Server ${idx + 1}`,
      planned: 0,
      pesertaOk: 0,
      pesertaFail: 0,
      hasilOk: 0,
      jawabanOk: 0,
      errors: []
    }));

    // Map usernameLower -> { pesertaId, shardIndex, client } untuk keperluan restore hasil & jawaban
    const restoredPesertaMap = new Map();

    if (opts.restorePeserta) {
      const pesertaSource = Array.isArray(backupData.peserta) ? backupData.peserta : [];

      if (opts.clearExisting) {
        report(42, `Membersihkan peserta lama di ${targetShards.length} server sebelum membagi ulang...`);
        await Promise.allSettled(targetShards.map(async (sh) => {
          await this.executeWithAdminAuth(sh.client, async (c) => {
            try { await c.from('jawaban_peserta').delete().neq('id', ZERO_UUID); } catch (e) {}
            try { await c.from('hasil_ujian').delete().neq('id', ZERO_UUID); } catch (e) {}
            const { data: oldPeserta } = await c.from('peserta').select('id');
            const oldIds = (oldPeserta || []).map(x => x.id).filter(Boolean);
            for (const idBatch of chunkArr(oldIds, 12)) {
              await Promise.allSettled(idBatch.map(pid => c.rpc('delete_peserta_user', { p_peserta_id: pid })));
            }
          });
        }));
      }

      if (pesertaSource.length > 0) {
        const buckets = this.computePesertaShardDistribution(pesertaSource, opts.distributionStrategy, targetShards);
        let processedCount = 0;
        const totalPeserta = pesertaSource.length;

        report(50, `Membagi ${totalPeserta} peserta ke ${targetShards.length} server sekaligus...`);

        await Promise.allSettled(buckets.map(async (bucket) => {
          const rep = shardReports[bucket.shardIndex];
          rep.planned = bucket.items.length;
          if (bucket.items.length === 0) return;

          const client = bucket.shard.client;
          await this.ensureAdminAuth(client);

          // Proses paralel 6 akun per gelombang di setiap server (5 server x 6 = 30 paralel serentak)
          for (const wave of chunkArr(bucket.items, 6)) {
            await Promise.allSettled(wave.map(async (p) => {
              const cleanUser = String(p.username || '').trim().replace(/\s+/g, '').toLowerCase();
              const cleanPass = String(p.password_plain || p.password || opts.defaultPassword).trim() || opts.defaultPassword;
              const cleanNama = String(p.nama_lengkap || cleanUser).trim();
              const cleanJurusan = String(p.jurusan || '').trim();
              const cleanKelas = String(p.kelas || '').trim();
              const cleanRuang = String(p.ruang || '').trim();
              const cleanSesi = String(p.sesi || '').trim();

              if (!cleanUser) {
                rep.pesertaFail++;
                return;
              }

              try {
                let actualId = null;
                await this.executeWithAdminAuth(client, async (c) => {
                  const { data: createdId, error: cErr } = await c.rpc('create_peserta_user', {
                    p_username: cleanUser,
                    p_password: cleanPass,
                    p_nama_lengkap: cleanNama,
                    p_jurusan: cleanJurusan,
                    p_kelas: cleanKelas,
                    p_ruang: cleanRuang,
                    p_sesi: cleanSesi
                  });

                  if (!cErr && createdId) {
                    actualId = createdId;
                  } else {
                    const errMsg = ((cErr && cErr.message) || '') + ' ' + ((cErr && cErr.details) || '');
                    if (errMsg.toLowerCase().includes('duplicate') || errMsg.toLowerCase().includes('unique') || errMsg.toLowerCase().includes('already exists')) {
                      const { data: existing } = await c.from('peserta').select('id').ilike('username', cleanUser).maybeSingle();
                      if (existing && existing.id) {
                        actualId = existing.id;
                        const passHash = await this.sha256(cleanPass);
                        await c.from('peserta').update({
                          username: cleanUser,
                          password_hash: passHash,
                          password_plain: cleanPass,
                          nama_lengkap: cleanNama,
                          jurusan: cleanJurusan,
                          kelas: cleanKelas,
                          ruang: cleanRuang,
                          sesi: cleanSesi
                        }).eq('id', actualId);
                        try {
                          await c.rpc('update_peserta_password', { p_peserta_id: actualId, p_password: cleanPass });
                        } catch (ePass) {}
                      } else {
                        throw cErr;
                      }
                    } else {
                      throw cErr || new Error('Gagal membuat akun peserta');
                    }
                  }

                  if (actualId && opts.preserveStudentStatus) {
                    const st = ['Belum Ujian', 'Sedang Ujian', 'Sudah Ujian'].includes(p.status_ujian) ? p.status_ujian : 'Belum Ujian';
                    await c.from('peserta').update({
                      status_ujian: st,
                      pelanggaran: parseInt(p.pelanggaran || 0) || 0,
                      is_locked: Boolean(p.is_locked)
                    }).eq('id', actualId);
                  }
                });

                if (actualId) {
                  restoredPesertaMap.set(cleanUser, { id: actualId, shardIndex: bucket.shardIndex, client });
                  rep.pesertaOk++;
                } else {
                  rep.pesertaFail++;
                }
              } catch (err) {
                rep.pesertaFail++;
                if (rep.errors.length < 5) rep.errors.push(`${cleanUser}: ${err.message || 'Gagal'}`);
              } finally {
                processedCount++;
                const pct = 50 + Math.round((processedCount / totalPeserta) * 35);
                report(Math.min(85, pct), `Membagi peserta ke ${targetShards.length} server (${processedCount}/${totalPeserta})...`);
              }
            }));
          }
        }));
      }
    }

    // Jika peserta tidak ikut di-restore tetapi hasil ingin dipulihkan, indeks peserta yang sedang aktif di semua server
    if ((opts.restoreHasil || opts.restoreAnswers) && restoredPesertaMap.size === 0) {
      await Promise.allSettled(targetShards.map(async (sh, idx) => {
        const { data } = await sh.client.from('peserta').select('id, username');
        (data || []).forEach(p => {
          const u = String(p.username || '').trim().toLowerCase();
          if (u) restoredPesertaMap.set(u, { id: p.id, shardIndex: idx, client: sh.client });
        });
      }));
    }

    // ---------------------------------------------------------
    // LANGKAH 4: PULIHKAN HASIL UJIAN & JAWABAN KE SERVER MASING-MASING SISWA
    // ---------------------------------------------------------
    if (opts.restoreHasil && Array.isArray(backupData.hasil_ujian) && backupData.hasil_ujian.length > 0) {
      report(88, 'Memulihkan rekap hasil ujian ke server masing-masing siswa...');
      const hasilByShard = targetShards.map(() => []);
      const oldIdToUser = new Map((backupData.peserta || []).map(p => [String(p.id), String(p.username || '').trim().toLowerCase()]));

      backupData.hasil_ujian.forEach(h => {
        const uName = String(
          h.peserta_username ||
          (h.peserta && h.peserta.username) ||
          oldIdToUser.get(String(h.peserta_id)) ||
          ''
        ).trim().toLowerCase();
        const target = restoredPesertaMap.get(uName);
        if (!target) return;

        hasilByShard[target.shardIndex].push({
          peserta_id: target.id,
          paket_soal_id: h.paket_soal_id || null,
          jumlah_benar: parseInt(h.jumlah_benar || 0) || 0,
          jumlah_salah: parseInt(h.jumlah_salah || 0) || 0,
          nilai: parseFloat(h.nilai || 0) || 0,
          status_kelulusan: h.status_kelulusan || 'Selesai',
          waktu_mulai: h.waktu_mulai || null,
          waktu_selesai: h.waktu_selesai || new Date().toISOString()
        });
      });

      await Promise.allSettled(hasilByShard.map(async (rows, idx) => {
        if (rows.length === 0) return;
        const sh = targetShards[idx];
        await this.executeWithAdminAuth(sh.client, async (c) => {
          const { data: pkRows } = await c.from('paket_soal').select('id');
          const pkSet = new Set((pkRows || []).map(x => String(x.id)));
          const sanitized = rows.map(r => ({
            ...r,
            paket_soal_id: (r.paket_soal_id && pkSet.has(String(r.paket_soal_id))) ? r.paket_soal_id : null
          }));
          for (const batch of chunkArr(sanitized, 50)) {
            const { error } = await c.from('hasil_ujian').insert(batch);
            if (!error) shardReports[idx].hasilOk += batch.length;
          }
        });
      }));
    }

    if (opts.restoreAnswers && Array.isArray(backupData.jawaban_peserta) && backupData.jawaban_peserta.length > 0) {
      report(94, 'Memulihkan detail jawaban peserta ke server masing-masing siswa...');
      const jwbByShard = targetShards.map(() => []);
      const oldIdToUser = new Map((backupData.peserta || []).map(p => [String(p.id), String(p.username || '').trim().toLowerCase()]));

      backupData.jawaban_peserta.forEach(a => {
        const uName = String(a.peserta_username || oldIdToUser.get(String(a.peserta_id)) || '').trim().toLowerCase();
        const target = restoredPesertaMap.get(uName);
        if (!target || !a.soal_id) return;
        jwbByShard[target.shardIndex].push({
          peserta_id: target.id,
          soal_id: a.soal_id,
          jawaban: a.jawaban || null,
          benar: Boolean(a.benar),
          ragu_ragu: Boolean(a.ragu_ragu)
        });
      });

      await Promise.allSettled(jwbByShard.map(async (rows, idx) => {
        if (rows.length === 0) return;
        const sh = targetShards[idx];
        await this.executeWithAdminAuth(sh.client, async (c) => {
          for (const batch of chunkArr(rows, 80)) {
            const { error } = await c.from('jawaban_peserta').upsert(batch, { onConflict: 'peserta_id,soal_id' });
            if (!error) shardReports[idx].jawabanOk += batch.length;
          }
        });
      }));
    }

    report(100, 'Pemulihan & pembagian ke seluruh server selesai!');
    return { ok: true, shardReports };
  }
};

// =====================================================================
// PHP + MySQL BACKEND (mode "php")
// Setiap method di bawah menggantikan method DB yang sama ketika
// window.CBT_CONFIG.backend === 'php'. Mode lain tetap memakai
// implementasi asli (Supabase / localStorage) di atas.
// =====================================================================
const DB_PHP = {
  getSettings() { return DB.api('getSettings'); },

  saveSettings(durasi, passing, tampilkanNilai, tokenUjian, tokenAktif, acakSoal) {
    return DB.api('saveSettings', {
      settings: {
        durasi_menit: durasi,
        passing_grade: passing,
        tampilkan_nilai: tampilkanNilai,
        token_ujian: tokenUjian || 'CBT123',
        token_aktif: Boolean(tokenAktif),
        acak_soal: acakSoal !== undefined ? Boolean(acakSoal) : true
      }
    });
  },

  getPesertaList() { return DB.api('getPesertaList'); },

  registerPeserta(username, pass, nama, jurusan, kelas, ruang, sesi) {
    return DB.api('registerPeserta', {
      username, password: pass, nama_lengkap: nama, jurusan, kelas, ruang, sesi
    });
  },

  editPesertaProfile(id, payload, pass) {
    return DB.api('editPeserta', { id, payload, password: pass || '' });
  },

  deletePeserta(id) { return DB.api('deletePeserta', { id }); },

  deleteAllPeserta() { return DB.api('deleteAllPeserta'); },

  updateStatusUjian(pesertaId, status) {
    return DB.api('updateStatusUjian', { peserta_id: pesertaId, status });
  },

  incrementPelanggaran(pesertaId) {
    return DB.api('incrementPelanggaran', { peserta_id: pesertaId });
  },

  unlockPesertaByToken(pesertaId, inputToken) {
    return DB.api('unlockPesertaByToken', { peserta_id: pesertaId, token: inputToken });
  },

  toggleLockPeserta(pesertaId, isLocked) {
    return DB.api('toggleLockPeserta', { peserta_id: pesertaId, is_locked: isLocked });
  },

  setPesertaSessionToken(pesertaId, token) {
    return DB.api('setPesertaSessionToken', { peserta_id: pesertaId, token: token || '' });
  },

  getPesertaSessionToken(pesertaId) {
    return DB.api('getPesertaSessionToken', { peserta_id: pesertaId });
  },

  async getPesertaLiveState(pesertaId) {
    try {
      const data = await DB.api('session', { role: 'peserta' });
      const p = data && data.profile;
      if (!p || (pesertaId && String(p.id) !== String(pesertaId))) return null;
      return {
        status_ujian: p.status_ujian || 'Belum Ujian',
        is_locked: Boolean(p.is_locked),
        pelanggaran: parseInt(p.pelanggaran || 0),
        active_session_token: p.active_session_token || null,
        tokenSupported: Object.prototype.hasOwnProperty.call(p, 'active_session_token')
      };
    } catch (e) {
      return null;
    }
  },

  resetPesertaLoginSession(pesertaId) {
    return DB.api('resetPesertaLoginSession', { peserta_id: pesertaId });
  },

  getJurusanList() { return DB.api('getJurusanList'); },

  saveJurusan(id, namaJurusan) {
    return DB.api('saveJurusan', { id: id || '', nama_jurusan: namaJurusan });
  },

  deleteJurusan(id) { return DB.api('deleteJurusan', { id }); },

  getKelasList() { return DB.api('getKelasList'); },

  saveKelas(id, namaKelas) {
    return DB.api('saveKelas', { id: id || '', nama_kelas: namaKelas });
  },

  deleteKelas(id) { return DB.api('deleteKelas', { id }); },

  syncMasterCatalog() { return Promise.resolve({ kelas: [], jurusan: [] }); },

  getMasterCatalog() { return Promise.resolve({ kelas: [], jurusan: [] }); },

  syncPublicPaketCatalog() { return Promise.resolve([]); },

  getPublicPaketCatalog() { return Promise.resolve([]); },

  getCardBranding() {
    try {
      const raw = localStorage.getItem('CBT_CETAK_KARTU_BRANDING_V1');
      return Promise.resolve(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return Promise.resolve(null);
    }
  },

  saveCardBranding(brandingObj) {
    const clean = { ...(brandingObj || {}), updated_at: new Date().toISOString() };
    try { localStorage.setItem('CBT_CETAK_KARTU_BRANDING_V1', JSON.stringify(clean)); } catch (e) {}
    return Promise.resolve(clean);
  },

  getPublicKelasJurusanFromPeserta() { return Promise.resolve({ kelas: [], jurusan: [] }); },

  getGuruList() { return DB.api('getGuruList'); },

  saveGuru(id, payload, password = '') {
    return DB.api('saveGuru', { id: id || '', payload, password: password || '' });
  },

  deleteGuru(id) { return DB.api('deleteGuru', { id }); },

  getPaketList() { return DB.api('getPaketList'); },

  savePaket(id, payload) { return DB.api('savePaket', { id: id || '', payload }); },

  deletePaket(id) { return DB.api('deletePaket', { id }); },

  getSoalByPaket(paketId) { return DB.api('getSoalByPaket', { paket_id: paketId }); },

  getSoalList() { return DB.api('getSoalList'); },

  saveSoal(id, payload) { return DB.api('saveSoal', { id: id || '', payload }); },

  deleteSoal(id) { return DB.api('deleteSoal', { id }); },

  bulkInsertSoal(soalList) { return DB.api('bulkInsertSoal', { items: soalList }); },

  getHasilList() { return DB.api('getHasilList'); },

  checkExistingHasil(pesertaId, paketSoalId = null) { 
    return DB.api('checkExistingHasil', { peserta_id: pesertaId, paket_soal_id: paketSoalId }); 
  },

  insertHasil(pesertaId, benar, salah, nilai, status, start, end, paketSoalId = null) {
    return DB.api('insertHasil', {
      peserta_id: pesertaId,
      paket_soal_id: paketSoalId,
      jumlah_benar: benar,
      jumlah_salah: salah,
      nilai: nilai,
      status_kelulusan: status,
      waktu_mulai: start,
      waktu_selesai: end
    });
  },

  resetHasilUjian(hasilId, pesertaId) {
    return DB.api('resetHasilUjian', { hasil_id: hasilId, peserta_id: pesertaId });
  },

  resetPesertaSesi(pesertaId) { return DB.api('resetPesertaSesi', { peserta_id: pesertaId }); },

  bukaSesiMapelBaru() { return DB.api('bukaSesiMapelBaru'); },

  bersihkanHasilSimulasi() { return DB.api('bersihkanHasilSimulasi'); },

  async resetSemuaPeserta(options = {}) {
    const mode = options.mode || 'sesi_aman';
    const subsetIds = Array.isArray(options.pesertaIds) && options.pesertaIds.length > 0
      ? options.pesertaIds
      : null;

    if (!subsetIds) {
      if (mode === 'reset_total') return DB.api('bersihkanHasilSimulasi');
      if (mode === 'sesi_aman') return DB.api('bukaSesiMapelBaru');
    }

    const targets = subsetIds || (await DB.api('getPesertaList') || []).map(p => p.id);
    const batchSize = 20;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (pid) => {
        if (mode === 'login_lock') {
          await DB.api('resetPesertaLoginSession', { peserta_id: pid });
          await DB.api('toggleLockPeserta', { peserta_id: pid, is_locked: false });
        } else {
          await DB.api('resetPesertaSesi', { peserta_id: pid });
        }
      }));
    }
    return { ok: true, mode };
  },

  getJawabanList(pesertaId) { return DB.api('getJawabanList', { peserta_id: pesertaId }); },

  syncJawaban(pesertaId, soalId, option, isCorrect, isRagu) {
    return DB.api('syncJawaban', {
      peserta_id: pesertaId,
      soal_id: soalId,
      jawaban: option,
      benar: isCorrect,
      ragu_ragu: isRagu
    });
  },

  syncJawabanBatch(pesertaId, answersArray) {
    return DB.api('syncJawabanBatch', {
      peserta_id: pesertaId,
      answers: answersArray
    });
  },

  deleteJawabanSoalIds(pesertaId, soalIds) {
    return DB.api('deleteJawabanSoalIds', {
      peserta_id: pesertaId,
      soal_ids: soalIds
    });
  },

  async restoreBackup(backupData, options = {}, onProgress = null) {
    const report = (pct, msg) => {
      if (typeof onProgress === 'function') onProgress(pct, msg);
    };
    report(20, 'Memulihkan bank soal & master ke server PHP/MySQL...');
    await DB.api('restoreBackup', {
      paket_soal: Array.isArray(backupData.paket_soal) ? backupData.paket_soal : null,
      jurusan: Array.isArray(backupData.jurusan) ? backupData.jurusan : null,
      kelas: Array.isArray(backupData.kelas) ? backupData.kelas : null,
      soal: backupData.soal || [],
      pengaturan: (backupData.pengaturan_ujian && backupData.pengaturan_ujian[0]) || null
    });
    let okCount = 0;
    let failCount = 0;
    if (options.restorePeserta !== false && Array.isArray(backupData.peserta) && backupData.peserta.length > 0) {
      report(55, `Memulihkan ${backupData.peserta.length} akun peserta...`);
      const defPass = String(options.defaultPassword || '123456').trim() || '123456';
      for (const p of backupData.peserta) {
        try {
          await DB_PHP.registerPeserta(
            p.username,
            p.password_plain || p.password || defPass,
            p.nama_lengkap,
            p.jurusan || '',
            p.kelas || '',
            p.ruang || '',
            p.sesi || ''
          );
          okCount++;
        } catch (e) {
          failCount++;
        }
      }
    }
    report(100, 'Pemulihan selesai.');
    return { ok: true, shardReports: [{ id: 1, name: 'Server PHP + MySQL', pesertaOk: okCount, pesertaFail: failCount, hasilOk: 0 }] };
  },

  async loginAdmin(email, password) {
    const user = await DB.api('loginAdmin', { email, password });
    return user;
  },

  async loginGuru(username, password) {
    const user = await DB.api('loginGuru', { username: (username || '').trim(), password });
    return user;
  },

  async loginPeserta(username, password, options = {}) {
    const deviceId = (typeof Auth !== 'undefined' && Auth.getOrCreateDeviceId) ? Auth.getOrCreateDeviceId() : '';
    try {
      const res = await DB.api('loginPeserta', {
        username: username.trim(),
        password,
        device_id: deviceId,
        force_takeover: Boolean(options && options.forceTakeover)
      });
      if (res && res.session_token) {
        sessionStorage.setItem('CBT_ACTIVE_SESSION_TOKEN', res.session_token);
      }
      return res;
    } catch (err) {
      if (err && err.status === 409) {
        err.code = 'MULTI_DEVICE_ACTIVE';
      }
      throw err;
    }
  },

  async checkSession(role) {
    const loginPage = role === 'admin' ? 'login-admin.html' : 'index.html';
    try {
      const data = await DB.api('session', { role });
      Auth.initAutoLogout(role === 'admin' ? 15 : 60);
      return data;
    } catch (err) {
      if (err.status === 403) {
        window.location.href = `${loginPage}?error=unauthorized_${role}`;
      } else {
        window.location.href = loginPage;
      }
      return null;
    }
  }
};

Object.keys(DB_PHP).forEach((name) => {
  const original = DB[name];
  DB[name] = function (...args) {
    if (DB.isPhp()) return DB_PHP[name].apply(DB, args);
    return original.apply(DB, args);
  };
});

window.DB = DB;
