const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

// Khởi tạo Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Kết nối MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Đã kết nối MongoDB thành công!'))
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
    
    if (!token || !chatId) {
        console.log("⚠️ Thiếu Telegram Token hoặc Chat ID!");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `🚨 **BIẾN ĐỘNG SỐ DƯ** 🚨\n\n${text}`,
                parse_mode: 'Markdown'
            })
        });
        const result = await response.json();
        if (!result.ok) {
            console.error("❌ Telegram API trả về lỗi:", result);
        } else {
            console.log("✅ Đã gửi tin nhắn thành công về Telegram!");
        }
    } catch (err) {
        console.error("❌ Lỗi kết nối Telegram:", err);
    }
}

// 4. Hàm trích xuất nội dung body thô và làm sạch HTML cơ bản
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
    return body.replace(/<[^>]*>?/gm, '').substring(0, 400);
}

// 5. Hàm dùng Gemini AI phân tích
async function analyzeEmailWithAI(subject, snippet, body) {
    try {
        const prompt = `
Phân tích email xem có phải biến động số dư ngân hàng/ví điện tử không.
Tiêu đề: "${subject}"
Nội dung: "${snippet} ${body}"

Trả về JSON thuần (không dùng markdown code block):
{
  "isBankTransaction": true hoặc false,
  "bankName": "Tên ngân hàng",
  "summary": "Tóm tắt ngắn giao dịch"
}
`;

        const aiPromise = ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [prompt],
        });

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI Timeout')), 10000)
        );

        const response = await Promise.race([aiPromise, timeoutPromise]);

        let textResponse = '';
        if (typeof response.text === 'function') {
            textResponse = response.text();
        } else if (response.text) {
            textResponse = response.text;
        } else if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
            textResponse = response.candidates[0].content.parts[0].text;
        }

        textResponse = textResponse.trim().replace(/```json/g, '').replace(/```/g, '').trim();

        const jsonStart = textResponse.indexOf('{');
        const jsonEnd = textResponse.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            return JSON.parse(textResponse.substring(jsonStart, jsonEnd + 1));
        }

        return { isBankTransaction: false };
    } catch (err) {
        console.error("⚠️ Lỗi hoặc quá thời gian phân tích AI:", err.message);
        return { isBankTransaction: false };
    }
}

// 6. Hàm quét email tự động
async function checkEmailsViaApi() {
    console.log("🔄 Đang quét email...");

    if (mongoose.connection.readyState !== 1) {
        console.log("⏳ Đang chờ kết nối MongoDB...");
        return;
    }

    try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await Transaction.deleteMany({ created_at: { $lt: twentyFourHoursAgo } });

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread newer_than:1d'
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) {
            console.log("📭 Không có email chưa đọc.");
            return;
        }

        console.log(`📬 Tìm thấy ${messages.length} email chưa đọc. Đang xử lý...`);

        for (const msg of messages) {
            const msgId = msg.id;

            const existing = await Transaction.findOne({ msgId: msgId });
            if (existing) {
                await gmail.users.messages.batchModify({
                    userId: 'me',
                    requestBody: { ids: [msgId], removeLabelIds: ['UNREAD'] }
                });
                continue;
            }

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

            const aiAnalysis = await analyzeEmailWithAI(subject, snippet, body);

            console.log(`🤖 [AI Result] Tiêu đề: "${subject}" -> Giao dịch:`, aiAnalysis.isBankTransaction);

            if (aiAnalysis && aiAnalysis.isBankTransaction) {
                const bankName = aiAnalysis.bankName || "Ngân hàng";
                const formattedMessage = `[${bankName}] ${aiAnalysis.summary || subject}`;

                const newTx = new Transaction({
                    msgId: msgId,
                    message: formattedMessage,
                    is_read: false
                });
                await newTx.save();
                console.log("💾 Đã lưu giao dịch:", formattedMessage);

                await sendTelegramNotification(formattedMessage);
            }

            await gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: {
                    ids: [msgId],
                    removeLabelIds: ['UNREAD']
                }
            });
            console.log(`👁️ Đã đánh dấu đọc xong email ID: ${msgId}`);
        }
    } catch (err) {
        console.error("❌ Lỗi vòng lặp quét email:", err);
    }
}

// Quét định kỳ mỗi 30 giây
setInterval(checkEmailsViaApi, 30000);

// API endpoint kích hoạt quét email thủ công từ ESP32
app.get('/api/trigger-check-email', async (req, res) => {
    const mac = req.query.mac;
    console.log(`📩 Nhận yêu cầu kiểm tra email thủ công từ thiết bị MAC: ${mac}`);
    try {
        await checkEmailsViaApi();
        res.status(200).json({ success: true, message: "Đã quét email thành công." });
    } catch (err) {
        console.error("❌ Lỗi quét email thủ công:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

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

app.get('/api/bank-history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 3;
        const txs = await Transaction.find().sort({ created_at: -1 }).limit(limit);
        res.json({ transactions: txs });
    } catch (err) {
        res.status(500).json({ transactions: [] });
    }
});

app.get('/api/bank-stats', async (req, res) => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const txs = await Transaction.find({ created_at: { $gte: startOfDay } });
        res.json({ total_transactions: txs.length, total_amount: 0 });
    } catch (err) {
        res.status(500).json({ total_transactions: 0, total_amount: 0 });
    }
});

app.get('/api/check-license', (req, res) => {
    res.json({ status: "active", expiration: "2030-01-01" });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", message: "Server is alive!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server chạy tại cổng ${PORT}`));
