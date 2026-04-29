#!/bin/bash

# Kiểm tra xem pm2 có được cài đặt không
if ! command -v pm2 &> /dev/null
then
    echo "PM2 chưa được cài đặt. Đang cài đặt pm2..."
    npm install -g pm2
fi

echo "🚀 Đang khởi động Traffic Bot với PM2..."

# Dừng process cũ nếu có
pm2 stop traffic-bot 2>/dev/null || true
pm2 delete traffic-bot 2>/dev/null || true

# Khởi động bot
pm2 start src/bot.js --name "traffic-bot" --watch --ignore-watch="node_modules"

# Hiển thị trạng thái
pm2 status traffic-bot

echo "✅ Traffic Bot đã được khởi động thành công!"
echo "Sử dụng 'pm2 logs traffic-bot' để xem nhật ký."
echo "Sử dụng 'pm2 stop traffic-bot' để dừng bot."
