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

    // 1. Jika ada token di database yang diperbarui dalam <= 3 menit terakhir (+15d toleransi)
    if (settings && settings.token_ujian && settings.updated_at) {
      const updatedMs = new Date(settings.updated_at).getTime();
      const elapsed = now - updatedMs;
      if (!isNaN(updatedMs) && elapsed >= -30000 && elapsed <= interval + 15000) {
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

    // 3. Toleransi 15 detik awal pergantian slot
    if ((now % interval) < 15000) {
      if (cleanInput === this.generateTimeSlotToken(currentSlot - 1)) {
        return true;
      }
    }

    return false;
  },

  // Auto-heal admin session jika sebuah shard belum memiliki sesi terautentikasi
  async ensureAdminAuth(client) {
    const target = client || window.supabaseClient;
    if (!target || !target.auth) return false;
    try {
      const { data } = await target.auth.getSession();
      if (!data || !data.session) {
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
              kelas_diampu: existing.kelas_diampu || g.kelas_diampu || ''
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

    if (!cleanUsername || !cleanNama || !cleanMapel) {
      throw new Error("Username, Nama Lengkap, dan Mata Pelajaran yang diampu wajib diisi.");
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
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_PENGATURAN'));
    } else {
      const { data, error } = await window.supabaseClient
        .from('pengaturan_ujian')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
      if (error) throw error;
      return data;
    }
  },

  async saveSettings(durasi, passing, tampilkanNilai, tokenUjian, tokenAktif, acakSoal) {
    if (this.isLocal()) {
      const s = {
        id: 1,
        durasi_menit: durasi,
        passing_grade: passing,
        tampilkan_nilai: tampilkanNilai,
        token_ujian: tokenUjian || 'CBT123',
        token_aktif: Boolean(tokenAktif),
        acak_soal: acakSoal !== undefined ? Boolean(acakSoal) : true,
        updated_at: new Date().toISOString()
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
        updated_at: new Date().toISOString()
      };
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      if (shards.length > 1) {
        // Broadcast ke seluruh server Supabase agar durasi & token seragam
        await Promise.allSettled(shards.map(s => s.client && s.client.from('pengaturan_ujian').upsert(payload)));
        return payload;
      }
      const { data, error } = await window.supabaseClient
        .from('pengaturan_ujian')
        .upsert(payload);
      if (error) throw error;
      return data;
    }
  },

  // -------------------------------------------------------------
  // PESERTA (STUDENTS) MANAGEMENT
  // -------------------------------------------------------------
  async getPesertaList() {
    if (this.isLocal()) {
      this.initLocalData();
      return JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA'));
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const isUnified = window.isUnifiedSupabaseMode && window.isUnifiedSupabaseMode();

      if (isUnified && shards.length > 1) {
        // Tarik data seluruh siswa dari ke-5 server secara paralel
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return [];
          const { data, error } = await shard.client
            .from('peserta')
            .select('*')
            .order('created_at', { ascending: false });
          if (error) {
            console.warn(`Gagal mengambil data peserta dari ${shard.name}:`, error);
            return [];
          }
          return (data || []).map(p => ({
            ...p,
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
    if (this.isLocal()) {
      const hash = await this.sha256(pass);
      const payload = {
        username: username,
        password_hash: hash,
        nama_lengkap: nama,
        jurusan: jurusan,
        kelas: kelas,
        ruang: ruang,
        sesi: sesi,
        status_ujian: 'Belum Ujian',
        pelanggaran: 0,
        is_locked: false
      };
      return await this.savePesertaLocal(null, payload);
    } else {
      // Auto-Routing: Tentukan server tujuan berdasarkan jurusan/sesi
      const targetShard = (window.getShardForPeserta && window.getShardForPeserta(jurusan, sesi)) || null;
      const client = (targetShard && targetShard.client) || window.supabaseClient;
      const { data, error } = await client.rpc('create_peserta_user', {
        p_username: username,
        p_password: pass,
        p_nama_lengkap: nama,
        p_jurusan: jurusan,
        p_kelas: kelas,
        p_ruang: ruang,
        p_sesi: sesi
      });
      if (error) throw error;
      return data;
    }
  },

  async editPesertaProfile(id, payload, pass, shardId = null) {
    if (this.isLocal()) {
      if (pass) {
        payload.password_hash = await this.sha256(pass);
      }
      return await this.savePesertaLocal(id, payload);
    } else {
      const client = this.getClientForShard(shardId);
      const { error: profileErr } = await client
        .from('peserta')
        .update(payload)
        .eq('id', id);
      if (profileErr) throw profileErr;

      if (pass) {
        const { error: passErr } = await client.rpc('update_peserta_password', {
          p_peserta_id: id,
          p_password: pass
        });
        if (passErr) throw passErr;
      }
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

  // Update status (e.g. 'Sedang Ujian', 'Sudah Ujian')
  async updateStatusUjian(pesertaId, status) {
    if (this.isLocal()) {
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const idx = list.findIndex(p => p.id === pesertaId);
      if (idx !== -1) {
        list[idx].status_ujian = status;
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
    } else {
      const { error } = await window.supabaseClient
        .from('peserta')
        .update({ status_ujian: status })
        .eq('id', pesertaId);
      if (error) throw error;
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
        const { error } = await client.from('peserta').update(updatePayload).eq('id', pesertaId);
        if (error) throw error;
      } else {
        const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
        if (shards.length > 1) {
          await Promise.allSettled(shards.map(s => s.client && s.client.from('peserta').update(updatePayload).eq('id', pesertaId)));
        } else {
          const { error } = await window.supabaseClient.from('peserta').update(updatePayload).eq('id', pesertaId);
          if (error) throw error;
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
        return Array.from(mapById.values());
      }
      const { data, error } = await window.supabaseClient
        .from('paket_soal')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    }
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
      if (shards.length > 1) {
        const insertPayload = id ? payload : { ...payload, id: payload.id || this.uuidv4() };
        // Broadcast ke semua server Supabase agar paket soal selalu seragam dengan ID yang sama
        const results = await Promise.allSettled(shards.map(async (shard) => {
          if (!shard.client) return null;
          return await this.executeWithAdminAuth(shard.client, async (c) => {
            if (id) {
              const { error } = await c.from('paket_soal').update(payload).eq('id', id);
              if (error) throw error;
            } else {
              const { error } = await c.from('paket_soal').insert(insertPayload);
              if (error) throw error;
            }
            return true;
          });
        }));
        const anySuccess = results.some(r => r.status === 'fulfilled' && r.value);
        if (!anySuccess) {
          const firstErr = results.find(r => r.status === 'rejected')?.reason;
          if (firstErr) throw firstErr;
        }
        return insertPayload;
      }
      if (id) {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { error } = await c.from('paket_soal').update(payload).eq('id', id);
          if (error) throw error;
          return payload;
        });
      } else {
        return await this.executeWithAdminAuth(window.supabaseClient, async (c) => {
          const { error } = await c.from('paket_soal').insert(payload);
          if (error) throw error;
          return payload;
        });
      }
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
        return await this.executeWithAdminAuth(client, async (c) => {
          const { error } = await c.from('paket_soal').delete().eq('id', id);
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

  async getSoalByPaket(paketId) {
    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      return list
        .filter(s => s.paket_soal_id === paketId && s.id !== this.GURU_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__')
        .sort((a,b) => a.nomor - b.nomor);
    } else {
      const { data, error } = await window.supabaseClient
        .from('soal')
        .select('*')
        .eq('paket_soal_id', paketId)
        .order('nomor', { ascending: true });
      if (error) throw error;
      return (data || []).filter(s => s.id !== this.GURU_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__' && s.nomor !== -999);
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
      const { data, error } = await window.supabaseClient
        .from('hasil_ujian')
        .insert({
          peserta_id: pesertaId,
          paket_soal_id: paketSoalId || null,
          jumlah_benar: benar,
          jumlah_salah: salah,
          nilai: nilai,
          status_kelulusan: status,
          waktu_mulai: start,
          waktu_selesai: end
        });
      if (error) throw error;
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
      for (const shard of targetShards) {
        const client = shard.client || window.supabaseClient;
        if (!client) continue;
        if (hasilId) await client.from('hasil_ujian').delete().eq('id', hasilId);
        if (pesertaId) {
          await client.from('jawaban_peserta').delete().eq('peserta_id', pesertaId);
          await client.from('peserta').update({ status_ujian: 'Belum Ujian', pelanggaran: 0 }).eq('id', pesertaId);
        }
      }
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
        localStorage.setItem('CBT_LOCAL_PESERTA', JSON.stringify(list));
      }
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      const targetShards = shardId ? shards.filter(s => String(s.id) === String(shardId)) : (shards.length > 0 ? shards : [{ client: window.supabaseClient }]);
      for (const shard of targetShards) {
        const client = shard.client || window.supabaseClient;
        if (!client) continue;
        await client.from('jawaban_peserta').delete().eq('peserta_id', pesertaId);
        await client.from('hasil_ujian').delete().eq('peserta_id', pesertaId);
        await client.from('peserta').update({ status_ujian: 'Belum Ujian', pelanggaran: 0, is_locked: false }).eq('id', pesertaId);
      }
    }
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
      const { data, error } = await window.supabaseClient
        .from('jawaban_peserta')
        .upsert({
          peserta_id: pesertaId,
          soal_id: soalId,
          jawaban: option,
          benar: isCorrect,
          ragu_ragu: isRagu,
          created_at: new Date().toISOString()
        }, { onConflict: 'peserta_id,soal_id' });
      if (error) throw error;
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
      if (error) throw error;
      return { ok: true, count: answersArray.length };
    }
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

  async loginPeserta(username, password) {
    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_PESERTA')) || [];
      const student = list.find(p => p.username === username);
      if (!student) {
        throw new Error("Username tidak ditemukan.");
      }

      const inputHash = await this.sha256(password);
      if (student.password_hash !== inputHash) {
        throw new Error("Password Peserta salah (Demo mode password: '123456').");
      }

      const sessionObj = { id: student.id, email: `${username}@cbt.smkn1lempuing.sch.id`, role: 'peserta', profile: student };
      sessionStorage.setItem('CBT_SESSION', JSON.stringify(sessionObj));
      return sessionObj;
    } else {
      return await Auth.loginPeserta(username, password);
    }
  },

  async checkSession(role) {
    if (this.isLocal()) {
      const sess = sessionStorage.getItem('CBT_SESSION') || sessionStorage.getItem('CBT_GURU_SESSION');
      const loginPage = role === 'admin' ? 'login-admin.html' : 'login.html';
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
    await Auth.logout();
  },

  // -------------------------------------------------------------
  // EXTRA HELPERS (backup / bulk operations)
  // -------------------------------------------------------------
  async getSoalList() {
    if (this.isLocal()) {
      this.initLocalData();
      const list = JSON.parse(localStorage.getItem('CBT_LOCAL_SOAL')) || [];
      return list.filter(s => s.id !== this.GURU_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__' && s.nomor !== -999);
    } else {
      const { data, error } = await window.supabaseClient
        .from('soal')
        .select('*')
        .order('nomor', { ascending: true });
      if (error) throw error;
      return (data || []).filter(s => s.id !== this.GURU_SYS_ROW_ID && s.opsi_a !== '__CBT_SYS_GURU__' && s.nomor !== -999);
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
        await this.deletePeserta(p.id);
      }
    }
  },

  async restoreBackup(backupData) {
    if (this.isLocal()) {
      localStorage.setItem('CBT_LOCAL_SOAL', JSON.stringify(backupData.soal || []));
      if (Array.isArray(backupData.paket_soal)) {
        localStorage.setItem('CBT_LOCAL_PAKET', JSON.stringify(backupData.paket_soal));
      }
      if (Array.isArray(backupData.jurusan)) {
        localStorage.setItem('CBT_LOCAL_JURUSAN', JSON.stringify(backupData.jurusan));
      }
      if (Array.isArray(backupData.kelas)) {
        localStorage.setItem('CBT_LOCAL_KELAS', JSON.stringify(backupData.kelas));
      }
      if (backupData.pengaturan_ujian && backupData.pengaturan_ujian.length > 0) {
        localStorage.setItem('CBT_LOCAL_PENGATURAN', JSON.stringify(backupData.pengaturan_ujian[0]));
      }
      return;
    }

    if (Array.isArray(backupData.jurusan) && backupData.jurusan.length > 0) {
      try {
        await window.supabaseClient.from('jurusan').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await window.supabaseClient.from('jurusan').insert(backupData.jurusan.map(j => ({ id: j.id, nama_jurusan: j.nama_jurusan || j.nama || j.kode })));
      } catch (e) {
        console.warn('Gagal restore jurusan di Supabase:', e);
      }
    }

    if (Array.isArray(backupData.kelas) && backupData.kelas.length > 0) {
      try {
        await window.supabaseClient.from('kelas').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await window.supabaseClient.from('kelas').insert(backupData.kelas.map(k => ({ id: k.id, nama_kelas: k.nama_kelas || k.nama })));
      } catch (e) {
        console.warn('Gagal restore kelas di Supabase:', e);
      }
    }

    const { error: delSoalErr } = await window.supabaseClient.from('soal').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (delSoalErr) throw delSoalErr;

    const newSoal = backupData.soal || [];
    if (newSoal.length > 0) {
      // Hanya pertahankan relasi paket yang masih ada di database
      const { data: paketRows } = await window.supabaseClient.from('paket_soal').select('id');
      const paketIds = new Set((paketRows || []).map(p => p.id));
      const cleanSoal = newSoal.map(s => {
        return {
          paket_soal_id: paketIds.has(s.paket_soal_id) ? s.paket_soal_id : null,
          nomor: s.nomor,
          pertanyaan: s.pertanyaan,
          opsi_a: s.opsi_a,
          opsi_b: s.opsi_b,
          opsi_c: s.opsi_c,
          opsi_d: s.opsi_d,
          jawaban_benar: s.jawaban_benar,
          bobot: s.bobot,
          gambar: s.gambar || null
        };
      });
      const { error: insSoalErr } = await window.supabaseClient.from('soal').insert(cleanSoal);
      if (insSoalErr) throw insSoalErr;
    }

    const settings = backupData.pengaturan_ujian;
    if (settings && settings.length > 0) {
      const s = settings[0];
      await window.supabaseClient.from('pengaturan_ujian').upsert({
        id: 1,
        durasi_menit: s.durasi_menit,
        passing_grade: s.passing_grade
      });
    }
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

  restoreBackup(backupData) {
    return DB.api('restoreBackup', {
      paket_soal: Array.isArray(backupData.paket_soal) ? backupData.paket_soal : null,
      jurusan: Array.isArray(backupData.jurusan) ? backupData.jurusan : null,
      kelas: Array.isArray(backupData.kelas) ? backupData.kelas : null,
      soal: backupData.soal || [],
      pengaturan: (backupData.pengaturan_ujian && backupData.pengaturan_ujian[0]) || null
    });
  },

  async loginAdmin(email, password) {
    const user = await DB.api('loginAdmin', { email, password });
    return user;
  },

  async loginGuru(username, password) {
    const user = await DB.api('loginGuru', { username: (username || '').trim(), password });
    return user;
  },

  async loginPeserta(username, password) {
    return await DB.api('loginPeserta', { username: username.trim(), password });
  },

  async checkSession(role) {
    const loginPage = role === 'admin' ? 'login-admin.html' : 'login.html';
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
