# CBT Seleksi Penerimaan PPDB - SMK Negeri 1 Lempuing

Aplikasi web Computer Based Test (CBT) modern, responsif, dan berbasis client-side untuk seleksi masuk peserta didik baru di SMK Negeri 1 Lempuing. Dibuat agar siap dihosting secara gratis di GitHub Pages dengan backend database cloud serverless gratis dari Supabase.

---

## 📂 Struktur Proyek

```text
cbt-smkn1-lempuing/
├── index.html            # Halaman utama landing page & informasi alur PPDB
├── login.html            # Portal login tab ganda (Peserta & Admin)
├── ujian.html            # Halaman Dashboard Peserta & pengerjaan ujian CBT
├── admin.html            # Panel Admin (statistik, CRUD peserta/soal, excel, backup)
├── css/
│   └── styles.css        # Desain kustom, tema warna biru-putih premium, layout cetak PDF
├── js/
│   ├── config.js         # Pengaturan default Supabase URL & Anon Key (opsional)
│   ├── supabase-config.js# Inisialisasi Supabase client SDK
│   ├── auth.js           # Sistem autentikasi, pembagian role, & logout otomatis
│   ├── excel-helpers.js  # Utilitas parser SheetJS (Import/Export Excel)
│   ├── templates.js      # Generator template Excel dinamis di browser
│   ├── admin.js          # Pengendali data & grafik statistik Panel Admin
│   └── ujian.js          # Pengendali alur ujian, timer anti-refresh, & PDF kartu peserta
├── database/
│   └── schema.sql        # Skema tabel, kebijakan RLS, trigger, & fungsi RPC PostgreSQL
└── README.md             # Dokumentasi instalasi dan konfigurasi proyek
```

---

## 🛠️ Langkah Konfigurasi Supabase

Aplikasi ini menggunakan Supabase sebagai database relasional (PostgreSQL), manajemen sesi autentikasi, serta Row Level Security (RLS) untuk keamanan data. Ikuti langkah di bawah ini untuk menghubungkan aplikasi Anda:

