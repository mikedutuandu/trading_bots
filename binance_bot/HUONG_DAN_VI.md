# 🤖 Hướng Dẫn Bot Trade Binance Futures (cho người mới)

> Tài liệu này giải thích bot hoạt động thế nào, **kèm ví dụ từng tình huống cụ thể**
> để bạn dễ hình dung. Đọc xong bạn sẽ hiểu: mỗi lệnh có thể kết thúc theo những cách
> nào, lời/lỗ bao nhiêu, và ai đóng lệnh (canh theo giờ hay canh mỗi phút).

---

## Phần 1 — Bot làm gì? (tóm tắt)

Bot tự động **mua/bán hợp đồng tương lai (futures) coin trên Binance** theo chiến lược
cố định, **không cần ngồi canh**. Nó chạy theo **2 nhịp**:

- ⏰ **Mỗi giờ** (khi nến 1h đóng): quét coin, tìm xu hướng, **vào lệnh**, **chốt lời
  TP1/TP2**, dời/siết trailing stop.
- ⚡ **Mỗi 1 phút** (lớp bảo vệ "guardian"): canh các lệnh đang mở, **ép cắt lỗ** nếu
  giá vọt qua stop, và **thoát sớm khi xu hướng đảo chiều** (theo khung 15 phút).

Đây là bot **bám xu hướng (trend-following)** — đi theo con sóng lớn, không đoán đỉnh/đáy.

---

## Phần 2 — Kiến thức cơ bản

### 🔼 Long & 🔽 Short
- **Long** = cược giá **TĂNG** (mua trước). **Short** = cược giá **GIẢM** (bán trước).
- Mở short = lệnh **SELL**; đóng short = lệnh **BUY**. (Thấy "Sell" trong lịch sử **không**
  có nghĩa đã chốt — đó là **mở** một short.)

### 📏 "R" — khái niệm quan trọng nhất
**R = số tiền chấp nhận mất nếu lệnh thua** = khoảng cách từ giá vào đến cắt lỗ.

- Bot rủi ro **1% tài khoản mỗi lệnh**. Ví dụ trong tài liệu này: **1R = $50** (mỗi lệnh
  thua mất tối đa ~$50).
- Lệnh thua = **−1R**. Thắng +2R = gấp đôi tiền rủi ro, +3R = gấp ba…
- Mọi thứ đo bằng **R**, không đo bằng giá → mọi lệnh cùng mức rủi ro dù coin đắt hay rẻ.

### ⚙️ Đòn bẩy 10x — KHÔNG phải là rủi ro
Rủi ro do **mức cắt lỗ** quyết định, không phải đòn bẩy. Bot luôn giữ vị thế nhỏ so với
tài khoản.

---

## Phần 3 — Chiến lược: "Trend-Pullback"

> Nói đơn giản: **"Đi theo trend, chờ giá nghỉ một nhịp rồi nhảy vào."**

1. **Xu hướng** = EMA50 vs EMA200 (khung 1h): EMA50 > EMA200 → chỉ **Long**; ngược lại →
   chỉ **Short**. Bot **luôn đi theo** xu hướng, không ngược dòng.
2. **Chờ giá hồi (pullback)** về vùng EMA20 rồi mới vào (không đu đỉnh).
3. **Lọc bằng ADX ≥ 25** — chỉ vào khi xu hướng đủ mạnh (tránh đi ngang).

Bot chỉ chạy **1 chiến lược: trend-pullback**. (`trend-breakout` đã **tắt** vì backtest lỗ.)

---

## Phần 4 — Cách bot vào/ra lệnh (luật chơi)

### 🎯 Thang chốt lời (chia 3 phần: 0.3 / 0.3 / 0.4)
| Mốc | Khi giá đạt | Bot làm | Stop dời tới |
|---|---|---|---|
| **TP1** | +1R | bán **0.3** (30% lệnh) | **hòa vốn** (giá vào) → hết lỗ |
| **TP2** | +2R | bán **0.3** | **+1R** (khóa lời) + bật trailing |
| **Runner** | — | **0.4** còn lại **chạy theo trend** | trailing siết theo (cách 3×ATR) |

