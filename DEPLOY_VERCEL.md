# Deploy ke Vercel

Deployment publik belum dibuat karena project perlu dihubungkan ke akun GitHub/Vercel milikmu. Jangan kirim password atau token.

1. Unduh `screener-saham-vercel.zip` dan ekstrak.
2. Buat private repository di GitHub, lalu unggah isi folder proyek. `source.xlsx` memang tidak disertakan.
3. Di Vercel pilih **Add New → Project**, import repository itu, lalu deploy tanpa build command khusus.
4. Setelah deploy, cek `https://<domain-kamu>/api/health` dan `https://<domain-kamu>/api/data`.
5. Preview saat ini melayani `/api/data` secara lokal. Untuk domain permanen, langkah import repo di atas harus dilakukan dari akunmu.

`vercel.json` sudah mengatur fungsi Python di region Singapore (`sin1`). Catatan data yang tetap berlaku di build ini: roster 962 masih provisional, 841/962 punya quote pada snapshot terakhir, dan flag Kandidat tetap N/A sampai kriterianya tersedia.
