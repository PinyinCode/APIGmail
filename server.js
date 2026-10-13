const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

// ⭐ CORS cho web client
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Khởi tạo Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. Kết nối MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Đã kết nối MongoDB thành công!'))
    .catch(err => console.error('Lỗi kết nối MongoDB:', err));

// ═══ SCHEMA CŨ: BANK TRANSACTION ═══
const transactionSchema = new mongoose.Schema({
    msgId: { type: String, unique: true },
    message: String,
    is_read: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// ═══ ⭐ SCHEMA MỚI: OTP XÁC THỰC THIẾT BỊ ═══
const otpSchema = new mongoose.Schema({
    email: { type: String, index: true },
    otp: String,
    deviceId: String,
    deviceName: String,
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 600 } // TTL 10 phút
});
const OtpCode = mongoose.model('OtpCode', otpSchema);

// 2. Google OAuth2 Client (Gmail)
const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// 3. Hàm gửi Telegram
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

// 4. Hàm trích xuất body email
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

// 5. Gemini AI phân tích
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
        console.error("⚠️ Lỗi AI:", err.message);
        return { isBankTransaction: false };
    }
}

// 6. Quét email tự động
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

        console.log(`📬 Tìm thấy ${messages.length} email chưa đọc.`);

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
                userId: 'me', id: msgId, format: 'full'
            });

            const headers = detail.data.payload.headers;
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
            const subject = subjectHeader ? subjectHeader.value : '';
            const snippet = detail.data.snippet || '';
            const body = getEmailBody(detail.data.payload);

            const aiAnalysis = await analyzeEmailWithAI(subject, snippet, body);

            console.log(`🤖 [AI] "${subject}" -> ${aiAnalysis.isBankTransaction}`);

            if (aiAnalysis && aiAnalysis.isBankTransaction) {
                const bankName = aiAnalysis.bankName || "Ngân hàng";
                const formattedMessage = `[${bankName}] ${aiAnalysis.summary || subject}`;

                const newTx = new Transaction({
                    msgId: msgId, message: formattedMessage, is_read: false
                });
                await newTx.save();
                console.log("💾 Đã lưu:", formattedMessage);
                await sendTelegramNotification(formattedMessage);
            }

            await gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: { ids: [msgId], removeLabelIds: ['UNREAD'] }
            });
        }
    } catch (err) {
        console.error("❌ Lỗi quét email:", err);
    }
}

/* ═══════════════════════════════════════════════════════════
   ⭐ DEVICE OTP — Gửi mail xác thực thiết bị
   ═══════════════════════════════════════════════════════════ */

const lastSentMap = new Map();

function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function buildOtpEmailHtml(otp, deviceName, email) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px">
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px;border-radius:12px 12px 0 0;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:22px">🔐 Xác thực đăng nhập</h1>
        </div>
        <div style="background:#fff;padding:28px 24px;border-radius:0 0 12px 12px">
            <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
                Xin chào,<br>
                Có một thiết bị mới đang cố đăng nhập vào tài khoản <b>${email}</b>:
            </p>
            <div style="background:#f1f5f9;border-radius:10px;padding:14px 18px;margin-bottom:20px">
                <div style="font-weight:bold;color:#0f172a;font-size:15px">${deviceName || 'Thiết bị'}</div>
            </div>
            <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 12px">
                Nhập mã OTP sau để xác nhận:
            </p>
            <div style="text-align:center;margin:24px 0">
                <div style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:18px 36px;border-radius:12px">
                    <div style="color:#fff;font-size:36px;font-weight:900;letter-spacing:8px;font-family:monospace">${otp}</div>
                </div>
            </div>
            <p style="color:#94a3b8;font-size:13px;text-align:center;margin:0">
                Mã có hiệu lực trong <b>10 phút</b>.
            </p>
            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:8px;margin-top:20px">
                <p style="color:#92400e;font-size:13px;margin:0;line-height:1.5">
                    ⚠️ Nếu <b>KHÔNG phải bạn</b>, hãy bỏ qua email này và đổi mật khẩu ngay.
                </p>
            </div>
        </div>
        <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:16px">
            Học Tiếng Trung — Hệ thống bảo mật tài khoản
        </p>
    </div>
    `;
}

async function sendGmailHtml(to, subject, htmlContent) {
    const fromEmail = process.env.GOOGLE_SENDER_EMAIL || 'me';
    const messageParts = [
        `From: "Học Tiếng Trung" <${fromEmail}>`,
        `To: ${to}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlContent).toString('base64')
    ];
    const raw = messageParts.join('\n');
    const encoded = Buffer.from(raw).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encoded }
    });
}

