# Hướng dẫn: Chiến lược Funding Carry (Cross-Sectional Long/Short)

> Tài liệu này giải thích chiến lược **funding carry** mới — khác hoàn toàn với bot
> `trend-pullback` cũ. Đọc xong bạn sẽ hiểu: nó hoạt động ra sao, tiền lời đến từ đâu,
> khi nào ăn / khi nào rủi ro, và cách chạy test/live.

---

## 1. Tóm tắt 1 câu

**Mỗi ngày, bot SHORT các coin đang "trả phí funding cao nhất" và LONG các coin "trả phí thấp/âm nhất", với số tiền long = short (trung hòa thị trường), để THU phí funding — không phải để đoán giá lên/xuống.**

---

## 2. Funding rate là gì? (nền tảng phải hiểu trước)

Trên hợp đồng **perpetual futures** (perp), cứ **mỗi 8 giờ** (00:00, 08:00, 16:00 UTC) bên long và bên short **trả tiền cho nhau**, gọi là **funding**:

- Funding **dương** (`+`) → **long TRẢ cho short**.
- Funding **âm** (`−`) → **short TRẢ cho long**.

Ví dụ: BNB có funding `+0.01%/8h`. Nếu bạn:
- **Long** 1000 USDT BNB → cứ 8h bạn **mất** 0.01% × 1000 = **−0.10 USDT**.
- **Short** 1000 USDT BNB → cứ 8h bạn **nhận** **+0.10 USDT** (chỉ nhờ giữ lệnh, không cần giá chạy).

👉 **Ý tưởng then chốt:** nếu bạn SHORT một coin có funding dương cao, bạn được **trả tiền đều đặn** chỉ để giữ lệnh đó. Đó là khoản "tiền cho thuê" ta muốn thu.

---

## 3. Ý tưởng cốt lõi: thu funding một cách TRUNG HÒA

Vấn đề: nếu chỉ short coin funding cao, lỡ giá nó tăng mạnh thì lỗ giá > tiền funding nhận được.

Giải pháp: **đồng thời LONG các coin funding thấp/âm** (cũng được nhận funding), với **tổng tiền long = tổng tiền short**. Khi đó:

- Thị trường tăng → short lỗ giá, nhưng long lời giá → **gần như bù nhau**.
- Thị trường giảm → long lỗ giá, nhưng short lời giá → **gần như bù nhau**.
- Còn lại: **khoản funding bạn thu được từ cả hai phía** ✅

Đây gọi là **market-neutral** (trung hòa thị trường): bạn **không đặt cược giá lên hay xuống**, bạn chỉ thu "tiền thuê" funding. Giống chủ nhà thu tiền thuê — không quan tâm giá nhà lên xuống.

---

## 3b. "Nếu long giảm VÀ short tăng thì cả 10 lệnh cùng lỗ?" (câu hỏi hay gây nhầm)

Bình thường **KHÔNG**, vì **các coin crypto chạy CÙNG HƯỚNG**: khi BTC lên thì gần như mọi coin lên, khi BTC xuống thì mọi coin xuống. Nên không có chuyện "long giảm trong khi short tăng" một cách thường xuyên.

Khi cả 10 coin **cùng chạy một hướng** → long và short **luôn ngược dấu nhau** → bù nhau:

| Kịch bản | 5 LONG | 5 SHORT | Kết quả |
|---|---|---|---|
| Thị trường **TĂNG** (mọi coin lên) | +lời | −lỗ (short mà giá lên) | **Bù nhau ≈ 0** ✅ |
| Thị trường **GIẢM** (mọi coin xuống) | −lỗ | +lời (short mà giá xuống) | **Bù nhau ≈ 0** ✅ |

👉 Dù lên hay xuống, **một bên lời thì bên kia lỗ** → triệt tiêu. Bạn **không mất tiền vì cả thị trường lên/xuống**. Còn lại chỉ là **funding thu được.** Đó là "trung hòa".

**Cả 2 cùng lỗ** chỉ xảy ra khi 5 coin LONG chạy *thua* 5 coin SHORT (giá **tách nhau / phân hóa**) — nhưng việc đó hiếm hơn và được cân lại bởi kịch bản ngược (cả 2 cùng lời):

| Kịch bản (phân hóa) | 5 LONG | 5 SHORT | Kết quả |
|---|---|---|---|
| Long giảm + Short tăng | −lỗ | −lỗ | **CẢ 2 LỖ** ⚠️ |
| Long tăng + Short giảm | +lời | +lời | **CẢ 2 LỜI** 🎁 |

