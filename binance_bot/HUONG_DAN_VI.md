# 🤖 Hướng Dẫn Bot Trade Binance Futures (cho người mới)

> Tài liệu này giải thích bot đang hoạt động như thế nào, viết đơn giản nhất có thể.
> Đọc xong bạn sẽ hiểu: bot làm gì, kiếm lời kiểu gì, và rủi ro ở đâu.

---

## Phần 1 — Bot này làm gì?

Bot tự động **mua/bán hợp đồng tương lai (futures) coin trên Binance** theo một
chiến lược cố định, **không cần bạn ngồi canh**. Mỗi giờ (khi nến 1h đóng) bot:

1. Quét ~12 coin lớn (BTC, ETH, SOL, BNB…).
2. Tìm coin đang có **xu hướng (trend)** rõ ràng.
3. Vào lệnh, tự đặt mức **cắt lỗ** và **chốt lời**.
4. Tự quản lý cho đến khi đóng lệnh.

Đây là bot **bám xu hướng (trend-following)** — nó cố đi theo con sóng lớn, không
đoán đỉnh/đáy.

---

## Phần 2 — Kiến thức Futures cơ bản (cần biết trước)

### 🔼 Long và 🔽 Short
- **Long** = đặt cược giá **TĂNG**. Mua trước, bán sau. Giá lên → lời.
- **Short** = đặt cược giá **GIẢM**. Bán trước, mua lại sau. Giá xuống → lời.

> Futures khác mua coin thường ở chỗ: bạn **kiếm lời được cả khi giá giảm** (short).
> Trên Binance, mở short = đặt lệnh **SELL**; đóng short = đặt lệnh **BUY**.
> (Vì vậy thấy chữ "Sell" trong lịch sử lệnh **không có nghĩa là đã chốt** — đó là
> lệnh **mở** một lệnh short.)

### ⚙️ Đòn bẩy (Leverage)
Đòn bẩy cho phép mở lệnh lớn hơn số vốn. Bot để **10x**, nhưng **đòn bẩy KHÔNG
phải là rủi ro** ở đây — rủi ro do **mức cắt lỗ** quyết định (xem phần dưới). Bot
luôn giữ vị thế nhỏ so với tài khoản.

### 📏 "R" là gì? (khái niệm quan trọng nhất)
**R = số tiền bạn chấp nhận mất nếu lệnh thua** (khoảng cách từ giá vào đến cắt lỗ).

- Bot rủi ro **1% tài khoản mỗi lệnh**. Tài khoản ~$5000 → **1R ≈ $50**.
- Lệnh thua = **−1R = −$50**.
- Lệnh thắng +2R = **+$100**, +3R = **+$150**…

Mọi thứ trong bot đo bằng **R**, không đo bằng giá. Cách này giúp mọi lệnh có cùng
mức rủi ro dù coin đắt hay rẻ.

---

## Phần 3 — Chiến lược của bot: "Trend-Pullback"

Tên gọi: **bám xu hướng + chờ giá hồi**. Ý tưởng:

1. **Xác định xu hướng** bằng đường trung bình EMA50 và EMA200:
   - EMA50 > EMA200 → xu hướng **TĂNG** → bot chỉ tìm lệnh **Long**.
   - EMA50 < EMA200 → xu hướng **GIẢM** → bot chỉ tìm lệnh **Short**.
   - → Bot **luôn đi THEO xu hướng**, không bao giờ ngược dòng.
2. **Chờ giá hồi (pullback)** về vùng EMA20 — tức là không đu đỉnh, mà chờ giá
   nghỉ một nhịp rồi mới vào.
3. **Lọc thêm bằng ADX ≥ 25** — chỉ vào khi xu hướng đủ mạnh (tránh thị trường đi
   ngang lình xình, là lúc bot dễ thua nhất).

> Nói đơn giản: **"Đi theo trend, chờ giá nghỉ một nhịp rồi nhảy vào."**

