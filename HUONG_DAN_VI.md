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
3. **Lọc bằng ADX ≥ 35** — chỉ vào khi xu hướng THẬT mạnh (nâng từ 25 lên 35 sau đợt
   tối ưu 2026-06-10 → ít lệnh hơn nhưng chất hơn; slot trống là bình thường).

Bot chỉ chạy **1 chiến lược: trend-pullback**. (`trend-breakout` đã **tắt** vì backtest lỗ.)

---

## Phần 4 — Cách bot vào/ra lệnh (luật chơi)

### 🎯 Thang chốt lời (config hiện tại 2026-06-10: **0 / 0.5 / 0.5**)
| Mốc | Khi giá đạt | Bot làm | Stop dời tới |
|---|---|---|---|
| **TP1** | +1R | **KHÔNG bán gì** (TAKE1=0) | **hòa vốn** (giá vào) → hết lỗ |
| **TP2** | +2R | bán **0.5** (nửa lệnh) | **+1R** (khóa lời) + bật trailing |
| **Runner** | — | **0.5** còn lại **chạy theo trend** | trailing siết theo (cách 3×ATR) |

→ Lệnh thắng đầy đủ = `0.5×(+2R) + 0.5×(runner chạy xa)`. Sau TP2, runner **không bao
giờ** lời dưới +1R (stop đã khóa ở +1R, chỉ siết theo hướng có lợi). Mốc TP1 giờ chỉ có
một việc: **đưa stop về hòa vốn** — đổi "chốt sớm chút lời" lấy "runner to hơn", là lựa
chọn thắng trong đợt sweep walk-forward 2026-06-10.

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
Trailing rộng 3×ATR = **$12**. Lệnh chia **0 / 0.5 / 0.5** (không chốt ở TP1).

---

### 🔴 Tình huống 1 — Thua, dính cắt lỗ ngay (chưa tới TP1)
- **Diễn biến:** vừa vào thì giá đi ngược, **bật lên ≥ $106**.
- **Bot làm:** đóng **toàn bộ** ở $106.
- **Kết quả:** **−1R = −$50**. (Đây là lỗ tối đa của 1 lệnh.)
- **Ai đóng:** guardian (mỗi phút) hoặc tick giờ — cái nào thấy trước.

### 🟡 Tình huống 2 — Tới TP1 rồi quay về hòa vốn (huề) ⭐
- **Diễn biến:** giá xuống **$94 (TP1)** → bot **không chốt gì** (TAKE1=0), chỉ dời stop
  về **$100 (hòa vốn)**. Sau đó giá **quay lên $100**.
- **Bot làm:** đóng **toàn bộ** ở hòa vốn ($100).
- **Kết quả:** **≈ $0 (huề, trừ chút phí)** — **KHÔNG lỗ**, vì TP1 đã kích hoạt "tấm khiên
  hòa vốn".
- 💡 *Đánh đổi có chủ đích:* không chốt gì ở TP1 nghĩa là kịch bản này về **$0** thay vì
  +0.3R như config cũ — đổi lại, khi trend chạy thật (TH3) runner to **gấp rưỡi**. Sweep
  walk-forward 2026-06-10 cho thấy đổi như vậy lời hơn về tổng.
- **Ai đóng:** tick giờ (chạm hòa vốn) hoặc guardian.

### 🟢 Tình huống 3 — TP1 + TP2 + runner chạy xa (thắng lớn)
| Giờ | Giá | Chuyện gì | Stop | Ghi chú |
|---|---|---|---|---|
| 0 | $100 | 🟢 vào short | $106 | lỗ tối đa −$50 |
| 1 | $94 | **TP1** → không chốt, dời stop | → $100 | hết lỗ ("tấm khiên") |
| 2 | $88 | **TP2** → chốt 0.5 (+$50) | → $94 | khóa +1R, bật trailing |
| 3 | $82 | runner +3R | $94 | |
| 4 | $76 | đáy mới +4R | → **$88** | trailing siết xuống |
| 5 | $70 | đáy mới +5R | → **$82** | khóa thêm |
| 6 | $82 | 🔴 giá bật lại, chạm $82 | ĐÓNG | runner chốt +3R (0.5 = +$75) |

- **Kết quả:** $50 + $75 = **+$125 (+2.5R)** — gấp 2.5× tiền rủi ro.
- **Ai đóng:** trailing stop (tick giờ).

### 🟢 Tình huống 4 — TP2 rồi runner quay đầu NGAY (thắng tối thiểu)
- **Diễn biến:** sau TP2 ($88) giá bật lên ngay chạm khóa **+1R ($94)**.
- **Bot làm:** runner 0.5 đóng ở +1R (**+$25**).
- **Kết quả:** $50 + $25 = **+$75 (+1.5R)** — vẫn lời. *(Sau TP2 runner không bao giờ
  dưới +1R.)*

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

