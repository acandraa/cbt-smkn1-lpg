<?php
// =====================================================================
// REST API (PHP + MySQL) untuk CBT SMK Negeri 1 Lempuing
// Dipakai saat window.CBT_BACKEND = "php" di js/config.js
//
// Semua request: POST JSON { "action": "...", ...parameter }
// Response sukses : { "data": ... }
// Response gagal  : { "error": "pesan" } + HTTP status 4xx/5xx
// =====================================================================

declare(strict_types=1);

$CONFIG = require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

if (!empty($CONFIG['debug'])) {
    ini_set('display_errors', '1');
    error_reporting(E_ALL);
} else {
    ini_set('display_errors', '0');
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

class ApiError extends Exception
{
    public int $status;
    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function respond($data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode(['data' => $data], JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $status = 400): void
{
    throw new ApiError($message, $status);
}

function db(): PDO
{
    static $pdo = null;
    global $CONFIG;
    if ($pdo === null) {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $CONFIG['db_host'],
            (int)$CONFIG['db_port'],
            $CONFIG['db_name'],
            $CONFIG['db_charset']
        );
        $pdo = new PDO($dsn, $CONFIG['db_user'], $CONFIG['db_pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        // Semua waktu disimpan dalam UTC
        $pdo->exec("SET time_zone = '+00:00'");
    }
    return $pdo;
}

function uuidv4(): string
{
    $d = random_bytes(16);
    $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
    $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
}

/** ISO-8601 (dari browser) -> 'Y-m-d H:i:s' UTC untuk MySQL */
function toDbDate($value): ?string
{
    if ($value === null || $value === '') return null;
    try {
        $dt = new DateTime((string)$value);
        $dt->setTimezone(new DateTimeZone('UTC'));
        return $dt->format('Y-m-d H:i:s');
    } catch (Exception $e) {
        return null;
    }
}

const DATE_COLS  = ['jadwal_mulai', 'jadwal_selesai', 'created_at', 'updated_at', 'waktu_mulai', 'waktu_selesai'];
const BOOL_COLS  = ['is_locked', 'tampilkan_nilai', 'token_aktif', 'acak_soal', 'ragu_ragu', 'benar'];
const INT_COLS   = ['pelanggaran', 'durasi_menit', 'nomor', 'bobot', 'jumlah_benar', 'jumlah_salah'];
const FLOAT_COLS = ['nilai', 'passing_grade'];

/** Normalisasi tipe data baris MySQL agar sama dengan format Supabase */
function normalizeRow(?array $row): ?array
{
    if ($row === null) return null;
    foreach ($row as $k => $v) {
        if ($v === null) continue;
        if (in_array($k, DATE_COLS, true)) {
            $row[$k] = str_replace(' ', 'T', (string)$v) . 'Z';
        } elseif (in_array($k, BOOL_COLS, true)) {
            $row[$k] = (bool)(int)$v;
        } elseif (in_array($k, INT_COLS, true)) {
            $row[$k] = (int)$v;
        } elseif (in_array($k, FLOAT_COLS, true)) {
            $row[$k] = (float)$v;
        }
    }
    return $row;
}

function normalizeRows(array $rows): array
{
    return array_map('normalizeRow', $rows);
}

function fetchAll(string $sql, array $params = []): array
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return normalizeRows($st->fetchAll());
}

function fetchOne(string $sql, array $params = []): ?array
{
    $st = db()->prepare($sql);
    $st->execute($params);
    $row = $st->fetch();
    return $row === false ? null : normalizeRow($row);
}

function exec_sql(string $sql, array $params = []): int
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st->rowCount();
}

/** Ambil hanya kolom yang diizinkan dari payload */
function pick(array $src, array $allowed): array
{
    $out = [];
    foreach ($allowed as $col) {
        if (array_key_exists($col, $src)) $out[$col] = $src[$col];
    }
    return $out;
}

function toBit($v): int
{
    return ($v === true || $v === 1 || $v === '1' || $v === 'true') ? 1 : 0;
}

function emptyToNull($v)
{
    return ($v === '' || $v === null) ? null : $v;
}

// ---------------------------------------------------------------------
// Session & Authorization
// ---------------------------------------------------------------------

function startSession(): void
{
    global $CONFIG;
    $secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    session_name($CONFIG['session_name'] ?? 'CBTSESS');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function currentAdmin(): ?array
{
    return $_SESSION['admin'] ?? null;
}

function currentGuru(): ?array
{
    return $_SESSION['guru'] ?? null;
}

function currentPesertaId(): ?string
{
    return $_SESSION['peserta_id'] ?? null;
}

function requireAdmin(): array
{
    $a = currentAdmin();
    if (!$a) fail('Akses ditolak: Hanya Administrator.', 403);
    return $a;
}

function requireAdminOrGuru(): array
{
    $a = currentAdmin();
    if ($a) return $a;
    $g = currentGuru();
    if ($g) return $g;
    fail('Akses ditolak: Hanya Administrator atau Guru.', 403);
}

function requireAnyLogin(): void
{
    if (!currentAdmin() && !currentGuru() && !currentPesertaId()) fail('Sesi berakhir. Silakan login kembali.', 401);
}

function ensureGuruTable(): void
{
    try {
        db()->query("SELECT 1 FROM guru LIMIT 1");
    } catch (Throwable $e) {
        db()->exec("CREATE TABLE IF NOT EXISTS guru (
            id CHAR(36) NOT NULL PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            nama_lengkap VARCHAR(255) NOT NULL,
            mapel_diampu TEXT NOT NULL,
            jurusan_diampu TEXT DEFAULT NULL,
            kelas_diampu TEXT DEFAULT NULL,
            paket_ids TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    }
    try { db()->query("SELECT jurusan_diampu FROM guru LIMIT 1"); }
    catch (Throwable $e) { db()->exec("ALTER TABLE guru ADD COLUMN jurusan_diampu TEXT DEFAULT NULL AFTER mapel_diampu"); }
    try { db()->query("SELECT kelas_diampu FROM guru LIMIT 1"); }
    catch (Throwable $e) { db()->exec("ALTER TABLE guru ADD COLUMN kelas_diampu TEXT DEFAULT NULL AFTER jurusan_diampu"); }
}

/**
 * Admin boleh mengakses peserta mana pun.
 * Peserta hanya boleh mengakses datanya sendiri.
 */
function resolvePesertaId($requested): string
{
    if (currentAdmin()) {
        if (!$requested) fail('peserta_id wajib diisi.');
        return (string)$requested;
    }
    $own = currentPesertaId();
    if (!$own) fail('Sesi berakhir. Silakan login kembali.', 401);
    if ($requested && (string)$requested !== $own) fail('Akses ditolak.', 403);
    return $own;
}

// ---------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Gunakan metode POST.']);
    exit;
}

$raw = file_get_contents('php://input');
$req = json_decode($raw ?: '{}', true);
if (!is_array($req)) $req = [];
$action = (string)($req['action'] ?? '');

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

try {
    startSession();

    // Aksi yang mengubah session harus tetap memegang lock session.
    // Aksi lain melepas lock agar request paralel (simpan jawaban) tidak antre.
    if (!in_array($action, ['loginAdmin', 'loginGuru', 'loginPeserta', 'logout'], true)) {
        session_write_close();
    }

    switch ($action) {

        // ---------------- UTIL ----------------
        case 'ping':
            // Dipakai js/supabase-config.js untuk deteksi otomatis mode "php"
            respond(['ok' => true, 'backend' => 'php', 'time' => gmdate('c')]);

        case 'dbCheck':
            db()->query('SELECT 1');
            respond(['ok' => true]);

        // ---------------- AUTH ----------------
        case 'loginAdmin': {
            $email = trim((string)($req['email'] ?? ''));
            $pass  = (string)($req['password'] ?? '');
            $admin = fetchOne('SELECT id, email, password_hash FROM admins WHERE email = ?', [$email]);
            if (!$admin || !password_verify($pass, $admin['password_hash'])) {
                fail('Email atau Password Admin salah.', 401);
            }
            session_regenerate_id(true);
            unset($_SESSION['guru']);
            $_SESSION['admin'] = ['id' => $admin['id'], 'email' => $admin['email'], 'role' => 'admin'];
            respond($_SESSION['admin']);
        }

        case 'loginGuru': {
            ensureGuruTable();
            $username = trim((string)($req['username'] ?? ''));
            $pass     = (string)($req['password'] ?? '');
            $guru = fetchOne('SELECT * FROM guru WHERE LOWER(username) = LOWER(?)', [$username]);
            if (!$guru) {
                fail('Username Guru tidak ditemukan.', 401);
            }
            $sha256Pass = hash('sha256', $pass);
            $validPass = password_verify($pass, $guru['password_hash']) || hash_equals($guru['password_hash'], $sha256Pass);
            if (!$validPass) {
                fail('Password Guru salah.', 401);
            }
            session_regenerate_id(true);
            unset($_SESSION['admin']);
            $paketIds = [];
            if (!empty($guru['paket_ids'])) {
                $decoded = json_decode((string)$guru['paket_ids'], true);
                if (is_array($decoded)) $paketIds = $decoded;
            }
            $_SESSION['guru'] = [
                'id'             => $guru['id'],
                'username'       => $guru['username'],
                'email'          => $guru['username'],
                'nama_lengkap'   => $guru['nama_lengkap'],
                'mapel_diampu'   => $guru['mapel_diampu'],
                'jurusan_diampu' => $guru['jurusan_diampu'] ?? '',
                'kelas_diampu'   => $guru['kelas_diampu'] ?? '',
                'paket_ids'      => $paketIds,
                'role'           => 'guru',
            ];
            respond($_SESSION['guru']);
        }

        case 'loginPeserta': {
            $rawUsername = trim((string)($req['username'] ?? ''));
            $cleanUser   = strtolower((string)preg_replace('/\s+/', '', $rawUsername));
            $pass        = (string)($req['password'] ?? '');
            $cleanPass   = trim($pass);

            $p = fetchOne('SELECT * FROM peserta WHERE LOWER(TRIM(username)) = LOWER(?)', [$cleanUser]);
            if (!$p && $rawUsername !== $cleanUser) {
                $p = fetchOne('SELECT * FROM peserta WHERE LOWER(TRIM(username)) = LOWER(?)', [$rawUsername]);
            }
            if (!$p && preg_match('/^0+\d+$/', $cleanUser)) {
                $noZeroUser = ltrim($cleanUser, '0');
                $p = fetchOne('SELECT * FROM peserta WHERE LOWER(TRIM(username)) = LOWER(?)', [$noZeroUser]);
            }

            if (!$p) {
                fail('Nomor Peserta atau Password salah.', 401);
            }

            $passCandidates = array_values(array_unique(array_filter([
                $cleanPass,
                $pass,
                strtolower($cleanPass),
                strtoupper($cleanPass),
                preg_match('/^0+\d+$/', $cleanPass) ? ltrim($cleanPass, '0') : '',
                preg_match('/^\d+$/', $cleanPass) ? ('0' . $cleanPass) : '',
            ], fn($v) => $v !== '')));

            $storedHash = trim((string)($p['password_hash'] ?? ''));
            $isValid = false;
            foreach ($passCandidates as $cand) {
                if (password_verify($cand, $storedHash) || hash_equals($storedHash, hash('sha256', $cand)) || hash_equals($storedHash, $cand)) {
                    $isValid = true;
                    break;
                }
            }

            if (!$isValid) {
                fail('Nomor Peserta atau Password salah.', 401);
            }

            session_regenerate_id(true);
            $_SESSION['peserta_id'] = $p['id'];
            unset($p['password_hash']);
            $profile = normalizeRow($p);
            respond([
                'user'    => ['id' => $p['id'], 'email' => strtolower(trim((string)$p['username'])) . '@cbt.smkn1lempuing.sch.id', 'role' => 'peserta'],
                'profile' => $profile,
            ]);
        }

        case 'logout':
            $_SESSION = [];
            if (ini_get('session.use_cookies')) {
                $params = session_get_cookie_params();
                setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'] ?? '', $params['secure'], $params['httponly']);
            }
            session_destroy();
            respond(['ok' => true]);

        case 'session': {
            $role = (string)($req['role'] ?? '');
            if ($role === 'admin' || $role === 'guru') {
                $a = currentAdmin();
                if ($a) {
                    if (!fetchOne('SELECT id FROM admins WHERE id = ?', [$a['id']])) fail('Akun admin tidak ditemukan.', 403);
                    respond($a);
                }
                $g = currentGuru();
                if ($g) {
                    ensureGuruTable();
                    $fresh = fetchOne('SELECT * FROM guru WHERE id = ?', [$g['id']]);
                    if (!$fresh) fail('Akun guru tidak ditemukan.', 403);
                    $paketIds = [];
                    if (!empty($fresh['paket_ids'])) {
                        $decoded = json_decode((string)$fresh['paket_ids'], true);
                        if (is_array($decoded)) $paketIds = $decoded;
                    }
                    $gSession = [
                        'id'             => $fresh['id'],
                        'username'       => $fresh['username'],
                        'email'          => $fresh['username'],
                        'nama_lengkap'   => $fresh['nama_lengkap'],
                        'mapel_diampu'   => $fresh['mapel_diampu'],
                        'jurusan_diampu' => $fresh['jurusan_diampu'] ?? '',
                        'kelas_diampu'   => $fresh['kelas_diampu'] ?? '',
                        'paket_ids'      => $paketIds,
                        'role'           => 'guru',
                    ];
                    $_SESSION['guru'] = $gSession;
                    respond($gSession);
                }
                fail('Belum login sebagai admin atau guru.', 401);
            }
            if ($role === 'peserta') {
                $pid = currentPesertaId();
                if (!$pid) fail('Belum login sebagai peserta.', 401);
                $p = fetchOne('SELECT * FROM peserta WHERE id = ?', [$pid]);
                if (!$p) fail('Data peserta tidak ditemukan.', 403);
                unset($p['password_hash']);
                respond([
                    'user'    => ['id' => $p['id'], 'email' => $p['username'] . '@cbt.smkn1lempuing.sch.id', 'role' => 'peserta'],
                    'profile' => $p,
                ]);
            }
            fail('Role tidak valid.');
        }

        // ---------------- DATA GURU ----------------
        case 'getGuruList': {
            requireAdmin();
            ensureGuruTable();
            $rows = fetchAll('SELECT id, username, nama_lengkap, mapel_diampu, jurusan_diampu, kelas_diampu, paket_ids, created_at FROM guru ORDER BY nama_lengkap ASC');
            $out = array_map(function ($r) {
                $paketIds = [];
                if (!empty($r['paket_ids'])) {
                    $dec = json_decode((string)$r['paket_ids'], true);
                    if (is_array($dec)) $paketIds = $dec;
                }
                $r['paket_ids'] = $paketIds;
                $r['jurusan_diampu'] = $r['jurusan_diampu'] ?? '';
                $r['kelas_diampu']   = $r['kelas_diampu'] ?? '';
                return $r;
            }, $rows);
            respond($out);
        }

        case 'saveGuru': {
            requireAdminOrGuru();
            ensureGuruTable();
            $id      = trim((string)($req['id'] ?? ''));
            $payload = $req['payload'] ?? [];
            $pass    = (string)($req['password'] ?? '');

            $username = trim((string)($payload['username'] ?? ''));
            $nama     = trim((string)($payload['nama_lengkap'] ?? ''));
            $mapel    = trim((string)($payload['mapel_diampu'] ?? ''));
            $jurusan  = trim((string)($payload['jurusan_diampu'] ?? ''));
            $kelas    = trim((string)($payload['kelas_diampu'] ?? ''));
            $paketIds = isset($payload['paket_ids']) && is_array($payload['paket_ids'])
                ? json_encode(array_values($payload['paket_ids']))
                : (is_string($payload['paket_ids'] ?? null) ? $payload['paket_ids'] : '[]');

            if ($username === '' || $nama === '' || $mapel === '') {
                fail('Username, Nama Lengkap, dan Mata Pelajaran yang diampu wajib diisi.');
            }

            if ($id) {
                $dup = fetchOne('SELECT id FROM guru WHERE LOWER(username) = LOWER(?) AND id != ?', [$username, $id]);
                if ($dup) fail('Username guru sudah digunakan akun lain.');
                if ($pass !== '') {
                    $hash = hash('sha256', $pass);
                    exec_sql('UPDATE guru SET username = ?, password_hash = ?, nama_lengkap = ?, mapel_diampu = ?, jurusan_diampu = ?, kelas_diampu = ?, paket_ids = ? WHERE id = ?',
                        [$username, $hash, $nama, $mapel, $jurusan, $kelas, $paketIds, $id]);
                } else {
                    exec_sql('UPDATE guru SET username = ?, nama_lengkap = ?, mapel_diampu = ?, jurusan_diampu = ?, kelas_diampu = ?, paket_ids = ? WHERE id = ?',
                        [$username, $nama, $mapel, $jurusan, $kelas, $paketIds, $id]);
                }
            } else {
                if ($pass === '') fail('Password wajib diisi untuk akun guru baru.');
                $dup = fetchOne('SELECT id FROM guru WHERE LOWER(username) = LOWER(?)', [$username]);
                if ($dup) fail('Username guru sudah terdaftar.');
                $id = uuidv4();
                $hash = hash('sha256', $pass);
                exec_sql('INSERT INTO guru (id, username, password_hash, nama_lengkap, mapel_diampu, jurusan_diampu, kelas_diampu, paket_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
                    [$id, $username, $hash, $nama, $mapel, $jurusan, $kelas, $paketIds]);
            }
            respond(fetchOne('SELECT id, username, nama_lengkap, mapel_diampu, jurusan_diampu, kelas_diampu, paket_ids, created_at FROM guru WHERE id = ?', [$id]));
        }

        case 'deleteGuru': {
            requireAdmin();
            ensureGuruTable();
            $id = trim((string)($req['id'] ?? ''));
            exec_sql('DELETE FROM guru WHERE id = ?', [$id]);
            respond(['ok' => true]);
        }

        case 'changeAdminPassword': {
            $a = requireAdmin();
            $old = (string)($req['old_password'] ?? '');
            $new = (string)($req['new_password'] ?? '');
            if (strlen($new) < 6) fail('Password baru minimal 6 karakter.');
            $row = fetchOne('SELECT password_hash FROM admins WHERE id = ?', [$a['id']]);
            if (!$row || !password_verify($old, $row['password_hash'])) fail('Password lama salah.', 401);
            exec_sql('UPDATE admins SET password_hash = ? WHERE id = ?', [password_hash($new, PASSWORD_BCRYPT), $a['id']]);
            respond(['ok' => true]);
        }

        // ---------------- PENGATURAN ----------------
        case 'getSettings':
            requireAnyLogin();
            respond(fetchOne('SELECT * FROM pengaturan_ujian WHERE id = 1'));

        case 'saveSettings': {
            requireAdmin();
            $s = $req['settings'] ?? [];
            exec_sql(
                'INSERT INTO pengaturan_ujian (id, durasi_menit, passing_grade, tampilkan_nilai, token_ujian, token_aktif, acak_soal, updated_at)
                 VALUES (1, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE durasi_menit = VALUES(durasi_menit), passing_grade = VALUES(passing_grade),
                   tampilkan_nilai = VALUES(tampilkan_nilai), token_ujian = VALUES(token_ujian),
                   token_aktif = VALUES(token_aktif), acak_soal = VALUES(acak_soal), updated_at = UTC_TIMESTAMP()',
                [
                    (int)($s['durasi_menit'] ?? 60),
                    (float)($s['passing_grade'] ?? 60),
                    toBit($s['tampilkan_nilai'] ?? true),
                    substr((string)($s['token_ujian'] ?? 'CBT123'), 0, 10) ?: 'CBT123',
                    toBit($s['token_aktif'] ?? false),
                    toBit($s['acak_soal'] ?? true),
                ]
            );
            respond(fetchOne('SELECT * FROM pengaturan_ujian WHERE id = 1'));
        }

        // ---------------- PESERTA ----------------
        case 'getPesertaList':
            requireAdmin();
            respond(fetchAll(
                'SELECT id, username, nama_lengkap, jurusan, kelas, ruang, sesi, status_ujian, pelanggaran, is_locked, created_at
                 FROM peserta ORDER BY created_at DESC'
            ));

        case 'registerPeserta': {
            requireAdmin();
            $username = strtolower((string)preg_replace('/\s+/', '', trim((string)($req['username'] ?? ''))));
            $pass     = trim((string)($req['password'] ?? ''));
            $nama     = trim((string)($req['nama_lengkap'] ?? ''));
            if ($username === '' || $pass === '' || $nama === '') fail('Username, password, dan nama wajib diisi.');

            $existing = fetchOne('SELECT id FROM peserta WHERE LOWER(TRIM(username)) = LOWER(?)', [$username]);
            if ($existing) {
                $existingId = (string)$existing['id'];
                exec_sql(
                    'UPDATE peserta SET username = ?, password_hash = ?, nama_lengkap = ?, jurusan = ?, kelas = ?, ruang = ?, sesi = ? WHERE id = ?',
                    [
                        $username, password_hash($pass, PASSWORD_BCRYPT), $nama,
                        emptyToNull($req['jurusan'] ?? null), emptyToNull($req['kelas'] ?? null),
                        emptyToNull($req['ruang'] ?? null), emptyToNull($req['sesi'] ?? null),
                        $existingId,
                    ]
                );
                respond($existingId);
            }

            $id = uuidv4();
            exec_sql(
                'INSERT INTO peserta (id, username, password_hash, nama_lengkap, jurusan, kelas, ruang, sesi, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
                [
                    $id, $username, password_hash($pass, PASSWORD_BCRYPT), $nama,
                    emptyToNull($req['jurusan'] ?? null), emptyToNull($req['kelas'] ?? null),
                    emptyToNull($req['ruang'] ?? null), emptyToNull($req['sesi'] ?? null),
                ]
            );
            respond($id);
        }

        case 'editPeserta': {
            requireAdmin();
            $id = (string)($req['id'] ?? '');
            $payload = pick($req['payload'] ?? [], ['username', 'nama_lengkap', 'jurusan', 'kelas', 'ruang', 'sesi']);
            if ($payload) {
                if (isset($payload['username'])) {
                    $payload['username'] = strtolower((string)preg_replace('/\s+/', '', trim((string)$payload['username'])));
                    if (fetchOne('SELECT id FROM peserta WHERE LOWER(TRIM(username)) = LOWER(?) AND id <> ?', [$payload['username'], $id])) {
                        fail("Username '{$payload['username']}' sudah dipakai peserta lain.", 409);
                    }
                }
                $sets = implode(', ', array_map(fn($c) => "`$c` = ?", array_keys($payload)));
                exec_sql("UPDATE peserta SET $sets WHERE id = ?", [...array_values($payload), $id]);
            }
            $pass = trim((string)($req['password'] ?? ''));
            if ($pass !== '') {
                exec_sql('UPDATE peserta SET password_hash = ? WHERE id = ?', [password_hash($pass, PASSWORD_BCRYPT), $id]);
            }
            respond(['ok' => true]);
        }

        case 'deletePeserta':
            requireAdmin();
            exec_sql('DELETE FROM peserta WHERE id = ?', [(string)($req['id'] ?? '')]);
            respond(['ok' => true]);

        case 'deleteAllPeserta':
            requireAdmin();
            exec_sql('DELETE FROM peserta');
            respond(['ok' => true]);

        case 'updateStatusUjian': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            $status = (string)($req['status'] ?? '');
            if (!in_array($status, ['Belum Ujian', 'Sedang Ujian', 'Sudah Ujian'], true)) fail('Status tidak valid.');
            // Peserta tidak boleh mengembalikan status "Sudah Ujian" menjadi status lain
            if (!currentAdmin()) {
                $cur = fetchOne('SELECT status_ujian FROM peserta WHERE id = ?', [$pid]);
                if ($cur && $cur['status_ujian'] === 'Sudah Ujian' && $status !== 'Sudah Ujian') fail('Ujian sudah selesai.', 403);
            }
            exec_sql('UPDATE peserta SET status_ujian = ? WHERE id = ?', [$status, $pid]);
            respond(['ok' => true]);
        }

        case 'incrementPelanggaran': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            exec_sql('UPDATE peserta SET pelanggaran = pelanggaran + 1, is_locked = CASE WHEN (pelanggaran + 1) % 3 = 0 THEN 1 ELSE is_locked END WHERE id = ?', [$pid]);
            respond(['ok' => true]);
        }

        case 'unlockPesertaByToken': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            $inputToken = strtoupper(trim((string)($req['token'] ?? '')));
            if ($inputToken === '') fail('Token Pembebas wajib diisi.');
            $settings = fetchOne('SELECT token_ujian FROM pengaturan_ujian WHERE id = 1');
            $validToken = strtoupper(trim((string)($settings['token_ujian'] ?? 'CBT123')));
            if ($inputToken !== $validToken) {
                fail('Token Pembebas tidak valid atau salah! Silakan minta token aktif kepada Pengawas Ujian.');
            }
            exec_sql('UPDATE peserta SET is_locked = 0 WHERE id = ?', [$pid]);
            respond(['ok' => true]);
        }

        case 'toggleLockPeserta': {
            requireAdmin();
            $locked = toBit($req['is_locked'] ?? false);
            $pid = (string)($req['peserta_id'] ?? '');
            exec_sql('UPDATE peserta SET is_locked = ? WHERE id = ?', [$locked, $pid]);
            respond(['ok' => true]);
        }

        // ---------------- JURUSAN ----------------
        case 'getJurusanList': {
            requireAnyLogin();
            db()->exec("CREATE TABLE IF NOT EXISTS jurusan (
                id CHAR(36) NOT NULL PRIMARY KEY,
                nama_jurusan VARCHAR(100) NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

            $countRow = fetchOne('SELECT COUNT(*) AS c FROM jurusan');
            $count = (int)($countRow ? $countRow['c'] : 0);
            if ($count === 0) {
                $existing = fetchAll('SELECT DISTINCT UPPER(TRIM(jurusan)) AS j FROM peserta WHERE jurusan IS NOT NULL AND jurusan != "" UNION SELECT DISTINCT UPPER(TRIM(jurusan)) AS j FROM paket_soal WHERE jurusan IS NOT NULL AND jurusan != "" AND LOWER(jurusan) != "semua"');
                $defaultList = ['TKJ', 'RPL', 'Multimedia'];
                foreach ($existing as $row) {
                    if (!empty($row['j']) && !in_array($row['j'], $defaultList, true)) {
                        $defaultList[] = $row['j'];
                    }
                }
                foreach ($defaultList as $j) {
                    exec_sql('INSERT IGNORE INTO jurusan (id, nama_jurusan, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [uuidv4(), $j]);
                }
            }
            respond(fetchAll('SELECT * FROM jurusan ORDER BY nama_jurusan ASC'));
        }

        case 'saveJurusan': {
            requireAdmin();
            $id = (string)($req['id'] ?? '');
            $nama = strtoupper(trim((string)($req['nama_jurusan'] ?? '')));
            if ($nama === '') fail('Nama jurusan wajib diisi.');

            db()->exec("CREATE TABLE IF NOT EXISTS jurusan (
                id CHAR(36) NOT NULL PRIMARY KEY,
                nama_jurusan VARCHAR(100) NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

            if ($id) {
                exec_sql('UPDATE jurusan SET nama_jurusan = ? WHERE id = ?', [$nama, $id]);
            } else {
                $id = uuidv4();
                exec_sql('INSERT INTO jurusan (id, nama_jurusan, created_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE nama_jurusan = VALUES(nama_jurusan)', [$id, $nama]);
            }
            respond(fetchOne('SELECT * FROM jurusan WHERE id = ?', [$id]));
        }

        case 'deleteJurusan': {
            requireAdmin();
            $id = (string)($req['id'] ?? '');
            exec_sql('DELETE FROM jurusan WHERE id = ?', [$id]);
            respond(['ok' => true]);
        }

        // ---------------- KELAS ----------------
        case 'getKelasList': {
            requireAnyLogin();
            db()->exec("CREATE TABLE IF NOT EXISTS kelas (
                id CHAR(36) NOT NULL PRIMARY KEY,
                nama_kelas VARCHAR(50) NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

            try {
                db()->query("SELECT nama_kelas FROM kelas LIMIT 1");
            } catch (Throwable $e) {
                try {
                    db()->exec("ALTER TABLE kelas CHANGE COLUMN nama nama_kelas VARCHAR(50) NOT NULL");
                } catch (Throwable $e2) {
                    db()->exec("ALTER TABLE kelas ADD COLUMN nama_kelas VARCHAR(50) NOT NULL");
                }
            }

            try {
                db()->query("SELECT nama_kelas FROM kelas LIMIT 1");
            } catch (Throwable $e) {
                try {
                    db()->exec("ALTER TABLE kelas CHANGE COLUMN nama nama_kelas VARCHAR(50) NOT NULL");
                } catch (Throwable $e2) {
                    db()->exec("ALTER TABLE kelas ADD COLUMN nama_kelas VARCHAR(50) NOT NULL");
                }
            }

            $countRow = fetchOne('SELECT COUNT(*) AS c FROM kelas');
            $count = (int)($countRow ? $countRow['c'] : 0);
            if ($count === 0) {
                $existing = fetchAll('SELECT DISTINCT UPPER(TRIM(kelas)) AS k FROM peserta WHERE kelas IS NOT NULL AND kelas != ""');
                $defaultList = ['X TKJ 1', 'X TKJ 2', 'X RPL 1', 'X RPL 2', 'XI MM 1'];
                foreach ($existing as $row) {
                    if (!empty($row['k']) && !in_array($row['k'], $defaultList, true)) {
                        $defaultList[] = $row['k'];
                    }
                }
                foreach ($defaultList as $k) {
                    exec_sql('INSERT IGNORE INTO kelas (id, nama_kelas, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [uuidv4(), $k]);
                }
            }
            respond(fetchAll('SELECT * FROM kelas ORDER BY nama_kelas ASC'));
        }

        case 'saveKelas': {
            requireAdmin();
            $id = (string)($req['id'] ?? '');
            $nama = strtoupper(trim((string)($req['nama_kelas'] ?? '')));
            if ($nama === '') fail('Nama kelas wajib diisi.');

            db()->exec("CREATE TABLE IF NOT EXISTS kelas (
                id CHAR(36) NOT NULL PRIMARY KEY,
                nama_kelas VARCHAR(50) NOT NULL UNIQUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

            try {
                db()->query("SELECT nama_kelas FROM kelas LIMIT 1");
            } catch (Throwable $e) {
                try {
                    db()->exec("ALTER TABLE kelas CHANGE COLUMN nama nama_kelas VARCHAR(50) NOT NULL");
                } catch (Throwable $e2) {
                    db()->exec("ALTER TABLE kelas ADD COLUMN nama_kelas VARCHAR(50) NOT NULL");
                }
            }

            if ($id) {
                exec_sql('UPDATE kelas SET nama_kelas = ? WHERE id = ?', [$nama, $id]);
            } else {
                $id = uuidv4();
                exec_sql('INSERT INTO kelas (id, nama_kelas, created_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE nama_kelas = VALUES(nama_kelas)', [$id, $nama]);
            }
            respond(fetchOne('SELECT * FROM kelas WHERE id = ?', [$id]));
        }

        case 'deleteKelas': {
            requireAdmin();
            $id = (string)($req['id'] ?? '');
            exec_sql('DELETE FROM kelas WHERE id = ?', [$id]);
            respond(['ok' => true]);
        }

        // ---------------- PAKET SOAL ----------------
        case 'getPaketList': {
            requireAnyLogin();
            // Pastikan kolom kelas ada di tabel paket_soal
            try { db()->query("SELECT kelas FROM paket_soal LIMIT 1"); }
            catch (Throwable $e) { db()->exec("ALTER TABLE paket_soal ADD COLUMN kelas VARCHAR(50) DEFAULT NULL AFTER jurusan"); }
            $rows = fetchAll(
                'SELECT p.*, (SELECT COUNT(*) FROM soal s WHERE s.paket_soal_id = p.id) AS total_soal
                 FROM paket_soal p
                 ORDER BY p.created_at DESC'
            );
            $out = array_map(function ($r) {
                $r['total_soal'] = (int)($r['total_soal'] ?? 0);
                return $r;
            }, $rows);
            respond($out);
        }

        case 'savePaket': {
            requireAdminOrGuru();
            try { db()->query("SELECT kelas FROM paket_soal LIMIT 1"); }
            catch (Throwable $e) { db()->exec("ALTER TABLE paket_soal ADD COLUMN kelas VARCHAR(50) DEFAULT NULL AFTER jurusan"); }

            $id = (string)($req['id'] ?? '');
            $p = $req['payload'] ?? [];
            $data = [
                'nama_paket'     => trim((string)($p['nama_paket'] ?? '')),
                'jurusan'        => emptyToNull($p['jurusan'] ?? null),
                'kelas'          => emptyToNull($p['kelas'] ?? null),
                'jadwal_mulai'   => toDbDate($p['jadwal_mulai'] ?? null),
                'jadwal_selesai' => toDbDate($p['jadwal_selesai'] ?? null),
            ];
            if ($data['nama_paket'] === '') fail('Nama paket wajib diisi.');
            if ($id) {
                exec_sql('UPDATE paket_soal SET nama_paket = ?, jurusan = ?, kelas = ?, jadwal_mulai = ?, jadwal_selesai = ? WHERE id = ?',
                    [...array_values($data), $id]);
            } else {
                $id = uuidv4();
                exec_sql('INSERT INTO paket_soal (id, nama_paket, jurusan, kelas, jadwal_mulai, jadwal_selesai, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
                    [$id, ...array_values($data)]);
            }
            respond(fetchOne('SELECT * FROM paket_soal WHERE id = ?', [$id]));
        }

        case 'deletePaket':
            requireAdminOrGuru();
            exec_sql('DELETE FROM paket_soal WHERE id = ?', [(string)($req['id'] ?? '')]);
            respond(['ok' => true]);

        // ---------------- SOAL ----------------
        case 'getSoalByPaket':
            requireAnyLogin();
            respond(fetchAll('SELECT * FROM soal WHERE paket_soal_id = ? ORDER BY nomor ASC', [(string)($req['paket_id'] ?? '')]));

        case 'getSoalList':
            requireAdminOrGuru();
            respond(fetchAll('SELECT * FROM soal ORDER BY paket_soal_id, nomor ASC'));

        case 'saveSoal': {
            requireAdminOrGuru();
            $id = (string)($req['id'] ?? '');
            $s = soalPayload($req['payload'] ?? []);
            if ($id) {
                $sets = implode(', ', array_map(fn($c) => "`$c` = ?", array_keys($s)));
                exec_sql("UPDATE soal SET $sets WHERE id = ?", [...array_values($s), $id]);
            } else {
                insertSoal($s);
            }
            respond(['ok' => true]);
        }

        case 'deleteSoal':
            requireAdminOrGuru();
            exec_sql('DELETE FROM soal WHERE id = ?', [(string)($req['id'] ?? '')]);
            respond(['ok' => true]);

        case 'bulkInsertSoal': {
            requireAdminOrGuru();
            $items = $req['items'] ?? [];
            if (!is_array($items)) fail('Format data soal tidak valid.');
            $pdo = db();
            $pdo->beginTransaction();
            try {
                foreach ($items as $it) insertSoal(soalPayload($it));
                $pdo->commit();
            } catch (Throwable $e) {
                $pdo->rollBack();
                throw $e;
            }
            respond(['inserted' => count($items)]);
        }

        // ---------------- HASIL UJIAN ----------------
        case 'getHasilList': {
            requireAdminOrGuru();
            // Pastikan kolom paket_soal_id ada di tabel hasil_ujian
            try { db()->query("SELECT paket_soal_id FROM hasil_ujian LIMIT 1"); }
            catch (Throwable $e) { db()->exec("ALTER TABLE hasil_ujian ADD COLUMN paket_soal_id CHAR(36) DEFAULT NULL AFTER peserta_id"); }

            try { db()->exec("ALTER TABLE hasil_ujian MODIFY COLUMN status_kelulusan VARCHAR(50) NOT NULL DEFAULT 'Selesai'"); }
            catch (Throwable $e) {}

            $rows = fetchAll(
                'SELECT h.id, h.peserta_id, h.paket_soal_id, h.jumlah_benar, h.jumlah_salah, h.nilai, h.status_kelulusan, h.waktu_selesai,
                        COALESCE(ps.nama_paket, (
                            SELECT ps2.nama_paket FROM jawaban_peserta jp 
                            JOIN soal s ON s.id = jp.soal_id 
                            JOIN paket_soal ps2 ON ps2.id = s.paket_soal_id 
                            WHERE jp.peserta_id = h.peserta_id LIMIT 1
                        ), "Umum / Ujian Utama") AS nama_mapel,
                        p.id AS p_id, p.username AS p_username, p.nama_lengkap AS p_nama_lengkap,
                        p.kelas AS p_kelas, p.jurusan AS p_jurusan
                 FROM hasil_ujian h 
                 LEFT JOIN peserta p ON p.id = h.peserta_id
                 LEFT JOIN paket_soal ps ON ps.id = h.paket_soal_id
                 ORDER BY h.waktu_selesai DESC, h.nilai DESC'
            );
            $out = array_map(function ($r) {
                return [
                    'id'               => $r['id'],
                    'paket_soal_id'    => $r['paket_soal_id'],
                    'nama_mapel'       => $r['nama_mapel'],
                    'jumlah_benar'     => $r['jumlah_benar'],
                    'jumlah_salah'     => $r['jumlah_salah'],
                    'nilai'            => $r['nilai'],
                    'status_kelulusan' => $r['status_kelulusan'],
                    'waktu_selesai'    => $r['waktu_selesai'],
                    'peserta'          => $r['p_id'] ? [
                        'id'           => $r['p_id'],
                        'username'     => $r['p_username'],
                        'nama_lengkap' => $r['p_nama_lengkap'],
                        'kelas'        => $r['p_kelas'],
                        'jurusan'      => $r['p_jurusan'],
                    ] : null,
                ];
            }, $rows);
            respond($out);
        }

        case 'checkExistingHasil': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            $paketId = (string)($req['paket_soal_id'] ?? '');
            if ($paketId !== '') {
                respond(fetchOne('SELECT * FROM hasil_ujian WHERE peserta_id = ? AND paket_soal_id = ?', [$pid, $paketId]));
            } else {
                respond(fetchOne('SELECT * FROM hasil_ujian WHERE peserta_id = ? ORDER BY created_at DESC LIMIT 1', [$pid]));
            }
        }

        case 'insertHasil': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            $paketId = (string)($req['paket_soal_id'] ?? '') ?: null;
            $status = (string)($req['status_kelulusan'] ?? '-');
            if (!in_array($status, ['Lulus', 'Tidak Lulus', '-', 'Selesai'], true)) {
                $status = '-';
            }

            try { db()->query("SELECT paket_soal_id FROM hasil_ujian LIMIT 1"); }
            catch (Throwable $e) { db()->exec("ALTER TABLE hasil_ujian ADD COLUMN paket_soal_id CHAR(36) DEFAULT NULL AFTER peserta_id"); }

            try { db()->exec("ALTER TABLE hasil_ujian MODIFY COLUMN status_kelulusan VARCHAR(50) NOT NULL DEFAULT 'Selesai'"); }
            catch (Throwable $e) {}

            $hid = uuidv4();
            $params = [
                $hid, $pid, $paketId,
                (int)($req['jumlah_benar'] ?? 0),
                (int)($req['jumlah_salah'] ?? 0),
                (float)($req['nilai'] ?? 0),
                $status,
                toDbDate($req['waktu_mulai'] ?? null),
                toDbDate($req['waktu_selesai'] ?? null) ?? gmdate('Y-m-d H:i:s'),
            ];
            if (currentAdmin()) {
                exec_sql(
                    'INSERT INTO hasil_ujian (id, peserta_id, paket_soal_id, jumlah_benar, jumlah_salah, nilai, status_kelulusan, waktu_mulai, waktu_selesai, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
                    $params
                );
            } else {
                // Peserta hanya boleh mengirim hasil satu kali per paket/mapel
                if ($paketId) {
                    if (fetchOne('SELECT id FROM hasil_ujian WHERE peserta_id = ? AND paket_soal_id = ?', [$pid, $paketId])) {
                        fail('Hasil ujian untuk mata pelajaran ini sudah pernah dikirim.', 409);
                    }
                } else {
                    if (fetchOne('SELECT id FROM hasil_ujian WHERE peserta_id = ?', [$pid])) {
                        fail('Hasil ujian sudah pernah dikirim.', 409);
                    }
                }
                exec_sql(
                    'INSERT INTO hasil_ujian (id, peserta_id, paket_soal_id, jumlah_benar, jumlah_salah, nilai, status_kelulusan, waktu_mulai, waktu_selesai, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
                    $params
                );
            }
            respond(fetchOne('SELECT * FROM hasil_ujian WHERE id = ?', [$hid]));
        }

        case 'resetHasilUjian':
        case 'resetPesertaSesi': {
            requireAdmin();
            $pid = (string)($req['peserta_id'] ?? '');
            $pdo = db();
            $pdo->beginTransaction();
            exec_sql('DELETE FROM jawaban_peserta WHERE peserta_id = ?', [$pid]);
            exec_sql('DELETE FROM hasil_ujian WHERE peserta_id = ?', [$pid]);
            exec_sql("UPDATE peserta SET status_ujian = 'Belum Ujian', pelanggaran = 0, is_locked = 0 WHERE id = ?", [$pid]);
            $pdo->commit();
            respond(['ok' => true]);
        }

        // ---------------- JAWABAN ----------------
        case 'getJawabanList': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            respond(fetchAll('SELECT * FROM jawaban_peserta WHERE peserta_id = ?', [$pid]));
        }

        case 'syncJawaban': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            $soalId = (string)($req['soal_id'] ?? '');
            if (!currentAdmin() && fetchOne('SELECT id FROM hasil_ujian WHERE peserta_id = ?', [$pid])) {
                fail('Ujian sudah selesai, jawaban tidak dapat diubah.', 403);
            }
            exec_sql(
                'INSERT INTO jawaban_peserta (id, peserta_id, soal_id, jawaban, benar, ragu_ragu, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE jawaban = VALUES(jawaban), benar = VALUES(benar),
                   ragu_ragu = VALUES(ragu_ragu), created_at = UTC_TIMESTAMP()',
                [
                    uuidv4(), $pid, $soalId,
                    emptyToNull($req['jawaban'] ?? null),
                    toBit($req['benar'] ?? false),
                    toBit($req['ragu_ragu'] ?? false),
                ]
            );
            respond(['ok' => true]);
        }

        case 'syncJawabanBatch': {
            $pid = resolvePesertaId($req['peserta_id'] ?? null);
            $items = $req['answers'] ?? [];
            if (!is_array($items) || empty($items)) {
                respond(['ok' => true, 'count' => 0]);
            }
            if (!currentAdmin() && fetchOne('SELECT id FROM hasil_ujian WHERE peserta_id = ?', [$pid])) {
                fail('Ujian sudah selesai, jawaban tidak dapat diubah.', 403);
            }

            // Ambil kunci jawaban sekaligus dari database untuk verifikasi
            $soalIds = [];
            foreach ($items as $it) {
                if (!empty($it['soal_id'])) {
                    $soalIds[] = (string)$it['soal_id'];
                }
            }
            $soalIds = array_values(array_unique($soalIds));

            $keyMap = [];
            if (!empty($soalIds)) {
                $placeholders = implode(',', array_fill(0, count($soalIds), '?'));
                $rows = fetchAll("SELECT id, jawaban_benar FROM soal WHERE id IN ($placeholders)", $soalIds);
                foreach ($rows as $r) {
                    $keyMap[$r['id']] = $r['jawaban_benar'];
                }
            }

            $pdo = db();
            $pdo->beginTransaction();
            try {
                $stmt = $pdo->prepare(
                    'INSERT INTO jawaban_peserta (id, peserta_id, soal_id, jawaban, benar, ragu_ragu, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
                     ON DUPLICATE KEY UPDATE jawaban = VALUES(jawaban), benar = VALUES(benar),
                       ragu_ragu = VALUES(ragu_ragu), created_at = UTC_TIMESTAMP()'
                );

                $savedCount = 0;
                foreach ($items as $ans) {
                    $sId = (string)($ans['soal_id'] ?? '');
                    if (!$sId) continue;
                    $opt = emptyToNull($ans['jawaban'] ?? null);
                    $ragu = toBit($ans['ragu_ragu'] ?? false);
                    $isCorrect = (isset($keyMap[$sId]) && $opt !== null && (string)$keyMap[$sId] === (string)$opt) ? 1 : 0;

                    $stmt->execute([
                        uuidv4(),
                        $pid,
                        $sId,
                        $opt,
                        $isCorrect,
                        $ragu
                    ]);
                    $savedCount++;
                }
                $pdo->commit();
                respond(['ok' => true, 'count' => $savedCount]);
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
        }

        // ---------------- BACKUP / RESTORE ----------------
        case 'restoreBackup': {
            requireAdmin();
            $paket   = $req['paket_soal'] ?? null;
            $jurusan = $req['jurusan'] ?? null;
            $kelas   = $req['kelas'] ?? null;
            $soal    = $req['soal'] ?? [];
            $set     = $req['pengaturan'] ?? null;
            $pdo = db();
            $pdo->beginTransaction();
            try {
                if (is_array($jurusan) && count($jurusan) > 0) {
                    db()->exec("CREATE TABLE IF NOT EXISTS jurusan (
                        id CHAR(36) NOT NULL PRIMARY KEY,
                        nama_jurusan VARCHAR(100) NOT NULL UNIQUE,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
                    exec_sql('DELETE FROM jurusan');
                    foreach ($jurusan as $j) {
                        $nm = strtoupper(trim((string)($j['nama_jurusan'] ?? $j['nama'] ?? $j['kode'] ?? '')));
                        if ($nm !== '') {
                            exec_sql('INSERT IGNORE INTO jurusan (id, nama_jurusan, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [
                                $j['id'] ?? uuidv4(),
                                $nm
                            ]);
                        }
                    }
                }
                if (is_array($kelas) && count($kelas) > 0) {
                    db()->exec("CREATE TABLE IF NOT EXISTS kelas (
                        id CHAR(36) NOT NULL PRIMARY KEY,
                        nama_kelas VARCHAR(50) NOT NULL UNIQUE,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
                    exec_sql('DELETE FROM kelas');
                    foreach ($kelas as $k) {
                        $nm = strtoupper(trim((string)($k['nama_kelas'] ?? $k['nama'] ?? '')));
                        if ($nm !== '') {
                            exec_sql('INSERT IGNORE INTO kelas (id, nama_kelas, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [
                                $k['id'] ?? uuidv4(),
                                $nm
                            ]);
                        }
                    }
                }
                exec_sql('DELETE FROM soal');
                if (is_array($paket)) {
                    try { db()->query("SELECT kelas FROM paket_soal LIMIT 1"); }
                    catch (Throwable $e) { db()->exec("ALTER TABLE paket_soal ADD COLUMN kelas VARCHAR(50) DEFAULT NULL AFTER jurusan"); }

                    exec_sql('DELETE FROM paket_soal');
                    foreach ($paket as $p) {
                        exec_sql('INSERT INTO paket_soal (id, nama_paket, jurusan, kelas, jadwal_mulai, jadwal_selesai, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())', [
                            $p['id'] ?? uuidv4(),
                            (string)($p['nama_paket'] ?? 'Paket Tanpa Nama'),
                            emptyToNull($p['jurusan'] ?? null),
                            emptyToNull($p['kelas'] ?? null),
                            toDbDate($p['jadwal_mulai'] ?? null),
                            toDbDate($p['jadwal_selesai'] ?? null),
                        ]);
                    }
                }
                foreach ((array)$soal as $s) {
                    $row = soalPayload($s);
                    // Lepaskan relasi bila paket tidak ada
                    if ($row['paket_soal_id'] && !fetchOne('SELECT id FROM paket_soal WHERE id = ?', [$row['paket_soal_id']])) {
                        $row['paket_soal_id'] = null;
                    }
                    insertSoal($row, $s['id'] ?? null);
                }
                if (is_array($set)) {
                    exec_sql(
                        'UPDATE pengaturan_ujian SET durasi_menit = ?, passing_grade = ?, updated_at = UTC_TIMESTAMP() WHERE id = 1',
                        [(int)($set['durasi_menit'] ?? 60), (float)($set['passing_grade'] ?? 60)]
                    );
                }
                $pdo->commit();
            } catch (Throwable $e) {
                $pdo->rollBack();
                throw $e;
            }
            respond(['ok' => true]);
        }

        default:
            fail('Aksi tidak dikenal: ' . $action, 404);
    }
} catch (ApiError $e) {
    http_response_code($e->status);
    echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    $msg = 'Kesalahan database.';
    if (!empty($CONFIG['debug'])) $msg .= ' ' . $e->getMessage();
    elseif (($e->errorInfo[1] ?? null) === 1062) $msg = 'Data duplikat: data dengan kunci yang sama sudah ada.';
    elseif (in_array(($e->errorInfo[1] ?? null), [1045, 1049, 2002], true) || $e->getCode() === 2002) {
        $msg = 'Tidak dapat terhubung ke database. Periksa api/config.php.';
    }
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    http_response_code(500);
    $msg = 'Terjadi kesalahan server.';
    if (!empty($CONFIG['debug'])) $msg .= ' ' . $e->getMessage();
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
}

// ---------------------------------------------------------------------
// Fungsi bantu soal
// ---------------------------------------------------------------------

function soalPayload(array $s): array
{
    $jawaban = strtoupper(trim((string)($s['jawaban_benar'] ?? '')));
    return [
        'paket_soal_id' => emptyToNull($s['paket_soal_id'] ?? null),
        'nomor'         => isset($s['nomor']) && $s['nomor'] !== '' ? (int)$s['nomor'] : null,
        'pertanyaan'    => (string)($s['pertanyaan'] ?? ''),
        'opsi_a'        => (string)($s['opsi_a'] ?? ''),
        'opsi_b'        => (string)($s['opsi_b'] ?? ''),
        'opsi_c'        => emptyToNull($s['opsi_c'] ?? null),
        'opsi_d'        => emptyToNull($s['opsi_d'] ?? null),
        'opsi_e'        => emptyToNull($s['opsi_e'] ?? null),
        'jawaban_benar' => $jawaban,
        'bobot'         => isset($s['bobot']) && $s['bobot'] !== '' ? (int)$s['bobot'] : 1,
        'gambar'        => emptyToNull($s['gambar'] ?? null),
    ];
}

function insertSoal(array $s, ?string $id = null): void
{
    $cols = array_keys($s);
    $sql = 'INSERT INTO soal (id, ' . implode(', ', array_map(fn($c) => "`$c`", $cols)) . ', created_at) VALUES (?, '
        . implode(', ', array_fill(0, count($cols), '?')) . ', UTC_TIMESTAMP())';
    exec_sql($sql, [$id ?: uuidv4(), ...array_values($s)]);
}
