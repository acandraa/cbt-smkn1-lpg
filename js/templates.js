// Client-side Excel Template Generator

const ExcelTemplates = {
  // Download template for importing Peserta
  downloadPesertaTemplate() {
    const headers = ['Username', 'Password', 'Nama Lengkap', 'Jurusan', 'Kelas', 'Ruang', 'Sesi'];
    const rows = [
      headers,
      ['u001', 'pass123', 'Budi Santoso', 'TKJ', 'X TKJ 1', 'Ruang 1', 'Sesi 1'],
      ['u002', 'pass456', 'Siti Aminah', 'AKL', 'X AKL 2', 'Ruang 2', 'Sesi 2'],
      ['u003', 'pass789', 'Agus Setiawan', 'TBSM', 'XI TBSM 1', 'Ruang 1', 'Sesi 1']
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Format kolom Username & Password sebagai Text ('@') agar angka 0 di depan tidak hilang di Excel
    ['A2', 'A3', 'A4', 'B2', 'B3', 'B4'].forEach(cellRef => {
      if (ws[cellRef]) {
        ws[cellRef].t = 's';
        ws[cellRef].z = '@';
      }
    });

    // Auto sizing columns
    ws['!cols'] = [
      { wch: 15 }, // Username
      { wch: 15 }, // Password
      { wch: 25 }, // Nama Lengkap
      { wch: 15 }, // Jurusan
      { wch: 15 }, // Kelas
      { wch: 15 }, // Ruang
      { wch: 15 }  // Sesi
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Template Peserta");
    XLSX.writeFile(wb, "Template_Peserta_CBT.xlsx");
  },

  // Download template for importing Soal (Standar SLTA: 5 Opsi A, B, C, D, E)
  downloadSoalTemplate() {
    const headers = ['Nomor', 'Pertanyaan', 'Opsi A', 'Opsi B', 'Opsi C', 'Opsi D', 'Opsi E', 'Jawaban Benar', 'Bobot'];
    const rows = [
      headers,
      [
        1, 
        'Siapakah presiden pertama Republik Indonesia?', 
        'Ir. Soekarno', 
        'Drs. Mohammad Hatta', 
        'Soeharto', 
        'B.J. Habibie', 
        'Abdurrahman Wahid',
        'A', 
        2
      ],
      [
        2, 
        'Manakah dari kota berikut yang merupakan ibu kota Provinsi Sumatera Selatan?', 
        'Bandung', 
        'Palembang', 
        'Medan', 
        'Surabaya', 
        'Lampung',
        'B', 
        2
      ],
      [
        3, 
        'Hasil dari 12 dikali dengan 12 adalah 144.', 
        'Benar', 
        'Salah', 
        '', 
        '', 
        '',
        'A', 
        1
      ],
      [
        4, 
        'Benua terbesar di dunia adalah Benua Afrika.', 
        'Benar', 
        'Salah', 
        '', 
        '', 
        '',
        'B', 
        1
      ]
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Auto sizing columns
    ws['!cols'] = [
      { wch: 8 },  // Nomor
      { wch: 50 }, // Pertanyaan
      { wch: 20 }, // Opsi A
      { wch: 20 }, // Opsi B
      { wch: 20 }, // Opsi C
      { wch: 20 }, // Opsi D
      { wch: 20 }, // Opsi E
      { wch: 15 }, // Jawaban Benar
      { wch: 10 }  // Bobot
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Template Soal");
    XLSX.writeFile(wb, "Template_Soal_CBT.xlsx");
  }
};

window.ExcelTemplates = ExcelTemplates;