→ Lệnh thắng đầy đủ = `0.3×(+1R) + 0.3×(+2R) + 0.4×(runner chạy xa)`. Sau TP2, runner
**không bao giờ** lời dưới +1R (vì stop đã khóa ở +1R, chỉ siết theo hướng có lợi).

### ⏰ vs ⚡ — "2 cái đồng hồ" (rất quan trọng để hiểu các ví dụ)
| Việc | Bao lâu kiểm tra 1 lần | Ai làm |
|---|---|---|
| Chốt TP1, TP2 · dời/siết trailing | **mỗi giờ** (nến 1h đóng) | tick theo giờ |
| **Ép cắt lỗ** trên giá hiện tại | **mỗi 1 phút** | guardian |
| **Thoát khi đảo chiều 15m** | **mỗi 1 phút** | guardian |

> 💡 Chốt lời TP1/TP2 chạy theo **giờ**. Còn **cắt lỗ** và **đảo chiều** được canh mỗi
> **phút** → an toàn hơn, không phải đợi cả tiếng.

### ⚡ Guardian (lớp bảo vệ mỗi phút) làm 2 việc
- **A. Ép cắt lỗ:** sàn demo **không** giữ lệnh stop chờ sẵn được. Nếu chỉ đợi nến giờ,
  giá có thể vọt **qua** stop rồi mới đóng (lỗ to hơn −1R). Guardian canh mỗi phút, giá
  chạm stop là **đóng ngay** (`GUARDIAN_STOP`).
- **B. Thoát khi đảo chiều:** nếu khung **15 phút** đảo chiều **ngược** lệnh (và lệnh
  **chưa** tới TP2), guardian **đóng lệnh sớm** (`REVERSAL_CLOSE`) + báo Telegram. Mục
  tiêu: giữ an toàn, giữ chút lời, không đợi giá quay lại đụng stop.

---

## Phần 5 — TẤT CẢ CÁC TÌNH HUỐNG (ví dụ cụ thể) 📖

**Dùng chung 1 ví dụ SHORT:** vào short coin SOL ở **$100**, ATR = $4 → 1R = 1.5×ATR =
**$6 giá** = **$50 tiền**. Cắt lỗ **$106**. TP1 = **$94** (+1R). TP2 = **$88** (+2R).
Trailing rộng 3×ATR = **$12**. Lệnh chia 0.3 / 0.3 / 0.4.

---

### 🔴 Tình huống 1 — Thua, dính cắt lỗ ngay (chưa tới TP1)
- **Diễn biến:** vừa vào thì giá đi ngược, **bật lên ≥ $106**.
- **Bot làm:** đóng **toàn bộ** ở $106.
- **Kết quả:** **−1R = −$50**. (Đây là lỗ tối đa của 1 lệnh.)
- **Ai đóng:** guardian (mỗi phút) hoặc tick giờ — cái nào thấy trước.

### 🟢 Tình huống 2 — Tới TP1 rồi quay về hòa vốn (lời nhỏ) ⭐
- **Diễn biến:** giá xuống **$94 (TP1)** → bot chốt 0.3 (**+$15**), dời stop về **$100
  (hòa vốn)**. Sau đó giá **quay lên $100**.
- **Bot làm:** 0.7 còn lại đóng ở hòa vốn ($100) = **$0**.
- **Kết quả:** **+$15 (+0.3R)** — **KHÔNG lỗ**.
- 💡 *Cải tiến quan trọng:* cấu hình **cũ** chốt 0 ở TP1 → về hòa vốn = **$0** (huề).
  Cấu hình **mới** chốt 0.3 ở TP1 → giữ được **+$15** dù giá quay đầu.
- **Ai đóng:** tick giờ (chạm hòa vốn).