**Tóm lại:** bạn **đổi rủi ro lớn** (đoán hướng thị trường) lấy **rủi ro nhỏ hơn** (coin tách nhau). Trung bình thì phân hóa triệt tiêu, để **funding là phần lời ròng**. Không miễn phí, nhưng an toàn hơn đoán hướng nhiều. (Cú "cả 2 lỗ lớn" xảy ra khi **sập mạnh** → đó là lý do có **kill-switch**.)

---

## 4. "Vậy nó CÓ còn long/short không?" — Câu trả lời

**CÓ. Nó mở cả lệnh LONG và lệnh SHORT cùng lúc** — ví dụ 5 lệnh long + 5 lệnh short cùng một thời điểm.

Nhưng **cách CHỌN long/short khác hẳn bot cũ:**

| | Bot trend cũ (`trend-pullback`) | Funding carry (cái mới) |
|---|---|---|
| Nhìn vào | **Giá** từng coin | **Funding rate** từng coin |
| Long khi | Coin đang trend tăng | Coin có funding **thấp/âm** nhất |
| Short khi | Coin đang trend giảm | Coin có funding **cao** nhất |
| Đặt cược | **Hướng giá** (đoán lên/xuống) | **KHÔNG đoán giá** — thu funding |
| Cân bằng | Có thể toàn long hoặc toàn short | Luôn **5 long + 5 short** (trung hòa) |
| Lời từ | Giá chạy đúng hướng | **Phí funding** (+ một ít giá) |

Nói cách khác: vẫn là long/short, nhưng **lý do** long/short hoàn toàn khác — và quan trọng là **cân bằng 50/50** để không phụ thuộc giá.

---

## 5. Cơ chế chi tiết (cách bot làm mỗi ngày)

1. **Universe**: 31 coin major thanh khoản (lấy từ `SYMBOLS` trong `.env`).
2. **Tính tín hiệu**: với mỗi coin, lấy **funding trung bình 7 ngày gần nhất** (`L=168` giờ).
3. **Xếp hạng** 31 coin theo funding.
4. **Mở book**:
   - **LONG** 5 coin (`K=5`) có funding **thấp nhất** (âm → bạn nhận funding khi long).
   - **SHORT** 5 coin có funding **cao nhất** (dương → bạn nhận funding khi short).
   - Mỗi lệnh **cùng một số tiền nhỏ** (vd 12 USDT/lệnh → tổng ~120 USDT, 60 long + 60 short).
5. **Giữ 24 giờ** (`H=24`), rồi **rebalance**: xếp hạng lại. Coin nào vẫn đúng phía thì **giữ nguyên**; coin nào rớt khỏi top thì **đóng**; coin mới vào thì **mở**. (Chỉ giao dịch phần **thay đổi** → tiết kiệm phí.)

### Ví dụ số cụ thể

Giả sử hôm nay funding 7 ngày như sau:

```
Funding cao nhất (SHORT — nhận tiền):  BNB +0.015%, LINK +0.012%, BTC +0.010%, UNI +0.009%, XMR +0.008%
Funding thấp nhất (LONG — nhận tiền):  TRX −0.060%, ZEC −0.031%, FIL −0.015%, WLD −0.015%, BCH −0.012%
```

Bot sẽ: **SHORT** BNB/LINK/BTC/UNI/XMR và **LONG** TRX/ZEC/FIL/WLD/BCH.

→ Mỗi 8h, bạn **nhận funding từ cả 10 lệnh**. Giá 10 coin chạy lên xuống thì long/short bù nhau (gần như). Lời ròng ≈ **tổng funding thu được − phí giao dịch**.

---

## 5b. Lệnh có đóng không? Khi nào đóng? (câu hỏi hay gây nhầm)

**KHÔNG phải mở mãi không đóng.** Nhưng cũng **KHÔNG có chốt lời/cắt lỗ (TP/SL)** như bot cũ. Cơ chế là **xoay vòng theo bảng xếp hạng funding**:

Mỗi 24h rebalance, với từng coin:
1. **Vẫn trong top/bottom-5** → **GIỮ NGUYÊN** lệnh (không đụng → không tốn phí).
2. **Rớt khỏi top/bottom-5** (funding không còn cao/thấp) → **ĐÓNG** lệnh đó.
3. **Mới lọt vào top/bottom-5** → **MỞ** lệnh mới.

> Ví dụ thật: hôm nay LONG BCH; ngày mai BCH rớt hạng, SOL lọt vào → bot **đóng BCH, mở SOL**, **8 lệnh còn lại giữ nguyên**. Chỉ giao dịch phần *thay đổi*.