Bot hiện chỉ chạy **1 chiến lược: trend-pullback** (đã được kiểm chứng có lời).
Có 1 chiến lược khác (`trend-breakout`) nhưng đã **tắt** vì backtest cho thấy nó lỗ.

---

## Phần 4 — Bí mật kiếm lời (PHẦN QUAN TRỌNG NHẤT) 🎯

### Sự thật ngược đời: bot THUA ~7/10 lệnh nhưng vẫn LÃI

Bí mật là **độ lệch (asymmetry)**: lệnh thua **nhỏ**, lệnh thắng **to**.

| | Lệnh thua | Lệnh thắng |
|---|---|---|
| Kích thước | nhỏ (~−1R) | to (+2R, +3R, +5R…) |
| Vì sao | cắt lỗ nhanh | cho **chạy theo trend** |

### Ví dụ: 10 lệnh, rủi ro $50/lệnh

**Cho lệnh thắng chạy xa (cách bot làm — config A):**
```
7 lệnh THUA × −$50            = −$350
3 lệnh THẮNG, chạy xa ~+$125  = +$375
                       TỔNG   = +$25  ✅ LÃI
```
**Nếu cắt lệnh thắng sớm:**
```
7 lệnh THUA × −$50    = −$350
3 lệnh THẮNG × +$50   = +$150
              TỔNG    = −$200  ❌ LỖ
```

→ Cùng số thắng/thua, nhưng **để lệnh thắng chạy** thì lãi, **cắt sớm** thì lỗ. Đây
là lý do bot **không chốt lời ở TP1** (chỉ dời stop về hòa vốn) và **để runner chạy**.

> 💡 **Vẫn không treo mãi:** "để chạy" KHÔNG có nghĩa ôm vô tận — có **3 timeout** phủ
> trọn vòng đời (xem Phần 5), đảm bảo không lệnh nào treo quá 7 ngày. *Time is money.*

### Ví von dễ nhớ
> 🌱 **Làm vườn: nhổ cỏ dại, tưới cho hoa lớn.**
> Cắt lệnh thua nhanh (nhổ cỏ), để lệnh thắng lớn lên (tưới hoa) — nhưng không để cây
> nào "ngồi lì" mãi (3 timeout dọn chỗ cho cây mới).

---

## Phần 5 — Vòng đời một lệnh (entry → exit)

Đây là điều bot **thực sự đang làm** với mỗi lệnh:

```
1. VÀO LỆNH (theo trend, sau khi giá hồi)
   → đặt cắt lỗ ban đầu cách giá vào 1.5×ATR (= −1R nếu chạm)
        ↓
2. Giá đạt +1R (TP1)
   → KHÔNG chốt gì, nhưng DỜI cắt lỗ về HÒA VỐN (giá vào)
   → từ đây lệnh KHÔNG THỂ LỖ nữa ✅
        ↓
3. Giá đạt +2R (TP2)
   → 💰 CHỐT 1/2 lệnh (khóa lời), dời cắt lỗ lên +1R
   → BẬT trailing stop cho 1/2 còn lại
        ↓
4. Phần 1/2 còn lại CHẠY theo trend
   → trailing stop "đi theo" giá (cách 3×ATR)
   → trend còn chạy → lời còn tăng (+3R, +5R…)
        ↓
5. ĐÓNG khi: trailing chạm / trend đảo (EMA50 cắt EMA200)
            HOẶC chạm 1 trong 3 TIMEOUT (xem dưới)
```

**Tóm lại:** chốt 1/2 ở +2R, để 1/2 chạy theo trend. Bạn **không cần canh tay** — bot
tự biết điểm dừng.

### ⏱️ 3 timeout phủ trọn vòng đời (không lệnh nào treo mãi — "time is money")

Một lệnh có 3 giai đoạn, **mỗi giai đoạn có 1 timeout** dọn lệnh treo:

