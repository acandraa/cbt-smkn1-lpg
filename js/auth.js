// Authentication & Session Management Module

const Auth = {
  // Login admin using Email and Password
  async loginAdmin(email, password) {
    const shards = (window.getSupabaseShards && window.getSupabaseShards()) || [];
    if (!window.supabaseClient && shards.length === 0) {
      throw new Error("Koneksi Supabase belum dikonfigurasi.");
    }

    // Jika multi-shard, coba autentikasi ke shard yang aktif atau shard yang ada
    if (shards.length > 1) {
      const activeShardId = window.getActiveSupabaseShardId();
      let targetShard = shards.find(s => String(s.id) === String(activeShardId)) || shards[0];

      try {
        const { data, error } = await targetShard.client.auth.signInWithPassword({ email, password });
        if (!error && data && data.user) {
          window.setActiveSupabaseShard(targetShard.id);
          return data.user;
        }
      } catch (e) {}

      // Jika gagal di shard pertama, cek shard lainnya
      for (const shard of shards) {
        if (shard.id === targetShard.id) continue;
        try {
          const { data, error } = await shard.client.auth.signInWithPassword({ email, password });
          if (!error && data && data.user) {
            window.setActiveSupabaseShard(shard.id);
            return data.user;
          }
        } catch (e) {}
      }
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
    } else if (window.supabaseClient) {
      await window.supabaseClient.auth.signOut();
    }
    sessionStorage.removeItem('CBT_SESSION');
    sessionStorage.removeItem('CBT_ACTIVE_SHARD_ID');
    sessionStorage.removeItem('CBT_ACTIVE_SHARD_NAME');
    localStorage.removeItem('CBT_SESSION_EXPIRE');
    window.location.href = 'index.html';
  },

  // Check if session is valid and redirect accordingly
  async checkSession(requiredRole) {
    const loginPage = requiredRole === 'admin' ? 'login-admin.html' : 'login.html';

    // Pulihkan shard aktif jika tersimpan di sessionStorage
    const savedShardId = sessionStorage.getItem('CBT_ACTIVE_SHARD_ID');
    if (savedShardId && window.setActiveSupabaseShard) {
      window.setActiveSupabaseShard(savedShardId);
    }

    if (!window.supabaseClient) {
      if (requiredRole === 'admin') {
        return null;
      }
      window.location.href = loginPage + '?error=config_missing';
      return;
    }

    const { data: { session }, error } = await window.supabaseClient.auth.getSession();

    if (error || !session) {
      this.clearSessionData();
      window.location.href = loginPage;
      return null;
    }

    const user = session.user;

    if (requiredRole === 'admin') {
      const { data: adminData, error: adminErr } = await window.supabaseClient
        .from('admins')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (adminErr || !adminData) {
        if (user.email === 'admin@smkn1lempuing.sch.id') {
          // Bypass for default admin
          this.initAutoLogout(15);
          return user;
        }
        await window.supabaseClient.auth.signOut();
        window.location.href = 'login-admin.html?error=unauthorized_admin';
        return null;
      }
      
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
