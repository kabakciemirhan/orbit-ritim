# ORBIT — tek tuşlu ritim oyunu

İki gezegen, ATEŞ ve BUZ, birbirinin etrafında döner. Doğru anda bir tuşa bastığında dönen gezegen bir sonraki taşa oturur ve roller değişir. İki taş arasındaki açı, iki vuruş arasındaki süreyi gösterir: düz çizgi bir "temel vuruş", dar açı daha hızlı, geniş açı daha yavaş bir vuruş demektir.

Saf HTML + CSS + JavaScript (ES modules). Build adımı, framework ya da dış CDN yok. GitHub Pages'te olduğu gibi çalışır.

## Nasıl oynanır

- **Herhangi bir tuş**, fare tıklaması veya dokunma = vuruş. **Esc** = duraklat.
- İsabet pencereleri: Perfect ±45 ms · Early/Late ±90 ms · Too Early/Too Late ±140 ms (taş geçilir ama combo sıfırlanır) · daha geç = **Miss**.
- Modlar:
  - **Normal:** Miss = ölüm. Oyun son checkpoint'ten devam eder (varsayılan: her 64 taşta bir).
  - **Pratik:** Ölüm yok. %50 / %75 / %100 hız.
  - **Otomatik:** Bot her vuruşu kusursuz basar. Senkron kontrolü için kullanışlıdır.
- Zorluk seviyeleri, iki vuruş arasındaki en kısa süreye göre belirlenir: Kolay ≥300 ms, Normal ≥160 ms, Zor ≥90 ms, Rush ≥50 ms.
- İlk oyundan önce **Gecikme kalibrasyonu**nu yapman önerilir: 16 vuruş boyunca metronoma göre basarsın, ortalama sapman giriş gecikmesi olarak kaydedilir.

## Kendi şarkınla oynamak (MP3 + MIDI)

1. **Kendi şarkını yükle** kartını seç ve bir ses dosyası (MP3/OGG/WAV/M4A) ile aynı şarkının MIDI dosyasını seç ya da sürükleyip bırak.
2. **Dosyaların hiçbir yere yüklenmez.** Her şey tarayıcında işlenir.
3. ORBIT MIDI'yi kayda otomatik olarak hizalar:
   - Önce **doğrusal** hizalama dener: spectral-flux onset zarfı ile MIDI darbe dizisinin çapraz korelasyonu (±3 s ofset, 0.97–1.03 tempo ölçeği).
   - Kayıt MIDI'den farklı bir tempoda çalınıyorsa (örneğin hızlanan bir performans) **esnek** hizalamaya geçer: chroma özellikleri üzerinde DTW, ardından onset korelasyonuyla ince ayar. Sonuç parçalı doğrusal bir zaman eşlemesidir.
4. **Hizalama** ekranında ofseti (±500 ms, ok tuşları ±1 / Shift ±10 ms) ve tempo ölçeğini elle düzeltebilir, MIDI notalarını tık sesiyle kaydın üstünde dinleyebilirsin. Ayarlar şarkı başına kaydedilir.

## Yerelde çalıştırma

```bash
python3 -m http.server 8000
# http://localhost:8000
```

Kendi dosyalarını `assets/local/song.mp3` ve `assets/local/song.mid` olarak koyarsan menüde **Yerel şarkı** kartı da çıkar. Bu klasör `.gitignore`'dadır ve hiçbir zaman commit'lenmez.

Testler (Node 18+):

```bash
node tools/test-chart.mjs     # MIDI ayrıştırma + chart geometrisi
node tools/test-game.mjs      # oyun döngüsü simülasyonu (bot %100 Perfect, isabet pencereleri)
node tools/test-align.mjs     # MP3↔MIDI hizalama (ffmpeg gerekir)
```

## Notlar

- Oyun mekaniği *A Dance of Fire and Ice*'tan ilham alır. ORBIT bağımsız ve özgün bir oyundur, o oyunla bir bağlantısı yoktur.
- Bu repo hiçbir telifli şarkı içermez. Demo bölüm ("Yörünge Etüdü") özgündür ve tarayıcıda Web Audio ile sentezlenir.
- **Çakışma önleme:** Açısal hız sabit olduğu için yoğun pasajlarda yol kendi üstüne sarabilir. Bu ayar açıkken (varsayılan), yol çakışacağı zaman dönüş yönü ters çevrilir (twirl). Zamanlama hiç değişmez. Spesifikasyondaki "tempo hızlanınca twirl" ayarı ayrıdır ve varsayılan olarak kapalıdır.

---

## English

**ORBIT** is a one-button rhythm game. Two planets orbit each other, and you press any key, click or tap on the beat to move to the next tile. The angle between tiles encodes the time between beats.

- Play the built-in, royalty-free demo, or load **your own audio + MIDI**. Files are processed locally in your browser and never uploaded.
- MIDI is aligned to the recording automatically: linear cross-correlation first, then a flexible chroma-DTW time warp when the performance tempo differs. You can fine-tune the result by hand and preview it with clicks.
- Modes: Normal (checkpoints), Practice (50/75/100 % speed, no death), Auto (bot).
- Run locally with `python3 -m http.server 8000`. No build step and no dependencies.
- The gameplay mechanic is inspired by *A Dance of Fire and Ice*. ORBIT is an independent, original game. This repository contains no copyrighted songs.