| Giai đoạn | Trạng thái | Timeout | Ý nghĩa |
|---|---|---|---|
| **① Chưa tới TP1** | lệnh "chết", chưa +1R | **2 ngày** (`MAX_HOLD_BARS`) | không chạy → đóng, dọn chỗ |
| **② TP1 → TP2** | đã +1R, kẹt hòa vốn | **3 ngày** (`STALL_BARS`) | kẹt không tiến → đóng |
| **③ Sau TP2** | runner đang chạy | **7 ngày** (`MAX_TOTAL_BARS`) | cho chạy thoải mái, nhưng cap cuối 7 ngày |

→ Timeout **tăng dần** theo "độ ngon" của lệnh: lệnh chết cắt sớm nhất (2 ngày), lệnh
đang thắng (runner) cho nhiều dây nhất (7 ngày). **Backtest: 3 timeout này KHÔNG làm
giảm lời** (+132% y như không có) vì thực tế lệnh tự đóng trước đó — chúng chỉ là
**lưới an toàn** đảm bảo không bao giờ treo vô hạn.

### 🔎 Trailing stop là gì?
- **Stop thường** = đứng YÊN một chỗ.
- **Trailing stop** = stop **ĐI THEO giá** theo hướng có lợi. Giá càng đi đúng
  (với short = giá càng giảm), stop càng **kéo theo xuống**, **khóa dần lời**.
- Nó **chỉ siết chặt, KHÔNG BAO GIỜ nới ra** → lời đã có được bảo vệ.
- Cách giá **3×ATR** (đủ rộng để không bị "rung" ra sớm).
- Giá **đảo chiều** chạm trailing stop → **đóng lệnh, chốt lời**.

> 🚗 **Ví von:** giống cái **phanh tay tự động leo dốc** — xe lùi một chút là
> phanh giữ ngay, không cho tụt hết xuống.

### 📖 Ví dụ cụ thể: 1 vòng đời lệnh SHORT (kèm trailing)

**Giả sử:** vào short coin SOL ở **$100**, ATR = $4 → 1R = 1.5×ATR = **$6**.
Rủi ro = **$50**. (Trailing rộng 3×ATR = **$12**.)

| Giờ | Giá SOL | Chuyện gì xảy ra | Stop ở đâu | Trạng thái |
|---|---|---|---|---|
| **0** | **$100** | 🟢 VÀO short | $106 | lỗ tối đa **−$50** |
| 1 | $94 | đạt **+1R (TP1)** | → **$100** (hòa vốn) | ✅ KHÔNG thể lỗ nữa |
| 2 | $88 | đạt **+2R (TP2)** | → $94 | 💰 **chốt 1/2 (+$50)**, BẬT trailing |
| 3 | $82 | đáy mới (+3R) | $94 | nửa còn lại +3R |
| 4 | $76 | đáy mới (+4R) | → **$88** (trailing siết) | khóa tối thiểu +2R |
| 5 | $70 | đáy mới (+5R) | → **$82** (trailing siết) | khóa tối thiểu +3R |
| 6 | $82 | 🔴 giá **BẬT LẠI**, chạm stop $82 | ĐÓNG | 💰 **chốt nửa còn lại +3R** |

→ Để ý cột **Stop**: giá càng xuống (giờ 3→4→5), trailing càng **kéo xuống theo**
($94 → $88 → $82), khóa lời dần. Giờ 6 giá bật lên chạm stop → bot tự đóng.

**Tổng tiền lệnh này:**

| Phần | Chốt ở | Lời |
|---|---|---|
| Nửa 1 (TP2) | $88 = +2R | +$50 |
| Nửa 2 (trailing) | $82 = +3R | +$75 |
| **TỔNG** | | **+$125** (gấp **2.5×** số rủi ro $50) |

**Nếu giá đảo chiều SỚM?** Sau TP2 ($88) giá bật lại ngay lên $94 → chạm stop $94
(=+1R) → nửa còn lại chốt **+$25**. Tổng = $50 + $25 = **+$75**. → **Vẫn lời** sau TP2.
*(Còn nếu lệnh kẹt giữa TP1↔TP2 hoài → timeout ② đóng nó sau 3 ngày, xem ở trên.)*

