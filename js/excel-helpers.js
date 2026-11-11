// SheetJS Integration & Helper Module

const ExcelHelpers = {
  // Read Excel file containing Peserta data
  parsePesertaExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          
          // Read as array of rows
          const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
          if (rows.length < 2) {
            return reject(new Error("File Excel kosong atau tidak memiliki baris data."));
          }

          const headers = rows[0].map(h => h ? h.toString().trim() : '');
          
          // Required headers check
          const required = ['Username', 'Password', 'Nama Lengkap', 'Jurusan', 'Kelas', 'Ruang', 'Sesi'];
          const missing = required.filter(r => !headers.includes(r));
          
          if (missing.length > 0) {
            return reject(new Error("Format kolom Excel salah. Kolom yang kurang: " + missing.join(", ")));
          }

          // Map headers index
          const idx = {};
          required.forEach(col => {
            idx[col] = headers.indexOf(col);
          });

          const pesertaList = [];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0 || !row[idx['Username']]) continue; // skip empty rows

            pesertaList.push({
              username: row[idx['Username']].toString().trim(),
              password: row[idx['Password']] ? row[idx['Password']].toString().trim() : '',
              nama_lengkap: row[idx['Nama Lengkap']] ? row[idx['Nama Lengkap']].toString().trim() : '',
              jurusan: row[idx['Jurusan']] ? row[idx['Jurusan']].toString().trim() : '',
              kelas: row[idx['Kelas']] ? row[idx['Kelas']].toString().trim() : '',
              ruang: row[idx['Ruang']] ? row[idx['Ruang']].toString().trim() : '',
              sesi: row[idx['Sesi']] ? row[idx['Sesi']].toString().trim() : ''
            });
          }

          resolve(pesertaList);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  },

  // Read Excel file containing Soal data
  parseSoalExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          
          const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
          if (rows.length < 2) {
            return reject(new Error("File Excel kosong atau tidak memiliki baris data."));
          }

          const headers = rows[0].map(h => h ? h.toString().trim() : '');
          
          // Required headers check
          const required = ['Nomor', 'Pertanyaan', 'Opsi A', 'Opsi B', 'Opsi C', 'Opsi D', 'Jawaban Benar', 'Bobot'];
          const missing = required.filter(r => !headers.includes(r));
          
          if (missing.length > 0) {
            return reject(new Error("Format kolom Excel salah. Kolom yang kurang: " + missing.join(", ")));
          }

          const idx = {};
          required.forEach(col => {
            idx[col] = headers.indexOf(col);
          });

          const soalList = [];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0 || row[idx['Nomor']] === undefined) continue;

            const no = parseInt(row[idx['Nomor']]);
            const bobot = row[idx['Bobot']] !== undefined ? parseInt(row[idx['Bobot']]) : 1;

            soalList.push({
              nomor: isNaN(no) ? i : no,
              pertanyaan: row[idx['Pertanyaan']] ? row[idx['Pertanyaan']].toString().trim() : '',
              opsi_a: row[idx['Opsi A']] ? row[idx['Opsi A']].toString().trim() : '',
              opsi_b: row[idx['Opsi B']] ? row[idx['Opsi B']].toString().trim() : '',
              opsi_c: row[idx['Opsi C']] ? row[idx['Opsi C']].toString().trim() : '',
              opsi_d: row[idx['Opsi D']] ? row[idx['Opsi D']].toString().trim() : '',
              jawaban_benar: row[idx['Jawaban Benar']] ? row[idx['Jawaban Benar']].toString().trim().toUpperCase() : '',
              bobot: isNaN(bobot) ? 1 : bobot
            });
          }

          resolve(soalList);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  },

  // Export JSON array to dynamic styled Excel
  exportJSONToExcel(dataList, headersMap, fileName, sheetName = 'Sheet1') {
    // dataList: [{nomor: 1, nama: "Budi"}]
    // headersMap: { nomor: "No. Ujian", nama: "Nama Lengkap" }
    
    // Create header row and maps keys
    const keys = Object.keys(headersMap);
    const headerRow = keys.map(k => headersMap[k]);
    
    const excelRows = [headerRow];
    
    dataList.forEach(item => {
      const row = keys.map(k => {
        let val = item[k];
        if (val === null || val === undefined) return '';
        // Date parsing formats
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
          return new Date(val).toLocaleString();
        }
        return val;
      });
      excelRows.push(row);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(excelRows);

    // Set column widths auto fit
    const wscols = keys.map((k, colIndex) => {
      let maxLen = headerRow[colIndex].length;
      for (let r = 1; r < excelRows.length; r++) {
        const cellVal = excelRows[r][colIndex];
        if (cellVal) {
          maxLen = Math.max(maxLen, cellVal.toString().length);
        }
      }
      return { wch: Math.min(maxLen + 4, 50) }; // cap at 50
    });
    ws['!cols'] = wscols;

    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, fileName + ".xlsx");
  }
};

window.ExcelHelpers = ExcelHelpers;
