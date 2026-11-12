// Authentication & Session Management Module

const Auth = {
  // Login admin using Email and Password
  async loginAdmin(email, password) {
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    if (!window.supabaseClient && shards.length === 0) {
      throw new Error("Koneksi Supabase belum dikonfigurasi.");
    }

    // Pastikan sesi guru dibersihkan saat login sebagai Admin penuh
    try {
      sessionStorage.removeItem('CBT_GURU_SESSION');
      sessionStorage.setItem('CBT_ADMIN_AUTH_SYNC', JSON.stringify({ email, password }));
    } catch (e) {}

    // Jika multi-shard, autentikasi ke SELURUH shard Supabase secara paralel
    // Hal ini krusial agar admin memiliki token otorisasi yang sah di ke-5 server
    if (shards.length > 1) {
      const results = await Promise.allSettled(shards.map(async (shard) => {
        if (!shard.client || !shard.client.auth) return null;
        const { data, error } = await shard.client.auth.signInWithPassword({ email, password });
        if (error) {
          console.warn(`[Shard ${shard.id} - ${shard.name}] Gagal login admin:`, error.message);
          return null;
        }
        return data && data.user ? { shardId: shard.id, user: data.user } : null;
      }));

      const successfulShards = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      if (successfulShards.length === 0) {
        throw new Error("Email atau password admin salah, atau koneksi ke server ditolak.");
      }

      // Default shard aktif: 'all' (gabungan semua server)
      window.setActiveSupabaseShard('all');
      return successfulShards[0].user;
    }

    if (!window.supabaseClient) {
      throw new Error("Koneksi Supabase belum dikonfigurasi.");
    }
    const { data, error } = await window.supabaseClient.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) throw error;

    // Verify if they are indeed an admin
    const { data: adminData, error: adminErr } = await window.supabaseClient
      .from('admins')
      .select('id')
      .eq('id', data.user.id)
      .maybeSingle();

    if (adminErr || !adminData) {
      // Self-heal or bypass for default demo admin
      if (data.user.email === 'admin@smkn1lempuing.sch.id') {
        // Automatically register them in admins table if missing (best effort)
        await window.supabaseClient.from('admins').insert({ id: data.user.id, email: data.user.email }).maybeSingle();
      } else {
        // Not an admin! Log them out immediately
        await window.supabaseClient.auth.signOut();
        throw new Error("Akses ditolak: Akun Anda bukan merupakan Administrator.");
      }
    }

    return data.user;
  },

  // Login Guru Mata Pelajaran menggunakan Username dan Password
  async loginGuru(username, password) {
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const cleanUser = (username || '').trim();
    if (!cleanUser || !password) {
      throw new Error("Username dan Password Guru wajib diisi.");
    }

    // Autentikasi ke Supabase di latar belakang menggunakan akun sinkronisasi sistem agar akses RLS soal & nilai berjalan mulus
    let syncCreds = null;
    try {
      syncCreds = JSON.parse(sessionStorage.getItem('CBT_ADMIN_AUTH_SYNC') || 'null');
    } catch (e) {}
    const sysEmail = (syncCreds && syncCreds.email) || 'admin@smkn1lempuing.sch.id';
    const sysPass = (syncCreds && syncCreds.password) || 'admin123';

    if (shards.length > 1) {
      await Promise.allSettled(shards.map(async (shard) => {
        if (!shard.client || !shard.client.auth) return null;
        const { data } = await shard.client.auth.getSession();
        if (!data || !data.session) {
          await shard.client.auth.signInWithPassword({ email: sysEmail, password: sysPass });
        }
      }));
      if (window.setActiveSupabaseShard) window.setActiveSupabaseShard('all');
    } else if (window.supabaseClient && window.supabaseClient.auth) {
      const { data } = await window.supabaseClient.auth.getSession();
      if (!data || !data.session) {
        await window.supabaseClient.auth.signInWithPassword({ email: sysEmail, password: sysPass });
      }
    }

    // Verifikasi kredensial guru melalui DB Adapter
    const guruUser = await window.DB.verifyGuruCredentials(cleanUser, password);
    if (!guruUser) {
      throw new Error("Username atau Password Guru salah, atau akun belum didaftarkan oleh Admin.");
    }

    const sessionGuru = {
      id: guruUser.id,
      username: guruUser.username,
      email: `${guruUser.username}@guru.smkn1lempuing.sch.id`,
      nama_lengkap: guruUser.nama_lengkap,
      mapel_diampu: guruUser.mapel_diampu || '',
      jurusan_diampu: guruUser.jurusan_diampu || '',
      kelas_diampu: guruUser.kelas_diampu || '',
      paket_ids: guruUser.paket_ids || '[]',
      role: 'guru'
    };

    sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(sessionGuru));
    return sessionGuru;
  },

  // Helper: Normalisasi Nomor Peserta / Username (hapus spasi tak sengaja & ubah ke huruf kecil)
  _normalizeUsername(u) {
    return String(u || '').trim().replace(/\s+/g, '').toLowerCase();
  },

  // Helper: Daftar kandidat password untuk toleransi spasi keyboard HP, huruf besar/kecil otomatis, dan angka 0 di depan yang terpotong Excel
  _getPasswordCandidates(rawPassword) {
    const raw = String(rawPassword || '');
    const clean = raw.trim();
    const candidates = [clean, raw, clean.toLowerCase(), clean.toUpperCase()];
    if (/^0+\d+$/.test(clean)) {
      candidates.push(clean.replace(/^0+/, ''));
    }
    if (/^\d+$/.test(clean)) {
      candidates.push('0' + clean);
      candidates.push('00' + clean);
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  },

  // Helper: Pastikan client Supabase memiliki sesi sistem/admin saat perlu cek tabel peserta / self-heal
  async _ensureSystemSession(client) {
    if (!client || !client.auth) return false;
    try {
      const { data } = await client.auth.getSession();
      if (data && data.session) return true;
    } catch (e) {}
    let syncCreds = null;
    try {
      syncCreds = JSON.parse(sessionStorage.getItem('CBT_ADMIN_AUTH_SYNC') || 'null');
    } catch (e) {}
    const sysEmail = (syncCreds && syncCreds.email) || 'admin@smkn1lempuing.sch.id';
    const sysPass = (syncCreds && syncCreds.password) || 'admin123';
    try {
      const { data, error } = await client.auth.signInWithPassword({ email: sysEmail, password: sysPass });
      return Boolean(!error && data && data.user);
    } catch (e) {
      return false;
    }
  },

  // Helper: Ambil profil peserta dengan retry otomatis jika jaringan sempat lambat
  async _fetchPesertaProfileWithRetry(client, userId, cleanNomor) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data, error } = await client
          .from('peserta')
          .select('*')
          .eq('id', userId)
          .maybeSingle();
        if (!error && data) return data;
      } catch (e) {}
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 350));
      }
    }
    if (cleanNomor) {
      try {
        const { data } = await client
          .from('peserta')
          .select('*')
          .ilike('username', cleanNomor)
          .maybeSingle();
        if (data) return data;
      } catch (e) {}
    }
    return null;
  },

  // Helper: Coba login langsung ke 1 shard via Supabase Auth
  async _tryDirectLoginOnShard(shard, email, cleanPass, rawPass, cleanNomor) {
    if (!shard || !shard.client || !shard.client.auth) return { winner: null, networkErr: false };
    const passToTry = cleanPass !== rawPass ? [cleanPass, rawPass] : [cleanPass];
    let hadNetworkErr = false;

    for (const p of passToTry) {
      try {
        const { data, error } = await shard.client.auth.signInWithPassword({
          email: email,
          password: p
        });
        if (error) {
          const msg = (error.message || '').toLowerCase();
          if (msg.includes('fetch') || msg.includes('network') || msg.includes('rate limit') || msg.includes('too many') || error.status === 429 || error.status >= 500) {
            hadNetworkErr = true;
          }
          continue;
        }
        if (!data || !data.user) continue;

        const pesertaData = await this._fetchPesertaProfileWithRetry(shard.client, data.user.id, cleanNomor);
        if (!pesertaData) {
          await shard.client.auth.signOut();
          continue;
        }

        return {
          winner: {
            shardId: shard.id,
            shardName: shard.name,
            user: data.user,
            profile: pesertaData
          },
          networkErr: false
        };
      } catch (e) {
        hadNetworkErr = true;
      }
    }
    return { winner: null, networkErr: hadNetworkErr };
  },

  // Helper: Self-Healing & Fallback Login via tabel public.peserta
  // Menangani akun yang username-nya berhuruf besar di Excel/Manual (cth: 'U001'), angka 0 terpotong Excel, atau kena rate-limit GoTrue
  async _trySelfHealLoginOnShard(shard, rawNomor, cleanNomor, rawPassword) {
    if (!shard || !shard.client || !window.DB) return null;
    const client = shard.client;

    try {
      await this._ensureSystemSession(client);

      // 1. Cari peserta di tabel public.peserta secara case-insensitive atau variasi angka 0 di depan
      let pesertaData = null;
      const usernameCandidates = [cleanNomor, String(rawNomor || '').trim()];
      if (/^0+\d+$/.test(cleanNomor)) {
        usernameCandidates.push(cleanNomor.replace(/^0+/, ''));
      } else if (/^\d+$/.test(cleanNomor)) {
        usernameCandidates.push('0' + cleanNomor);
        usernameCandidates.push('00' + cleanNomor);
      }

      for (const uCand of Array.from(new Set(usernameCandidates.filter(Boolean)))) {
        const { data } = await client
          .from('peserta')
          .select('*')
          .ilike('username', uCand)
          .maybeSingle();
        if (data) {
          pesertaData = data;
          break;
        }
      }

      if (!pesertaData) return null;

      // 2. Cocokkan password terhadap password_hash (SHA-256) di tabel peserta
      const storedHash = String(pesertaData.password_hash || '').trim().toLowerCase();
      const passCandidates = this._getPasswordCandidates(rawPassword);
      let matchedPass = null;

      for (const cand of passCandidates) {
        const candHash = (await window.DB.sha256(cand)).toLowerCase();
        if (candHash === storedHash || cand === storedHash) {
          matchedPass = cand;
          break;
        }
      }

      if (!matchedPass) {
        // Peserta ditemukan di server ini, namun password memang tidak cocok
        return { userFoundButWrongPassword: true, shardId: shard.id };
      }

      // 3. Password COCOK! Lakukan Self-Healing akun auth.users agar siswa bisa masuk dengan mulus
      const targetUsername = this._normalizeUsername(pesertaData.username || cleanNomor);
      const targetEmail = `${targetUsername}@cbt.smkn1lempuing.sch.id`;

      // 3a. Coba sinkronkan password via RPC update_peserta_password terlebih dahulu
      try {
        await client.rpc('update_peserta_password', {
          p_peserta_id: pesertaData.id,
          p_password: matchedPass
        });
      } catch (e) {}

      // Jika username lama mengandung huruf besar/spasi dan belum ujian, perbaiki auth.users.email menjadi huruf kecil
      if (pesertaData.username !== targetUsername && (!pesertaData.status_ujian || pesertaData.status_ujian === 'Belum Ujian')) {
        try {
          await client.rpc('delete_peserta_user', { p_peserta_id: pesertaData.id });
          const { data: newId, error: recErr } = await client.rpc('create_peserta_user', {
            p_username: targetUsername,
            p_password: matchedPass,
            p_nama_lengkap: pesertaData.nama_lengkap || '',
            p_jurusan: pesertaData.jurusan || '',
            p_kelas: pesertaData.kelas || '',
            p_ruang: pesertaData.ruang || '',
            p_sesi: pesertaData.sesi || ''
          });
          if (!recErr && newId) {
            pesertaData.id = newId;
            pesertaData.username = targetUsername;
          }
        } catch (e) {}
      }

      // 3b. Coba signInWithPassword kembali setelah self-heal
      try {
        const { data: signInData, error: signInErr } = await client.auth.signInWithPassword({
          email: targetEmail,
          password: matchedPass
        });
        if (!signInErr && signInData && signInData.user) {
          const freshProfile = (await this._fetchPesertaProfileWithRetry(client, signInData.user.id, targetUsername)) || pesertaData;
          return {
            winner: {
              shardId: shard.id,
              shardName: shard.name,
              user: signInData.user,
              profile: freshProfile
            }
          };
        }
      } catch (e) {}

      // 3c. Jika masih gagal signInWithPassword karena auth.users.email lama berhuruf besar atau belum ujian, buat ulang akun secara aman
      if (!pesertaData.status_ujian || pesertaData.status_ujian === 'Belum Ujian') {
        try {
          await this._ensureSystemSession(client);
          await client.rpc('delete_peserta_user', { p_peserta_id: pesertaData.id });
          const { data: recreatedId, error: recErr } = await client.rpc('create_peserta_user', {
            p_username: targetUsername,
            p_password: matchedPass,
            p_nama_lengkap: pesertaData.nama_lengkap || '',
            p_jurusan: pesertaData.jurusan || '',
            p_kelas: pesertaData.kelas || '',
            p_ruang: pesertaData.ruang || '',
            p_sesi: pesertaData.sesi || ''
          });
          if (!recErr && recreatedId) {
            pesertaData.id = recreatedId;
            pesertaData.username = targetUsername;
            const { data: retryAuth, error: retryErr } = await client.auth.signInWithPassword({
              email: targetEmail,
              password: matchedPass
            });
            if (!retryErr && retryAuth && retryAuth.user) {
              const freshProfile = (await this._fetchPesertaProfileWithRetry(client, retryAuth.user.id, targetUsername)) || pesertaData;
              return {
                winner: {
                  shardId: shard.id,
                  shardName: shard.name,
                  user: retryAuth.user,
                  profile: freshProfile
                }
              };
            }
          }
        } catch (e) {}
      }

      // 3d. Fallback Session: Jika GoTrue sedang terkena rate-limit (HTTP 429) namun password_hash peserta 100% sah,
      // tetap izinkan siswa masuk menggunakan sesi terverifikasi agar ujian tidak terhambat
      await this._ensureSystemSession(client);
      const fallbackUser = {
        id: pesertaData.id,
        email: targetEmail,
        role: 'peserta'
      };
      const fallbackSessionObj = {
        user: fallbackUser,
        profile: pesertaData,
        shardId: shard.id,
        shardName: shard.name
      };
      sessionStorage.setItem('CBT_PESERTA_FALLBACK_SESSION', JSON.stringify(fallbackSessionObj));

      return {
        winner: fallbackSessionObj
      };
    } catch (e) {
      return null;
    }
  },

  // Login peserta using Nomor Peserta and Password (mendukung Multi-Shard Auto-Routing & Anti-Gagal Login)
  async loginPeserta(nomorPeserta, password) {
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const rawNomor = String(nomorPeserta || '').trim();
    const cleanNomor = this._normalizeUsername(rawNomor);
    const rawPass = String(password || '');
    const cleanPass = rawPass.trim();

    if (!cleanNomor || !cleanPass) {
      throw new Error("Nomor Peserta dan Password wajib diisi.");
    }

    sessionStorage.removeItem('CBT_PESERTA_FALLBACK_SESSION');
    const email = `${cleanNomor}@cbt.smkn1lempuing.sch.id`;

    // 1. Jika Multi-Shard aktif (> 1 project Supabase)
    if (shards.length > 1) {
      let winner = null;
      let anyNetworkError = false;

      // Optimasi Anti-Rate-Limit: Jika perangkat siswa sudah pernah terhubung ke shard tertentu sebelumnya, coba shard tersebut lebih dulu
      const lastShardId = sessionStorage.getItem('CBT_PESERTA_ACTIVE_SHARD_ID') || localStorage.getItem('CBT_LAST_PESERTA_SHARD_ID');
      const prioritizedShard = lastShardId ? shards.find(s => String(s.id) === String(lastShardId)) : null;

      if (prioritizedShard) {
        const fastTry = await this._tryDirectLoginOnShard(prioritizedShard, email, cleanPass, rawPass, cleanNomor);
        if (fastTry.winner) {
          winner = fastTry.winner;
        }
      }

      // Jika belum ketemu di shard terakhir, cari di shard lainnya
      if (!winner) {
        const remainingShards = prioritizedShard
          ? shards.filter(s => String(s.id) !== String(prioritizedShard.id))
          : shards;

        const results = await Promise.all(
          remainingShards.map(shard => this._tryDirectLoginOnShard(shard, email, cleanPass, rawPass, cleanNomor))
        );
        const found = results.find(r => r && r.winner !== null);
        if (found) {
          winner = found.winner;
        }
        if (results.some(r => r && r.networkErr)) {
          anyNetworkError = true;
        }
      }

      // 2. TAHAP PENYELAMAT (Self-Healing & Fallback via public.peserta):
      // Jika login langsung gagal (misal karena username huruf besar di Excel, angka 0 terpotong, atau rate-limit),
      // cek langsung ke tabel peserta di semua shard
      let wrongPasswordDetected = false;
      if (!winner) {
        const healResults = await Promise.all(
          shards.map(shard => this._trySelfHealLoginOnShard(shard, rawNomor, cleanNomor, rawPass))
        );
        const healed = healResults.find(r => r && r.winner);
        if (healed && healed.winner) {
          winner = healed.winner;
        } else if (healResults.some(r => r && r.userFoundButWrongPassword)) {
          wrongPasswordDetected = true;
        }
      }

      if (!winner) {
        if (wrongPasswordDetected) {
          throw new Error("Password yang Anda masukkan salah. Periksa kembali huruf besar/kecil atau klik ikon mata untuk melihat ketikan password Anda.");
        }
        if (anyNetworkError) {
          throw new Error("Koneksi internet kurang stabil atau server sedang sibuk. Silakan tunggu 3 detik lalu tekan tombol Masuk kembali.");
        }
        throw new Error("Nomor Peserta atau Password salah, atau akun belum terdaftar. Pastikan Nomor Peserta sesuai kartu ujian.");
      }

      // Kunci sesi siswa ke server yang memenangkan login & simpan cache profil
      window.setActiveSupabaseShard(winner.shardId);
      sessionStorage.setItem('CBT_ACTIVE_SHARD_NAME', winner.shardName || '');
      try {
        localStorage.setItem('CBT_LAST_PESERTA_SHARD_ID', String(winner.shardId));
        sessionStorage.setItem('CBT_PESERTA_PROFILE_CACHE', JSON.stringify({
          user: winner.user,
          profile: winner.profile,
          shardId: winner.shardId
        }));
      } catch (e) {}

      return { user: winner.user, profile: winner.profile };
    }

    // 2. Single-Shard / Default Supabase fallback
    if (!window.supabaseClient) {
      throw new Error("Koneksi Supabase belum dikonfigurasi.");
    }

    const singleShardObj = { id: '1', name: 'Server Utama', client: window.supabaseClient };
    const directRes = await this._tryDirectLoginOnShard(singleShardObj, email, cleanPass, rawPass, cleanNomor);
    if (directRes.winner) {
      try {
        sessionStorage.setItem('CBT_PESERTA_PROFILE_CACHE', JSON.stringify({
          user: directRes.winner.user,
          profile: directRes.winner.profile,
          shardId: '1'
        }));
      } catch (e) {}
      return { user: directRes.winner.user, profile: directRes.winner.profile };
    }

    const healRes = await this._trySelfHealLoginOnShard(singleShardObj, rawNomor, cleanNomor, rawPass);
    if (healRes && healRes.winner) {
      try {
        sessionStorage.setItem('CBT_PESERTA_PROFILE_CACHE', JSON.stringify({
          user: healRes.winner.user,
          profile: healRes.winner.profile,
          shardId: '1'
        }));
      } catch (e) {}
      return { user: healRes.winner.user, profile: healRes.winner.profile };
    }

    if (healRes && healRes.userFoundButWrongPassword) {
      throw new Error("Password yang Anda masukkan salah. Periksa kembali ketikan password Anda.");
    }
    if (directRes.networkErr) {
      throw new Error("Koneksi internet kurang stabil atau server sedang sibuk. Silakan coba beberapa saat lagi.");
    }
    throw new Error("Nomor Peserta atau Password salah.");
  },

  // Logout from current session
  async logout() {
    if (window.CBT_CONFIG && window.CBT_CONFIG.backend === 'php') {
      try {
        await fetch(window.CBT_CONFIG.apiUrl || 'api/index.php', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logout' })
        });
      } catch (e) {
        console.error("Gagal logout dari server:", e);
      }
    } else {
      const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
      if (shards.length > 0) {
        await Promise.allSettled(shards.map(s => s.client && s.client.auth && s.client.auth.signOut()));
      } else if (window.supabaseClient) {
        await window.supabaseClient.auth.signOut();
      }
    }
    sessionStorage.removeItem('CBT_SESSION');
    sessionStorage.removeItem('CBT_GURU_SESSION');
    sessionStorage.removeItem('CBT_PESERTA_FALLBACK_SESSION');
    sessionStorage.removeItem('CBT_PESERTA_PROFILE_CACHE');
    sessionStorage.removeItem('CBT_ACTIVE_SHARD_ID');
    sessionStorage.removeItem('CBT_ACTIVE_SHARD_NAME');
    sessionStorage.removeItem('CBT_PESERTA_ACTIVE_SHARD_ID');
    sessionStorage.removeItem('CBT_PESERTA_ACTIVE_SHARD_NAME');
    if (/(admin|login-admin)\.html/i.test(window.location.pathname || '')) {
      sessionStorage.removeItem('CBT_ADMIN_ACTIVE_SHARD_ID');
      sessionStorage.removeItem('CBT_ADMIN_ACTIVE_SHARD_NAME');
    }
    localStorage.removeItem('CBT_SESSION_EXPIRE');
    window.location.href = 'index.html';
  },

  // Check if session is valid and redirect accordingly
  async checkSession(requiredRole) {
    const loginPage = requiredRole === 'admin' ? 'login-admin.html' : 'index.html';

    // Pulihkan shard aktif jika tersimpan di sessionStorage
    const savedShardId = window.getActiveSupabaseShardId && window.getActiveSupabaseShardId();
    if (savedShardId && window.setActiveSupabaseShard) {
      window.setActiveSupabaseShard(savedShardId);
    }

    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];

    // Cek apakah peserta menggunakan Fallback Session (saat GoTrue rate-limit tetapi password_hash sah)
    if (requiredRole === 'peserta') {
      let fallbackRaw = null;
      try {
        fallbackRaw = sessionStorage.getItem('CBT_PESERTA_FALLBACK_SESSION');
      } catch (e) {}

      if (fallbackRaw) {
        try {
          const fb = JSON.parse(fallbackRaw);
          if (fb && fb.user && fb.profile) {
            if (fb.shardId && window.setActiveSupabaseShard) {
              window.setActiveSupabaseShard(fb.shardId);
            }
            if (window.supabaseClient) {
              await this._ensureSystemSession(window.supabaseClient);
              const fresh = await this._fetchPesertaProfileWithRetry(window.supabaseClient, fb.profile.id, fb.profile.username);
              if (fresh) {
                fb.profile = fresh;
                sessionStorage.setItem('CBT_PESERTA_FALLBACK_SESSION', JSON.stringify(fb));
              }
            }
            this.initAutoLogout(60);
            return { user: fb.user, profile: fb.profile };
          }
        } catch (e) {
          sessionStorage.removeItem('CBT_PESERTA_FALLBACK_SESSION');
        }
      }
    }

    // Cek apakah yang sedang login adalah Akun Guru Mata Pelajaran
    if (requiredRole === 'admin') {
      let guruSessionRaw = null;
      try {
        guruSessionRaw = sessionStorage.getItem('CBT_GURU_SESSION');
      } catch (e) {}

      if (guruSessionRaw) {
        try {
          const guruUser = JSON.parse(guruSessionRaw);
          if (guruUser && guruUser.role === 'guru') {
            // Pastikan koneksi ke shard Supabase tetap terautentikasi agar Guru bisa kelola soal & unduh nilai
            let syncCreds = null;
            try { syncCreds = JSON.parse(sessionStorage.getItem('CBT_ADMIN_AUTH_SYNC') || 'null'); } catch (e) {}
            const sysEmail = (syncCreds && syncCreds.email) || 'admin@smkn1lempuing.sch.id';
            const sysPass = (syncCreds && syncCreds.password) || 'admin123';

            if (shards.length > 1) {
              await Promise.allSettled(shards.map(async (ms) => {
                if (ms.client && ms.client.auth) {
                  const { data } = await ms.client.auth.getSession();
                  if (!data || !data.session) {
                    await ms.client.auth.signInWithPassword({ email: sysEmail, password: sysPass });
                  }
                }
              }));
            } else if (window.supabaseClient && window.supabaseClient.auth) {
              const { data } = await window.supabaseClient.auth.getSession();
              if (!data || !data.session) {
                await window.supabaseClient.auth.signInWithPassword({ email: sysEmail, password: sysPass });
              }
            }

            // Segarkan data mapel_diampu terbaru dari daftar guru jika memungkinkan
            try {
              if (window.DB && window.DB.getGuruList) {
                const list = await window.DB.getGuruList();
                const fresh = (list || []).find(g => g.id === guruUser.id || (g.username || '').toLowerCase() === (guruUser.username || '').toLowerCase());
                if (fresh) {
                  guruUser.nama_lengkap = fresh.nama_lengkap;
                  guruUser.mapel_diampu = fresh.mapel_diampu;
                  guruUser.jurusan_diampu = fresh.jurusan_diampu || '';
                  guruUser.kelas_diampu = fresh.kelas_diampu || '';
                  guruUser.paket_ids = fresh.paket_ids || '[]';
                  sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(guruUser));
                }
              }
            } catch (e) {}

            this.initAutoLogout(30); // Auto logout 30 menit untuk guru
            return guruUser;
          }
        } catch (e) {
          sessionStorage.removeItem('CBT_GURU_SESSION');
        }
      }
    }

    let session = null;
    if (window.supabaseClient && window.supabaseClient.auth) {
      try {
        const res = await window.supabaseClient.auth.getSession();
        session = res && res.data ? res.data.session : null;
      } catch (e) {}
    }

    // Untuk peserta: jika di shard aktif belum ada session, cari di shard lainnya
    if (requiredRole === 'peserta' && !session && shards.length > 1) {
      for (const s of shards) {
        if (s.client && s.client.auth) {
          try {
            const { data } = await s.client.auth.getSession();
            if (data && data.session) {
              session = data.session;
              if (window.setActiveSupabaseShard) window.setActiveSupabaseShard(s.id);
              break;
            }
          } catch (e) {}
        }
      }
    }

    // Untuk admin pada mode multi-shard: pastikan seluruh server memiliki sesi login aktif
    // Jika ada server (seperti Server 2) yang belum terautentikasi, lakukan auto-reauth transparan
    if (requiredRole === 'admin' && shards.length > 1) {
      let checks = await Promise.allSettled(
        shards.map(s => (s.client && s.client.auth) ? s.client.auth.getSession() : Promise.resolve(null))
      );
      
      const missingShards = shards.filter((s, idx) => {
        const c = checks[idx];
        return (c.status !== 'fulfilled' || !c.value || !c.value.data || !c.value.data.session);
      });

      if (missingShards.length > 0) {
        // Auto-heal sesi admin di shard yang belum login
        let syncCreds = null;
        try {
          syncCreds = JSON.parse(sessionStorage.getItem('CBT_ADMIN_AUTH_SYNC') || 'null');
        } catch (e) {}
        const adminEmail = (syncCreds && syncCreds.email) || 'admin@smkn1lempuing.sch.id';
        const adminPass = (syncCreds && syncCreds.password) || 'admin123';

        await Promise.allSettled(missingShards.map(async (ms) => {
          if (ms.client && ms.client.auth) {
            try {
              await ms.client.auth.signInWithPassword({ email: adminEmail, password: adminPass });
            } catch (e) {
              console.warn(`[Shard ${ms.id} - ${ms.name}] Gagal auto-reauth:`, e.message);
            }
          }
        }));

        // Periksa ulang setelah auto-reauth
        checks = await Promise.allSettled(
          shards.map(s => (s.client && s.client.auth) ? s.client.auth.getSession() : Promise.resolve(null))
        );
      }

      const anyMissing = checks.some(c => {
        if (c.status !== 'fulfilled' || !c.value || !c.value.data) return true;
        return !c.value.data.session;
      });
      if (anyMissing) {
        session = null;
      } else if (!session) {
        const firstValid = checks.find(c => c.status === 'fulfilled' && c.value && c.value.data && c.value.data.session);
        if (firstValid) session = firstValid.value.data.session;
      }
    }

    if (!session) {
      this.clearSessionData();
      window.location.href = loginPage;
      return null;
    }

    const user = session.user;

    if (requiredRole === 'admin') {
      this.initAutoLogout(15); // Auto logout after 15 mins inactivity
      return user;
    } 
    
    if (requiredRole === 'peserta') {
      const cleanEmailPrefix = user.email ? user.email.split('@')[0] : '';
      let pesertaData = await this._fetchPesertaProfileWithRetry(window.supabaseClient, user.id, cleanEmailPrefix);

      // Gunakan cache profil dari saat login jika jaringan sempat tersendat saat membuka ujian.html
      if (!pesertaData) {
        try {
          const cached = JSON.parse(sessionStorage.getItem('CBT_PESERTA_PROFILE_CACHE') || 'null');
          if (cached && cached.profile && (cached.profile.id === user.id || cached.user?.id === user.id)) {
            pesertaData = cached.profile;
          }
        } catch (e) {}
      }

      if (!pesertaData) {
        await window.supabaseClient.auth.signOut();
        window.location.href = 'index.html?error=unauthorized_peserta';
        return null;
      }

      this.initAutoLogout(60); // Auto logout after 60 mins for students
      return { user, profile: pesertaData };
    }

    return user;
  },

  clearSessionData() {
    localStorage.removeItem('CBT_SESSION_EXPIRE');
    sessionStorage.removeItem('CBT_ADMIN_AUTH_SYNC');
    sessionStorage.removeItem('CBT_GURU_SESSION');
    sessionStorage.removeItem('CBT_PESERTA_FALLBACK_SESSION');
    sessionStorage.removeItem('CBT_PESERTA_PROFILE_CACHE');
  },

  // Automatic logout on inactivity
  initAutoLogout(minutes) {
    const expireTime = Date.now() + minutes * 60 * 1000;
    localStorage.setItem('CBT_SESSION_EXPIRE', expireTime);

    // Debounced listener to reset timer on user movement
    const resetTimer = () => {
      const newExpire = Date.now() + minutes * 60 * 1000;
      localStorage.setItem('CBT_SESSION_EXPIRE', newExpire);
    };

    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keypress', resetTimer);
    window.addEventListener('click', resetTimer);
    window.addEventListener('scroll', resetTimer);

    // Interval checker
    if (window.authInterval) clearInterval(window.authInterval);
    
    window.authInterval = setInterval(() => {
      const expire = localStorage.getItem('CBT_SESSION_EXPIRE');
      if (expire && Date.now() > parseInt(expire)) {
        clearInterval(window.authInterval);
        alert("Sesi Anda telah berakhir karena tidak ada aktivitas. Silakan login kembali.");
        this.logout();
      }
    }, 10000); // check every 10 seconds
  }
};

window.Auth = Auth;
