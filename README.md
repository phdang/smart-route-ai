# 🗺️ Smart Route AI — Traffic Bot (Mapbox + Vietmap v4 Edition)

Discord bot giao thông thế hệ mới: Tra cứu tuyến đường thực tế, phân tích kẹt xe thời gian thực, **kiểm tra biển cấm (Vietmap)**, tính phí BOT chính xác, và tự động áp dụng **AI Game Theory (DeepSeek)** để chọn lộ trình tối ưu.

---

## ⌨️ Hệ thống Lệnh Hiện đại

Bot hỗ trợ song song **Slash Commands** hiện đại và **NLP Command Parsing** (cú pháp tự do).

### 1. Slash Commands (Khuyên dùng)
Gõ `/` để xem danh sách lệnh với tính năng **Autocomplete (Gợi ý địa danh)** thời gian thực:
- `/traffic location`: Xem tình hình giao thông tại một địa điểm cụ thể.
- `/route origin destination`: So sánh các tuyến đường và tính phí BOT.
- `/check origin destination`: Phân tích chuyên sâu lộ trình với AI và dữ liệu biển cấm.

> ⚡ **Tối ưu UX:** Hệ thống Autocomplete sử dụng **Vietmap Search v4** với cơ chế tự động ẩn menu sau khi chọn, giúp bạn chỉ cần chọn địa điểm và nhấn Enter là có kết quả ngay, không bị nháy UI.

### 2. Cú pháp Tự do (NLP Supported)
Bạn có thể chat trực tiếp vào kênh để bot tự hiểu ý định:
- `!route đi từ A tới B`
- `!check kẹt xe từ X qua Y`
- `!traffic ở Ngã tư Bảy Hiền`

---

## 🌟 Tính năng Đột phá

### 1. 🧭 Tìm đường & Phí BOT (Vietmap v4)
- **Search Engine v4:** Nâng cấp lên **Vietmap Search/Geocode v4** mang lại độ chính xác cao nhất cho các địa chỉ tại Việt Nam.
- **Phí BOT/Phà:** Truy vấn dữ liệu thực từ Vietmap API. Tự động nhận diện trạm Vào/Ra để tính tổng tiền chính xác.
- **Sampling Thông minh:** Lấy mẫu lộ trình (150-180 điểm) để tối ưu hóa việc nhận diện trạm BOT mà không làm quá tải API.

### 2. 🔍 AI Game Theory & Biển cấm
- **DeepSeek V4 Flash:** Phân tích lộ trình dựa trên chiến lược **Minimax Regret** khi có kẹt xe nặng.
- **Dữ liệu Biển cấm:** Đối soát lộ trình với cơ sở dữ liệu biển cấm ô tô, cấm giờ của Vietmap để đưa ra cảnh báo vi phạm.

### 📍 3. Giám sát Giao thông (CI Index)
- **Congestion Index (CI):** Tính toán độ trễ dựa trên thời gian di chuyển thực tế so với bình thường.
- **Trạng thái trực quan:** 🟢 Thông thoáng, 🟡 Hơi đông, 🟠 Kẹt trung bình, 🔴 Kẹt nặng.

---

## 🧠 Logic & Hiệu năng

### 🚀 Tối ưu hóa Location Resolution
- **Packed Values:** Autocomplete trả về giá trị dạng `vm:lat,lng|id|label`. Điều này giúp bot lấy ngay tọa độ mà không cần gọi thêm API "Place", giảm độ trễ tối đa (~200ms nhanh hơn).
- **Flicker-free UI:** Ngăn chặn việc menu gợi ý hiện lại sau khi người dùng đã chọn địa điểm bằng cách nhận diện prefix kỹ thuật.
- **Safe Truncation:** Đảm bảo tất cả dữ liệu (Label, Value) luôn tuân thủ giới hạn 100 ký tự của Discord để tránh lỗi API.

### ⚡ Hệ thống Cache & Messaging
- **Redis Cache v2:** Lưu trữ kết quả định tuyến và giao thông để phản hồi tức thì.
- **Auto-split Message:** Tự động chia nhỏ tin nhắn dài (danh sách BOT, 40 đoạn đường) để không vượt quá giới hạn 2000 ký tự của Discord.

---

## 🏗️ Cấu trúc Mã nguồn

```text
src/
├── bot.js          # Entry point: Xử lý Interaction, Autocomplete, Slash Commands
├── routeService.js # Core logic: Vietmap Search/Place v4, Directions, Geocoding
├── llmService.js   # AI Engine: Game Theory & NLP Command Parsing
├── engine.js       # Math Engine: Tính toán CI, Scoring, Normalization
├── register.js     # Slash Command Registration: Định nghĩa các options & autocomplete
├── cache.js        # Data Layer: Redis Persistence
└── formatter.js    # UI Layer: Format tin nhắn, hiển thị label sạch (Clean Labels)
```

---

## 🛠️ Cài đặt nhanh

### 1. Biến môi trường (`.env`)
```env
MAPBOX_ACCESS_TOKEN=pk.eyJ1Ijo...
VIETMAP_API_KEY=...
DISCORD_TOKEN=...
ALLOWED_USER_ID=...
ALLOWED_CHANNEL_ID=...
```

### 2. Khởi động
```bash
npm install
node src/register.js # Đăng ký Slash Commands với Discord
pm2 start src/bot.js --name traffic-bot
```

---

*Smart Route AI — Phát triển bởi phdang. Sử dụng Mapbox & Vietmap APIs.*
