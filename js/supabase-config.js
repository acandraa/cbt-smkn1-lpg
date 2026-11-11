// Supabase client initialization wrapper
// + Penentuan mode backend (supabase / php / local)
// + Dukungan Multi-Shard (hingga 5 akun / project Supabase untuk 700+ peserta)
// + Mode "Unified Dashboard" (Semua Server Gabungan dalam 1 Tampilan Admin)

(function () {
  // -------------------------------------------------------------
  // Helper: Pembersih URL Supabase
  // -------------------------------------------------------------
  function cleanSupabaseUrl(rawUrl) {
    if (!rawUrl) return '';
    let u = rawUrl.trim();
    u = u.replace(/\/+$/, "");
    u = u.replace(/\/rest\/v1$/, "");
    u = u.replace(/\/auth\/v1$/, "");
    u = u.replace(/\/+$/, "");
    if (u.includes("supabase.co") && !/^https?:\/\//i.test(u)) {
      u = "https://" + u;
    }
    return u;
  }

  // -------------------------------------------------------------
  // 1. Tentukan mode backend
  // -------------------------------------------------------------
  const apiUrl = window.CBT_PHP_API_URL || 'api/index.php';
  let mode = (window.CBT_BACKEND || 'auto').toLowerCase();

  // Deteksi apakah API PHP tersedia (sinkron, hasil di-cache per tab)
  function detectPhpApi() {
    const cached = sessionStorage.getItem('CBT_PHP_API_AVAILABLE');
    if (cached !== null) return cached === '1';

    const host = window.location.hostname || '';
    if (window.location.protocol === 'file:' || host.endsWith('github.io')) {
      sessionStorage.setItem('CBT_PHP_API_AVAILABLE', '0');
      return false;
    }

    let ok = false;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ action: 'ping' }));
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        ok = !!(res && res.data && res.data.backend === 'php');
      }
    } catch (e) {
      ok = false;
    }
    sessionStorage.setItem('CBT_PHP_API_AVAILABLE', ok ? '1' : '0');
    return ok;
  }

  // Cek apakah ada konfigurasi Supabase di shards atau default
  const shardsConfig = Array.isArray(window.CBT_SUPABASE_SHARDS) ? window.CBT_SUPABASE_SHARDS : [];
  const hasConfiguredShard = shardsConfig.some(s => s && s.url && s.key && s.url.trim() !== '' && s.key.trim() !== '');
  const defaultUrl = cleanSupabaseUrl(window.CBT_DEFAULT_SUPABASE_URL || localStorage.getItem('CBT_SUPABASE_URL') || '');
  const defaultKey = (window.CBT_DEFAULT_SUPABASE_KEY || localStorage.getItem('CBT_SUPABASE_ANON_KEY') || '').trim();
  const hasDefaultSupabase = !!(defaultUrl && defaultKey);

  if (mode === 'auto') {
    if (detectPhpApi()) {
      mode = 'php';
    } else {
      mode = (hasConfiguredShard || hasDefaultSupabase) ? 'supabase' : 'local';
    }
  }

  // -------------------------------------------------------------
  // 2. Mode PHP + MySQL (Hosting biasa / Laragon)
  // -------------------------------------------------------------
  if (mode === 'php') {
    window.CBT_CONFIG = {
      backend: 'php',
      apiUrl: apiUrl,
      url: '',
      key: '',
      isConfigured: true,
      isMultiShard: false
    };
    window.supabaseClient = null;
    window.CBT_VALID_SHARDS = [];
    return;
  }

  // -------------------------------------------------------------
  // 3. Mode Demo Lokal (localStorage)
  // -------------------------------------------------------------
  if (mode === 'local') {
    window.CBT_CONFIG = { backend: 'local', url: '', key: '', isConfigured: false, isMultiShard: false };
    window.supabaseClient = null;
    window.CBT_VALID_SHARDS = [];
    return;
  }

  // -------------------------------------------------------------
  // 4. Mode Supabase (Multi-Shard hingga 5 Akun / Proyek)
  // -------------------------------------------------------------
  const validShards = [];
  const isAdminPage = /(admin|login-admin)\.html/i.test(window.location.pathname || '');
  const SHARD_ID_KEY = isAdminPage ? 'CBT_ADMIN_ACTIVE_SHARD_ID' : 'CBT_PESERTA_ACTIVE_SHARD_ID';
  const SHARD_NAME_KEY = isAdminPage ? 'CBT_ADMIN_ACTIVE_SHARD_NAME' : 'CBT_PESERTA_ACTIVE_SHARD_NAME';

  if (shardsConfig.length > 0) {
    shardsConfig.forEach((shard, index) => {
      if (shard && shard.url && shard.key && shard.url.trim() !== '' && shard.key.trim() !== '') {
        const cUrl = cleanSupabaseUrl(shard.url);
        const cKey = shard.key.trim();
        const sId = shard.id || (index + 1);
        let clientInstance = null;
        if (window.supabase) {
          try {
            const clientOpts = isAdminPage
              ? { auth: { storageKey: `cbt_admin_shard_${sId}`, persistSession: true } }
              : { auth: { storageKey: `cbt_peserta_shard_${sId}`, storage: window.sessionStorage, persistSession: true } };
            clientInstance = window.supabase.createClient(cUrl, cKey, clientOpts);
          } catch (err) {
            console.error(`Gagal menginisialisasi Supabase Shard [${sId}]:`, err);
          }
        }
        validShards.push({
          id: sId,
          name: shard.name || `Server ${index + 1}`,
          url: cUrl,
          key: cKey,
          client: clientInstance
        });
      }
    });
  }

  // Fallback ke defaultUrl jika shards kosong
  if (validShards.length === 0 && hasDefaultSupabase) {
    let clientInstance = null;
    if (window.supabase) {
      try {
        const clientOpts = isAdminPage
          ? { auth: { storageKey: 'cbt_admin_shard_1', persistSession: true } }
          : { auth: { storageKey: 'cbt_peserta_shard_1', storage: window.sessionStorage, persistSession: true } };
        clientInstance = window.supabase.createClient(defaultUrl, defaultKey, clientOpts);
      } catch (err) {
        console.error("Gagal menginisialisasi default Supabase client:", err);
      }
    }
    validShards.push({
      id: 1,
      name: "Server Utama",
      url: defaultUrl,
      key: defaultKey,
      client: clientInstance
    });
  }

  window.CBT_VALID_SHARDS = validShards;

  // Helper: Ambil semua shard yang valid
  window.getSupabaseShards = function () {
    return window.CBT_VALID_SHARDS || [];
  };

  // Helper: Cek apakah sedang dalam Mode Gabungan (Unified All Servers)
  window.isUnifiedSupabaseMode = function () {
    if (!window.CBT_CONFIG || window.CBT_CONFIG.backend !== 'supabase') return false;
    const activeId = sessionStorage.getItem(SHARD_ID_KEY);
    return (activeId === 'all' || !activeId) && (window.CBT_VALID_SHARDS && window.CBT_VALID_SHARDS.length > 1);
  };

  // Helper: Dapatkan ID Shard aktif ('all' atau ID angka)
  window.getActiveSupabaseShardId = function () {
    const saved = sessionStorage.getItem(SHARD_ID_KEY);
    if (saved) return saved;
    // Default di admin: jika multi-shard aktif, jadikan 'all' sebagai default
    return (window.CBT_VALID_SHARDS && window.CBT_VALID_SHARDS.length > 1) ? 'all' : (window.CBT_VALID_SHARDS[0] ? String(window.CBT_VALID_SHARDS[0].id) : null);
  };

  // Helper: Ganti / Aktifkan Shard tertentu ('all' untuk semua server)
  window.setActiveSupabaseShard = function (shardId) {
    if (shardId === 'all' || !shardId) {
      sessionStorage.setItem(SHARD_ID_KEY, 'all');
      sessionStorage.setItem(SHARD_NAME_KEY, 'Semua Server (Gabungan)');
      if (window.CBT_VALID_SHARDS && window.CBT_VALID_SHARDS.length > 0) {
        window.supabaseClient = window.CBT_VALID_SHARDS[0].client;
      }
      return { id: 'all', name: 'Semua Server (Gabungan)', client: window.supabaseClient };
    }

    const target = (window.CBT_VALID_SHARDS || []).find(s => String(s.id) === String(shardId));
    if (target && target.client) {
      window.supabaseClient = target.client;
      sessionStorage.setItem(SHARD_ID_KEY, String(target.id));
      sessionStorage.setItem(SHARD_NAME_KEY, target.name);
      if (window.CBT_CONFIG) {
        window.CBT_CONFIG.url = target.url;
        window.CBT_CONFIG.key = target.key;
        window.CBT_CONFIG.activeShard = target;
      }
      return target;
    }
    return null;
  };

  // Helper: Penentuan otomatis Shard untuk Siswa berdasarkan Jurusan / Sesi
  window.getShardForPeserta = function (jurusan, sesi) {
    const shards = window.getSupabaseShards();
    if (shards.length <= 1) return shards[0] || null;

    const j = (jurusan || '').toUpperCase();
    const s = (sesi || '').toUpperCase();

    // 1. Cocokkan nama jurusan dengan nama server
    for (const shard of shards) {
      const sName = (shard.name || '').toUpperCase();
      if (j) {
        if (j.includes('TKJ') && sName.includes('TKJ')) return shard;
        if (j.includes('ATP') && sName.includes('ATP')) return shard;
        if (j.includes('TKRO') && sName.includes('TKRO')) return shard;
        if (j.includes('TBSM') && sName.includes('TBSM')) return shard;
        if ((j.includes('AK') || j.includes('AKUN')) && (sName.includes('AK') || sName.includes('AKUN'))) return shard;
        if (j.includes('MM') && sName.includes('MM')) return shard;
        if (j.includes('RPL') && sName.includes('RPL')) return shard;
      }
    }

    // 2. Cocokkan Sesi jika jurusan tidak spesifik (misal: "Sesi 1" -> Shard 1)
    for (const shard of shards) {
      const sName = (shard.name || '').toUpperCase();
      if (s && sName.includes(s)) return shard;
    }

    // 3. Fallback: jika admin sedang memilih 1 server tertentu (bukan 'all'), gunakan server itu
    const activeId = sessionStorage.getItem(SHARD_ID_KEY);
    if (activeId && activeId !== 'all') {
      const target = shards.find(x => String(x.id) === String(activeId));
      if (target) return target;
    }

    return shards[0];
  };

  if (validShards.length > 0) {
    const initialShardId = window.getActiveSupabaseShardId();
    if (initialShardId === 'all') {
      window.supabaseClient = validShards[0].client;
      sessionStorage.setItem(SHARD_ID_KEY, 'all');
      sessionStorage.setItem(SHARD_NAME_KEY, 'Semua Server (Gabungan)');
    } else {
      let activeShard = validShards.find(s => String(s.id) === String(initialShardId)) || validShards[0];
      window.supabaseClient = activeShard.client;
      sessionStorage.setItem(SHARD_ID_KEY, String(activeShard.id));
      sessionStorage.setItem(SHARD_NAME_KEY, activeShard.name);
    }

    window.CBT_CONFIG = {
      backend: 'supabase',
      url: validShards[0].url,
      key: validShards[0].key,
      isConfigured: true,
      isMultiShard: validShards.length > 1,
      shardCount: validShards.length
    };

    console.info(`[CBT Supabase] Aktif: Mode Multi-Shard (${validShards.length} server terdaftar).`);
  } else {
    window.CBT_CONFIG = { backend: 'local', url: '', key: '', isConfigured: false, isMultiShard: false };
    window.supabaseClient = null;
    console.warn("Supabase credentials belum diisi. Aplikasi berjalan dalam mode lokal atau silakan atur di config.js.");
  }
})();
