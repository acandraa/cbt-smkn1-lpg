<?php
// =====================================================================
// Konfigurasi koneksi database MySQL untuk mode hosting PHP
// Sesuaikan dengan data dari cPanel / phpMyAdmin hosting Anda.
// =====================================================================

return [
    'db_host'    => 'localhost',
    'db_port'    => 3306,
    'db_name'    => 'cbt_smkn1',   // nama database yang dibuat di phpMyAdmin
    'db_user'    => 'root',        // username database
    'db_pass'    => '',            // password database
    'db_charset' => 'utf8mb4',

    // Nama cookie sesi (ubah jika menjalankan beberapa aplikasi di domain yang sama)
    'session_name' => 'CBTSMKN1SESS',

    // Tampilkan detail error PHP/SQL ke browser (set false di hosting produksi)
    'debug' => false,
];

