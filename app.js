const express = require('express');
const path = require('path');
const GoMerchant = require('./GoMerchant');
const { ImageUploadService } = require("node-upload-images");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const FormData = require("form-data");
const session = require('express-session');
const tokenManager = require('./tokenManager');

const app = express();
const sdk = new GoMerchant();

app.set('json spaces', 2);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware untuk track password verification
app.use(session({
  secret: process.env.SESSION_SECRET || 'zyemer-super-secret-key-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Setup default password jika belum ada
(async () => {
  if (!tokenManager.password) {
    // 🔐 UBAH PASSWORD DI SINI
    const PASSWORD = 'zyemer'; // ← GANTI DENGAN PASSWORD KAMU
    await tokenManager.setPassword(PASSWORD);
    console.log('✅ Password set: ' + PASSWORD);
  }
})();

// ================= FUNGSI UPLOAD =================
async function toUrl(buffer, provider = "catbox") {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Input harus buffer");
  }

  // === CATBOX ===
  if (provider === "catbox") {
    const form = new FormData();
    form.append("fileToUpload", buffer, "file.png");
    form.append("reqtype", "fileupload");

    const res = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      headers: form.getHeaders()
    });

    const text = await res.text();
    if (!text.startsWith("http")) throw new Error("Catbox upload gagal");
    return text;
  }

  // === FALLBACK PROVIDER (untuk provider lain jika butuh) ===
  const service = new ImageUploadService(provider);
  let { directLink } = await service.uploadFromBinary(buffer, "skyzo.png");
  return directLink;
}

// ================= ROUTE HALAMAN =================
app.get('/', (req, res) => {
    res.render('index', { isPasswordProtectedReady: tokenManager.isInitialized });
});

// Token setup page (protected by password)
app.get('/auth/token-setup', (req, res) => {
    if (!req.session.passwordVerified) {
        return res.status(403).render('index', { 
            error: 'Kamu perlu verify password dulu untuk akses token setup!',
            isPasswordProtectedReady: tokenManager.isInitialized,
            showPasswordPrompt: true
        });
    }
    res.render('token-setup', { hasTokens: tokenManager.hasTokens() });
});

// ================= AUTH =================
// Verify password untuk akses token setup
app.post('/api/auth/verify-password', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ success: false, error: 'Password wajib diisi' });
        }

        const isValid = await tokenManager.verifyPassword(password);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Password salah!' });
        }

        // Mark session as password verified
        req.session.passwordVerified = true;
        res.json({ success: true, message: 'Password verified! Redirect ke token setup...' });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// Setup/Save tokens
