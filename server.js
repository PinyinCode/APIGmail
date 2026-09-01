const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai'); // Thêm thư viện Google Gen AI

const app = express();
app.use(express.json());

// Khởi tạo Gemini AI (yêu cầu biến môi trường GEMINI_API_KEY)
const ai = new GoogleGenAI();

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

// 2. Cấu hình Google OAuth2 Client (Gmail)
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

// 4. Hàm trích xuất nội dung email (Hỗ trợ lấy body thô của email)
function getEmailBody(payload) {
    let body = '';
    if (payload.body && payload.body.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                break;
            } else if (part.parts) {
                body = getEmailBody(part);
                if (body) break;
            }
        }
    }
    return body;
}

// 5. Hàm dùng Gemini AI để phân tích email thay vì dùng từ khóa cứng
async function analyzeEmailWithAI(subject, snippet, body) {
    try {
        const prompt = `
Bạn là một trợ lý tài chính thông minh. Hãy phân tích email dưới đây xem đây có phải là email thông báo biến động số dư (tiền đến, tiền đi, thanh toán, chuyển khoản) từ một ngân hàng hoặc ví điện tử hay không.

Tiêu đề email: "${subject}"
Đoạn trích/Nội dung email: "${snippet} \n ${body.substring(0, 500)}"

Yêu cầu trả về dạng JSON thuần túy (không chứa Markdown như \`\`\`json):
{
  "isBankTransaction": true hoặc false,
  "bankName": "Tên ngân hàng hoặc ví điện tử (VD: MBBank, VCB, Techcombank, Momo...)",
  "summary": "Tóm tắt ngắn gọn biến động (VD: Biến động số dư: +500,000 VND từ Nguyễn Văn A)"
}
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        let textResponse = response.text.trim();
        // Làm sạch nếu model lỡ trả về định dạng markdown block
        textResponse = textResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');

        return JSON.parse(textResponse);
    } catch (err) {
        console.error("Lỗi phân tích Gemini AI:", err);
        return { isBankTransaction: false };
    }
}

// 6. Hàm quét email tự động sử dụng AI
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

        // Quét các email chưa đọc trong 24h qua có chứa các từ khóa chung chung về tài chính
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread newer_than:1d ("giao dịch" OR "số dư" OR "tài khoản" OR "biến động" OR "thanh toán" OR "VND" OR "VND+")'
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
            const subject = subjectHeader ? subjectHeader.value : '';
            const snippet = detail.data.snippet || '';
            const body = getEmailBody(detail.data.payload);

            // Gọi Gemini AI để phân tích nội dung email
            const aiAnalysis = await analyzeEmailWithAI(subject, snippet, body);

            if (aiAnalysis && aiAnalysis.isBankTransaction) {
                const bankName = aiAnalysis.bankName || "Ngân hàng";
                const formattedMessage = `[${bankName}] ${aiAnalysis.summary || subject}`;

                // Lưu vào MongoDB
                const newTx = new Transaction({
                    msgId: msgId,
                    message: formattedMessage,
                    is_read: false
                });
                await newTx.save();
                console.log("Đã lưu giao dịch ngân hàng mới bằng AI:", formattedMessage);

                // Bắn tin nhắn về Telegram
                await sendTelegramNotification(formattedMessage);
            }

            // Đánh dấu email là Đã đọc trên Gmail (dù có phải ngân hàng hay không để tránh quét lại nhiều lần)
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

// 7. API chính cho thiết bị lấy thông tin giao dịch
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

// 8. API dành riêng cho UptimeRobot ghé thăm (Giữ server luôn thức 24/7)
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", message: "Server is alive!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng ${PORT}`));
