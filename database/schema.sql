-- SQL Schema for CBT SMK Negeri 1 Lempuing

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Clean up existing tables (if any)
DROP TABLE IF EXISTS public.jawaban_peserta CASCADE;
DROP TABLE IF EXISTS public.hasil_ujian CASCADE;
DROP TABLE IF EXISTS public.soal CASCADE;
DROP TABLE IF EXISTS public.peserta CASCADE;
DROP TABLE IF EXISTS public.admins CASCADE;
DROP TABLE IF EXISTS public.pengaturan_ujian CASCADE;
DROP TABLE IF EXISTS public.jurusan CASCADE;
DROP TABLE IF EXISTS public.kelas CASCADE;

-- 0. Table for Jurusan & Kelas (Master Data)
CREATE TABLE public.jurusan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nama_jurusan VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO public.jurusan (nama_jurusan) VALUES ('TKJ'), ('AKL'), ('TBSM'), ('TKRO'), ('ATP')
ON CONFLICT (nama_jurusan) DO NOTHING;

CREATE TABLE public.kelas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nama_kelas VARCHAR(50) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO public.kelas (nama_kelas) VALUES ('X TKJ 1'), ('X TKJ 2'), ('X AKL 1'), ('X AKL 2'), ('X TBSM 1'), ('X TBSM 2'), ('X TKRO 1'), ('X TKRO 2'), ('X ATP 1'), ('X ATP 2')
ON CONFLICT (nama_kelas) DO NOTHING;

