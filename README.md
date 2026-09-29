# Screener Saham IDX — Sinyal & Trend

Web screener yang memakai **logika indikator dari spreadsheet**, tetapi tidak memakai 489 baris `APP_EMITEN` sebagai batas universe atau sebagai data harga. Halaman memuat seluruh roster lokal (962 kode sementara), menarik scan quote TradingView, menghitung indikator, lalu menampilkan `N/A` bila sumber tidak menyediakan nilai.

## Jalankan lokal

Butuh Python 3.10+; tidak perlu memasang package tambahan.

```bash
cd screener-saham
python3 server.py
```

Buka `http://localhost:4173`. Untuk membuat `index.html` self-contained dari snapshot terakhir:

```bash
python3 scripts/refresh_snapshot.py
python3 build.py
```

`index.html` tetap bisa dibuka sebagai snapshot offline. Tombol refresh membutuhkan server/API.

## Sumber data dan cakupan

- **Harga, volume, average volume 30D, P/E, MA20/MA50:** TradingView Indonesia scanner.
- **Sentimen makro:** tab publik `APP_SENTIMEN` bila dapat dibaca; bukan data baris emiten.
- **Roster saat ini:** `data/universe.json` berisi 955 kode dari CSV kepemilikan KSEI bertanggal 27 Feb 2026, ditambah WBSA, JELI, JECX, BACH, EMMI, PRDL, dan RANS. Jumlahnya 962, tetapi **belum diverifikasi kode-per-kode terhadap roster resmi IDX**. IDX endpoint melaporkan 962 record; itu hanya mencocokkan jumlah, bukan membuktikan setiap kodenya benar. Aplikasi menandainya sebagai *provisional*.
- **Cakupan quote snapshot 29 Sep 2026:** scanner mengembalikan 845 instrumen; 4 tidak cocok dengan roster sementara dan dikeluarkan. Terdapat 841 ticker yang cocok dan 121 kode tanpa quote yang cocok; nilai quote/indikator yang tidak tersedia ditampilkan `N/A`. Cakupan berubah setiap scan.
- **Kandidat:** rumus historis tidak ada di sheet, jadi aturannya dibuat sendiri (konstanta `CANDIDATE_*` di `market_data.py`, mudah diubah): psikologi positif (Akumulasi/Breakout/Bullish) **dan** kekuatan KUAT, RVOL ≥ 1,5×, posisi harga ≥ 70%, nilai transaksi ≥ Rp1 miliar, tren bukan Downtrend. Ini bukan replika kolom historis sheet.
- **Scalping** (konstanta `SCALP_*` di `market_data.py`): Fast Trade ≥ 80 (Hot Scalp), RVOL ≥ 1,5×, nilai transaksi ≥ Rp5 miliar, posisi harga ≥ 60%, naik hari ini tetapi ≤ 20%.
- **Swing** (konstanta `SWING_*`): Uptrend dengan harga ≤ MA20 + 10%, atau Pullback yang masih di atas MA50; nilai transaksi ≥ Rp2 miliar, RVOL ≥ 0,8×, psikologi bukan Sell Off/Distribusi/Lemah Sepi, kekuatan bukan Lemah, tidak turun > 3% hari ini.
- **P/E kosong / negatif:** status valuasi ditampilkan `⚠ Rugi / No Data`, sama seperti sheet (bukan N/A).
- **Kode tanpa quote (121):** seluruh kolom kosong karena TradingView memang tidak mengembalikan data (umumnya suspen/delisting); baris ditampilkan redup dengan label "Tidak ada quote".
- **Close dekat high:** versi ini memakai aturan eksplisit `posisi harga ≥ 98%` dari range low–high harian; ini bukan klaim bahwa flag `closeDiHigh` lama sudah direplikasi persis.

`data/stocks.json` dan tampilan tabel dibuat dari roster + scan quote. Tab `APP_EMITEN` **tidak dibaca sebagai sumber baris saham**. Bila quote gagal, API memakai snapshot lokal 962 baris; jika snapshot lengkap pun tidak ada, semua nilai pasar tetap `N/A`.

## Formula yang diterapkan

- **Score (0–100):**
  `MIN(RVOL,3)/3×40 + posisi×25 + MIN(MAX(chg,0),5)/5×20 + MIN(turnover,100)/100×15`, dibulatkan ke bilangan bulat. Score hanya dihitung bila RVOL, posisi, perubahan, dan nilai transaksi tersedia.
- **RVOL:** volume hari ini ÷ average volume 30D.
- **Posisi:** `(harga − low) ÷ (high − low + 0,001)`, dibulatkan 2 desimal.
- **Psikologi, kekuatan, aktivitas, dan fast-trade:** menerapkan ambang pada formula `WishlistEmiten`.
- **Tren:** cabang MA20/MA50 dari formula sheet, menggunakan harga dan nilai MA yang tersedia dari TradingView.
- **Valuasi:** ambang P/E mengikuti formula sheet; median acuan dihitung ulang dari P/E positif yang tersedia di scan universe (bukan 489 baris contoh).
- **Filter Bullish:** mengikuti formula `SINYAL&TREND`: label psikologi positif (Akumulasi/Breakout/Bullish) **dan** kekuatan mengandung `KUAT`.

Field yang kosong tidak disubstitusi nol. Akibatnya score juga `N/A` bila salah satu komponen wajib hilang.

## Deploy ke Vercel

Konfigurasi `vercel.json` sudah menyiapkan static site dan fungsi Python `/api/data` serta `/api/health`; fungsi diarahkan ke region `sin1` (Singapore). Untuk deployment permanen:

1. Buat **private GitHub repository** lalu push folder proyek.
2. Pastikan `source.xlsx` tidak ikut di-commit—sudah dikecualikan oleh `.gitignore` dan `.vercelignore`.
3. Masuk ke akun Vercel sendiri, pilih **Add New → Project**, lalu import repository itu.
4. Biarkan Vercel mendeteksi static files dan fungsi Python; deploy.
5. Setelah push berikutnya, Vercel akan membuat deployment baru.

Tidak perlu membagikan password, token, atau credential. Saya belum dapat membuat deployment permanen atas akun GitHub/Vercel kamu dari workspace ini; koneksi repository harus disetujui dari akunmu.

## Catatan risiko & pembaruan

Feed dapat tertunda, terbatas, atau berubah cakupannya. Refresh manual meminta scan baru; cache API berlaku 60 detik per instance. Untuk memperbarui snapshot lokal, jalankan `python3 scripts/refresh_snapshot.py`. `python3 scripts/build_universe.py` akan membangun ulang roster *provisional* dari sumber yang sama; jangan menandainya resmi sebelum rekonsiliasi kode-per-kode dengan IDX. Screener ini untuk penyaringan informasi, bukan rekomendasi investasi.

## Diagnosis kesegaran data

Buka `/api/debug?ticker=SEMA` (ganti kode emitennya). Endpoint ini menampilkan baris mentah scanner TradingView beserta header responsnya, dibandingkan dengan quote Yahoo Finance (`SEMA.JK`) lengkap dengan cap waktu, plus kesimpulan singkat sumber mana yang tertinggal.