app.post('/api/auth/tokens', async (req, res) => {
    try {
        if (!req.session.passwordVerified) {
            return res.status(403).json({ success: false, error: 'Verify password dulu!' });
        }

        const { accessToken, refreshToken } = req.body;
        
        if (!accessToken || !refreshToken) {
            return res.status(400).json({ 
                success: false, 
                error: 'Access token dan refresh token wajib diisi' 
            });
        }

        // Validate tokens dengan test API call
        try {
            await sdk.getMe(accessToken);
        } catch (e) {
            return res.status(400).json({ 
                success: false, 
                error: 'Access token tidak valid! ' + (e.response?.data?.message || e.message)
            });
        }

        // Save tokens
        tokenManager.setTokens(accessToken, refreshToken);

        // Setup auto-refresh setiap 15 menit
        tokenManager.setupAutoRefresh(sdk, 15 * 60 * 1000);

        res.json({ 
            success: true, 
            message: 'Tokens saved! Auto-refresh aktif setiap 15 menit.',
            hasTokens: true
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// Get current token status
app.get('/api/auth/token-status', (req, res) => {
    res.json({
        hasTokens: tokenManager.hasTokens(),
        lastRefresh: tokenManager.tokens.lastRefresh,
        passwordProtected: tokenManager.isInitialized
    });
});

// Kirim OTP
app.get('/auth/otp', async (req, res) => {
    try {
        let phone = req.query.phone;
        if (!phone) return res.status(400).json({ success: false, error: 'phone wajib diisi' });
        if (phone.startsWith("62")) phone = phone.slice(2)
        const data = await sdk.requestOtp(phone);
        res.json({ success: true, data: { otp_token: data.data.otp_token, message: "Kode OTP Berhasil Dikirim Via SMS" } });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// Verifikasi OTP
app.get('/auth/verify', async (req, res) => {
    try {
        const { otp, otp_token } = req.query;
        if (!otp || !otp_token) return res.status(400).json({ success: false, error: 'otp dan otp_token wajib diisi' });
        const data = await sdk.verifyOtp(otp, otp_token);
        res.json({ success: true, data });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// Refresh token
app.get('/auth/refresh/token', async (req, res) => {
    try {
        const refreshToken = req.query.refresh_token;
        if (!refreshToken) return res.status(400).json({ success: false, error: 'refresh_token wajib diisi' });
        const data = await sdk.refreshToken(refreshToken);
        res.json({ success: true, data });
    } catch (e) {
        res.status(401).json({ success: false, error: e.response?.data || e.message });
    }
});

// ================= API =================
// Validasi token & profil
app.get('/api/validate', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).json({ success: false, error: 'token wajib diisi' });
        const data = await sdk.getMe(token);
        res.json({ success: true, user: data.user, access_token: token });
    } catch (e) {
        res.status(401).json({ success: false, error: e.response?.data || e.message });
    }
});

// Profil (me)
app.get('/api/me', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).json({ success: false, error: 'token wajib diisi' });
        const data = await sdk.getMe(token);
        res.json({ success: true, data });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// History dengan token manual (old endpoint, tetap support)
app.get('/api/history', async (req, res) => {
    try {
        const token = req.query.token;

        if (!token) {
            return res.status(400).json({
                success: false,
                error: 'token wajib diisi'
            });
        }

        const user = await sdk.getMe(token);

        const defaultStartTime = new Date(
            Date.now() - (7 * 24 * 60 * 60 * 1000)
        ).toISOString();

        const startTime = req.query.start_time || defaultStartTime;

        const result = await sdk.getJournals(
            token,
            user.user.merchant_id,
            startTime
        );

        const data = (result.hits || [])
            .filter(item =>
                item?.metadata?.transaction?.payment_type === 'qris'
            )
            .map(item => {
                const aspi = item.metadata?.provider_metadata?.aspi;

                return {
                    id: item.id,
                    reference_id: item.reference_id,
                    status: item.status,
                    time: item.time,

                    amount: aspi?.data?.amount || 0,

                    issuer: aspi?.issuer || null,
                    acquirer: aspi?.acquirer || null,

                    merchant_name: aspi?.data?.merchant_name || null,
                    merchant_id: aspi?.data?.merchant_id || null,
                    merchant_city: aspi?.data?.merchant_city || null,

                    terminal_label:
                        aspi?.data?.additional_data?.terminal_label || null
                };
            });

        res.json({
            success: true,
            total: data.length,
            data
        });

    } catch (e) {
        res.status(400).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ⭐ AUTO-MANAGED HISTORY API - Token tersimpan, auto-refresh setiap 15 menit
app.get('/api/history/auto', async (req, res) => {
    try {
        // Cek apakah tokens sudah tersimpan
        if (!tokenManager.hasTokens()) {
            return res.status(401).json({
                success: false,
                error: 'Tokens belum tersimpan! Silahkan setup di /auth/token-setup dulu'
            });
        }

        const { accessToken, refreshToken } = tokenManager.getTokens();

        try {
            // Try fetch dengan current token
            const user = await sdk.getMe(accessToken);

            const defaultStartTime = new Date(
                Date.now() - (7 * 24 * 60 * 60 * 1000)
            ).toISOString();

            const startTime = req.query.start_time || defaultStartTime;

            const result = await sdk.getJournals(
                accessToken,
                user.user.merchant_id,
                startTime
            );

            const data = (result.hits || [])
                .filter(item =>
                    item?.metadata?.transaction?.payment_type === 'qris'
                )
                .map(item => {
                    const aspi = item.metadata?.provider_metadata?.aspi;

                    return {
                        id: item.id,
                        reference_id: item.reference_id,
                        status: item.status,
                        time: item.time,

                        amount: aspi?.data?.amount || 0,

                        issuer: aspi?.issuer || null,
                        acquirer: aspi?.acquirer || null,

                        merchant_name: aspi?.data?.merchant_name || null,
                        merchant_id: aspi?.data?.merchant_id || null,
                        merchant_city: aspi?.data?.merchant_city || null,

                        terminal_label:
                            aspi?.data?.additional_data?.terminal_label || null
                    };
                });

            res.json({
                success: true,
                total: data.length,
                data,
                tokenRefreshStatus: 'using_current_token'
            });

        } catch (e) {
            // Jika current token error, coba refresh otomatis
            if (e.response?.status === 401 || e.message.includes('401')) {
                console.log('🔄 Current token expired, trying auto-refresh...');
                
                try {
                    const refreshResult = await sdk.refreshToken(refreshToken);
                    const newAccessToken = refreshResult.data.access_token;
                    
                    // Update token yang tersimpan
                    tokenManager.updateAccessToken(newAccessToken);
                    console.log('✅ Token auto-refreshed successfully!');

                    // Retry fetch dengan token baru
                    const user = await sdk.getMe(newAccessToken);
                    const defaultStartTime = new Date(
                        Date.now() - (7 * 24 * 60 * 60 * 1000)
                    ).toISOString();

                    const startTime = req.query.start_time || defaultStartTime;

                    const result = await sdk.getJournals(
                        newAccessToken,
                        user.user.merchant_id,
                        startTime
                    );

                    const data = (result.hits || [])
                        .filter(item =>
                            item?.metadata?.transaction?.payment_type === 'qris'
                        )
                        .map(item => {
                            const aspi = item.metadata?.provider_metadata?.aspi;

                            return {
                                id: item.id,
                                reference_id: item.reference_id,
                                status: item.status,
                                time: item.time,

                                amount: aspi?.data?.amount || 0,

                                issuer: aspi?.issuer || null,
                                acquirer: aspi?.acquirer || null,

                                merchant_name: aspi?.data?.merchant_name || null,
                                merchant_id: aspi?.data?.merchant_id || null,
                                merchant_city: aspi?.data?.merchant_city || null,

                                terminal_label:
                                    aspi?.data?.additional_data?.terminal_label || null
                            };
                        });

                    return res.json({
                        success: true,
                        total: data.length,
                        data,
                        tokenRefreshStatus: 'auto_refreshed_now'
                    });

                } catch (refreshErr) {
                    return res.status(401).json({
                        success: false,
                        error: 'Token expired dan refresh gagal! Silahkan setup ulang token di /auth/token-setup',
                        refreshError: refreshErr.response?.data || refreshErr.message
                    });
                }
            }

            throw e;
        }

    } catch (e) {
        res.status(400).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// Daftar payout
app.get('/api/payouts', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token) return res.status(400).json({ success: false, error: 'token wajib diisi' });
        const data = await sdk.getPayouts(token);
        res.json({ success: true, data });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// QRIS Dinamis → menghasilkan gambar & upload ke hosting, kembalikan URL
app.get('/api/qris/create', async (req, res) => {
    try {
        const { amount, static_qr } = req.query;
        if (!amount || !static_qr) {
            return res.status(400).json({ success: false, error: 'Parameter amount dan static_qr wajib diisi' });
        }

        // Generate QR
        const data = await sdk.createDynamicQRIS(amount, static_qr);
        const qrBuffer = Buffer.isBuffer(data.qr_buffer)
            ? data.qr_buffer
            : Buffer.from(data.qr_buffer.data);

        // Upload buffer ke image hosting
        const imageUrl = await toUrl(qrBuffer, "catbox"); // catbox lebih stabil dari pixhost.to

        res.json({
            success: true,
            image_url: imageUrl,
            amount: data.amount,
            qr_string: data.qr_string,
            created_at: data.created_at
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// Cek status pembayaran QRIS
app.get('/api/qris/status', async (req, res) => {
    try {
        const { token, amount, created_at } = req.query;
        if (!token || !amount || !created_at) {
            return res.status(400).json({ success: false, error: 'token, amount, dan created_at wajib diisi' });
        }

        const user = await sdk.getMe(token);
        const logs = await sdk.getJournals(token, user.user.merchant_id, created_at);
        const amountSearch = parseInt(amount) * 100;
        const found = logs.hits.find(h => {
            const txTime = new Date(h.time).getTime();
            const qrisTime = new Date(created_at).getTime();
            return h.amount === amountSearch && txTime >= qrisTime;
        });
        res.json({ success: true, status: found ? 'PAID' : 'PENDING', data: found || null });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

const PORT = process.env.PORT || 3015;

// Di Vercel, app di-import sebagai serverless function (jangan listen).
// Di lokal/Termux, tetap jalan normal dengan app.listen.
if (process.env.VERCEL !== '1') {
    app.listen(PORT, () => console.log(`GoMerch listening on port ${PORT}`));
}

module.exports = app;