### 🟢 Tình huống 8 — ⚡ Đảo chiều SAU khi đã chạm TP1
- **Diễn biến:** đã chạm TP1 ($94 → **không chốt gì**, stop đã về hòa vốn). Giá đang ở
  **$92** (giữa TP1–TP2). Khung 15m đảo chiều.
- **Bot làm:** guardian đóng **toàn bộ lệnh** ở $92.
- **Kết quả:** ≈ **+$66 (~+1.3R)** — cả lệnh thoát sớm có lời nhờ bắt đảo chiều, tốt hơn
  để nó tụt về hòa vốn = $0.
- **Ai đóng:** ⚡ guardian (mỗi phút).

### 🟡 Tình huống 9 — HEALTH_CLOSE: xu hướng KHUNG 1H đảo (chốt theo giờ)
- **Diễn biến:** EMA50/EMA200 **khung 1h** (không phải 15m) đảo chiều → xu hướng **gốc**
  hỏng.
- **Bot làm:** đóng ở giá đóng nến giờ. Lời/lỗ tùy giá lúc đó.
- **Khác guardian:** đây là theo **giờ** (chậm hơn). Guardian 15m thường bắt đảo chiều
  **sớm hơn** cái này.
- **Ai đóng:** tick giờ.

### 🟡 Tình huống 10 — ⏳ Time-stop: lệnh "chết" bị dọn sau 12 nến (HEALTH_CLOSE)
- **Diễn biến:** lệnh mở đã **12 nến 1h** mà **chưa từng chạm TP1 (+1R)** — giá cứ lình
  bình quanh giá vào (trend không nổ).
- **Bot làm:** tick giờ đóng **toàn bộ** ở giá đóng nến (lý do `HEALTH_CLOSE`). Tương tự:
  đã chạm TP1 nhưng **12 nến** sau vẫn chưa tới TP2 → cũng đóng (giải phóng slot).
- **Kết quả:** tùy giá lúc đó — thường là lời/lỗ nhỏ. Mục đích: **không giam vốn + slot**
  vào lệnh không đi đâu.
- 💡 *Vì sao trên dashboard thấy "13h" mà limit là 12?* Cột Age đếm từ lúc nến tín hiệu
  **mở** (sớm hơn lúc khớp lệnh ~1h), còn time-stop đếm **nến đã đóng** tại tick mỗi giờ →
  limit 12 nến = đóng khi Age hiển thị **~13h**. Cột Age có ghi kèm, vd `13h ago (11/12 bars)`.
- **Ai đóng:** tick giờ.

---

## Phần 6 — Bảng tổng hợp các tình huống

| # | Tình huống | Kết quả (1R=$50) | Ai đóng |
|---|---|---|---|
| 1 | Dính stop ngay (chưa TP1) | **−$50** (−1R) | guardian / giờ |
| 2 | Chạm TP1 rồi về hòa vốn | **≈ $0** (huề) | giờ |
| 3 | TP2 + runner chạy xa | **+$125** (+2.5R) | trailing (giờ) |
| 4 | TP2, runner quay đầu ngay | **+$75** (+1.5R) | trailing (giờ) |
| 5 | ⚡ Đảo chiều, đang lời nhỏ (chưa TP1) | **+$25** (+0.5R) | guardian |
| 6 | ⚡ Đảo chiều, đang lỗ nhỏ | **−$25** (−0.5R) | guardian |
| 7 | ⚡ Ép stop giữa giờ (giá nhảy qua) | **−$50** (−1R) | guardian |
| 8 | ⚡ Đảo chiều sau khi chạm TP1 | **+$66** (~+1.3R) | guardian |
| 9 | Xu hướng 1h đảo (HEALTH_CLOSE) | tùy giá | giờ |
| 10 | ⏳ Time-stop 12 nến (lệnh "chết") | tùy giá (thường nhỏ) | giờ |

> 📌 Các kiểu "lý do đóng" thấy trong bảng **Recent closed**:
> **STOP / GUARDIAN_STOP** = cắt lỗ · **MANAGED_STOP** = stop đã dời (hòa vốn/+1R/trailing) ·
> **REVERSAL_CLOSE** = guardian thoát do đảo chiều 15m · **HEALTH_CLOSE** = xu hướng 1h đảo
> **hoặc** time-stop (12 nến).

---

## Phần 7 — Khi nào bot KHÔNG vào lệnh?
- **Đủ số lệnh:** đang mở đủ **4** lệnh (`MAX_OPEN_POSITIONS`) → không mở thêm. (Đã test
  lại 2026-06-10: nâng lên 6/8 làm KẾT QUẢ TỆ HƠN — slot thừa chỉ đầy khi cả thị trường
  cùng pha, đúng lúc nguy hiểm nhất. 4 là đúng.)
