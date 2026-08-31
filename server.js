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

// Định nghĩa Schema lưu giao dịch
const transactionSchema = new mongoose.Schema({
    msgId: { type: String, unique: true },
    message: String,
    is_read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// 2. Cấu hình Google OAuth2 Client sử dụng thông tin bạn vừa lấy
const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// 3. Hàm quét email tự động qua Gmail API
async function checkEmailsViaApi() {
    try {
        // Tìm các email chưa đọc
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread'
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
            const msgId = msg.id;

            // Kiểm tra email đã lưu trong DB chưa
            const existing = await Transaction.findOne({ msgId: msgId });
            if (existing) continue;

            // Lấy nội dung chi tiết email
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msgId,
                format: 'full'
            });

            // Lấy tiêu đề email (Subject)
            const headers = detail.data.payload.headers;
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
            const subject = subjectHeader ? subjectHeader.value : 'Biến động số dư';

            // Lưu vào MongoDB
            const newTx = new Transaction({
                msgId: msgId,
                message: subject,
                is_read: false
            });
            await newTx.save();
            console.log("Đã lưu email mới qua Gmail API:", subject);

            // Đánh dấu email là Đã đọc trên Gmail (gỡ nhãn UNREAD)
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

// Chạy quét email mỗi 30 giây
setInterval(checkEmailsViaApi, 30000);

// 4. API cho phần cứng (ESP32) gọi sang lấy nội dung giao dịch
app.get('/api/check-bank-audio', async (req, res) => {
    try {
        const pendingTx = await Transaction.findOne({ is_read: false }).sort({ created_at: 1 });

        if (pendingTx) {
            res.json({
                has_notification: true,
                message: pendingTx.message,
                audio_url: ""
            });

            pendingTx.is_read = true;
            await pendingTx.save();
        } else {
            res.json({ has_notification: false });
        }
    } catch (err) {
        res.status(500).json({ has_notification: false, error: "Server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server Gmail API đang chạy tại cổng ${PORT}`);
});
