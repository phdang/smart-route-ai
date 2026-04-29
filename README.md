# 🗺️ Smart Route AI — Traffic Bot (Mapbox + AI Edition)

Discord bot giao thông thế hệ mới: Tra cứu tuyến đường thực tế, phân tích kẹt xe thời gian thực, **kiểm tra biển cấm (Vietmap)**, tính phí BOT chính xác, và tự động áp dụng **AI Game Theory (DeepSeek)** để chọn lộ trình tối ưu.

---

## ⌨️ Lệnh Discord linh hoạt (NLP Supported)

Bot đã hỗ trợ **Xử lý ngôn ngữ tự nhiên (NLP)**. Bạn có thể dùng cú pháp chuẩn hoặc nhập văn bản tự do.

| Loại lệnh | Cú pháp chuẩn | Cú pháp tự do (AI hiểu) |
| :--- | :--- | :--- |
| **So sánh đường** | `!route A → B` | `!route đi từ A tới B`, `!route A qua B` |
| **Check kẹt xe** | `!check A → B` | `!check từ A đến B`, `!check kẹt xe A qua B` |
| **Xem khu vực** | `!traffic A` | `!traffic ở A`, `!traffic tình hình A` |
| **Trợ giúp** | `!help` | |

> 🤖 **Thông minh:** Khi bạn dùng cú pháp tự do, bot sẽ thả biểu tượng 🤖 để thông báo đang dùng AI để hiểu câu lệnh của bạn.

---

## 🌟 Tính năng đột phá

### 1. 🧭 `!route` — So sánh lộ trình đa phương thức
- Phân tích song song tuyến mặc định và tuyến né cao tốc.
- Hiển thị: ETA thực tế, Khoảng cách, Congestion Index (CI).
- **Phí BOT/Phà (Vietmap API):** Truy vấn dữ liệu thực từ Vietmap Route-Tolls API v1.1.
    - **Chính xác:** Lấy danh sách trạm BOT, địa chỉ và giá vé cụ thể cho từng loại xe (mặc định xe con `vehicle=1`).
    - **Minh bạch:** Hiển thị chi tiết từng trạm (Vào/Ra) trên từng dòng riêng biệt.

### 2. 🔍 `!check` — AI Game Theory & Phân tích lộ trình chi tiết
- **Lộ trình thay thế:** Lấy tối đa 4 lộ trình từ Mapbox Driving-Traffic.
- **Xếp hạng Multi-factor:** Chuẩn hóa điểm số dựa trên Thời gian (70%), Kẹt xe (20%), Chi phí (10%).
- **Kiểm tra quy định (Vietmap v3):** Đối soát lộ trình Mapbox với dữ liệu biển cấm ô tô/cấm giờ của Vietmap để cảnh báo vi phạm.
- **Chi tiết lộ trình:** Hiển thị lên đến **40 đoạn đường chính** dài nhất trên tuyến để người dùng nắm rõ lộ trình.
- **DeepSeek V4 Flash:** Tự động kích hoạt khi tuyến chính kẹt nặng (CI ≥ 1.5). Áp dụng chiến lược **Minimax Regret** để chọn lộ trình tối ưu nhất.

### 3. 📍 `!traffic` — Giám sát khu vực (Proximity Geocoding)
- Báo cáo chỉ số kẹt xe (CI) và nhãn trạng thái trực quan (🟢🟡🟠🔴).
- **Proximity Bias:** Ưu tiên kết quả địa điểm tại khu vực lân cận để tăng độ chính xác khi tìm kiếm.

---

## 🧠 Logic xử lý dữ liệu chi tiết

### 💰 Hệ thống tính phí BOT (Vietmap Integration)
- **Sampling Tọa độ:** Tự động lấy mẫu lộ trình (sampling) tối đa **150 điểm** để gửi lên Vietmap API. Việc này giúp tránh lỗi `413 Request Entity Too Large` hoặc `400 Bad Request` khi lộ trình quá dài mà vẫn đảm bảo độ chính xác khi nhận diện trạm BOT.
- **Xử lý Entry/Exit:** Nhận diện các cặp trạm Vào (0đ) và Ra (có phí) để tính tổng chi phí `totalCost` chính xác nhất.
- **Dữ liệu minh bạch:** Mỗi trạm BOT được trình bày kèm biểu tượng `🎫`, tên trạm, địa chỉ và giá tiền cụ thể.

### 🛡️ Kiểm tra biển cấm & Quy định
- Sử dụng **Vietmap Route v3 API** để kiểm tra các hạn chế về biển cấm ô tô, cấm theo giờ hoặc các quy định đặc thù khác trên lộ trình chính.

### 📨 Cơ chế gửi tin nhắn thông minh
- **Auto-split Message:** Tự động chia nhỏ phản hồi nếu độ dài vượt quá giới hạn 2000 ký tự của Discord (giới hạn mỗi phần ~1800 ký tự), đảm bảo thông tin chi tiết (lộ trình 40 đoạn + danh sách BOT dài) luôn được gửi đầy đủ.

### ⚡ Hệ thống Cache v2
- Sử dụng **Redis** với Key Versioning (`v2`) để đảm bảo dữ liệu luôn mới nhất, tránh sử dụng lại các kết quả cũ khi logic tính toán hoặc cấu trúc dữ liệu thay đổi.

---

## 🧠 Công thức & Thuật toán

### Congestion Index (CI)
```
CI = duration_with_traffic / duration_typical
```
| CI | Trạng thái | Ý nghĩa |
|:---|:-----------|:---|
| < 1.15 | 🟢 Thông thoáng | Di chuyển nhanh hơn hoặc bằng bình thường |
| 1.15 – 1.4 | 🟡 Hơi đông | Chậm hơn khoảng 15-40% |
| 1.4 – 1.7 | 🟠 Kẹt trung bình | Thời gian đi tăng gần gấp đôi |
| ≥ 1.7 | 🔴 Kẹt nặng | Kẹt xe nghiêm trọng, nên đổi đường |

### Multi-factor Scoring (Xếp hạng lộ trình)
```
Score = 0.70 × norm(ETA) + 0.20 × norm(CI) + 0.10 × norm(Cost)
```

---

## 🏗️ Kiến trúc Hệ thống

```text
src/
├── bot.js          # Entry point: Xử lý Discord, Smart Command, Message Splitting
├── llmService.js   # AI Engine: Game Theory & NLP Command Parsing (DeepSeek)
├── routeService.js # Core logic: Directions, Vietmap Tolls/Regulation v3, Sampling
├── engine.js       # Math Engine: Tính toán CI, Scoring, Normalization
├── cache.js        # Data Layer: Redis (Key v2)
├── parser.js       # Regex Engine: Xử lý nhanh các câu lệnh chuẩn
└── formatter.js    # UI Layer: Định dạng hiển thị chi tiết (40 segments, BOT list)
```

---

## 🛠️ Cài đặt nhanh

### 1. Biến môi trường (`.env`)
```env
MAPBOX_ACCESS_TOKEN=pk.eyJ1Ijo...
DISCORD_TOKEN=...
ALLOWED_USER_ID=...
ALLOWED_CHANNEL_ID=...
OPENROUTER_API_KEY=...
VIETMAP_API_KEY=...
REDIS_URL=redis://localhost:6379
```

### 2. Khởi động với PM2
```bash
# Cài đặt và khởi động
npm install
pm2 start src/bot.js --name traffic-bot

# Xem trạng thái & log
pm2 status
pm2 logs traffic-bot
```

---

*Smart Route AI — Phát triển bởi phdang. Sử dụng Mapbox & Vietmap APIs.*