- **Cooldown:** vừa đóng 1 coin → đợi **6 giờ** mới vào lại coin đó.
- **Kill switch:** lỗ **≥ 5% trong ngày** → ngừng mở lệnh mới hôm đó (xem lưu ý ở Phần 9).
- **Thị trường đi ngang:** ADX < 35 → bỏ qua (xu hướng chưa đủ mạnh). Ngưỡng cao nên
  **slot trống thường xuyên là BÌNH THƯỜNG** — ít lệnh nhưng chất.

---

## Phần 8 — Quản lý rủi ro (cấu hình hiện tại)

| Quy tắc | Giá trị | Ý nghĩa |
|---|---|---|
| Rủi ro mỗi lệnh | **1%** tài khoản | mỗi lệnh thua tối đa ~1R |
| **Trần size mỗi lệnh** | **$500 notional** | chặn thiệt hại khi giá GAP qua stop (lỗ gap tỷ lệ theo SIZE, không theo R). Với stop gần, trần này thường "đè" risk thực xuống ~0.3–0.5% |
| Số lệnh mở cùng lúc | **4** | đã test lại 2026-06-10: 6/8 tệ hơn rõ — 4 là đúng |
| Lọc vào lệnh | **ADX ≥ 35** | chỉ trend mạnh; ít lệnh nhưng chất |
| Lọc 15m thuận chiều | **ENTRY_ALIGN** | không vào khi 15m đang ngược lệnh (guardian sẽ cắt ngay trong 1 phút — đỡ mất phí oan) |
| Chốt lời | **TP1: không chốt (dời hòa vốn) · TP2: chốt 0.5 · trail 0.5** | dồn lời cho runner — combo thắng sweep 2026-06-10 |
| Trailing | **3×ATR** | đủ rộng để không bị rung ra sớm |
| Cắt lỗ | **1.5×ATR** (= 1R) | luôn có cắt lỗ; lệnh stop treo sẵn trên sàn + guardian ép mỗi phút |
| Guardian | **mỗi 1 phút**, đảo chiều = **15m**, chế độ **exit** | ép stop + thoát đảo chiều tự động |
| Kill switch | lỗ **5%/ngày** | ngừng **vào lệnh mới** (xem Phần 9) |
| Time-stop | **12 nến chưa +1R → đóng · sau TP1 12 nến chưa TP2 → đóng** | dọn lệnh "chết", giải phóng slot (xem TH10) |
| Cooldown | **6 giờ**/coin sau khi đóng | tránh vào lại ngay coin vừa đóng |
| Universe | **45 coin** thanh khoản cao (cố định) | đã lọc volume >$10M; coin mỏng = trượt giá |

> Triết lý: **lỗ cắt nhanh (−1R), lời để chạy, canh đảo chiều mỗi phút, không ôm quá 4 lệnh,
> không liều quá 1%, không lệnh nào to quá $500.**

---

## Phần 9 — LƯU Ý QUAN TRỌNG (đọc kỹ!) ⚠️

1. **Lợi thế còn MỎNG và phụ thuộc thị trường.** Đo nghiêm túc nhất (2026-06-10: đúng 45
   coin bot trade + mô phỏng cả guardian — `LIVE_SIM`): config hiện tại là config **duy nhất**
   dương cả train lẫn test trên 2 đợt walk-forward, nhưng chỉ ở mức **PF 1.02–1.13** (mỏng).
   Giai đoạn gần đây đẹp hơn (PF ~1.6) là nhờ **thị trường đang thuận** — đừng neo kỳ vọng.
   Kỳ vọng thực tế trên tài khoản ~$1k: **trung bình +0.2–0.7%/ngày, ~nửa số ngày đỏ/đứng
   yên, lời dồn vào vài ngày tốt** → đánh giá theo TUẦN, không theo ngày. Giữ size **siêu nhỏ**.

2. **Thắng/thua: ~50/50 là bình thường.** Bot không cố thắng nhiều, mà để **lệnh thắng to
   bù lệnh thua nhỏ**. Đánh giá qua **tổng nhiều lệnh** (vài chục lệnh), không qua 1 lệnh.

3. **"Cắt lỗ 5%/ngày" chỉ chặn lệnh MỚI, không đóng lệnh đang mở.** Nếu 4 lệnh đang mở
   cùng tụt về −1R thì lỗ trong ngày có thể **vượt** 5%. Hiểu đúng: nó là "khóa cửa không
   cho vào thêm", không phải "trần lỗ cứng".

4. **Trên DEMO, cắt lỗ chỉ được bảo vệ KHI bot đang chạy** (nhờ guardian mỗi phút) — sàn
   demo không giữ lệnh stop chờ sẵn. Bot **tắt** = không ai canh. (Trên **mainnet** thì có
   lệnh stop treo sẵn trên sàn, vẫn cắt kể cả khi bot tắt.)