**Quan trọng nhất:** funding được **tự cộng vào ví mỗi 8h** khi lệnh đang mở — bạn **KHÔNG cần đóng lệnh** để nhận funding. Cứ giữ là tiền chảy vào. (Chỉ lời/lỗ *giá* mới chốt khi đóng.) → Một lệnh có thể mở **1 ngày hoặc nhiều ngày**, tùy coin còn "trả funding ngon" không.

**Đóng HẾT khi:** bạn chạy `npm run flatten`, hoặc **kill-switch** kích (lỗ ngày ≥ 5% → tự đóng hết + dừng).

---

## 6. Lời/lỗ đến từ đâu?

| Thành phần | Mô tả |
|---|---|
| ✅ **Funding** | Nguồn lời CHÍNH — thu từ cả 10 lệnh mỗi 8h |
| ➖ **Giá (price)** | Long/short bù nhau → đóng góp nhỏ (nhiễu), không phải nguồn lời |
| ❌ **Phí** | Phí taker (~0.04%) + slippage mỗi lần rebalance |
| ❌ **Funding ngược** | Nếu một coin đột ngột đảo funding, có thể phải trả thay vì nhận |

Trong backtest, cột `fund` cho thấy funding đóng góp **+10–20% mỗi đoạn** — tức lời chủ yếu từ funding, đúng thiết kế.

---

## 7. Khi nào ĂN / khi nào RỦI RO (use case)

### ✅ Hoạt động tốt khi:
- Thị trường **bình thường/đi ngang**, funding ổn định và phân hóa giữa các coin.
- Đây là tình huống **đa số thời gian** → lý do chiến lược này qua được backtest đa-split.

### ⚠️ Rủi ro chính — "nhặt xu trước xe lu":
- Một cú **sập mạnh / deleveraging** (vd crash 2022): tương quan các coin tăng vọt, book "trung hòa" **không còn trung hòa**, giá có thể lỗ một cú lớn cùng lúc funding lật.
- Backtest 18 tháng của ta **KHÔNG có** cú sập kiểu đó → drawdown thật **có thể tệ hơn** backtest.
- 👉 Đây là lý do có **kill-switch** (xem mục 10): nếu lỗ trong ngày ≥ 5% → tự đóng hết + dừng.

### 💰 Kỳ vọng thực tế (quan trọng):
- Funding carry cho **~10–30%/năm** trong điều kiện tốt, và **giảm dần** khi nhiều người cùng làm.
- **Trên vốn <$5k → khoảng $3–4/ngày, KHÔNG phải $30/ngày.** Muốn $30/ngày cần ~$50k+ vốn.
- Đây là chiến lược để **học + lãi kép chậm + validate execution**, không phải nguồn thu nhập nhanh.

---

## 8. Hai "bot" độc lập trong cùng tài khoản

| | Lệnh chạy | DB riêng | Chiến lược |
|---|---|---|---|
| Bot trend cũ | `npm run testnet` / `npm run live` | `testnet.sqlite` / `live.sqlite` | trend-pullback (đoán hướng giá) |
| **Funding carry** | `npm run xsmom-testnet` / `npm run xsmom-live` | `xsmom-testnet.sqlite` / `xsmom-live.sqlite` | funding carry (trung hòa) |

> ⚠️ Nếu chạy CẢ HAI trên cùng tài khoản, vị thế của bot này sẽ là "orphan" với bot kia.
> Funding carry có **orphan-guard**: nó **cảnh báo** (không tự đóng) các vị thế ngoài universe của nó.
> Để đơn giản, nên chạy **một chiến lược một thời điểm** trên mỗi tài khoản.

---

## 9. CÁCH CHẠY — Nghiên cứu & Forward-test (không tiền thật)

### A. Backtest (replay quá khứ)
```bash
cd binance_bot
# funding carry, walk-forward, slippage 5bps, trên universe trong .env
SIGNAL=funding TRAIN_END=2025-12-01 SLIPPAGE_BPS=5 npm run xsmom-backtest
```
Đổi `SIGNAL=` thành `momentum` / `reversal` / `combo` để so sánh. `✅both` = lời cả train lẫn test.

