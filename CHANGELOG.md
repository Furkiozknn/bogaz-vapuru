# Değişiklik günlüğü

## 2.1 · Kasım 2026

Oynanışa (vardiyalar, puanlama, fizik, bot) dokunulmadı; eski kayıtlar olduğu gibi açılır.

### Yeni
- **Kaptan defteri:** yıldızla biten en iyi 5 sefer (puan, yıldız, tarih, yolcu) bu cihazda tutulur. Ana menü, Yenilikler, Kaptan defteri sekmesi. Yeni yerel anahtar: `arena.vapur.log`. Veri tarayıcıdan çıkmaz; `?auto` ve `?nosave` koşularında yazılmaz.
- **3 yıldızlı seferde kutlama:** sonuç kartında kısa konfeti. Kit ayarlarında "hareketi azalt" açıksa gösterilmez.
- **Sürüm etiketi ve Yenilikler penceresi:** ana menüde "v2.1 · Kasım 2026", "Yenilikler" düğmesi (yeni sürümde kırmızı nokta, `arena.vapur.seenver`), Esc ile kapanır, TR/EN.
- **Ana menüde "Diğer oyunlar" bağlantısı** (daha önce yalnız sonuç ekranındaydı).

### Sayfa
- Türkçe `<title>` ve `description` (öncekiler İngilizceydi, sayfa `lang="tr"`); `og:title`, `og:locale`, `og:site_name`, `og:image:alt`, `canonical`.
- Eksik Twitter kartı eklendi (`twitter:title/description/image/image:alt`); paylaşım görseli `docs/card.jpg`.
- `404.html` eklendi (TR/EN, oyuna ve merkez sayfaya dönüş).

### Bakım
- `test/duman.mjs`: sayfa açılışı, konsol/ağ hatası, vardiya başlatma ve gazla ilerleme, duraklatma, sonuç ekranı, eski kayıtla açılış, 390x844 ve 1366x768'de taşma, HUD hedef boyutları, yeni özellikler. Bağımlılık depoya eklenmez (`playwright-core` dışarıdan).
- `project-meta.json`: sürüm 2.1.0, test ve changelog yolları.

## 2.0.0 · Kasım 2026
- "Vapur Bileti" arayüz yenilemesi, altın saat ışığı, pastel yalılar, rütbe ve görevler, günlük meydan okuma, Sis Seferi.
