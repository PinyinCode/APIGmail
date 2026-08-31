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

// 4. Hàm quét email (Đã thêm kiểm tra trạng thái kết nối MongoDB)
async function checkEmailsViaApi() {
    // Kiểm tra nếu MongoDB chưa sẵn sàng (readyState != 1) thì bỏ qua lượt quét này
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

        // Quét email chưa đọc trong 24h qua có chứa từ khóa
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

            // Lưu vào MongoDB
            const newTx = new Transaction({
                msgId: msgId,
                message: subject,
                is_read: false
            });
            await newTx.save();
            console.log("Đã lưu email ngân hàng mới:", subject);

            // Bắn tin nhắn về Telegram
            await sendTelegramNotification(subject);

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

// API cho thiết bị khác gọi lấy thông tin
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng ${PORT}`));