### 🟢 Tình huống 3 — TP1 + TP2 + runner chạy xa (thắng lớn)
| Giờ | Giá | Chuyện gì | Stop | Ghi chú |
|---|---|---|---|---|
| 0 | $100 | 🟢 vào short | $106 | lỗ tối đa −$50 |
| 1 | $94 | **TP1** → chốt 0.3 (+$15) | → $100 | hết lỗ |
| 2 | $88 | **TP2** → chốt 0.3 (+$30) | → $94 | khóa +1R, bật trailing |
| 3 | $82 | runner +3R | $94 | |
| 4 | $76 | đáy mới +4R | → **$88** | trailing siết xuống |
| 5 | $70 | đáy mới +5R | → **$82** | khóa thêm |
| 6 | $82 | 🔴 giá bật lại, chạm $82 | ĐÓNG | runner chốt +3R (0.4 = +$60) |

- **Kết quả:** $15 + $30 + $60 = **+$105 (+2.1R)** — gấp ~2× tiền rủi ro.
- **Ai đóng:** trailing stop (tick giờ).

### 🟢 Tình huống 4 — TP1 + TP2 rồi runner quay đầu NGAY (thắng tối thiểu)
- **Diễn biến:** sau TP2 ($88) giá bật lên ngay chạm khóa **+1R ($94)**.
- **Bot làm:** runner 0.4 đóng ở +1R (**+$20**).
- **Kết quả:** $15 + $30 + $20 = **+$65 (+1.3R)** — vẫn lời. *(Sau TP2 runner không bao
  giờ dưới +1R.)*

### 🟢 Tình huống 5 — ⚡ Guardian thoát do đảo chiều, đang LỜI NHỎ (chưa tới TP1) ⭐ — VÍ DỤ CỦA BẠN
- **Diễn biến:** giá mới xuống **$97** (mới +0.5R, **chưa** tới TP1 $94). Nhưng khung
  **15m** EMA50 cắt **lên** EMA200 → xu hướng đảo lên, **ngược** với lệnh short.
- **Bot làm:** guardian (chế độ `exit`) **đóng toàn bộ** ở $97 ngay phút đó + báo Telegram.
- **Kết quả:** **+$25 (+0.5R)** — **lời nhỏ**. Thoát sớm, an toàn, không đợi giá quay lại
  đụng stop $106.
- **Ai đóng:** ⚡ guardian (mỗi phút).

### 🟡 Tình huống 6 — ⚡ Guardian thoát do đảo chiều, đang LỖ NHỎ
- **Diễn biến:** giá đi ngược lên **$103** (đang −0.5R, **chưa** tới stop $106). Khung 15m
  đảo chiều.
- **Bot làm:** guardian đóng ở $103.
- **Kết quả:** **−$25 (−0.5R)** — **lỗ nhỏ**, ít hơn lỗ tối đa −$50. Cắt sớm trước khi
  thành lỗ đủ.
- **Ai đóng:** ⚡ guardian (mỗi phút).

### 🔴 Tình huống 7 — ⚡ Guardian ép cắt lỗ giữa giờ (giá nhảy qua stop)
- **Diễn biến:** giá vọt nhanh lên **qua** stop $106 → $108 chỉ trong vài phút (giữa 2 nến
  giờ). Sàn demo **không** giữ lệnh stop chờ sẵn.
- **Nếu KHÔNG có guardian:** phải đợi tới nến giờ mới đóng → đóng ở $108 = **−1.3R (−$65)**.
- **Có guardian:** canh mỗi phút, giá chạm $106 là đóng ngay ≈ **−1R (−$50)**.
- 💡 *Đây là lý do chính có guardian* — bịt khe hở "giá trôi qua stop giữa giờ" trên demo.
- **Ai đóng:** ⚡ guardian (mỗi phút).

### 🟢 Tình huống 8 — ⚡ Đảo chiều SAU khi đã chốt TP1
- **Diễn biến:** đã chạm TP1 ($94, chốt **+$15**, stop về hòa vốn). Giá đang ở **$92**
  (giữa TP1–TP2). Khung 15m đảo chiều.
- **Bot làm:** guardian đóng **phần còn lại 0.7** ở $92 (lời thêm ~**+$47**).
- **Kết quả:** ≈ $15 + $47 = **+$62 (~+1.2R)**. *(Đã khóa +$15, phần còn lại thoát sớm vẫn
  có lời nhờ bắt đảo chiều — tốt hơn để nó tụt về hòa vốn.)*
