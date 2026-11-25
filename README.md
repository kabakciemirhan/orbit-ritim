# ORBIT — Rush E

Rush E için tek tuşlu bir ritim oyunu. İki gezegen, ATEŞ ve BUZ, birbirinin etrafında döner. Doğru anda bir tuşa bastığında dönen gezegen bir sonraki taşa oturur ve roller değişir. İki taş arasındaki açı, iki vuruş arasındaki süreyi gösterir.

Saf HTML + CSS + JavaScript (ES modules). Build adımı, framework ya da dış CDN yok.

## Şarkı dosyaları

Şarkı repoda, `assets/local/` klasöründe yer alır:

```
assets/local/song.mp3   # Rush E kaydı
assets/local/song.mid   # Rush E MIDI
```

## Çalıştırma

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## Nasıl oynanır

- **Herhangi bir tuş**, fare tıklaması veya dokunma = vuruş. **Esc** = duraklat.
- İsabet pencereleri: Perfect ±45 ms · Early/Late ±90 ms · Too Early/Too Late ±140 ms (taş geçilir ama combo sıfırlanır) · daha geç = **Miss**.
- Zorluklar: Kolay (vuruşlar arası ≥300 ms), Normal (≥160 ms), Zor (≥90 ms), Rush (≥50 ms).
- Modlar: **Normal** (Miss = ölüm, checkpoint'ten devam), **Pratik** (ölüm yok, %50/%75/%100 hız), **Otomatik** (bot).
- İlk oyundan önce **Gecikme kalibrasyonu**nu yapman önerilir.

## Hizalama

MIDI sabit tempoda, kayıt ise sürekli hızlanıyor. Bu yüzden oyun MIDI'yi kayda otomatik olarak hizalar:

- Önce doğrusal hizalama dener (onset korelasyonu).
- Doğrusal hizalama yetmezse esnek hizalamaya geçer: chroma DTW ve onset korelasyonuyla ince ayar.

**Hizalama** ekranında ofseti ve tempo ölçeğini elle düzeltebilir, MIDI notalarını tık sesiyle dinleyebilirsin.

## Testler (Node 18+)

```bash
node tools/test-chart.mjs     # MIDI ayrıştırma + chart geometrisi
node tools/test-game.mjs      # oyun döngüsü simülasyonu
node tools/test-align.mjs     # MP3↔MIDI hizalama (ffmpeg gerekir)
```

## Notlar

- Güncelleme yayınlarken `index.html` ve `js/main.js` içindeki `?v=` sürüm numarasını artır. Aksi halde tarayıcılar eski JS dosyalarını önbellekten kullanabilir.

- Oyun mekaniği *A Dance of Fire and Ice*'tan ilham alır. ORBIT bağımsız ve özgün bir oyundur.

---

**English:** ORBIT is a one-button rhythm game built for Rush E. Play it on the live site, or run it locally with `python3 -m http.server 8000`. The song files live in `assets/local/`. The gameplay mechanic is inspired by *A Dance of Fire and Ice*. ORBIT is an independent, original game.
