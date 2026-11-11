-- =====================================================================
-- SQL Schema MySQL / MariaDB untuk CBT SMK Negeri 1 Lempuing
-- Dipakai untuk hosting biasa (cPanel / Laragon / XAMPP) + phpMyAdmin
--
-- Cara pakai:
--   1. Buat database baru di phpMyAdmin (misal: cbt_smkn1)
--   2. Pilih database tersebut > tab "Import" > pilih file ini > "Go"
--   3. Sesuaikan kredensial di api/config.php
--
-- Akun admin default: admin@smkn1lempuing.sch.id / admin123
-- (SEGERA ganti password setelah login pertama di hosting produksi)
-- =====================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS jawaban_peserta;
DROP TABLE IF EXISTS hasil_ujian;
DROP TABLE IF EXISTS soal;
DROP TABLE IF EXISTS paket_soal;
DROP TABLE IF EXISTS peserta;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS pengaturan_ujian;
DROP TABLE IF EXISTS jurusan;
DROP TABLE IF EXISTS kelas;

SET FOREIGN_KEY_CHECKS = 1;

-- 0. Jurusan & Kelas (Master Data)
CREATE TABLE jurusan (
  id CHAR(36) NOT NULL PRIMARY KEY,
  nama_jurusan VARCHAR(100) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kelas (
  id CHAR(36) NOT NULL PRIMARY KEY,
  nama_kelas VARCHAR(50) NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1. Admin
CREATE TABLE admins (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Peserta
CREATE TABLE peserta (
  id CHAR(36) NOT NULL PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nama_lengkap VARCHAR(255) NOT NULL,
  jurusan VARCHAR(50) DEFAULT NULL,
  kelas VARCHAR(20) DEFAULT NULL,
  ruang VARCHAR(20) DEFAULT NULL,
  sesi VARCHAR(20) DEFAULT NULL,
  status_ujian ENUM('Belum Ujian','Sedang Ujian','Sudah Ujian') NOT NULL DEFAULT 'Belum Ujian',
  pelanggaran INT NOT NULL DEFAULT 0,
  is_locked TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Paket Soal
CREATE TABLE paket_soal (
  id CHAR(36) NOT NULL PRIMARY KEY,
  nama_paket VARCHAR(150) NOT NULL,
  jurusan VARCHAR(50) DEFAULT NULL,
  kelas VARCHAR(50) DEFAULT NULL,
  jadwal_mulai DATETIME DEFAULT NULL,
  jadwal_selesai DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Soal
CREATE TABLE soal (
  id CHAR(36) NOT NULL PRIMARY KEY,
  paket_soal_id CHAR(36) DEFAULT NULL,
  nomor INT DEFAULT NULL,
  pertanyaan TEXT NOT NULL,
  opsi_a TEXT NOT NULL,
  opsi_b TEXT NOT NULL,
  opsi_c TEXT DEFAULT NULL,
  opsi_d TEXT DEFAULT NULL,
  jawaban_benar VARCHAR(5) NOT NULL,
  bobot INT NOT NULL DEFAULT 1,
  gambar LONGTEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_soal_paket (paket_soal_id),
  CONSTRAINT fk_soal_paket FOREIGN KEY (paket_soal_id) REFERENCES paket_soal(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Hasil Ujian
CREATE TABLE hasil_ujian (
  id CHAR(36) NOT NULL PRIMARY KEY,
  peserta_id CHAR(36) NOT NULL,
  paket_soal_id CHAR(36) DEFAULT NULL,
  jumlah_benar INT NOT NULL,
  jumlah_salah INT NOT NULL,
  nilai DECIMAL(5,2) NOT NULL,
  status_kelulusan VARCHAR(50) NOT NULL DEFAULT 'Selesai',
  waktu_mulai DATETIME DEFAULT NULL,
  waktu_selesai DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_peserta (peserta_id),
  KEY idx_paket (paket_soal_id),
  CONSTRAINT fk_hasil_peserta FOREIGN KEY (peserta_id) REFERENCES peserta(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Jawaban Peserta
CREATE TABLE jawaban_peserta (
  id CHAR(36) NOT NULL PRIMARY KEY,
  peserta_id CHAR(36) NOT NULL,
  soal_id CHAR(36) NOT NULL,
  jawaban VARCHAR(5) DEFAULT NULL,
  benar TINYINT(1) DEFAULT NULL,
  ragu_ragu TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jawaban (peserta_id, soal_id),
  KEY idx_jawaban_soal (soal_id),
  CONSTRAINT fk_jawaban_peserta FOREIGN KEY (peserta_id) REFERENCES peserta(id) ON DELETE CASCADE,
  CONSTRAINT fk_jawaban_soal FOREIGN KEY (soal_id) REFERENCES soal(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Pengaturan Ujian (selalu 1 baris, id = 1)
CREATE TABLE pengaturan_ujian (
  id INT NOT NULL PRIMARY KEY DEFAULT 1,
  durasi_menit INT NOT NULL DEFAULT 60,
  passing_grade DECIMAL(5,2) NOT NULL DEFAULT 60.00,
  tampilkan_nilai TINYINT(1) NOT NULL DEFAULT 1,
  token_ujian VARCHAR(10) DEFAULT 'CBT123',
  token_aktif TINYINT(1) NOT NULL DEFAULT 0,
  acak_soal TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed pengaturan default
INSERT INTO pengaturan_ujian (id, durasi_menit, passing_grade, tampilkan_nilai, token_ujian, token_aktif, acak_soal)
VALUES (1, 60, 60.00, 1, 'CBT123', 0, 1);

-- Seed admin default: admin@smkn1lempuing.sch.id / admin123 (hash bcrypt)
INSERT INTO admins (id, email, password_hash)
VALUES ('00000000-0000-4000-8000-000000000001', 'admin@smkn1lempuing.sch.id',
        '$2y$10$hpLdRcXcCZm/f5O0TiyRBOGwheduV5/BGx6V5wCiXs4SxvsBdc3wK');

-- Seed master jurusan default
INSERT INTO jurusan (id, nama_jurusan) VALUES
  ('00000000-0000-4000-8000-000000000011', 'TKJ'),
  ('00000000-0000-4000-8000-000000000012', 'RPL'),
  ('00000000-0000-4000-8000-000000000013', 'Multimedia')
ON DUPLICATE KEY UPDATE nama_jurusan = VALUES(nama_jurusan);

-- Seed master kelas default
INSERT INTO kelas (id, nama_kelas) VALUES
  ('00000000-0000-4000-8000-000000000021', 'X TKJ 1'),
  ('00000000-0000-4000-8000-000000000022', 'X TKJ 2'),
  ('00000000-0000-4000-8000-000000000023', 'X RPL 1'),
  ('00000000-0000-4000-8000-000000000024', 'X RPL 2'),
  ('00000000-0000-4000-8000-000000000025', 'XI MM 1')
ON DUPLICATE KEY UPDATE nama_kelas = VALUES(nama_kelas);