- **Ai đóng:** ⚡ guardian (mỗi phút).

### 🟡 Tình huống 9 — HEALTH_CLOSE: xu hướng KHUNG 1H đảo (chốt theo giờ)
- **Diễn biến:** EMA50/EMA200 **khung 1h** (không phải 15m) đảo chiều → xu hướng **gốc**
  hỏng.
- **Bot làm:** đóng ở giá đóng nến giờ. Lời/lỗ tùy giá lúc đó.
- **Khác guardian:** đây là theo **giờ** (chậm hơn). Guardian 15m thường bắt đảo chiều
  **sớm hơn** cái này.
- **Ai đóng:** tick giờ.

---

## Phần 6 — Bảng tổng hợp các tình huống

| # | Tình huống | Kết quả (1R=$50) | Ai đóng |
|---|---|---|---|
| 1 | Dính stop ngay (chưa TP1) | **−$50** (−1R) | guardian / giờ |
| 2 | TP1 rồi về hòa vốn | **+$15** (+0.3R) | giờ |
| 3 | TP1+TP2+runner chạy xa | **+$105** (+2.1R) | trailing (giờ) |
| 4 | TP1+TP2, runner quay đầu ngay | **+$65** (+1.3R) | trailing (giờ) |
| 5 | ⚡ Đảo chiều, đang lời nhỏ (chưa TP1) | **+$25** (+0.5R) | guardian |
| 6 | ⚡ Đảo chiều, đang lỗ nhỏ | **−$25** (−0.5R) | guardian |
| 7 | ⚡ Ép stop giữa giờ (giá nhảy qua) | **−$50** (−1R) | guardian |
| 8 | ⚡ Đảo chiều sau TP1 | **+$62** (~+1.2R) | guardian |
| 9 | Xu hướng 1h đảo (HEALTH_CLOSE) | tùy giá | giờ |

> 📌 Các kiểu "lý do đóng" thấy trong bảng **Recent closed**:
> **STOP / GUARDIAN_STOP** = cắt lỗ · **MANAGED_STOP / TP3** = chốt lời (trailing/TP) ·
> **REVERSAL_CLOSE** = guardian thoát do đảo chiều 15m · **HEALTH_CLOSE** = xu hướng 1h đảo.

---

## Phần 7 — Khi nào bot KHÔNG vào lệnh?
- **Đủ số lệnh:** đang mở đủ **4** lệnh (`MAX_OPEN_POSITIONS`) → không mở thêm.
- **Cooldown:** vừa đóng 1 coin → đợi **24 giờ** mới vào lại coin đó.
- **Kill switch:** lỗ **≥ 5% trong ngày** → ngừng mở lệnh mới hôm đó (xem lưu ý ở Phần 9).
- **Thị trường đi ngang:** ADX < 25 → bỏ qua (xu hướng chưa đủ mạnh).

---

## Phần 8 — Quản lý rủi ro (cấu hình hiện tại)

| Quy tắc | Giá trị | Ý nghĩa |
|---|---|---|
| Rủi ro mỗi lệnh | **1%** tài khoản | mỗi lệnh thua tối đa ~1R |
| Số lệnh mở cùng lúc | **4** | giảm rủi ro "ôm nhiều lệnh cùng chiều" (đòn bẩy mạnh nhất để an toàn) |
| Chốt lời | **0.3 ở TP1, 0.3 ở TP2, trail 0.4** | vừa giữ lời sớm, vừa cho runner chạy |
| Trailing | **3×ATR** | đủ rộng để không bị rung ra sớm |
| Cắt lỗ | **1.5×ATR** (= 1R) | luôn có cắt lỗ; guardian ép mỗi phút |
| Guardian | **mỗi 1 phút**, đảo chiều = **15m**, chế độ **exit** | ép stop + thoát đảo chiều tự động |
| Kill switch | lỗ **5%/ngày** | ngừng **vào lệnh mới** (xem Phần 9) |
| Timeout (giữ lệnh tối đa) | **TẮT** | guardian + đảo chiều 1h lo việc dọn lệnh, không cần hẹn giờ |