### 4 kiểu đóng lệnh bạn sẽ thấy trong "Recent closed"
- **TP3 / MANAGED_STOP** = chốt lời (qua trailing hoặc chốt phần ở TP2).
- **STOP** = cắt lỗ −1R (lệnh thua).
- **HEALTH_CLOSE** = trend đảo chiều, HOẶC chạm 1 trong **3 timeout** (2/3/7 ngày).

---

## Phần 6 — Quản lý rủi ro (giữ cho không "cháy tài khoản")

| Quy tắc | Giá trị | Ý nghĩa |
|---|---|---|
| Rủi ro mỗi lệnh | **1%** tài khoản | mỗi lệnh chỉ mất tối đa ~$50 |
| Số lệnh mở cùng lúc | tối đa **10** *(testnet)* | bắt nhiều cơ hội — tiền thật nên để 3-5 |
| Chốt lời | **0 ở TP1 → hòa vốn, 1/2 ở TP2, trail 1/2** | để lệnh thắng chạy xa (lời tối đa) |
| Kill switch (ngắt) | lỗ **5%/ngày** | lỗ quá → ngừng vào lệnh mới hôm đó |
| Cooldown | **24 giờ** | sau khi đóng 1 coin, đợi 24h mới vào lại coin đó |
| Cắt lỗ | **1.5×ATR** | luôn có mức cắt lỗ tự động (đặt treo trên sàn) |
| ⏱️ Timeout ① (chưa TP1) | **2 ngày** | lệnh chết → đóng, dọn chỗ |
| ⏱️ Timeout ② (TP1→TP2) | **3 ngày** | lệnh kẹt hòa vốn → đóng |
| ⏱️ Timeout ③ (sau TP2) | **7 ngày** | cap cuối cho runner → không treo mãi |

→ Triết lý: **lỗ cắt nhanh, lời để chạy, nhưng KHÔNG treo vô hạn (3 timeout), không liều quá 1%.**

---

## Phần 7 — Cách chạy bot (các lệnh)

```bash
npm run testnet            # Chạy bot trên TESTNET (tiền ảo, an toàn)
npm run dashboard:testnet  # Mở bảng theo dõi → http://localhost:8787
npm run account            # Xem số dư + vị thế đang mở
npm run flatten            # KHẨN CẤP: đóng hết tất cả lệnh
npm run backtest           # Kiểm tra chiến lược trên dữ liệu quá khứ
npm run live               # Chạy tiền THẬT (cần bật 2 khóa an toàn)
```

> **Quan trọng:** `testnet` = tiền ảo (an toàn để học). `live` = tiền thật, phải
> bật **cả 2** khóa `ALLOW_LIVE=true` và `CONFIRM_LIVE=true` thì mới chạy.

---

## Phần 8 — Đọc Dashboard

Mở `http://localhost:8787` sau khi chạy `npm run dashboard:testnet`.

**Các ô trên cùng (KPI):**
- **Equity** = tổng tài khoản.
- **Unrealized (live)** = lời/lỗ của lệnh ĐANG MỞ (real-time, chưa chốt).
- **Net PnL (closed)** = lời/lỗ thực tế của lệnh ĐÃ ĐÓNG.
- **Win rate** = tỷ lệ thắng (sẽ ~28% — thấp là BÌNH THƯỜNG, xem Phần 4).
- **Profit factor** = tổng lời ÷ tổng lỗ (> 1 là có lời).