5. **Đang chạy tiền thật size nhỏ** (1% risk + trần $500/lệnh → risk thực ~0.3–0.5%/lệnh).
   **Chưa tăng size** cho tới khi đủ **≥4 tuần VÀ ≥50 lệnh thật** có lời + khớp với backtest
   LIVE_SIM; lúc đó tăng risk và trần **theo cặp** (trần ≈ 0.5× tài khoản). Khóa API: bật
   Futures, **TẮT rút tiền**, **khóa theo IP**.

6. **Không phải lời khuyên đầu tư.** Futures rủi ro cao, có thể mất tiền. Chỉ dùng tiền
   bạn sẵn sàng mất.

---

## Phần 10 — Cách chạy & đọc Dashboard

```bash
npm run live               # Tiền THẬT (cần bật ALLOW_LIVE=true và CONFIRM_LIVE=true)
npm run dashboard:live     # Bảng theo dõi LIVE → http://localhost:8788
npm run account:live       # Xem số dư + vị thế đang mở (live)
npm run flatten:live       # KHẨN CẤP: đóng hết tất cả lệnh (live)
npm run testnet            # Chạy thử trên DEMO (tiền ảo, an toàn) · dashboard:testnet → :8787

# So sánh backtest với live (mô phỏng cả guardian — luôn dùng 2 cờ này):
LIVE_SIM=true BACKTEST_SYMBOLS=env npm run backtest
```

**KPI phía trên:** **Equity (last tick)** = số dư theo tick giờ (có thể trễ ~1h) ·
**Unrealized (live)** = lời/lỗ nổi thời gian thực · **Gross exposure** = tổng size đang mở
(kèm ×tài khoản — cảnh báo vàng khi >2×) · **Day vs kill switch** = lỗ hôm nay / ngưỡng −5%.

**Bảng "Open positions":** **Entry/Mark** = giá vào/hiện tại · **Notional** = size lệnh
(cái trần $500 chặn) · **Stop** = cắt lỗ · **Max loss** = (đã chốt + phần còn lại) nếu chạm
stop, ≈ $0 khi đã về hòa vốn · **R now** = (đã chốt + lời nổi) ÷ rủi ro — so được thẳng với
cột R bảng closed · **TP**: `—` chưa chạm · `BE` đã chạm TP1 (stop về hòa vốn, chưa chốt gì)
· `TP2` đã chốt nửa · **Monitor** = guardian (✓ 15m thuận · ⚠ 15m ngược → tự đóng) ·
**Age** = tuổi lệnh kèm `(số nến/limit)` của time-stop.

**Bảng "P&L by day"** (bảng dễ nhất, xem mỗi ngày 1 lần là đủ — **ngày theo giờ Việt Nam GMT+7**):
- **Closed P&L** = lời/lỗ **ĐÃ CHỐT** trong ngày — chỉ tính các lệnh đã đóng xong, cộng
  đúng bằng bảng Recent closed. Đây là "tiền chắc".
- **Balance (end of day)** = cuối ngày trong tài khoản còn bao nhiêu. Lưu ý: Balance gồm cả
  lời/lỗ NỔI của lệnh đang mở, nên có thể nhích lệch so với cộng dồn Closed P&L — bình thường.
- 💡 Kỳ vọng đúng (từ backtest): trung bình +0.2–0.7%/ngày, **~nửa số ngày đỏ** — nhìn theo
  TUẦN, đừng buồn vì 1 ngày đỏ.
- (Riêng kill-switch −5%/ngày của bot vẫn reset theo 0h UTC = **7h sáng VN** — đó là múi
  giờ nội bộ của máy, không đổi.)

**Bảng "By close reason":** đếm lệnh theo lý do đóng — dùng để so live với backtest LIVE_SIM
(tỷ lệ REVERSAL_CLOSE phải tương đương).

---

## 📌 Tóm tắt 1 đoạn

> Bot đi **theo xu hướng** (chỉ trend mạnh, ADX≥35), vào khi giá **hồi nhịp**, mỗi lệnh
> **rủi ro 1%** + **trần $500**, luôn có **cắt lỗ**. Chạm +1R thì **dời stop về hòa vốn**,
> chạm +2R **chốt nửa**, **nửa còn lại chạy theo trend** (trailing). Một **guardian canh
> mỗi phút** ép cắt lỗ và **thoát sớm khi 15m đảo chiều**; lệnh "chết" quá **12 nến** bị
> dọn. Tối đa **4 lệnh** trên **45 coin**. Đang chạy **TIỀN THẬT size nhỏ** (từ 2026-06-10)
> để kiểm chứng. Lợi thế **còn mỏng** (PF walk-forward ~1.1) → **kiên nhẫn, đánh giá theo
> tuần, chưa tăng size** là quan trọng nhất. 🎯