### 1. Buat Proyek Supabase
1. Masuk ke [Supabase Dashboard](https://supabase.com) dan buat proyek baru gratis.
2. Tunggu hingga database selesai dibuat.

### 2. Jalankan Skema Database SQL
1. Salin seluruh isi berkas [database/schema.sql](file:///C:/Users/ASUS%20TUF/.gemini/antigravity-ide/scratch/cbt-smkn1-lempuing/database/schema.sql).
2. Di dashboard Supabase, buka menu **SQL Editor** dari panel kiri.
3. Klik **New Query**, tempel kode SQL yang Anda salin, lalu klik **Run**.
4. Skema database, trigger, fungsi RPC, dan kebijakan Row Level Security (RLS) Anda sekarang telah aktif.

### 3. Nonaktifkan Konfirmasi Email (Penting untuk Seleksi PPDB)
Karena peserta akan didaftarkan langsung oleh Administrator melalui dashboard admin (dari Excel atau form), kita harus menonaktifkan email konfirmasi agar peserta dapat langsung login menggunakan password yang diberikan:
1. Di dashboard Supabase, buka **Project Settings** > **Authentication** > **Providers** > **Email**.
2. **Matikan (disable)** opsi `Confirm email` dan `Secure email change`.
3. Klik **Save**.

### 4. Buat Akun Admin Pertama
1. Buka menu **Authentication** > **Users** di dashboard Supabase.
2. Klik **Add User** > **Create User**.
3. Masukkan email: `admin@smkn1lempuing.sch.id` dan tentukan password.
4. Akun tersebut secara otomatis akan dideteksi sebagai **Administrator** oleh sistem melalui database trigger yang terdaftar di `schema.sql`.

---

## ⚙️ Menghubungkan Aplikasi dengan Supabase

Ada dua cara untuk memasang kredensial Supabase URL dan Anon Key Anda:

### Cara A: Konfigurasi Dinamis dari Browser (Direkomendasikan)
1. Buka aplikasi web CBT Anda (atau buka langsung `login.html`).
2. Jika kredensial kosong, aplikasi akan menampilkan peringatan dan mengarahkan Anda ke Panel Pengaturan Awal.
3. Masukkan **Supabase URL** dan **Supabase Anon Public Key** (keduanya dapat ditemukan di dashboard Supabase pada menu **Project Settings** > **API**).
4. Klik **Simpan**. Kredensial akan disimpan dengan aman di `localStorage` peramban Anda.

### Cara B: Hardcode ke dalam Kode Sumber (Untuk Deployment GitHub Pages langsung)
Jika ingin aplikasi langsung terhubung secara otomatis untuk seluruh pengguna setelah diunggah ke GitHub Pages, Anda dapat mengedit berkas konfigurasi default:
1. Buka berkas [js/config.js](file:///C:/Users/ASUS%20TUF/.gemini/antigravity-ide/scratch/cbt-smkn1-lempuing/js/config.js).
2. Ubah nilainya menjadi kredensial proyek Supabase Anda:
   ```javascript
   window.CBT_DEFAULT_SUPABASE_URL = "https://xxxxxxxxx.supabase.co";
   window.CBT_DEFAULT_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
   ```

---

## 🚀 Panduan Deployment ke GitHub Pages

Aplikasi CBT ini 100% berjalan di sisi klien (client-side), sehingga dapat dihosting sepenuhnya secara **gratis** dan **cepat** menggunakan GitHub Pages.

1. Buat repositori baru di akun GitHub Anda (misalnya: `cbt-smkn1-lempuing`).
2. Masukkan semua berkas proyek ke repositori tersebut:
   ```bash
   git init
   git add .
   git commit -m "Initial commit CBT SMKN 1 Lempuing"
   git remote add origin https://github.com/USERNAME/cbt-smkn1-lempuing.git
   git branch -M main
   git push -u origin main
   ```
3. Di halaman repositori GitHub Anda, buka tab **Settings** (Pengaturan).
4. Gulir ke menu samping kiri bawah dan klik **Pages**.
5. Di bagian **Build and deployment** > **Source**, pilih **Deploy from a branch**.
6. Pilih branch `main` (atau `master`) dan folder `/ (root)`, lalu klik **Save**.
7. Tunggu sekitar 1-2 menit. Link situs web ujian online Anda akan tampil di bagian atas halaman (misalnya: `https://username.github.io/cbt-smkn1-lempuing/`).

---

## ⚙️ Cara Menggunakan Aplikasi

### Mengatur Ujian
1. Login sebagai Admin menggunakan email `admin@smkn1lempuing.sch.id`.
2. Masuk ke tab **Pengaturan** untuk menetapkan Durasi Ujian, Passing Grade KKM kelulusan, dan jadwal pelaksanaan.
3. Masuk ke tab **Bank Soal** untuk menambah soal secara manual atau mengunduh **Template Excel Soal**, mengisinya, dan mengimpor secara massal.
4. Masuk ke tab **Data Peserta** untuk menambah peserta atau mengunduh **Template Excel Peserta** untuk mengimpor seluruh siswa seleksi secara langsung.

### Mengikuti Ujian (Peserta)
1. Peserta login ke portal `login.html` menggunakan **Nomor Peserta** dan **Password** dari Excel/Kartu.
2. Peserta melihat detail profil mereka dan dapat mencetak **Kartu Peserta Resmi** dalam format PDF berkualitas tinggi.
3. Klik **Mulai Ujian**. Waktu pengerjaan akan dihitung mundur. Jika terjadi mati listrik/refres halaman, progres jawaban tidak akan hilang karena dicadangkan otomatis di database cloud Supabase secara real-time.
4. Peserta menekan tombol **Selesai Ujian**, sistem akan langsung memberikan koreksi nilai otomatis dan status kelulusan di layar dashboard siswa.
5. Admin dapat langsung mengekspor seluruh hasil pengerjaan, nilai benar/salah, status kelulusan, serta rincian jawaban siswa ke format Excel melalui panel admin.