**Bảng "Open positions" (lệnh đang mở):**
| Cột | Ý nghĩa |
|---|---|
| Side | `short` (cược giảm) / `long` (cược tăng) |
| Entry / Mark | giá vào / giá hiện tại |
| Stop | giá cắt lỗ |
| **Max loss** | mất bao nhiêu nếu chạm stop (≈ $0 nếu đã về hòa vốn) |
| **Target (+2R)** | mục tiêu lời (~+$100) |
| **uPnL (live)** | lời/lỗ hiện tại (chưa chốt) |
| **R now** | đang lời/lỗ mấy R |
| TP | đã chạm mốc nào (TP1 = đã về hòa vốn) |

---

## Phần 9 — Trạng thái hiện tại & Lộ trình

### Đang ở đâu?
Bot đang chạy **TESTNET (tiền ảo)** trên sàn demo của Binance — gọi là
**forward-test**: chạy thật nhưng không mất tiền, để xác nhận bot hoạt động đúng
và khớp với backtest.

> ✅ **Cắt lỗ treo trên sàn:** bot đặt lệnh STOP_MARKET treo sẵn trên sàn qua
> endpoint Algo mới (`/fapi/v1/algoOrder` — từ 2025-12-09 Binance bắt buộc lệnh
> điều kiện đi qua đây). Hoạt động **cả demo lẫn mainnet** → cắt lỗ **tức thì**
> kể cả khi bot tắt. Bot còn canh thêm theo nến mỗi giờ làm lớp dự phòng.

### Lộ trình
```
1. ✅ Backtest      — kiểm chứng chiến lược trên dữ liệu quá khứ (đã xong)
2. 🔄 Testnet       — chạy tiền ảo 1–2 tuần, xác nhận khớp backtest (ĐANG Ở ĐÂY)
3. ⏳ Live nhỏ      — tiền thật, size siêu nhỏ (RISK_USDT=1, ~$1/lệnh)
4. ⏳ Tăng dần      — chỉ tăng size khi số liệu thật ổn định
```

---

## Phần 10 — LƯU Ý QUAN TRỌNG (đọc kỹ!) ⚠️

1. **Lợi thế còn mỏng.** Backtest cho thấy bot **có lời nhưng biên độ nhỏ**
   (profit factor ~1.1). Không phải "máy in tiền". Phải chạy thật một thời gian
   mới biết chắc.

2. **Thắng ít lệnh là BÌNH THƯỜNG.** Bot thua ~7/10 lệnh (để lệnh thắng chạy xa bù
   lại). Đừng hoảng khi thấy nhiều lệnh đỏ −$50 liên tiếp — đó là thiết kế. Đánh giá
   bot qua **tổng lời sau nhiều lệnh** (vài chục lệnh), không qua 1 lệnh hay 1 ngày.

3. **Khi lên tiền thật: bắt đầu SIÊU NHỎ.** Dùng `RISK_USDT=1` (rủi ro ~$1/lệnh)
   cho đến khi có vài chục lệnh thật xác nhận có lời. Đừng vội tăng size.

4. **Khóa API key an toàn:** bật Futures, **TẮT rút tiền (withdrawals)**,
   **khóa theo IP**. Không bao giờ đưa key cho ai.

5. **Đây không phải lời khuyên đầu tư.** Trade futures rủi ro cao, có thể mất
   tiền. Chỉ dùng tiền bạn sẵn sàng mất.

---

## 📌 Tóm tắt 1 đoạn

> Bot đi **theo xu hướng**, vào lệnh khi giá **hồi nhịp**, mỗi lệnh **rủi ro 1%**,
> luôn có **cắt lỗ**. Nó **thua nhiều lệnh nhỏ** nhưng **để vài lệnh thắng chạy xa**
> (chốt 1/2 ở +2R, phần còn lại trailing) → tổng lại có lời. Có **3 timeout** (2/3/7
> ngày) phủ trọn vòng đời nên **không lệnh nào treo mãi** ("time is money"). Đang chạy
> **testnet (tiền ảo)** để kiểm chứng, sau đó mới lên **tiền thật với size siêu nhỏ**.
> Lợi thế còn mỏng nên **kiên nhẫn và giữ size nhỏ** là quan trọng nhất. 🎯