/* ═══ ENDPOINT: Gửi OTP ═══ */
app.post('/api/device/send-otp', async (req, res) => {
    try {
        const { email, deviceId, deviceName } = req.body || {};

        if (!email || !email.includes('@')) {
            return res.status(400).json({ ok: false, error: 'Email không hợp lệ' });
        }

        const emailLower = email.toLowerCase().trim();

        const lastSent = lastSentMap.get(emailLower);
        if (lastSent && Date.now() - lastSent < 60000) {
            const waitSec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
            return res.status(429).json({
                ok: false,
                error: `Vui lòng đợi ${waitSec} giây trước khi gửi lại`,
                waitSec
            });
        }

        await OtpCode.deleteMany({ email: emailLower });

        const otp = generateOtp();
        await OtpCode.create({
            email: emailLower,
            otp: otp,
            deviceId: deviceId || 'unknown',
            deviceName: deviceName || 'Thiết bị'
        });

        const html = buildOtpEmailHtml(otp, deviceName, emailLower);
        await sendGmailHtml(emailLower, '🔐 Mã xác thực đăng nhập thiết bị mới', html);

        lastSentMap.set(emailLower, Date.now());
        console.log(`📧 Đã gửi OTP ${otp} đến ${emailLower}`);

        return res.json({ ok: true, message: 'Đã gửi mã OTP' });

    } catch (err) {
        console.error('❌ Lỗi gửi OTP:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/* ═══ ENDPOINT: Verify OTP ═══ */
app.post('/api/device/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body || {};

        if (!email || !otp) {
            return res.status(400).json({ ok: false, error: 'Thiếu email hoặc OTP' });
        }

        const emailLower = email.toLowerCase().trim();
        const record = await OtpCode.findOne({ email: emailLower }).sort({ createdAt: -1 });

        if (!record) {
            return res.status(400).json({ ok: false, error: 'OTP không tồn tại hoặc đã hết hạn' });
        }

        if (Date.now() - record.createdAt.getTime() > 10 * 60 * 1000) {
            await OtpCode.deleteMany({ email: emailLower });
            return res.status(400).json({ ok: false, error: 'OTP đã hết hạn' });
        }

        if (record.attempts >= 5) {
            await OtpCode.deleteMany({ email: emailLower });
            return res.status(429).json({ ok: false, error: 'Quá nhiều lần thử. Vui lòng gửi lại OTP.' });
        }

        if (String(record.otp) !== String(otp).trim()) {
            record.attempts += 1;
            await record.save();
            return res.status(400).json({
                ok: false,
                error: 'Mã OTP không đúng',
                attemptsLeft: 5 - record.attempts
            });
        }

        await OtpCode.deleteMany({ email: emailLower });

        console.log(`✅ OTP đúng cho ${emailLower}`);
        return res.json({ ok: true, message: 'Xác thực thành công' });

    } catch (err) {
        console.error('❌ Lỗi verify OTP:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   CÁC ENDPOINT CŨ (bank notification)
   ═══════════════════════════════════════════════════════════ */

setInterval(checkEmailsViaApi, 30000);

app.get('/api/trigger-check-email', async (req, res) => {
    const mac = req.query.mac;
    console.log(`📩 Yêu cầu check email từ MAC: ${mac}`);
    try {
        await checkEmailsViaApi();
        res.status(200).json({ success: true, message: "Đã quét email thành công." });
    } catch (err) {
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