### B. Paper forward-test (tính như thật nhưng KHÔNG đặt lệnh) — **khuyến nghị chạy đầu tiên**
```bash
npm run xsmom-paper      # 1 lần rebalance (chỉ chạy khi đủ 24h); gửi Telegram
npm run xsmom-status     # xem track record tích lũy (equity, Sharpe, funding...)
```
Cho chạy tự động mỗi giờ bằng **cron** (rebalance mỗi 24h):
```
0 * * * * cd /duong/dan/binance_bot && /usr/local/bin/npm run xsmom-paper >> data/xsmom-paper.log 2>&1
```

---

## 10. CÁCH CHẠY — Đặt lệnh thật

### C. Testnet (demo, RỦI RO = 0) — **bắt buộc chạy trước khi live**
```bash
npm run xsmom-testnet    # đặt lệnh trên tài khoản demo (tiền ảo)
npm run account          # xem vị thế demo
npm run flatten          # đóng sạch demo khi muốn dừng
```
Cho chạy vài ngày qua cron để kiểm tra **toàn bộ chu kỳ rebalance** (đóng/mở khi tín hiệu đổi):
```
0 * * * * cd /duong/dan/binance_bot && /usr/local/bin/npm run xsmom-testnet >> data/xsmom-exec.log 2>&1
```

### D. Live (TIỀN THẬT) — chỉ sau khi testnet sạch vài ngày
```bash
# Cần CẢ HAI khóa, nếu thiếu bot từ chối chạy:
ALLOW_LIVE=true CONFIRM_LIVE=true XSMOM_NOTIONAL=6 npm run xsmom-live
```
- `XSMOM_NOTIONAL=6` → 6 USDT/lệnh × 10 = ~60 USDT tổng (size nhỏ nhất để validate, không phải kiếm lời).
- Đóng sạch live: `ALLOW_LIVE=true npm run flatten:live`

---

## 11. Các tham số (env) có thể chỉnh

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `XSMOM_L` | 168 | Số giờ lấy trung bình funding (168 = 7 ngày) |
| `XSMOM_H` | 24 | Chu kỳ rebalance (giờ) |
| `XSMOM_K` | 5 | Số lệnh mỗi phía (5 long + 5 short) |
| `XSMOM_NOTIONAL` | 12 | USDT mỗi lệnh (live nên để nhỏ: 5–6) |
| `XSMOM_LEV` | 3 | Đòn bẩy mỗi coin |
| `MAX_DAILY_LOSS_PCT` | 0.05 | Kill-switch: lỗ trong ngày ≥ 5% → đóng hết + dừng |
| `XSMOM_RESET=true` | — | Bật lại sau khi kill-switch đã dừng |
| `SIGNAL` | funding | `funding` / `momentum` / `reversal` / `combo` |

> Config tốt nhất qua backtest: **`XSMOM_L=168 XSMOM_H=24 XSMOM_K=5`** (đã là mặc định).

---

## 12. An toàn (đã tích hợp sẵn)

- **Cadence guard**: chỉ rebalance mỗi `H` giờ → chạy cron mỗi giờ an toàn.
- **Kill-switch**: lỗ trong ngày ≥ `MAX_DAILY_LOSS_PCT` → **flatten + halt** + báo Telegram; dừng tới khi `XSMOM_RESET=true`.
- **Orphan-guard**: cảnh báo (không tự đóng) vị thế ngoài universe.
- **Gate live 2 khóa**: cần `ALLOW_LIVE=true` **và** `CONFIRM_LIVE=true`.
- **Reconcile delta**: chỉ giao dịch phần thay đổi, không flatten-reopen toàn bộ → ít phí.

---

## 13. Quy trình khuyến nghị (theo thứ tự)

1. **Backtest** → hiểu config, xác nhận `✅both`.
2. **Paper** (cron) **vài tuần** → gom dữ liệu OOS *tương lai* thật, đặc biệt quan sát một cú giảm mạnh.
3. **Testnet** (cron) **vài ngày** → validate execution (đóng/mở/reconcile đúng).
4. **Live size nhỏ nhất** (`XSMOM_NOTIONAL=6`) → validate tiền thật + gom dữ liệu, **không kỳ vọng lời**.
5. Chỉ tăng size khi có **bằng chứng forward dương qua một đợt biến động**.

---

## ⚠️ Nhắc lại điều quan trọng nhất

- Đây là **lead tốt nhất** tìm được, nhưng vẫn là **edge mỏng + có tail risk**, chưa được kiểm chứng qua một cú crash thật.
- Trên **<$5k**, mục tiêu thực tế là **học + không thua + lãi kép chậm**, KHÔNG phải $30/ngày.
- **Nguyên tắc vàng:** không gì lên tiền thật trước khi qua paper + testnet, và luôn giữ size cực nhỏ lúc đầu.
