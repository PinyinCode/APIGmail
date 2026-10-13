const express = require('express');
const mongoose = require('mongoose');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// CORS cho web client
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Kết nối MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB error:', err));

// Schema OTP (TTL 10 phút)
const otpSchema = new mongoose.Schema({
    email: { type: String, index: true },
    otp: String,
    deviceId: String,
    deviceName: String,
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 600 }
});
const OtpCode = mongoose.model('OtpCode', otpSchema);

// Gmail OAuth2
const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);
oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// Kiểm tra OAuth2 khi server start
(async () => {
    try {
        const { token } = await oAuth2Client.getAccessToken();
        console.log('✅ OAuth2 OK —', token?.substring(0, 25) + '...');
    } catch (err) {
        console.error('❌ OAuth2 FAILED:', err.message);
        console.error('   Chi tiết:', err.response?.data || err.code);
    }
})();

// Helper
function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function buildOtpEmailHtml(otp, deviceName, email) {
    return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#f8fafc;padding:20px;border-radius:12px">
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px;border-radius:12px 12px 0 0;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:22px">🔐 Xác thực đăng nhập</h1>
        </div>
        <div style="background:#fff;padding:28px 24px;border-radius:0 0 12px 12px">
            <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
                Có một thiết bị mới đang cố đăng nhập vào tài khoản <b>${email}</b>:
            </p>
            <div style="background:#f1f5f9;border-radius:10px;padding:14px 18px;margin-bottom:20px">
                <div style="font-weight:bold;color:#0f172a;font-size:15px">${deviceName || 'Thiết bị'}</div>
            </div>
            <p style="color:#475569;font-size:14px;margin:0 0 12px">Nhập mã OTP sau để xác nhận:</p>
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
    </div>
    `;
}

async function sendGmailHtml(to, subject, htmlContent) {
    const fromEmail = process.env.GOOGLE_SENDER_EMAIL;
    const messageParts = [
        `From: "Account Verification" <${fromEmail}>`,
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

// Rate limit trong RAM
const lastSentMap = new Map();

/* ═══════════════════════════════════════
   ENDPOINT 1: Gửi OTP
   ═══════════════════════════════════════ */
app.post('/api/device/send-otp', async (req, res) => {
    try {
        const { email, deviceId, deviceName } = req.body || {};

        if (!email || !email.includes('@')) {
            return res.status(400).json({ ok: false, error: 'Email không hợp lệ' });
        }

        const emailLower = email.toLowerCase().trim();

        // Rate limit 60 giây
        const lastSent = lastSentMap.get(emailLower);
        if (lastSent && Date.now() - lastSent < 60000) {
            const waitSec = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
            return res.status(429).json({
                ok: false,
                error: `Vui lòng đợi ${waitSec} giây trước khi gửi lại`,
                waitSec
            });
        }

        // Xóa OTP cũ
        await OtpCode.deleteMany({ email: emailLower });

        const otp = generateOtp();
        await OtpCode.create({
            email: emailLower,
            otp: otp,
            deviceId: deviceId || 'unknown',
            deviceName: deviceName || 'Thiết bị'
        });

        const html = buildOtpEmailHtml(otp, deviceName, emailLower);
        await sendGmailHtml(emailLower, 'Your OTP Verification Code', html);

        lastSentMap.set(emailLower, Date.now());
        console.log(`📧 Gửi OTP ${otp} đến ${emailLower}`);

        return res.json({ ok: true, message: 'Đã gửi mã OTP' });

    } catch (err) {
        console.error('❌ Send OTP error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/* ═══════════════════════════════════════
   ENDPOINT 2: Verify OTP
   ═══════════════════════════════════════ */
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
            return res.status(429).json({ ok: false, error: 'Quá nhiều lần thử' });
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
        console.error('❌ Verify OTP error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/* Health check */
app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'OTP server is alive!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server chạy tại cổng ${PORT}`));
