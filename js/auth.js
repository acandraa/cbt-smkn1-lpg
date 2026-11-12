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
      paket_ids: guruUser.paket_ids || '[]',
      role: 'guru'
    };

    sessionStorage.setItem('CBT_GURU_SESSION', JSON.stringify(sessionGuru));
    return sessionGuru;
  },

  // Login peserta using Nomor Peserta and Password (mendukung Multi-Shard Auto-Routing)
  async loginPeserta(nomorPeserta, password) {
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    const cleanNomor = nomorPeserta.trim().toLowerCase();
    const email = `${cleanNomor}@cbt.smkn1lempuing.sch.id`;

    // 1. Jika Multi-Shard aktif (> 1 project Supabase), cari di semua server secara paralel
    if (shards.length > 1) {
      const attempts = shards.map(async (shard) => {
        try {
          const { data, error } = await shard.client.auth.signInWithPassword({
            email: email,
            password: password
          });
          if (error || !data || !data.user) return null;

          // Verifikasi peserta di tabel public.peserta shard tersebut
          const { data: pesertaData, error: pesertaErr } = await shard.client
            .from('peserta')
            .select('*')
            .eq('id', data.user.id)
            .maybeSingle();

          if (pesertaErr || !pesertaData) {
            await shard.client.auth.signOut();
            return null;
          }

          return {
            shardId: shard.id,
            shardName: shard.name,
            user: data.user,
            profile: pesertaData
          };
        } catch (e) {
          return null;
        }
      });

      const results = await Promise.all(attempts);
      const winner = results.find(r => r !== null);

      if (!winner) {
        throw new Error("Nomor Peserta atau Password salah, atau belum terdaftar di server manapun.");
      }

      // Kunci sesi siswa ke server yang memenangkan login
      window.setActiveSupabaseShard(winner.shardId);
      sessionStorage.setItem('CBT_ACTIVE_SHARD_NAME', winner.shardName);

      return { user: winner.user, profile: winner.profile };
    }

    // 2. Single-Shard / Default Supabase fallback
    if (!window.supabaseClient) {
      throw new Error("Koneksi Supabase belum dikonfigurasi.");
    }

    const { data, error } = await window.supabaseClient.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      if (error.message.includes("Invalid login credentials")) {
        throw new Error("Nomor Peserta atau Password salah.");
      }
      throw error;
    }

    const { data: pesertaData, error: pesertaErr } = await window.supabaseClient
      .from('peserta')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (pesertaErr || !pesertaData) {
      await window.supabaseClient.auth.signOut();
      throw new Error("Akses ditolak: Data peserta tidak ditemukan.");
    }

    return { user: data.user, profile: pesertaData };
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
      const { data: pesertaData, error: pesertaErr } = await window.supabaseClient
        .from('peserta')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (pesertaErr || !pesertaData) {
        await window.supabaseClient.auth.signOut();
        window.location.href = 'login.html?error=unauthorized_peserta';
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
