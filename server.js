const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// 1. Kết nối MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Đã kết nối MongoDB!'))
    .catch(err => console.error('Lỗi kết nối MongoDB:', err));

const transactionSchema = new mongoose.Schema({
    msgId: { type: String, unique: true },
    message: String,
    is_read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// 2. Cấu hình Google OAuth2 Client
const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// 3. Hàm gửi tin nhắn qua Telegram Bot
async function sendTelegramNotification(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) return;

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `🚨 **BIẾN ĐỘNG SỐ DƯ** 🚨\n\n${text}`,
                parse_mode: 'Markdown'
            })
        });
    } catch (err) {
        console.error("Lỗi gửi Telegram:", err);
    }
}

// 4. Hàm quét email tự động và nhận diện ngân hàng
async function checkEmailsViaApi() {
    if (mongoose.connection.readyState !== 1) {
        console.log("Đang chờ kết nối MongoDB...");
        return;
    }

    try {
        // Tự động xóa dữ liệu cũ hơn 24 giờ
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const deleteResult = await Transaction.deleteMany({ created_at: { $lt: twentyFourHoursAgo } });
        if (deleteResult.deletedCount > 0) {
            console.log(`Đã dọn dẹp ${deleteResult.deletedCount} giao dịch cũ trên MongoDB.`);
        }

        // Quét email chưa đọc trong 24h qua chứa từ khóa MB hoặc VCB
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread newer_than:1d ("MB eBanking" OR "VCB Digibank")'
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            const msgId = msg.id;

            const existing = await Transaction.findOne({ msgId: msgId });
            if (existing) continue;

            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msgId,
                format: 'full'
            });

            const headers = detail.data.payload.headers;
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
            const subject = subjectHeader ? subjectHeader.value : 'Biến động số dư ngân hàng';

            // Nhận diện ngân hàng để làm rõ nội dung
            let bankName = "Ngân hàng";
            const lowerSubject = subject.toLowerCase();
            if (lowerSubject.includes('mb ebanking') || lowerSubject.includes('mb')) {
                bankName = "MBBank";
            } else if (lowerSubject.includes('vcb digibank') || lowerSubject.includes('vcb')) {
                bankName = "VCB";
            }

            // Gộp tên ngân hàng và tiêu đề lại cho rõ ràng
            const formattedMessage = `[${bankName}] ${subject}`;

            // Lưu vào MongoDB
            const newTx = new Transaction({
                msgId: msgId,
                message: formattedMessage,
                is_read: false
            });
            await newTx.save();
            console.log("Đã lưu email ngân hàng mới:", formattedMessage);

            // Bắn tin nhắn về Telegram
            await sendTelegramNotification(formattedMessage);

            // Đánh dấu email là Đã đọc trên Gmail
            await gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: {
                    ids: [msgId],
                    removeLabelIds: ['UNREAD']
                }
            });
        }
    } catch (err) {
        console.error("Lỗi quét Gmail API:", err);
    }
}

// Quét định kỳ mỗi 30 giây
setInterval(checkEmailsViaApi, 30000);

// 5. API chính cho thiết bị lấy thông tin giao dịch
app.get('/api/check-bank-audio', async (req, res) => {
    try {
        const pendingTx = await Transaction.findOne({ is_read: false }).sort({ created_at: 1 });
        if (pendingTx) {
            res.json({ has_notification: true, message: pendingTx.message, audio_url: "" });
            pendingTx.is_read = true;
            await pendingTx.save();
        } else {
            res.json({ has_notification: false });
        }
    } catch (err) {
        res.status(500).json({ has_notification: false });
    }
});

// 6. API dành riêng cho UptimeRobot ghé thăm (Giữ server luôn thức 24/7)
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", message: "Server is alive!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng ${PORT}`));