-- 1. Table for Admin Users
CREATE TABLE public.admins (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 1b. Table for Guru Users (Mata Pelajaran, Jurusan & Kelas yang Diampu ditentukan oleh Admin)
CREATE TABLE IF NOT EXISTS public.guru (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nama_lengkap TEXT NOT NULL,
  mapel_diampu TEXT NOT NULL,
  jurusan_diampu TEXT DEFAULT '',
  kelas_diampu TEXT DEFAULT '',
  paket_ids TEXT DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Table for Participants (Peserta)
CREATE TABLE public.peserta (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, -- SHA-256 hash client-side for secondary verification
  nama_lengkap TEXT NOT NULL,
  jurusan VARCHAR(50),
  kelas VARCHAR(20),
  ruang VARCHAR(20),
  sesi VARCHAR(20),
  status_ujian VARCHAR(25) DEFAULT 'Belum Ujian' CHECK (status_ujian IN ('Belum Ujian', 'Sedang Ujian', 'Sudah Ujian')),
  pelanggaran INTEGER DEFAULT 0,
  is_locked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Table for Paket Soal (Question Groups)
CREATE TABLE public.paket_soal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nama_paket VARCHAR(150) NOT NULL,
  jurusan VARCHAR(50),
  kelas VARCHAR(50),
  jadwal_mulai TIMESTAMP WITH TIME ZONE,
  jadwal_selesai TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Table for Questions (Soal)
CREATE TABLE public.soal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paket_soal_id UUID REFERENCES public.paket_soal(id) ON DELETE CASCADE,
  nomor INTEGER,
  pertanyaan TEXT NOT NULL,
  opsi_a TEXT NOT NULL,
  opsi_b TEXT NOT NULL,
  opsi_c TEXT, -- optional
  opsi_d TEXT, -- optional
  opsi_e TEXT, -- optional (Standar Tingkat SLTA / SMK / SMA)
  jawaban_benar VARCHAR(5) NOT NULL, -- A, B, C, D, E, or T, F (Benar/Salah)
  bobot INTEGER DEFAULT 1,
  gambar TEXT, -- optional base64 image data
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Table for Exam Results (Hasil Ujian)
CREATE TABLE public.hasil_ujian (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peserta_id UUID REFERENCES public.peserta(id) ON DELETE CASCADE,
  paket_soal_id UUID REFERENCES public.paket_soal(id) ON DELETE SET NULL,
  jumlah_benar INTEGER NOT NULL,
  jumlah_salah INTEGER NOT NULL,
  nilai NUMERIC(5,2) NOT NULL,
  status_kelulusan VARCHAR(50) NOT NULL DEFAULT 'Selesai',
  waktu_mulai TIMESTAMP WITH TIME ZONE,
  waktu_selesai TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Table for Participant Answers (Jawaban Peserta)
CREATE TABLE public.jawaban_peserta (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peserta_id UUID REFERENCES public.peserta(id) ON DELETE CASCADE,
  soal_id UUID REFERENCES public.soal(id) ON DELETE CASCADE,
  jawaban VARCHAR(5),
  benar BOOLEAN,
  ragu_ragu BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(peserta_id, soal_id)
);

-- 7. Table for Exam Settings (Pengaturan Ujian)
CREATE TABLE public.pengaturan_ujian (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  durasi_menit INTEGER NOT NULL DEFAULT 60,
  passing_grade NUMERIC(5,2) NOT NULL DEFAULT 60.00,
  tampilkan_nilai BOOLEAN NOT NULL DEFAULT TRUE,
  token_ujian VARCHAR(10) DEFAULT 'CBT123',
  token_aktif BOOLEAN NOT NULL DEFAULT FALSE,
  acak_soal BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed default settings
INSERT INTO public.pengaturan_ujian (id, durasi_menit, passing_grade, token_ujian, token_aktif, acak_soal)
VALUES (1, 60, 60.00, 'CBT123', false, true)
ON CONFLICT (id) DO NOTHING;

-- Trigger to automatically flag admin users in public.admins
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email = 'admin@smkn1lempuing.sch.id' OR NEW.email LIKE '%admin.smk%' THEN
    INSERT INTO public.admins (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Helper function to check if the current user is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admins WHERE id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Create Peserta User securely from Admin dashboard
CREATE OR REPLACE FUNCTION public.create_peserta_user(
  p_username VARCHAR,
  p_password TEXT,
  p_nama_lengkap TEXT,
  p_jurusan VARCHAR,
  p_kelas VARCHAR,
  p_ruang VARCHAR,
  p_sesi VARCHAR
)
RETURNS UUID AS $$
DECLARE
  v_user_id UUID;
  v_clean_username VARCHAR;
  v_clean_pass TEXT;
  v_email VARCHAR;
  v_pass_hash TEXT;
BEGIN
  -- Only admins can call this function
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Akses ditolak: Hanya Administrator yang dapat mendaftarkan peserta.';
  END IF;

  v_clean_username := LOWER(REGEXP_REPLACE(TRIM(p_username), '\s+', '', 'g'));
  v_clean_pass := TRIM(p_password);
  v_email := v_clean_username || '@cbt.smkn1lempuing.sch.id';
  v_pass_hash := encode(digest(v_clean_pass, 'sha256'), 'hex');

  -- Create in auth.users
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, recovery_sent_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    v_email,
    crypt(v_clean_pass, gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('role', 'peserta', 'username', v_clean_username),
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
  RETURNING id INTO v_user_id;

  -- Create in public.peserta
  INSERT INTO public.peserta (
    id, username, password_hash, nama_lengkap, jurusan, kelas, ruang, sesi
  )
  VALUES (
    v_user_id,
    v_clean_username,
    v_pass_hash,
    TRIM(p_nama_lengkap),
    TRIM(p_jurusan),
    TRIM(p_kelas),
    TRIM(p_ruang),
    TRIM(p_sesi)
  );

  RETURN v_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Delete Peserta User and cascade delete profiles
CREATE OR REPLACE FUNCTION public.delete_peserta_user(p_peserta_id UUID)
RETURNS VOID AS $$
BEGIN
  -- Only admins can call this function
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Akses ditolak: Hanya Administrator yang dapat menghapus peserta.';
  END IF;

  -- Delete from auth.users (this cascade deletes public.peserta, hasil_ujian, jawaban_peserta)
  DELETE FROM auth.users WHERE id = p_peserta_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC: Update Peserta Password securely from Admin dashboard
CREATE OR REPLACE FUNCTION public.update_peserta_password(
  p_peserta_id UUID,
  p_password TEXT
)
RETURNS VOID AS $$
DECLARE
  v_clean_pass TEXT;
BEGIN
  -- Only admins can call this function
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Akses ditolak: Hanya Administrator yang dapat mengubah password peserta.';
  END IF;

  v_clean_pass := TRIM(p_password);

  -- Update password & normalize email in auth.users
  UPDATE auth.users u
  SET encrypted_password = crypt(v_clean_pass, gen_salt('bf')),
      email = LOWER(REGEXP_REPLACE(TRIM(p.username), '\s+', '', 'g')) || '@cbt.smkn1lempuing.sch.id',
      updated_at = now()
  FROM public.peserta p
  WHERE u.id = p_peserta_id AND p.id = p_peserta_id;

  -- Update password_hash & normalize username in public.peserta
  UPDATE public.peserta
  SET password_hash = encode(digest(v_clean_pass, 'sha256'), 'hex'),
      username = LOWER(REGEXP_REPLACE(TRIM(username), '\s+', '', 'g'))
  WHERE id = p_peserta_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Enable Row Level Security (RLS) on all tables
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.peserta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.soal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hasil_ujian ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jawaban_peserta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pengaturan_ujian ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paket_soal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jurusan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kelas ENABLE ROW LEVEL SECURITY;

-- RLS POLICIES

-- Admins Table
CREATE POLICY "Admins can view and manage all admins"
  ON public.admins FOR ALL TO authenticated USING (public.is_admin());

-- Peserta Table
CREATE POLICY "Admins can manage all peserta"
  ON public.peserta FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Peserta can view their own profile"
  ON public.peserta FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Peserta can update their own status"
  ON public.peserta FOR UPDATE TO authenticated USING (auth.uid() = id);

-- Soal Table
CREATE POLICY "Admins can manage all questions"
  ON public.soal FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Authenticated users can view questions"
  ON public.soal FOR SELECT TO authenticated USING (TRUE);

-- Hasil Ujian Table
CREATE POLICY "Admins can manage all exam results"
  ON public.hasil_ujian FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Peserta can view their own results"
  ON public.hasil_ujian FOR SELECT TO authenticated USING (auth.uid() = peserta_id);

CREATE POLICY "Peserta can submit their own exam results"
  ON public.hasil_ujian FOR INSERT TO authenticated WITH CHECK (auth.uid() = peserta_id);

-- Jawaban Peserta Table
CREATE POLICY "Admins can view all answers"
  ON public.jawaban_peserta FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Peserta can manage their own answers"
  ON public.jawaban_peserta FOR ALL TO authenticated 
  USING (auth.uid() = peserta_id)
  WITH CHECK (auth.uid() = peserta_id);

-- Pengaturan Ujian Table
CREATE POLICY "Admins can manage settings"
  ON public.pengaturan_ujian FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Authenticated users can view exam settings"
  ON public.pengaturan_ujian FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Admins can manage paket_soal"
  ON public.paket_soal FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Authenticated users can view paket_soal"
  ON public.paket_soal FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Admins can manage jurusan"
  ON public.jurusan FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Authenticated users can view jurusan"
  ON public.jurusan FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "Admins can manage kelas"
  ON public.kelas FOR ALL TO authenticated USING (public.is_admin());

CREATE POLICY "Authenticated users can view kelas"
  ON public.kelas FOR SELECT TO authenticated USING (TRUE);

-- ==========================================
-- 9. SEED DEFAULT ADMIN USER
-- ==========================================
-- Creates the default admin account: admin@smkn1lempuing.sch.id / admin123
DO $$
DECLARE
  v_admin_id UUID;
  v_email VARCHAR := 'admin@smkn1lempuing.sch.id';
  v_password VARCHAR := 'admin123';
BEGIN
  -- Cek apakah admin sudah terdaftar di auth.users sebelumnya
  SELECT id INTO v_admin_id FROM auth.users WHERE email = v_email LIMIT 1;

  -- Jika belum ada, buat akun baru
  IF v_admin_id IS NULL THEN
    v_admin_id := gen_random_uuid();
    
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, recovery_sent_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_admin_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      now(),
      now(),
      '{"provider":"email","providers":["email"]}',
      '{"role":"admin"}',
      now(),
      now(),
      '',
      '',
      '',
      ''
    );
    
    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_admin_id, v_admin_id::text, format('{"sub":"%s","email":"%s"}', v_admin_id::text, v_email)::jsonb, 'email', now(), now(), now()
    );
  END IF;

  -- Pastikan selalu terdaftar di tabel public.admins
  INSERT INTO public.admins (id, email) VALUES (v_admin_id, v_email) ON CONFLICT DO NOTHING;
END;
$$;