> Triết lý: **lỗ cắt nhanh (−1R), lời để chạy, canh đảo chiều mỗi phút, không ôm quá 4 lệnh, không liều quá 1%.**

---

## Phần 9 — LƯU Ý QUAN TRỌNG (đọc kỹ!) ⚠️

1. **Lợi thế còn MỎNG và phụ thuộc thị trường.** Backtest: giai đoạn gần đây (2026) **có
   lời** (profit factor ~1.2), nhưng giai đoạn 2024–2025 **lỗ ~90%**. Tức là bot ăn theo
   **một loại thị trường nhất định**, **chưa phải lợi thế chắc chắn**. → Giữ size **siêu nhỏ**.

2. **Thắng/thua: ~50/50 là bình thường.** Bot không cố thắng nhiều, mà để **lệnh thắng to
   bù lệnh thua nhỏ**. Đánh giá qua **tổng nhiều lệnh** (vài chục lệnh), không qua 1 lệnh.

3. **"Cắt lỗ 5%/ngày" chỉ chặn lệnh MỚI, không đóng lệnh đang mở.** Nếu 4 lệnh đang mở
   cùng tụt về −1R thì lỗ trong ngày có thể **vượt** 5%. Hiểu đúng: nó là "khóa cửa không
   cho vào thêm", không phải "trần lỗ cứng".

4. **Trên DEMO, cắt lỗ chỉ được bảo vệ KHI bot đang chạy** (nhờ guardian mỗi phút) — sàn
   demo không giữ lệnh stop chờ sẵn. Bot **tắt** = không ai canh. (Trên **mainnet** thì có
   lệnh stop treo sẵn trên sàn, vẫn cắt kể cả khi bot tắt.)

5. **Lên tiền thật thì bắt đầu SIÊU NHỎ** (`RISK_USDT=1`, ~$1/lệnh) cho tới khi vài chục
   lệnh thật xác nhận có lời. Khóa API: bật Futures, **TẮT rút tiền**, **khóa theo IP**.

6. **Không phải lời khuyên đầu tư.** Futures rủi ro cao, có thể mất tiền. Chỉ dùng tiền
   bạn sẵn sàng mất.

---

## Phần 10 — Cách chạy & đọc Dashboard

```bash
npm run testnet            # Chạy bot trên TESTNET (tiền ảo, an toàn)
npm run dashboard:testnet  # Bảng theo dõi → http://localhost:8787
npm run account            # Xem số dư + vị thế đang mở
npm run flatten            # KHẨN CẤP: đóng hết tất cả lệnh
npm run live               # Tiền THẬT (cần bật ALLOW_LIVE=true và CONFIRM_LIVE=true)
```

**Bảng "Open positions":** cột **Entry/Mark** = giá vào/hiện tại · **Stop** = cắt lỗ ·
**Max loss** = mất bao nhiêu nếu chạm stop (≈ $0 khi đã về hòa vốn) · **R now** = đang
lời/lỗ mấy R · **TP** = đã chạm mốc nào · **Monitor** = trạng thái guardian (✓ ổn · ⚠ phát
hiện đảo chiều 15m).

---

## 📌 Tóm tắt 1 đoạn

> Bot đi **theo xu hướng**, vào khi giá **hồi nhịp**, mỗi lệnh **rủi ro 1%**, luôn có **cắt
> lỗ**. Chốt **0.3 ở +1R**, **0.3 ở +2R**, **0.4 cho chạy theo trend** (trailing). Một
> **guardian canh mỗi phút** ép cắt lỗ và **thoát sớm khi khung 15m đảo chiều**. Mở tối đa
> **4 lệnh**. Đang chạy **testnet (tiền ảo)** để kiểm chứng. Lợi thế **còn mỏng, phụ thuộc
> thị trường** (in-sample từng lỗ ~90%) → **kiên nhẫn, giữ size siêu nhỏ** là quan trọng
> nhất. 🎯
