const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const usersDB = {};       
const pageIndexMap = {};  
let sessions = {};        

const defaultPageConfig = {
  appId: '1611337127153323',
  verifyToken: '14556456',
  pageAccessToken: '',
  pageId: '',
  pageName: '',
  easySlipApiKey: '47f197e2-8c05-42bb-b9ad-9186f84faa82', // EasySlip API Key
  
  matchType: 'contains',
  keywords: ['1', '11', '111', '11111', '111111', 'สนใจ', 'cf'],
  replyCommentText: 'แอดมินส่งรายละเอียดให้ในอินบ็อกซ์เรียบร้อยแล้วนะคะ 🙏',
  inboxText: 'ร.กรุงศรี 6651198576\nชื่อภิญโญ แจ้งกระจ่าง\n\n🙏 โอนแล้วแจ้งสลิป พร้อมชื่อที่อยู่ ได้เลยคะ🥰\n✨ (ส่งฟรี) ส่งฟรี EMS ✨',
  enableInbox: true,
  enableCommentReply: true,
  enableAutoLike: true,
  
  enableSlipVerify: true,
  merchantBank: 'BAY', 
  merchantAccount: '6651198576',
  merchantName: 'ภิญโญ แจ้งกระจ่าง',
  msgSlipSuccess: 'สถานะ: ตรวจสอบถูกต้อง ✅\nยอดเงิน: {amount} บาท\nวันที่: {date}\n\nรับยอดค่ะพี่ ขอบคุณมากค่ะ 🙏 แจ้งชื่อที่อยู่เบอร์โทร ได้เลยค่ะ🥰',
  msgSlipInvalid: '❌ สลิปไม่ถูกต้อง หรือเลขบัญชีผู้รับไม่ตรงกับของทางร้าน กรุณาตรวจสอบอีกครั้งนะคะ',
  msgSlipUnreadable: '⚠️ ไม่สามารถอ่านข้อมูลจากสลิปนี้ได้ กรุณาส่งรูปสลิปที่ชัดเจนอีกครั้งนะคะ',
  msgSlipDuplicate: '🔄 สลิปนี้ถูกใช้งานไปแล้ว ไม่สามารถส่งซ้ำได้ค่ะ'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// 🛠️ ฟังก์ชันสำหรับเรียกใช้งาน EasySlip API (v2)
async function callEasySlip(body, keyToUse) {
  return axios.post('https://api.easyslip.com/v2/verify/bank', body, {
    headers: {
      'Authorization': `Bearer ${keyToUse}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });
}

async function verifySlipByImageUrl(imageUrl, apiKey) {
  const keyToUse = apiKey || defaultPageConfig.easySlipApiKey;
  if (!keyToUse) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า EasySlip API Key');
    return { success: false, message: 'API Key missing' };
  }

  console.log('🔍 [EasySlip] กำลังส่งรูปไปตรวจ:', imageUrl);

  // วิธีที่ 1: ส่ง URL ให้ EasySlip โหลดรูปเอง
  try {
    const response = await callEasySlip({ url: imageUrl, checkDuplicate: true }, keyToUse);
    console.log('✅ [EasySlip] ผลการตรวจสอบ Raw Data:', JSON.stringify(response.data, null, 2));
    return { success: true, data: response.data };
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('❌ [EasySlip] ส่งแบบ URL ไม่สำเร็จ:', JSON.stringify(errData));

    const code = errData?.error?.code;
    if (['MISSING_API_KEY', 'INVALID_API_KEY', 'QUOTA_EXCEEDED', 'IP_NOT_ALLOWED', 'BRANCH_INACTIVE', 'SERVICE_BANNED', 'SERVICE_DELETED', 'USER_BANNED', 'RATE_LIMIT_EXCEEDED', 'SLIP_NOT_FOUND', 'SLIP_PENDING'].includes(code)) {
      return { success: false, error: errData };
    }
  }

  // วิธีที่ 2: ดาวน์โหลดรูปจาก Facebook เอง แล้วส่งเป็น base64
  try {
    const img = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const base64 = Buffer.from(img.data).toString('base64');
    const response = await callEasySlip({ base64, checkDuplicate: true }, keyToUse);
    console.log('✅ [EasySlip] (base64) ผลการตรวจสอบ Raw Data:', JSON.stringify(response.data, null, 2));
    return { success: true, data: response.data };
  } catch (err) {
    console.error('❌ [EasySlip] ส่งแบบ base64 ไม่สำเร็จ:', JSON.stringify(err.response?.data || err.message));
    return { success: false, error: err.response?.data || err.message };
  }
}

// 🔧 แปลงผลลัพธ์จาก EasySlip ให้อยู่ในรูปแบบเดียวกัน
function normalizeSlip(apiResponse) {
  if (!apiResponse) return null;
  if (apiResponse.success === false) return null;

  const dataObj = apiResponse.data && typeof apiResponse.data === 'object' ? apiResponse.data : apiResponse;
  const raw = dataObj.rawSlip || dataObj.slip || dataObj;

  const transRef = raw.transRef || dataObj.transRef || raw.id || raw.transNumber || '';
  if (!transRef) return null;

  const amountObj = raw.amount ?? dataObj.amount;
  const amount = typeof amountObj === 'object' && amountObj !== null
    ? (amountObj.amount ?? amountObj.local?.amount ?? 0)
    : (amountObj ?? 0);

  const rcv = raw.receiver || dataObj.receiver || {};
  const rcvAcc = rcv.account || {};
  const receiverAccounts = [
    rcvAcc.bank?.account,
    rcvAcc.proxy?.account,
    typeof rcvAcc === 'string' ? rcvAcc : ''
  ].filter(Boolean).map(String);

  const rawDate = raw.date || raw.transDate || dataObj.date || '';
  let dateText = rawDate;
  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) {
      dateText = d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
    }
  }

  return {
    transRef: String(transRef),
    amount,
    dateText,
    receiverAccounts,
    receiverNameTh: rcvAcc.name?.th || '',
    isDuplicate: dataObj.isDuplicate === true,
    matchedAccount: dataObj.matchedAccount || null
  };
}

// 🔧 เช็คเลขบัญชีผู้รับ
function accountMatches(merchantAcc, slipAccounts) {
  const merchant = String(merchantAcc || '').replace(/[^0-9]/g, '');
  if (!merchant) return true;

  for (const acc of slipAccounts) {
    const raw = String(acc);
    const chars = raw.replace(/[\s-]/g, '');
    if (chars.length === merchant.length) {
      let ok = true;
      for (let i = 0; i < chars.length; i++) {
        if (/[0-9]/.test(chars[i]) && chars[i] !== merchant[i]) { ok = false; break; }
      }
      if (ok) return true;
    }
    const visibleRuns = raw.split(/[^0-9]+/).filter(r => r.length >= 3);
    if (visibleRuns.length && visibleRuns.every(r => merchant.includes(r))) return true;
  }
  return false;
}

// 🔧 เทียบชื่อผู้รับ
function nameMatches(merchantName, slipName) {
  const clean = (v) => String(v || '')
    .replace(/(นางสาว|น\.ส\.|นาย|นาง|MISS|MRS|MR|MS)\.?/gi, '')
    .replace(/[\s.\-]/g, '')
    .toLowerCase();
  const a = clean(merchantName), b = clean(slipName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function checkAuth(req, res, next) {
  const token = req.headers['authorization'] || req.query.token;
  if (token && sessions[token]) {
    req.userId = sessions[token];
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized: กรุณาล็อกอินก่อนใช้งาน' });
  }
}

// -------------------------------------------------------------
// 1. หน้า Dashboard HTML UI
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ระบบจัดการ Multi-Page Bot ตอบคอมเมนต์อัตโนมัติ</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style> body { font-family: 'Sarabun', sans-serif; } </style>
</head>
<body class="bg-slate-100 text-slate-800 antialiased">
    <div id="auth-container" class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-3xl shadow-xl w-full max-w-md p-8 space-y-6">
            <div class="text-center">
                <h2 class="text-2xl font-bold text-slate-800">FB Bot Manager</h2>
                <p class="text-xs text-slate-500 mt-1">เข้าสู่ระบบเพื่อจัดการเพจของคุณ (ทำงานพร้อมกันได้สูงสุด 5 เพจ)</p>
            </div>
            <div class="flex bg-slate-100 p-1 rounded-xl">
                <button type="button" onclick="switchAuthMode('login')" id="tab-login" class="flex-1 py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-blue-600 transition-all">เข้าสู่ระบบ</button>
                <button type="button" onclick="switchAuthMode('signup')" id="tab-signup" class="flex-1 py-2 text-xs font-medium rounded-lg text-slate-500 transition-all">สมัครสมาชิก</button>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="text-xs font-semibold text-slate-600 block mb-1">ชื่อผู้ใช้งาน (Username):</label>
                    <input type="text" id="auth-user" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="กรอกชื่อผู้ใช้">
                </div>
                <div>
                    <label class="text-xs font-semibold text-slate-600 block mb-1">รหัสผ่าน (Password):</label>
                    <input type="password" id="auth-pass" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="กรอกรหัสผ่าน">
                </div>
                <button type="button" id="auth-btn" onclick="handleAuth()" class="w-full py-3 bg-blue-600 text-white font-medium text-sm rounded-xl hover:bg-blue-700 shadow-md">เข้าสู่ระบบ</button>
            </div>
        </div>
    </div>

    <div id="app-container" class="flex h-screen overflow-hidden hidden">
        <aside class="w-64 bg-white border-r border-slate-200 flex flex-col z-20">
            <div class="h-16 flex items-center justify-between px-6 border-b border-slate-100">
                <span class="font-bold text-lg text-blue-600">FB Bot Manager</span>
                <button type="button" onclick="logout()" class="text-xs text-rose-500 hover:underline font-semibold">ออกจากระบบ</button>
            </div>
            
            <div class="p-4 border-b border-slate-100 bg-slate-50 space-y-2">
                <label class="text-xs font-bold text-slate-600 block">🏪 เลือกเพจที่กำลังจัดการตั้งค่า:</label>
                <select id="active-page-selector" onchange="switchActivePage(this.value)" class="w-full p-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-500">
                    <option value="">-- ยังไม่มีเพจในระบบ --</option>
                </select>
                <button type="button" onclick="deleteCurrentPage()" class="w-full py-1.5 bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100 text-xs font-semibold rounded-lg transition-all">🗑️ ลบเพจนี้ออกจากระบบ</button>
            </div>

            <div class="flex-1 overflow-y-auto py-4 px-3 space-y-1">
                <div class="text-xs font-semibold text-slate-400 px-3 mb-2">เมนูหลัก</div>
                <a href="#" onclick="switchTab('dashboard')" id="nav-dashboard" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600">💬 ตอบกลับคอมเมนต์</a>
                <a href="#" onclick="switchTab('slip')" id="nav-slip" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">💐 ตรวจสลิปอัตโนมัติ</a>
                <a href="#" onclick="switchTab('broadcast')" id="nav-broadcast" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">🚀 บรอดแคสควบคุมเวลา</a>
                <a href="#" onclick="switchTab('live')" id="nav-live" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">🎥 ไลฟ์ (Sessions)</a>
                <a href="#" onclick="switchTab('webhook')" id="nav-webhook" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">⚙️ เพิ่มเพจ & Webhook</a>
            </div>
        </aside>

        <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <header class="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 z-10">
                <h1 id="page-title" class="text-lg font-bold text-slate-700">กำลังจัดการเพจ: <span id="header-page-name" class="text-blue-600">ยังไม่ได้เลือกเพจ</span></h1>
                <span class="text-xs bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-semibold">● User: <span id="current-username"></span></span>
            </header>

            <main class="flex-1 overflow-y-auto p-6">
                <div id="tab-dashboard" class="space-y-6">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                        <label class="text-sm font-semibold text-slate-700 block mb-2">คำดัก: หากคอมเมนต์ของลูกเพจ :</label>
                        <div class="flex gap-2 mb-4">
                            <button type="button" onclick="setMatchType('exact')" id="btn-exact" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white">ตรงกับคำว่า</button>
                            <button type="button" onclick="setMatchType('contains')" id="btn-contains" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600">มีคำว่า</button>
                        </div>
                        <div id="keywords-container" class="flex flex-wrap items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl min-h-[50px]"></div>
                        <div class="mt-2 flex gap-2">
                            <input type="text" id="new-keyword-input" placeholder="พิมพ์คำดักเพิ่ม เช่น สนใจ, cf, 1" class="px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                            <button type="button" onclick="addKeyword()" class="px-4 py-1.5 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-700">เพิ่มคำ</button>
                        </div>
                    </div>

                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
                        <label class="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" id="enable-auto-like" class="w-4 h-4 text-blue-600 rounded">
                            <span class="text-sm font-semibold text-slate-700">👍 กดไลก์คอมเมนต์อัตโนมัติ (เมื่อคอมเมนต์ตรงกับคีย์เวิร์ด)</span>
                        </label>
                    </div>

                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col justify-between">
                            <textarea id="reply-comment-input" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl mb-4 focus:outline-none focus:border-blue-500" placeholder="ข้อความตอบกลับใต้คอมเมนต์..."></textarea>
                            <label class="flex items-center gap-2 cursor-pointer pt-4 border-t border-slate-100">
                                <input type="checkbox" id="enable-comment-reply" class="w-4 h-4 text-blue-600 rounded">
                                <span class="text-sm font-medium text-slate-700">เปิดใช้งานตอบกลับคอมเมนต์อัตโนมัติ</span>
                            </label>
                        </div>
                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col justify-between">
                            <textarea id="inbox-input" rows="5" class="w-full p-3 text-sm border border-slate-200 rounded-xl mb-4 focus:outline-none focus:border-blue-500" placeholder="ข้อความส่งเข้าแชทส่วนตัว..."></textarea>
                            <label class="flex items-center gap-2 cursor-pointer pt-4 border-t border-slate-100">
                                <input type="checkbox" id="enable-inbox" class="w-4 h-4 text-blue-600 rounded">
                                <span class="text-sm font-medium text-slate-700">ส่งข้อความหาลูกค้าทางแชท (ดึงคอมเมนต์เข้าแชท)</span>
                            </label>
                        </div>
                    </div>
                    <div class="flex justify-end">
                        <button type="button" onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่าเพจนี้</button>
                    </div>
                </div>

                <div id="tab-slip" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-6">
                        <div class="flex items-center justify-between border-b border-slate-100 pb-4">
                            <div>
                                <h3 class="text-base font-bold text-slate-800">🧾 ตั้งค่าตรวจสลิปอัตโนมัติ (EasySlip API)</h3>
                                <p class="text-xs text-slate-500 mt-1">เมื่อลูกค้าส่งรูปสลิปเข้ามาในแชท ระบบจะตรวจยอดเงิน เลขบัญชีผู้รับ และเช็คสลิปซ้ำให้อัตโนมัติ</p>
                            </div>
                            <label class="flex items-center cursor-pointer">
                                <input type="checkbox" id="enable-slip-verify" class="sr-only peer">
                                <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 relative"></div>
                                <span class="ml-3 text-sm font-semibold text-slate-700">เปิดใช้งานตรวจสอบ</span>
                            </label>
                        </div>

                        <div>
                            <label class="text-xs font-semibold text-slate-600 block mb-1">EasySlip API Key:</label>
                            <input type="text" id="easyslip-api-key" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400" placeholder="กรอก API Key จาก EasySlip...">
                        </div>

                        <div class="bg-rose-50/50 border border-rose-200 rounded-2xl p-5 space-y-4">
                            <h4 class="text-xs font-bold text-rose-700 uppercase tracking-wider">บัญชีผู้รับเงินที่ต้องตรวจสอบ</h4>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ธนาคารผู้รับ:</label>
                                    <select id="merchant-bank" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400">
                                        <option value="BAY">ธนาคารกรุงศรีอยุธยา (BAY)</option>
                                        <option value="KBANK">ธนาคารกสิกรไทย (KBANK)</option>
                                        <option value="SCB">ธนาคารไทยพาณิชย์ (SCB)</option>
                                        <option value="BBL">ธนาคารกรุงเทพ (BBL)</option>
                                        <option value="KTB">ธนาคารกรุงไทย (KTB)</option>
                                        <option value="TTB">ธนาคารทหารไทยธนชาต (TTB)</option>
                                        <option value="GSB">ธนาคารออมสิน (GSB)</option>
                                        <option value="PROMPTPAY">พร้อมเพย์ (PromptPay)</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">เลขที่บัญชี / เบอร์พร้อมเพย์:</label>
                                    <input type="text" id="merchant-account" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ชื่อบัญชีผู้รับเงิน:</label>
                                    <input type="text" id="merchant-name" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400">
                                </div>
                            </div>
                        </div>

                        <div class="space-y-4">
                            <h4 class="text-sm font-bold text-slate-700">คำตอบของแชทบอต</h4>
                            <div class="flex border-b border-slate-200 gap-2">
                                <button type="button" onclick="switchSlipTab('success')" id="tab-btn-success" class="pb-2.5 px-4 text-xs font-bold text-rose-600 border-b-2 border-rose-600">สลิปถูกต้อง</button>
                                <button type="button" onclick="switchSlipTab('invalid')" id="tab-btn-invalid" class="pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700">สลิปไม่ถูกต้อง</button>
                                <button type="button" onclick="switchSlipTab('unreadable')" id="tab-btn-unreadable" class="pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700">สลิปตรวจสอบไม่ได้</button>
                                <button type="button" onclick="switchSlipTab('duplicate')" id="tab-btn-duplicate" class="pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700">สลิปซ้ำ</button>
                            </div>

                            <div class="bg-slate-50 rounded-2xl p-4 border border-slate-200">
                                <div id="slip-msg-success" class="space-y-2">
                                    <textarea id="msg-slip-success" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                </div>
                                <div id="slip-msg-invalid" class="space-y-2 hidden">
                                    <textarea id="msg-slip-invalid" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                </div>
                                <div id="slip-msg-unreadable" class="space-y-2 hidden">
                                    <textarea id="msg-slip-unreadable" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                </div>
                                <div id="slip-msg-duplicate" class="space-y-2 hidden">
                                    <textarea id="msg-slip-duplicate" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                </div>
                            </div>
                        </div>

                        <div class="flex justify-end pt-2">
                            <button type="button" onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่าสลิป</button>
                        </div>
                    </div>
                </div>

                <div id="tab-broadcast" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                        <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-4">
                            <div>
                                <h3 class="text-base font-bold text-slate-700">🚀 บรอดแคสข้อความปลอดภัย (Safety Broadcast)</h3>
                            </div>
                            <div class="text-right">
                                <span class="text-xs text-slate-400 block">ผู้รับในเพจนี้</span>
                                <span id="subscriber-count" class="text-lg font-bold text-blue-600">0 คน</span>
                            </div>
                        </div>

                        <div class="space-y-4">
                            <div>
                                <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความบรอดแคส:</label>
                                <textarea id="bc-message" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="พิมพ์ข้อความ..."></textarea>
                            </div>

                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">หน่วงเวลารายคน (วินาที):</label>
                                    <input type="number" id="bc-delay" value="3" min="1" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ส่งครบ (คน) แล้วพักระบบ:</label>
                                    <input type="number" id="bc-batch-size" value="20" min="1" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">พักระบบเป็นเวลา (นาที):</label>
                                    <input type="number" id="bc-pause-min" value="10" min="1" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white">
                                </div>
                            </div>

                            <div id="bc-progress-area" class="hidden bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
                                <div class="flex justify-between text-xs font-semibold text-blue-700">
                                    <span id="bc-status-text">กำลังรันระบบ...</span>
                                    <span id="bc-numbers">0/0</span>
                                </div>
                                <div class="w-full bg-blue-200 h-2.5 rounded-full overflow-hidden">
                                    <div id="bc-progress-bar" class="bg-blue-600 h-2.5 rounded-full w-0 transition-all duration-300"></div>
                                </div>
                            </div>

                            <div class="flex gap-3 pt-2">
                                <button type="button" id="btn-start-bc" onclick="startBroadcast()" class="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 shadow-sm">เริ่มส่งบรอดแคส</button>
                                <button type="button" id="btn-stop-bc" onclick="stopBroadcast()" class="hidden px-6 py-2.5 bg-rose-600 text-white font-medium rounded-xl hover:bg-rose-700 shadow-sm">หยุดบรอดแคส</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="tab-live" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <div>
                            <h3 class="text-base font-bold text-slate-700">🎥 เริ่ม Session ไลฟ์ใหม่</h3>
                            <p class="text-xs text-slate-500 mt-1">แต่ละ session แยกคำดัก ข้อความตอบ รายชื่อคนคอมเมนต์ สลิป/ยอดโอน และบรอดแคสต์ออกจากกัน ใส่ Video ID หรือลิงก์ไลฟ์เพื่อให้บอตแยกคอมเมนต์ให้อัตโนมัติ (ทำงานพร้อมกันหลายไลฟ์ได้) ถ้าเว้นว่าง จะเป็น session แบบเปิด/ปิดเอง คอมเมนต์ทั้งเพจที่ไม่ตรงไลฟ์อื่นจะถูกนับเข้า session นี้ ถ้าไม่มี session ที่ตรงเลย บอตจะใช้ค่าตั้งหลักของเพจเหมือนเดิม</p>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <input type="text" id="live-new-name" class="p-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="ชื่อ session เช่น ไลฟ์ค่ำวันนี้">
                            <input type="text" id="live-new-video" class="p-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="Video ID หรือลิงก์ไลฟ์ (เว้นว่างได้)">
                            <button type="button" onclick="createLiveSession()" class="px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 shadow-sm">➕ เริ่ม session</button>
                        </div>
                    </div>

                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                        <h3 class="text-base font-bold text-slate-700 mb-3">รายการ session ของเพจนี้</h3>
                        <div id="live-list" class="space-y-2"></div>
                    </div>

                    <div id="live-detail" class="hidden space-y-6">
                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                            <div class="flex flex-wrap items-center justify-between gap-3">
                                <div class="min-w-0">
                                    <input type="text" id="live-name-input" class="text-base font-bold text-slate-800 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:outline-none bg-transparent w-72 max-w-full">
                                    <div id="live-meta" class="text-xs text-slate-500 mt-1"></div>
                                </div>
                                <div class="flex gap-2">
                                    <button type="button" id="live-btn-toggle" onclick="toggleLiveStatus()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600"></button>
                                    <button type="button" onclick="deleteLiveSession()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100">🗑️ ลบ</button>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">คอมเมนต์ทั้งหมด</div><div id="lv-stat-comments" class="text-xl font-bold text-slate-800">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">ตรงคำดัก</div><div id="lv-stat-matched" class="text-xl font-bold text-blue-600">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">คนคอมเมนต์</div><div id="lv-stat-people" class="text-xl font-bold text-slate-800">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">สลิปที่ผ่าน</div><div id="lv-stat-slips" class="text-xl font-bold text-emerald-600">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">ยอดโอนรวม (บาท)</div><div id="lv-stat-total" class="text-xl font-bold text-emerald-600">0</div></div>
                            </div>
                        </div>

                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                            <h3 class="text-base font-bold text-slate-700">⚙️ ตั้งค่าเฉพาะ session นี้</h3>
                            <div>
                                <label class="text-sm font-semibold text-slate-700 block mb-2">คำดัก:</label>
                                <div class="flex gap-2 mb-3">
                                    <button type="button" onclick="liveSetMatch('exact')" id="lv-btn-exact" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600">ตรงกับคำว่า</button>
                                    <button type="button" onclick="liveSetMatch('contains')" id="lv-btn-contains" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white">มีคำว่า</button>
                                </div>
                                <div id="lv-keywords" class="flex flex-wrap items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl min-h-[50px]"></div>
                                <div class="mt-2 flex gap-2">
                                    <input type="text" id="lv-new-keyword" placeholder="พิมพ์คำดักเพิ่ม" class="px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                                    <button type="button" onclick="liveAddKeyword()" class="px-4 py-1.5 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-700">เพิ่มคำ</button>
                                </div>
                            </div>
                            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความตอบกลับใต้คอมเมนต์:</label>
                                    <textarea id="lv-reply-text" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500"></textarea>
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความส่งเข้าแชทส่วนตัว:</label>
                                    <textarea id="lv-inbox-text" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500"></textarea>
                                </div>
                            </div>
                            <div class="flex flex-wrap gap-5">
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-enable-like" class="w-4 h-4 rounded"><span class="text-sm text-slate-700">👍 กดไลก์คอมเมนต์</span></label>
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-enable-reply" class="w-4 h-4 rounded"><span class="text-sm text-slate-700">💬 เปิดใช้งานตอบกลับคอมเมนต์ใต้โพสต์</span></label>
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-enable-inbox" class="w-4 h-4 rounded"><span class="text-sm text-slate-700">📥 ส่งข้อความเข้าแชทส่วนตัว</span></label>
                            </div>
                            <div class="flex justify-end">
                                <button type="button" onclick="saveLiveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่า session นี้</button>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
                            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                                <h3 class="text-base font-bold text-slate-700 mb-3">💬 รายชื่อคนคอมเมนต์ (ล่าสุด 300 คน)</h3>
                                <div class="overflow-auto max-h-96">
                                    <table class="w-full text-xs">
                                        <thead class="text-left text-slate-500 border-b border-slate-200"><tr><th class="py-2 pr-2">ชื่อ</th><th class="py-2 pr-2">ครั้ง</th><th class="py-2 pr-2">ตรงคำดัก</th><th class="py-2 pr-2">คอมเมนต์ล่าสุด</th><th class="py-2">เวลา</th></tr></thead>
                                        <tbody id="lv-commenters"></tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                                <h3 class="text-base font-bold text-slate-700 mb-3">🧾 สลิปที่ตรวจผ่านใน session นี้</h3>
                                <div class="overflow-auto max-h-96">
                                    <table class="w-full text-xs">
                                        <thead class="text-left text-slate-500 border-b border-slate-200"><tr><th class="py-2 pr-2">เวลา</th><th class="py-2 pr-2">ลูกค้า</th><th class="py-2 pr-2 text-right">ยอด (บาท)</th><th class="py-2">เลขอ้างอิง</th></tr></thead>
                                        <tbody id="lv-slips"></tbody>
                                    </table>
                                </div>
                            </div>
                        </div>

                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                            <h3 class="text-base font-bold text-slate-700">🚀 บรอดแคสต์เฉพาะคนใน session นี้</h3>
                            <textarea id="lv-bc-message" rows="3" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="พิมพ์ข้อความ..."></textarea>
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">หน่วงรายคน (วินาที):</label><input type="number" id="lv-bc-delay" value="3" min="1" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ส่งครบ (คน) แล้วพัก:</label><input type="number" id="lv-bc-batch" value="20" min="1" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">พักเป็นเวลา (นาที):</label><input type="number" id="lv-bc-pause" value="10" min="1" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ผู้รับ:</label>
                                    <select id="lv-bc-target" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white">
                                        <option value="all">ทุกคนที่คอมเมนต์</option>
                                        <option value="matched">เฉพาะคนที่ตรงคำดัก</option>
                                    </select>
                                </div>
                            </div>
                            <div id="lv-bc-progress" class="hidden bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
                                <div class="flex justify-between text-xs font-semibold text-blue-700"><span id="lv-bc-status">-</span><span id="lv-bc-numbers">0/0</span></div>
                                <div class="w-full bg-blue-200 h-2.5 rounded-full overflow-hidden"><div id="lv-bc-bar" class="bg-blue-600 h-2.5 rounded-full w-0 transition-all duration-300"></div></div>
                            </div>
                            <div class="flex gap-3">
                                <button type="button" id="lv-btn-bc-start" onclick="startLiveBroadcast()" class="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 shadow-sm">เริ่มส่งบรอดแคสต์</button>
                                <button type="button" id="lv-btn-bc-stop" onclick="stopLiveBroadcast()" class="hidden px-6 py-2.5 bg-rose-600 text-white font-medium rounded-xl hover:bg-rose-700 shadow-sm">หยุดบรอดแคสต์</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="tab-webhook" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <h3 class="text-base font-bold text-slate-700">🌐 เพิ่มเพจเข้าระบบอัตโนมัติ (สูงสุด 5 เพจ)</h3>
                        <p class="text-xs text-slate-500">คลิกปุ่มด้านล่างเพื่อเข้าสู่ระบบ Facebook เลือกร้านค้าของคุณ ระบบจะดึงรายชื่อทุกเพจมาให้เลือกเพิ่มเข้าบัญชีของคุณ</p>
                        
                        <div class="flex items-center gap-4 pt-2">
                            <button type="button" onclick="loginWithFacebook()" class="px-6 py-3 bg-blue-600 text-white font-medium text-sm rounded-xl hover:bg-blue-700 shadow-md flex items-center gap-2 cursor-pointer">
                                <svg class="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                                <span>เข้าสู่ระบบด้วย Facebook เพื่อดึงเพจ</span>
                            </button>
                        </div>

                        <div id="page-select-box" class="bg-slate-50 p-4 rounded-xl border border-slate-200 mt-4 space-y-3">
                            <label class="text-xs font-semibold text-slate-700 block">🏪 เลือกเพจเพื่อเพิ่มเข้าระบบ (สูงสุด 5 เพจ):</label>
                            <div class="flex gap-2">
                                <select id="page-select-dropdown" class="flex-1 p-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-500">
                                    <option value="">-- ยังไม่ได้เลือกเพจ (กดปุ่มเข้าสู่ระบบ Facebook ด้านบนก่อน) --</option>
                                </select>
                                <button type="button" onclick="addSelectedPageToSystem()" class="px-4 py-2 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 shadow-sm shrink-0">➕ เพิ่มเพจนี้</button>
                            </div>

                            <div class="pt-2 border-t border-slate-200 flex items-center justify-between">
                                <span class="text-xs text-slate-500">ผูก Webhook ให้เพจที่กำลังเลือกอยู่ปัจจุบัน</span>
                                <button type="button" onclick="subscribeWebhookDirectly()" class="px-4 py-2 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700 shadow-sm flex items-center gap-1.5 shrink-0">
                                    ⚡ ผูก Webhook ให้เพจนี้ทันที
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-3">
                        <div class="flex flex-wrap items-center justify-between gap-3">
                            <h3 class="text-base font-bold text-slate-700">📡 สถานะการเชื่อมต่อ Webhook ของเพจนี้</h3>
                            <div class="flex gap-2">
                                <button type="button" onclick="checkSubscriptionStatus()" class="px-4 py-2 bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg hover:bg-slate-200">🔄 ตรวจสอบสถานะ</button>
                                <button type="button" onclick="subscribeWebhookDirectly()" class="px-4 py-2 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700">⚡ Subscribe ตอนนี้</button>
                            </div>
                        </div>
                        <div id="sub-status" class="text-sm p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600">ยังไม่ได้ตรวจสอบ กด "ตรวจสอบสถานะ"</div>
                        <details class="text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded-xl p-3">
                            <summary class="cursor-pointer font-semibold text-amber-700">ถ้ากด Subscribe แล้วยังไม่ได้ผล: ผูกด้วย Graph API Explorer (ชัวร์ที่สุด)</summary>
                            <ol class="list-decimal pl-5 mt-2 space-y-1">
                                <li>เปิด developers.facebook.com/tools/explorer แล้วเลือกแอปของคุณที่ช่อง Meta App</li>
                                <li>ที่ Permissions ติ๊กเพิ่ม pages_messaging และ pages_manage_metadata แล้วกด Generate Access Token</li>
                                <li>เลือกเพจของคุณในช่อง User or Page เพื่อให้ได้ Page Access Token</li>
                                <li>เปลี่ยน Method เป็น POST และใส่ Endpoint เป็น YOUR_PAGE_ID/subscribed_apps (แทนด้วยเลข Page ID)</li>
                                <li>กด + Add Parameter ใส่ key เป็น subscribed_fields และ value เป็น messages,messaging_postbacks,feed</li>
                                <li>กด Submit ถ้าขึ้น success เป็น true แปลว่าผูกสำเร็จ แล้วกลับมากด "ตรวจสอบสถานะ" ที่นี่</li>
                            </ol>
                            <p class="mt-2">เคล็ดลับ: คัดลอก Page Access Token จาก Explorer มาวางในช่อง Page Access Token ด้านล่าง ใส่ Page ID แล้วกดบันทึก ระบบจะใช้ Token นั้นกับเพจนี้ได้ทันที</p>
                        </details>
                    </div>

                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <h3 class="text-base font-bold text-slate-700">⚙️ ตั้งค่า Webhook สำหรับ Meta for Developers</h3>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Callback URL:</label>
                            <input type="text" id="webhook-url-display" readonly class="w-full p-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-600">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Verify Token:</label>
                            <input type="text" id="conf-verify-token" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Page Access Token:</label>
                            <input type="text" id="conf-page-token" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Facebook Page ID:</label>
                            <input type="text" id="conf-page-id" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                        </div>
                        <div class="pt-4 flex justify-end">
                            <button type="button" onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกตั้งค่า Webhook</button>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    </div>

    <script>
        let currentConfig = { keywords: [] };
        let statusInterval = null;
        let fetchedPagesList = [];
        let authToken = localStorage.getItem('auth_token') || '';
        let currentActivePageId = '';
        let authMode = 'login';

        function switchAuthMode(mode) {
            authMode = mode;
            document.getElementById('tab-login').className = mode === 'login' ? 'flex-1 py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-blue-600 transition-all' : 'flex-1 py-2 text-xs font-medium rounded-lg text-slate-500 transition-all';
            document.getElementById('tab-signup').className = mode === 'signup' ? 'flex-1 py-2 text-xs font-bold rounded-lg bg-white shadow-sm text-blue-600 transition-all' : 'flex-1 py-2 text-xs font-medium rounded-lg text-slate-500 transition-all';
            document.getElementById('auth-btn').innerText = mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก';
        }

        async function handleAuth() {
            const username = document.getElementById('auth-user').value.trim();
            const password = document.getElementById('auth-pass').value.trim();
            if(!username || !password) return alert('กรุณากรอกชื่อผู้ใช้และรหัสผ่านให้ครบถ้วน');

            const endpoint = authMode === 'login' ? '/api/login' : '/api/signup';
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if(data.success) {
                    authToken = data.token;
                    localStorage.setItem('auth_token', authToken);
                    checkAuthSession();
                } else {
                    alert('❌ ' + data.error);
                }
            } catch(e) {
                alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
            }
        }

        function logout() {
            localStorage.removeItem('auth_token');
            authToken = '';
            document.getElementById('auth-container').classList.remove('hidden');
            document.getElementById('app-container').classList.add('hidden');
        }

        async function checkAuthSession() {
            if(!authToken) return;
            try {
                const res = await fetch('/api/verify-session?token=' + authToken);
                const data = await res.json();
                if(data.success) {
                    document.getElementById('auth-container').classList.add('hidden');
                    document.getElementById('app-container').classList.remove('hidden');
                    document.getElementById('current-username').innerText = data.username;
                    loadUserPages();
                } else {
                    logout();
                }
            } catch(e) {
                logout();
            }
        }

        async function loadUserPages() {
            const res = await fetch('/api/user/pages?token=' + authToken);
            const data = await res.json();
            if(data.success) {
                const selector = document.getElementById('active-page-selector');
                selector.innerHTML = '';
                const pageIds = Object.keys(data.pages);
                if(pageIds.length === 0) {
                    selector.innerHTML = '<option value="">-- ยังไม่มีเพจในระบบ (ไปเพิ่มที่เมนูตั้งค่า) --</option>';
                    currentActivePageId = '';
                    document.getElementById('header-page-name').innerText = 'ยังไม่ได้เลือกเพจ';
                } else {
                    pageIds.forEach((pid, idx) => {
                        const pName = data.pages[pid].config.pageName || pid;
                        selector.innerHTML += '<option value="' + pid + '">' + pName + '</option>';
                        if(idx === 0 && !currentActivePageId) currentActivePageId = pid;
                    });
                    if(currentActivePageId && data.pages[currentActivePageId]) {
                        selector.value = currentActivePageId;
                    } else {
                        currentActivePageId = pageIds[0];
                        selector.value = currentActivePageId;
                    }
                    loadConfigForActivePage();
                }
            }
        }

        async function switchActivePage(pageId) {
            currentActivePageId = pageId;
            currentLiveId = '';
            document.getElementById('live-detail').classList.add('hidden');
            loadLiveList();
            loadConfigForActivePage();
        }

        async function deleteCurrentPage() {
            if(!currentActivePageId) return alert('⚠️ ไม่มีเพจให้ลบครับ');
            if(!confirm('⚠️ ยืนยันการลบเพจนี้ออกจากระบบ? บอตและข้อมูลตั้งค่าของเพจนี้จะถูกลบออก')) return;

            try {
                const res = await fetch('/api/user/delete-page?token=' + authToken, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pageId: currentActivePageId })
                });
                const data = await res.json();
                if(data.success) {
                    alert('🗑️ ลบเพจออกจากระบบเรียบร้อยแล้ว');
                    currentActivePageId = '';
                    loadUserPages();
                } else {
                    alert('❌ ลบเพจไม่สำเร็จ: ' + data.error);
                }
            } catch(e) {
                alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
            }
        }

        async function loadConfigForActivePage() {
            if(!currentActivePageId) return;
            const res = await fetch('/api/config?token=' + authToken + '&pageId=' + currentActivePageId);
            const data = await res.json();
            if(data.success) {
                currentConfig = data.config;
                if(!currentConfig.keywords) currentConfig.keywords = [];
                document.getElementById('header-page-name').innerText = currentConfig.pageName || currentConfig.pageId;
                document.getElementById('subscriber-count').innerText = (data.subscriberCount || 0) + ' คน';
                renderUI();
                checkSubscriptionStatus();
            }

            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('tab') === 'webhook') {
                switchTab('webhook');
            }

            const savedUserToken = localStorage.getItem('fb_user_token');
            if (savedUserToken) {
                fetchPagesWithToken(savedUserToken, false);
            }
        }

        function escapeHtml(str) {
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function renderUI() {
            if(!currentConfig.keywords) currentConfig.keywords = [];
            const kwContainer = document.getElementById('keywords-container');
            kwContainer.innerHTML = '';
            currentConfig.keywords.forEach((kw, i) => {
                const safeKw = escapeHtml(kw);
                kwContainer.innerHTML += '<span class="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-lg">' + safeKw + ' <button type="button" onclick="removeKeyword(' + i + ')" class="hover:text-red-200 font-bold ml-1">×</button></span>';
            });

            document.getElementById('reply-comment-input').value = currentConfig.replyCommentText || '';
            document.getElementById('inbox-input').value = currentConfig.inboxText || '';
            document.getElementById('enable-comment-reply').checked = !!currentConfig.enableCommentReply;
            document.getElementById('enable-inbox').checked = !!currentConfig.enableInbox;
            document.getElementById('enable-auto-like').checked = !!currentConfig.enableAutoLike;

            document.getElementById('conf-verify-token').value = currentConfig.verifyToken || '';
            document.getElementById('conf-page-token').value = currentConfig.pageAccessToken || '';
            document.getElementById('conf-page-id').value = currentConfig.pageId || '';
            document.getElementById('webhook-url-display').value = window.location.origin + '/webhook';
            
            document.getElementById('enable-slip-verify').checked = !!currentConfig.enableSlipVerify;
            document.getElementById('easyslip-api-key').value = currentConfig.easySlipApiKey || '';
            document.getElementById('merchant-bank').value = currentConfig.merchantBank || 'BAY';
            document.getElementById('merchant-account').value = currentConfig.merchantAccount || '';
            document.getElementById('merchant-name').value = currentConfig.merchantName || '';
            document.getElementById('msg-slip-success').value = currentConfig.msgSlipSuccess || '';
            document.getElementById('msg-slip-invalid').value = currentConfig.msgSlipInvalid || '';
            document.getElementById('msg-slip-unreadable').value = currentConfig.msgSlipUnreadable || '';
            document.getElementById('msg-slip-duplicate').value = currentConfig.msgSlipDuplicate || '';

            const isExact = currentConfig.matchType === 'exact';
            document.getElementById('btn-exact').className = isExact ? "px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white" : "px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600";
            document.getElementById('btn-contains').className = !isExact ? "px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white" : "px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600";
        }

        function loginWithFacebook() {
            const appId = '1611337127153323';
            const redirectUri = encodeURIComponent(window.location.origin + '/auth/facebook/callback');
            const scope = encodeURIComponent('pages_show_list,pages_messaging,pages_read_engagement,pages_read_user_content,pages_manage_engagement,pages_manage_metadata,pages_manage_posts');
            window.location.href = 'https://www.facebook.com/v19.0/dialog/oauth?client_id=' + appId + '&redirect_uri=' + redirectUri + '&scope=' + scope + '&auth_type=rerequest&response_type=token';
        }

        window.onload = () => {
            const hash = window.location.hash;
            if(hash.includes('access_token')) {
                const token = new URLSearchParams(hash.substring(1)).get('access_token');
                localStorage.setItem('fb_user_token', token);
                window.location.href = '/?tab=webhook&connected=true';
            }
            const savedFbToken = localStorage.getItem('fb_user_token');
            if(savedFbToken) fetchPagesWithToken(savedFbToken, false);
            checkAuthSession();
        };

        async function fetchPagesWithToken(token, showAlert) {
            try {
                const res = await fetch('/api/fetch-pages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userAccessToken: token })
                });
                const data = await res.json();

                if (data.success && data.pages) {
                    fetchedPagesList = data.pages;
                    const dropdown = document.getElementById('page-select-dropdown');
                    dropdown.innerHTML = '<option value="">-- เลือกเพจ --</option>';
                    data.pages.forEach((p, idx) => {
                        dropdown.innerHTML += '<option value="' + idx + '">' + escapeHtml(p.name) + ' (ID: ' + escapeHtml(p.id) + ')</option>';
                    });
                    if(showAlert) alert('✅ ดึงข้อมูลสำเร็จ พบ ' + data.pages.length + ' เพจ');
                } else {
                    if(showAlert) alert('❌ ไม่สามารถดึงรายชื่อเพจได้: ' + (data.error || 'Token หมดอายุ'));
                }
            } catch(e) {
                console.error(e);
            }
        }

        async function addSelectedPageToSystem() {
            const idx = document.getElementById('page-select-dropdown').value;
            if(idx === "") return alert('กรุณาเลือกเพจจากดรอปดาวน์ก่อนครับ');
            const selected = fetchedPagesList[idx];

            const res = await fetch('/api/user/add-page?token=' + authToken, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageId: selected.id, pageName: selected.name, pageAccessToken: selected.access_token })
            });
            const data = await res.json();
            if(data.success) {
                let msg = data.updated ? '✅ อัปเดต Token ของเพจเรียบร้อยแล้ว' : '✅ เพิ่มเพจเข้าสู่ระบบสำเร็จ!';
                if(data.subscribe && data.subscribe.success) msg += ' และผูก Webhook ให้อัตโนมัติแล้ว';
                else if(data.subscribe) msg += ' แต่ผูก Webhook ไม่สำเร็จ: ' + data.subscribe.error + ' (กด Subscribe ตอนนี้ หรือดูวิธีผูกด้วย Graph API Explorer ในหน้านี้)';
                alert(msg);
                loadUserPages();
            } else {
                alert('❌ ' + data.error);
            }
        }

        async function subscribeWebhookDirectly() {
            const pageToken = document.getElementById('conf-page-token').value;
            if(!pageToken) {
                alert('⚠️ กรุณาเลือกเพจที่กำลังใช้งานก่อนครับ!');
                return;
            }

            try {
                const res = await fetch('/api/subscribe-webhook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pageAccessToken: pageToken, pageId: document.getElementById('conf-page-id').value.trim() })
                });
                const data = await res.json();
                if(data.success) {
                    alert('🎉 ผูก Webhook (messages, feed, messaging_postbacks) ให้เพจสำเร็จเรียบร้อยแล้ว!');
                    checkSubscriptionStatus();
                } else {
                    alert('❌ ผูก Webhook ไม่สำเร็จ: ' + (data.error || 'Unknown error'));
                }
            } catch(e) {
                alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
            }
        }

        async function checkSubscriptionStatus() {
            const box = document.getElementById('sub-status');
            if(!currentActivePageId) { box.innerText = 'กรุณาเลือกเพจก่อน'; return; }
            box.innerText = 'กำลังตรวจสอบ...';
            try {
                const res = await fetch('/api/page/subscription-status?token=' + authToken + '&pageId=' + currentActivePageId);
                const d = await res.json();
                if(!d.success) {
                    box.className = 'text-sm p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700';
                    box.innerText = '❌ ตรวจสอบไม่สำเร็จ: ' + d.error;
                } else if(d.subscribed) {
                    box.className = 'text-sm p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700';
                    box.innerText = '✅ เชื่อมต่อแล้ว รับข้อมูลจาก: ' + d.fields.join(', ');
                } else {
                    box.className = 'text-sm p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700';
                    box.innerText = '⚠️ ยังไม่ได้เชื่อมต่อครบ' + (d.note ? ' (' + d.note + ')' : '') + ' ขาดฟิลด์: ' + d.missing.join(', ') + ' กด "Subscribe ตอนนี้"';
                }
            } catch(e) {
                box.innerText = '❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
            }
        }

        function switchSlipTab(tabKey) {
            ['success', 'invalid', 'unreadable', 'duplicate'].forEach(key => {
                document.getElementById('slip-msg-' + key).classList.add('hidden');
                document.getElementById('tab-btn-' + key).className = "pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700";
            });
            document.getElementById('slip-msg-' + tabKey).classList.remove('hidden');
            document.getElementById('tab-btn-' + tabKey).className = "pb-2.5 px-4 text-xs font-bold text-rose-600 border-b-2 border-rose-600";
        }

        function setMatchType(type) { currentConfig.matchType = type; renderUI(); }

        function addKeyword() {
            const val = document.getElementById('new-keyword-input').value.trim();
            if(!currentConfig.keywords) currentConfig.keywords = [];
            if(val && !currentConfig.keywords.includes(val)) {
                currentConfig.keywords.push(val);
                document.getElementById('new-keyword-input').value = '';
                renderUI();
            }
        }

        function removeKeyword(i) { 
            if(!currentConfig.keywords) currentConfig.keywords = [];
            currentConfig.keywords.splice(i, 1); 
            renderUI(); 
        }

        async function saveConfig() {
            if(!currentActivePageId) return alert('กรุณาเลือกเพจก่อนบันทึก');
            currentConfig.replyCommentText = document.getElementById('reply-comment-input').value;
            currentConfig.inboxText = document.getElementById('inbox-input').value;
            currentConfig.enableCommentReply = document.getElementById('enable-comment-reply').checked;
            currentConfig.enableInbox = document.getElementById('enable-inbox').checked;
            currentConfig.enableAutoLike = document.getElementById('enable-auto-like').checked;
            
            currentConfig.verifyToken = document.getElementById('conf-verify-token').value.trim();
            currentConfig.pageAccessToken = document.getElementById('conf-page-token').value.trim();
            currentConfig.pageId = document.getElementById('conf-page-id').value.trim();

            currentConfig.enableSlipVerify = document.getElementById('enable-slip-verify').checked;
            currentConfig.easySlipApiKey = document.getElementById('easyslip-api-key').value.trim();
            currentConfig.merchantBank = document.getElementById('merchant-bank').value;
            currentConfig.merchantAccount = document.getElementById('merchant-account').value;
            currentConfig.merchantName = document.getElementById('merchant-name').value;
            currentConfig.msgSlipSuccess = document.getElementById('msg-slip-success').value;
            currentConfig.msgSlipInvalid = document.getElementById('msg-slip-invalid').value;
            currentConfig.msgSlipUnreadable = document.getElementById('msg-slip-unreadable').value;
            currentConfig.msgSlipDuplicate = document.getElementById('msg-slip-duplicate').value;

            const res = await fetch('/api/config?token=' + authToken + '&pageId=' + currentActivePageId, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify(currentConfig) 
            });
            const data = await res.json();
            if(data.success) {
                alert('✅ บันทึกการตั้งค่า Webhook และเพจเรียบร้อยแล้ว!');
                loadUserPages();
            } else {
                alert('❌ บันทึกไม่สำเร็จ: ' + data.error);
            }
        }

        // ===================== Live Sessions =====================
        let liveCfg = { keywords: [], matchType: 'contains' };
        let currentLiveId = '';
        let currentLiveStatus = 'active';
        let livePollTimer = null;

        function liveUrl(path, extra) {
            return path + '?token=' + authToken + '&pageId=' + currentActivePageId + (extra || '');
        }

        function fmtTime(t) {
            if(!t) return '-';
            return new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        function fmtMoney(n) {
            return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
        }

        function startLivePolling() {
            stopLivePolling();
            livePollTimer = setInterval(refreshLive, 5000);
        }

        function stopLivePolling() {
            if(livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
        }

        async function refreshLive() {
            await loadLiveList();
            if(currentLiveId) await loadLiveDetail(false);
        }

        async function loadLiveList() {
            const box = document.getElementById('live-list');
            if(!currentActivePageId) {
                box.innerHTML = '<p class="text-xs text-slate-400">กรุณาเลือกหรือเพิ่มเพจก่อน</p>';
                return;
            }
            try {
                const res = await fetch(liveUrl('/api/live/list'));
                const data = await res.json();
                if(!data.success) { box.innerHTML = ''; return; }
                if(data.sessions.length === 0) {
                    box.innerHTML = '<p class="text-xs text-slate-400">ยังไม่มี session กดเริ่ม session ใหม่ด้านบนได้เลย</p>';
                    return;
                }
                let html = '';
                data.sessions.forEach(function(s) {
                    const active = s.status === 'active';
                    const badge = active
                        ? '<span class="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">● กำลังทำงาน</span>'
                        : '<span class="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full font-semibold">จบแล้ว</span>';
                    const sel = s.id === currentLiveId ? 'border-blue-500 bg-blue-50/40' : 'border-slate-200 hover:bg-slate-50';
                    const bind = s.videoId ? 'Video ID: ' + escapeHtml(s.videoId) : 'เปิด/ปิดเอง (ไม่ผูก Video ID)';
                    html += '<div data-sid="' + escapeHtml(s.id) + '" class="cursor-pointer border ' + sel + ' rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">'
                        + '<div class="min-w-0"><div class="text-sm font-semibold text-slate-800">' + escapeHtml(s.name) + ' ' + badge + '</div>'
                        + '<div class="text-xs text-slate-500">' + bind + ' · เริ่ม ' + escapeHtml(new Date(s.startedAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })) + '</div></div>'
                        + '<div class="text-xs text-slate-600">คอมเมนต์ ' + s.stats.comments + ' · ตรงคำดัก ' + s.stats.matched + ' · ' + s.stats.uniqueCommenters + ' คน · สลิป ' + s.stats.slips + ' (' + fmtMoney(s.stats.slipTotal) + ' บาท)</div>'
                        + '</div>';
                });
                box.innerHTML = html;
                box.onclick = function(e) {
                    const el = e.target.closest('[data-sid]');
                    if(el) selectLiveSession(el.getAttribute('data-sid'));
                };
            } catch(e) { console.error(e); }
        }

        async function createLiveSession() {
            if(!currentActivePageId) return alert('กรุณาเลือกเพจก่อน');
            const name = document.getElementById('live-new-name').value.trim();
            const videoId = document.getElementById('live-new-video').value.trim();
            const res = await fetch(liveUrl('/api/live/create'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, videoId })
            });
            const data = await res.json();
            if(data.success) {
                document.getElementById('live-new-name').value = '';
                document.getElementById('live-new-video').value = '';
                await selectLiveSession(data.id);
            } else {
                alert('❌ ' + data.error);
            }
        }

        async function selectLiveSession(sid) {
            currentLiveId = sid;
            await loadLiveDetail(true);
            loadLiveList();
        }

        async function loadLiveDetail(withConfig) {
            if(!currentLiveId) return;
            const res = await fetch(liveUrl('/api/live/detail', '&sid=' + currentLiveId));
            const d = await res.json();
            if(!d.success) {
                currentLiveId = '';
                document.getElementById('live-detail').classList.add('hidden');
                return;
            }
            document.getElementById('live-detail').classList.remove('hidden');
            if(withConfig) renderLiveConfig(d);
            renderLiveStats(d);
        }

        function renderLiveConfig(d) {
            liveCfg = d.config;
            if(!liveCfg.keywords) liveCfg.keywords = [];
            document.getElementById('live-name-input').value = d.session.name;
            document.getElementById('lv-reply-text').value = liveCfg.replyCommentText || '';
            document.getElementById('lv-inbox-text').value = liveCfg.inboxText || '';
            document.getElementById('lv-enable-like').checked = !!liveCfg.enableAutoLike;
            document.getElementById('lv-enable-reply').checked = !!liveCfg.enableCommentReply;
            document.getElementById('lv-enable-inbox').checked = !!liveCfg.enableInbox;
            renderLiveKeywords();
        }

        function renderLiveKeywords() {
            const box = document.getElementById('lv-keywords');
            box.innerHTML = '';
            liveCfg.keywords.forEach(function(kw, i) {
                box.innerHTML += '<span class="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-lg">' + escapeHtml(kw) + ' <button type="button" onclick="liveRemoveKeyword(' + i + ')" class="hover:text-red-200 font-bold ml-1">×</button></span>';
            });
            const isExact = liveCfg.matchType === 'exact';
            document.getElementById('lv-btn-exact').className = isExact ? 'px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white' : 'px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600';
            document.getElementById('lv-btn-contains').className = !isExact ? 'px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white' : 'px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600';
        }

        function liveSetMatch(type) { liveCfg.matchType = type; renderLiveKeywords(); }

        function liveAddKeyword() {
            const input = document.getElementById('lv-new-keyword');
            const val = input.value.trim();
            if(val && !liveCfg.keywords.includes(val)) {
                liveCfg.keywords.push(val);
                input.value = '';
                renderLiveKeywords();
            }
        }

        function liveRemoveKeyword(i) { liveCfg.keywords.splice(i, 1); renderLiveKeywords(); }

        function renderLiveStats(d) {
            const s = d.session;
            currentLiveStatus = s.status;
            document.getElementById('live-meta').innerText = (s.videoId ? 'ผูกกับ Video ID: ' + s.videoId : 'เปิด/ปิดเอง (ไม่ผูก Video ID)') + ' · ' + (s.status === 'active' ? 'กำลังทำงาน' : 'จบแล้ว');
            const toggle = document.getElementById('live-btn-toggle');
            toggle.innerText = s.status === 'active' ? '⏹️ จบ session' : '▶️ เปิด session อีกครั้ง';
            toggle.className = s.status === 'active'
                ? 'px-4 py-2 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600'
                : 'px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700';

            document.getElementById('lv-stat-comments').innerText = s.stats.comments;
            document.getElementById('lv-stat-matched').innerText = s.stats.matched;
            document.getElementById('lv-stat-people').innerText = s.stats.uniqueCommenters;
            document.getElementById('lv-stat-slips').innerText = s.stats.slips;
            document.getElementById('lv-stat-total').innerText = fmtMoney(s.stats.slipTotal);

            let ch = '';
            d.commenters.forEach(function(c) {
                ch += '<tr class="border-b border-slate-100"><td class="py-1.5 pr-2 font-medium text-slate-700">' + escapeHtml(c.name || c.userId) + '</td>'
                    + '<td class="py-1.5 pr-2">' + c.count + '</td>'
                    + '<td class="py-1.5 pr-2">' + (c.matchedCount > 0 ? '<span class="text-blue-600 font-semibold">' + c.matchedCount + ' (' + escapeHtml(c.lastKeyword) + ')</span>' : '-') + '</td>'
                    + '<td class="py-1.5 pr-2 text-slate-600">' + escapeHtml(c.lastMessage) + '</td>'
                    + '<td class="py-1.5 text-slate-500">' + fmtTime(c.lastTime) + '</td></tr>';
            });
            document.getElementById('lv-commenters').innerHTML = ch || '<tr><td colspan="5" class="py-3 text-slate-400">ยังไม่มีคอมเมนต์</td></tr>';

            let sh = '';
            d.slips.forEach(function(x) {
                sh += '<tr class="border-b border-slate-100"><td class="py-1.5 pr-2 text-slate-500">' + fmtTime(x.time) + '</td>'
                    + '<td class="py-1.5 pr-2 font-medium text-slate-700">' + escapeHtml(x.senderName || x.senderId) + '</td>'
                    + '<td class="py-1.5 pr-2 text-right text-emerald-600 font-semibold">' + fmtMoney(x.amount) + '</td>'
                    + '<td class="py-1.5 text-slate-500">' + escapeHtml(x.transRef) + '</td></tr>';
            });
            document.getElementById('lv-slips').innerHTML = sh || '<tr><td colspan="4" class="py-3 text-slate-400">ยังไม่มีสลิป</td></tr>';

            const bc = d.broadcastStatus;
            const area = document.getElementById('lv-bc-progress');
            if(bc.isBroadcasting || bc.total > 0) {
                area.classList.remove('hidden');
                document.getElementById('lv-bc-status').innerText = bc.statusMessage;
                document.getElementById('lv-bc-numbers').innerText = bc.current + '/' + bc.total + ' (สำเร็จ: ' + bc.success + ', ล้มเหลว: ' + bc.failed + ')';
                document.getElementById('lv-bc-bar').style.width = (bc.total > 0 ? (bc.current / bc.total) * 100 : 0) + '%';
            } else {
                area.classList.add('hidden');
            }
            document.getElementById('lv-btn-bc-start').classList.toggle('hidden', !!bc.isBroadcasting);
            document.getElementById('lv-btn-bc-stop').classList.toggle('hidden', !bc.isBroadcasting);
        }

        async function saveLiveConfig() {
            if(!currentLiveId) return;
            const body = {
                name: document.getElementById('live-name-input').value,
                keywords: liveCfg.keywords,
                matchType: liveCfg.matchType,
                replyCommentText: document.getElementById('lv-reply-text').value,
                inboxText: document.getElementById('lv-inbox-text').value,
                enableAutoLike: document.getElementById('lv-enable-like').checked,
                enableCommentReply: document.getElementById('lv-enable-reply').checked,
                enableInbox: document.getElementById('lv-enable-inbox').checked
            };
            const res = await fetch(liveUrl('/api/live/config', '&sid=' + currentLiveId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if(data.success) { alert('✅ บันทึกการตั้งค่า session นี้แล้ว'); loadLiveList(); }
            else alert('❌ ' + data.error);
        }

        async function toggleLiveStatus() {
            if(!currentLiveId) return;
            const next = currentLiveStatus === 'active' ? 'ended' : 'active';
            if(next === 'ended' && !confirm('จบ session นี้? บอตจะหยุดนับคอมเมนต์เข้า session นี้ (ข้อมูลยังอยู่ เปิดใหม่ได้)')) return;
            const res = await fetch(liveUrl('/api/live/status', '&sid=' + currentLiveId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next })
            });
            const data = await res.json();
            if(!data.success) alert('❌ ' + data.error);
            refreshLive();
        }

        async function deleteLiveSession() {
            if(!currentLiveId) return;
            if(!confirm('ลบ session นี้พร้อมข้อมูลคอมเมนต์และสลิปทั้งหมด?')) return;
            await fetch(liveUrl('/api/live/delete', '&sid=' + currentLiveId), { method: 'POST' });
            currentLiveId = '';
            document.getElementById('live-detail').classList.add('hidden');
            loadLiveList();
        }

        async function startLiveBroadcast() {
            if(!currentLiveId) return;
            const message = document.getElementById('lv-bc-message').value.trim();
            if(!message) return alert('กรุณากรอกข้อความบรอดแคสก่อนครับ!');
            if(!confirm('ยืนยันเริ่มส่งบรอดแคสต์ให้คนใน session นี้?')) return;
            const res = await fetch(liveUrl('/api/live/broadcast/start', '&sid=' + currentLiveId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    delaySec: parseInt(document.getElementById('lv-bc-delay').value) || 3,
                    batchSize: parseInt(document.getElementById('lv-bc-batch').value) || 20,
                    pauseMin: parseInt(document.getElementById('lv-bc-pause').value) || 10,
                    onlyMatched: document.getElementById('lv-bc-target').value === 'matched'
                })
            });
            const data = await res.json();
            if(!data.success) alert('❌ ' + data.error);
            loadLiveDetail(false);
        }

        async function stopLiveBroadcast() {
            if(!currentLiveId) return;
            await fetch(liveUrl('/api/live/broadcast/stop', '&sid=' + currentLiveId), { method: 'POST' });
            loadLiveDetail(false);
        }
        // =========================================================

        function switchTab(tabId) {
            ['dashboard', 'slip', 'broadcast', 'live', 'webhook'].forEach(id => {
                document.getElementById('tab-' + id).classList.add('hidden');
                document.getElementById('nav-' + id).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50";
            });
            document.getElementById('tab-' + tabId).classList.remove('hidden');
            if(tabId === 'live') { loadLiveList(); startLivePolling(); } else { stopLivePolling(); }
            document.getElementById('nav-' + tabId).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600";
        }

        async function startBroadcast() {
            if(!currentActivePageId) return alert('กรุณาเลือกเพจก่อน');
            const message = document.getElementById('bc-message').value.trim();
            const delaySec = parseInt(document.getElementById('bc-delay').value) || 3;
            const batchSize = parseInt(document.getElementById('bc-batch-size').value) || 20;
            const pauseMin = parseInt(document.getElementById('bc-pause-min').value) || 10;

            if(!message) return alert('กรุณากรอกข้อความบรอดแคสก่อนครับ!');
            if(!confirm('ยืนยันเริ่มส่งบรอดแคส?')) return;

            const res = await fetch('/api/broadcast/start?token=' + authToken + '&pageId=' + currentActivePageId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, delaySec, batchSize, pauseMin })
            });
            const data = await res.json();
            if(data.success) {
                document.getElementById('bc-progress-area').classList.remove('hidden');
                document.getElementById('btn-start-bc').classList.add('hidden');
                document.getElementById('btn-stop-bc').classList.remove('hidden');
                statusInterval = setInterval(checkBroadcastStatus, 1000);
            } else {
                alert('เกิดข้อผิดพลาด: ' + data.error);
            }
        }

        async function stopBroadcast() {
            await fetch('/api/broadcast/stop?token=' + authToken + '&pageId=' + currentActivePageId, { method: 'POST' });
            alert('ส่งคำสั่งหยุดบรอดแคสเรียบร้อยแล้ว');
        }

        async function checkBroadcastStatus() {
            const res = await fetch('/api/broadcast/status?token=' + authToken + '&pageId=' + currentActivePageId);
            const status = await res.json();

            document.getElementById('bc-status-text').innerText = status.statusMessage;
            document.getElementById('bc-numbers').innerText = status.current + '/' + status.total + ' (สำเร็จ: ' + status.success + ', ล้มเหลว: ' + status.failed + ')';

            const pct = status.total > 0 ? (status.current / status.total) * 100 : 0;
            document.getElementById('bc-progress-bar').style.width = pct + '%';

            if(!status.isBroadcasting) {
                clearInterval(statusInterval);
                document.getElementById('btn-start-bc').classList.remove('hidden');
                document.getElementById('btn-stop-bc').classList.add('hidden');
            }
        }
    </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// 2. Endpoint ระบบ Authentication 
// -------------------------------------------------------------
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  if (usersDB[username]) return res.json({ success: false, error: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว' });

  usersDB[username] = {
    password: password,
    pages: {} 
  };

  const token = 'token_' + crypto.randomBytes(32).toString('hex');
  sessions[token] = username;
  res.json({ success: true, token });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!usersDB[username] || usersDB[username].password !== password) {
    return res.json({ success: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }

  const token = 'token_' + crypto.randomBytes(32).toString('hex');
  sessions[token] = username;
  res.json({ success: true, token });
});

app.get('/api/verify-session', (req, res) => {
  const token = req.query.token;
  if (token && sessions[token]) {
    res.json({ success: true, username: sessions[token] });
  } else {
    res.json({ success: false });
  }
});

// -------------------------------------------------------------
// 3. Facebook OAuth Callback
// -------------------------------------------------------------
app.get('/auth/facebook/callback', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>กำลังเชื่อมต่อ Facebook...</title></head>
<body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
    <h2>⏳ กำลังดึงรายชื่อเพจของคุณ...</h2>
    <script>
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');

        if (accessToken) {
            localStorage.setItem('fb_user_token', accessToken);
            window.location.href = '/?tab=webhook&connected=true';
        } else {
            alert('❌ การเข้าสู่ระบบถูกยกเลิก');
            window.location.href = '/';
        }
    </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// 4. API จัดการเพจและตั้งค่า
// -------------------------------------------------------------
app.get('/api/user/pages', checkAuth, (req, res) => {
  res.json({ success: true, pages: usersDB[req.userId].pages });
});

// -------------------------------------------------------------
// ผูก/ตรวจสอบ Webhook ของเพจ
// -------------------------------------------------------------
const SUBSCRIBE_FIELDS = 'messages,messaging_postbacks,feed';
const REQUIRED_FIELDS = ['messages', 'messaging_postbacks', 'feed'];

function graphErrorMessage(err) {
  const msg = err.response?.data?.error?.message || err.message;
  const code = err.response?.data?.error?.code;
  let hint = '';
  if (code === 200 || /permission/i.test(msg)) {
    hint = ' (ขาดสิทธิ์ ให้เข้าสู่ระบบ Facebook ใหม่และอนุญาตสิทธิ์ pages_manage_metadata, pages_messaging แล้วกดเพิ่มเพจใหม่)';
  } else if (code === 190) {
    hint = ' (Token หมดอายุหรือไม่ถูกต้อง ให้เข้าสู่ระบบ Facebook ใหม่แล้วกดเพิ่มเพจ)';
  }
  return msg + hint;
}

async function subscribePage(pageId, pageAccessToken) {
  const target = pageId ? encodeURIComponent(pageId) : 'me';
  const response = await axios.post('https://graph.facebook.com/v19.0/' + target + '/subscribed_apps', {}, {
    params: { subscribed_fields: SUBSCRIBE_FIELDS, access_token: pageAccessToken },
    timeout: 10000
  });
  return response.data;
}

async function autoSubscribe(pageId, pageAccessToken) {
  try {
    await subscribePage(pageId, pageAccessToken);
    return { success: true };
  } catch (err) {
    return { success: false, error: graphErrorMessage(err) };
  }
}

app.get('/api/page/subscription-status', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });

  const token = pageData.config.pageAccessToken;
  const pid = pageData.config.pageId || req.query.pageId;
  if (!token) return res.json({ success: true, subscribed: false, fields: [], missing: REQUIRED_FIELDS, note: 'ยังไม่มี Page Access Token' });

  try {
    const response = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(pid) + '/subscribed_apps', {
      params: { access_token: token },
      timeout: 10000
    });
    const apps = response.data.data || [];
    const mine = apps.find(a => String(a.id) === String(defaultPageConfig.appId)) || apps[0];
    const fields = mine ? (mine.subscribed_fields || []) : [];
    const missing = REQUIRED_FIELDS.filter(f => !fields.includes(f));
    res.json({ success: true, subscribed: !!mine && missing.length === 0, appFound: !!mine, fields, missing });
  } catch (err) {
    res.json({ success: false, error: graphErrorMessage(err) });
  }
});

app.post('/api/user/add-page', checkAuth, async (req, res) => {
  const username = req.userId;
  const { pageId, pageName, pageAccessToken } = req.body;
  
  if (!pageId || !pageAccessToken) return res.json({ success: false, error: 'ข้อมูลเพจไม่ครบถ้วน' });

  const userPages = usersDB[username].pages;

  if (userPages[pageId]) {
    userPages[pageId].config.pageAccessToken = pageAccessToken;
    if (pageName) userPages[pageId].config.pageName = pageName;
    const subscribeUpd = await autoSubscribe(pageId, pageAccessToken);
    return res.json({ success: true, updated: true, subscribe: subscribeUpd });
  }
  if (Object.keys(userPages).length >= 5) return res.json({ success: false, error: 'จำกัดการเพิ่มสูงสุดไม่เกิน 5 เพจต่อ User ครับ' });

  const newPageData = {
    config: { ...defaultPageConfig, pageId, pageName, pageAccessToken },
    subscribers: new Set(),
    usedSlips: new Set(),
    liveSessions: {},
    broadcastStatus: { isBroadcasting: false, total: 0, current: 0, success: 0, failed: 0, statusMessage: 'พร้อมใช้งาน', shouldStop: false }
  };

  userPages[pageId] = newPageData;
  pageIndexMap[pageId] = { username, pageData: newPageData };

  const subscribe = await autoSubscribe(pageId, pageAccessToken);
  res.json({ success: true, subscribe });
});

app.post('/api/user/delete-page', checkAuth, (req, res) => {
  const username = req.userId;
  const { pageId } = req.body;
  const userPages = usersDB[username].pages;

  if (userPages[pageId]) {
    delete userPages[pageId];
    delete pageIndexMap[pageId];
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'ไม่พบเพจนี้ในระบบ' });
  }
});

app.get('/api/config', checkAuth, (req, res) => {
  const username = req.userId;
  const pageId = req.query.pageId;
  const pageData = usersDB[username]?.pages[pageId];

  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });

  res.json({ 
    success: true, 
    config: pageData.config, 
    subscriberCount: pageData.subscribers.size 
  });
});

app.post('/api/config', checkAuth, (req, res) => {
  const username = req.userId;
  const pageId = req.query.pageId;
  const pageData = usersDB[username]?.pages[pageId];

  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });

  const oldPageId = pageData.config.pageId;
  pageData.config = { ...pageData.config, ...req.body };
  
  if (oldPageId && pageIndexMap[oldPageId]) {
    delete pageIndexMap[oldPageId];
  }
  if (pageData.config.pageId) {
    pageIndexMap[pageData.config.pageId] = { username, pageData };
  }
  pageIndexMap[pageId] = { username, pageData };

  res.json({ success: true });
});

// 🛠️ ปรับปรุงระบบดึงเพจให้วนลูปดึง Pagination จนครบทุกเพจ
app.post('/api/fetch-pages', async (req, res) => {
  const { userAccessToken } = req.body;
  if (!userAccessToken) return res.json({ success: false, error: 'ไม่พบ Access Token' });

  try {
    let allPages = [];
    let nextPageUrl = `https://graph.facebook.com/v19.0/me/accounts?limit=100&access_token=${userAccessToken}`;

    while (nextPageUrl) {
      const response = await axios.get(nextPageUrl, { timeout: 15000 });
      const data = response.data;

      if (data && data.data) {
        allPages = allPages.concat(data.data);
      }

      nextPageUrl = data.paging && data.paging.next ? data.paging.next : null;
    }

    console.log(`✅ [Fetch Pages] ดึงข้อมูลเพจสำเร็จทั้งหมด ${allPages.length} เพจ`);
    res.json({ success: true, pages: allPages });
  } catch (err) {
    console.error('❌ [Fetch Pages Error]:', err.response?.data || err.message);
    res.json({ success: false, error: err.response?.data?.error?.message || err.message });
  }
});

app.post('/api/subscribe-webhook', async (req, res) => {
  const { pageAccessToken, pageId } = req.body;
  if (!pageAccessToken) return res.json({ success: false, error: 'ไม่พบ Page Access Token' });

  try {
    const data = await subscribePage(pageId, pageAccessToken);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: graphErrorMessage(err) });
  }
});

// -------------------------------------------------------------
// 5. API บรอดแคส
// -------------------------------------------------------------
app.post('/api/broadcast/start', checkAuth, async (req, res) => {
  const username = req.userId;
  const pageId = req.query.pageId;
  const { message, delaySec, batchSize, pauseMin } = req.body;
  
  const pageData = usersDB[username]?.pages[pageId];
  if (!pageData) return res.json({ success: false, error: 'กรุณาเลือกเพจก่อนทำรายการ' });
  
  if (pageData.broadcastStatus.isBroadcasting) return res.json({ success: false, error: 'กำลังรันบรอดแคสอยู่แล้ว' });
  if (pageData.subscribers.size === 0) return res.json({ success: false, error: 'ยังไม่มีผู้รับในระบบของเพจนี้' });

  const subList = Array.from(pageData.subscribers);
  pageData.broadcastStatus = { isBroadcasting: true, total: subList.length, current: 0, success: 0, failed: 0, statusMessage: 'กำลังเริ่มส่ง...', shouldStop: false };
  res.json({ success: true });

  (async () => {
    let currentBatchCount = 0;
    for (let i = 0; i < subList.length; i++) {
      if (pageData.broadcastStatus.shouldStop) break;
      const recipientId = subList[i];
      pageData.broadcastStatus.current = i + 1;
      pageData.broadcastStatus.statusMessage = 'กำลังส่งหาผู้รับที่ ' + (i + 1) + '/' + subList.length + '...';

      try {
        await axios.post('https://graph.facebook.com/v19.0/me/messages', {
          recipient: { id: recipientId },
          message: { text: message }
        }, { 
          params: { access_token: pageData.config.pageAccessToken },
          timeout: 10000 
        });
        pageData.broadcastStatus.success++;
      } catch (err) {
        pageData.broadcastStatus.failed++;
      }

      currentBatchCount++;
      if (currentBatchCount >= batchSize && (i + 1) < subList.length) {
        currentBatchCount = 0;
        for (let m = pauseMin; m > 0; m--) {
          if (pageData.broadcastStatus.shouldStop) break;
          pageData.broadcastStatus.statusMessage = '⏳ พักระบบ ' + m + ' นาที...';
          await sleep(60 * 1000);
        }
      } else {
        await sleep(delaySec * 1000);
      }
    }
    pageData.broadcastStatus.isBroadcasting = false;
    if (!pageData.broadcastStatus.shouldStop) pageData.broadcastStatus.statusMessage = '✅ บรอดแคสเสร็จสิ้นสมบูรณ์!';
  })();
});

app.post('/api/broadcast/stop', checkAuth, (req, res) => {
  const username = req.userId;
  const pageId = req.query.pageId;
  if (usersDB[username]?.pages[pageId]) {
    usersDB[username].pages[pageId].broadcastStatus.shouldStop = true;
  }
  res.json({ success: true });
});

app.get('/api/broadcast/status', checkAuth, (req, res) => {
  const username = req.userId;
  const pageId = req.query.pageId;
  if (usersDB[username]?.pages[pageId]) {
    res.json(usersDB[username].pages[pageId].broadcastStatus);
  } else {
    res.json({ isBroadcasting: false, statusMessage: 'ไม่พบข้อมูล' });
  }
});

// -------------------------------------------------------------
// 5.5 ระบบ Live Session (แยกข้อมูลตามไลฟ์แต่ละรอบ)
// -------------------------------------------------------------
function getLiveSessions(pageData) {
  if (!pageData.liveSessions) pageData.liveSessions = {};
  return pageData.liveSessions;
}

function parseVideoId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let m = raw.match(/videos\/(\d+)/);
  if (m) return m[1];
  m = raw.match(/[?&]v=(\d+)/);
  if (m) return m[1];
  const nums = raw.match(/\d{8,}/g);
  if (nums) return nums[nums.length - 1];
  return raw.replace(/[^0-9_]/g, '');
}

function findLiveSessionForComment(pageData, postId, videoId) {
  const active = Object.values(getLiveSessions(pageData)).filter(s => s.status === 'active');
  const ids = [postId, videoId].filter(Boolean).map(String);
  const byVideo = active.find(s => s.videoId && ids.some(id =>
    id === s.videoId || id.endsWith('_' + s.videoId) || s.videoId.endsWith('_' + id)));
  if (byVideo) return byVideo;
  const manual = active.filter(s => !s.videoId).sort((a, b) => b.startedAt - a.startedAt);
  return manual[0] || null;
}

function findLiveSessionForSender(pageData, senderId) {
  const all = Object.values(getLiveSessions(pageData));
  let best = null, bestTime = 0;
  for (const s of all) {
    const c = s.commenters.get(senderId);
    if (c && c.lastTime > bestTime) { best = s; bestTime = c.lastTime; }
  }
  if (best) return best;
  const active = all.filter(s => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt);
  return active[0] || null;
}

function findMatchedKeyword(cfg, text) {
  const list = cfg.keywords || [];
  const t = String(text || '').toLowerCase();
  if (cfg.matchType === 'exact') {
    return list.find(kw => t.trim() === String(kw).toLowerCase()) || '';
  }
  return list.find(kw => t.includes(String(kw).toLowerCase())) || '';
}

function liveSummary(s) {
  const slipTotal = s.slips.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  return {
    id: s.id, name: s.name, videoId: s.videoId, status: s.status,
    startedAt: s.startedAt, endedAt: s.endedAt || null,
    stats: {
      comments: s.stats.comments, matched: s.stats.matched,
      uniqueCommenters: s.commenters.size, slips: s.slips.length, slipTotal
    }
  };
}

function getLiveContext(req, res) {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) { res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' }); return null; }
  const live = getLiveSessions(pageData)[req.query.sid];
  return { pageData, live };
}

app.get('/api/live/list', checkAuth, (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const sessionsList = Object.values(getLiveSessions(pageData))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(liveSummary);
  res.json({ success: true, sessions: sessionsList });
});

app.post('/api/live/create', checkAuth, (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });

  const liveMap = getLiveSessions(pageData);
  if (Object.keys(liveMap).length >= 100) return res.json({ success: false, error: 'มี session มากเกินไป กรุณาลบ session เก่าก่อน' });

  const videoId = parseVideoId(req.body.videoId);
  if (videoId) {
    const dup = Object.values(liveMap).find(s => s.status === 'active' && s.videoId === videoId);
    if (dup) return res.json({ success: false, error: 'มี session ที่ผูกกับไลฟ์นี้และกำลังทำงานอยู่แล้ว: ' + dup.name });
  }

  const name = String(req.body.name || '').trim() ||
    ('ไลฟ์ ' + new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }));
  const c = pageData.config;
  const id = 'live_' + crypto.randomBytes(6).toString('hex');

  liveMap[id] = {
    id, name, videoId,
    status: 'active',
    startedAt: Date.now(),
    endedAt: null,
    config: {
      keywords: [...(c.keywords || [])],
      matchType: c.matchType || 'contains',
      replyCommentText: c.replyCommentText || '',
      inboxText: c.inboxText || '',
      enableCommentReply: !!c.enableCommentReply,
      enableInbox: !!c.enableInbox,
      enableAutoLike: !!c.enableAutoLike
    },
    stats: { comments: 0, matched: 0 },
    commenters: new Map(),
    slips: [],
    broadcastStatus: { isBroadcasting: false, total: 0, current: 0, success: 0, failed: 0, statusMessage: 'พร้อมใช้งาน', shouldStop: false }
  };
  res.json({ success: true, id });
});

app.get('/api/live/detail', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });

  const commenters = Array.from(s.commenters.entries())
    .map(([userId, c]) => ({ userId, ...c }))
    .sort((a, b) => b.lastTime - a.lastTime)
    .slice(0, 300);

  res.json({
    success: true,
    session: liveSummary(s),
    config: s.config,
    commenters,
    slips: s.slips.slice(-200).reverse(),
    broadcastStatus: s.broadcastStatus
  });
});

app.post('/api/live/config', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });

  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim();
  if (Array.isArray(b.keywords)) s.config.keywords = b.keywords.map(k => String(k).trim()).filter(Boolean);
  if (b.matchType === 'exact' || b.matchType === 'contains') s.config.matchType = b.matchType;
  if (typeof b.replyCommentText === 'string') s.config.replyCommentText = b.replyCommentText;
  if (typeof b.inboxText === 'string') s.config.inboxText = b.inboxText;
  if (typeof b.enableCommentReply === 'boolean') s.config.enableCommentReply = b.enableCommentReply;
  if (typeof b.enableInbox === 'boolean') s.config.enableInbox = b.enableInbox;
  if (typeof b.enableAutoLike === 'boolean') s.config.enableAutoLike = b.enableAutoLike;
  res.json({ success: true });
});

app.post('/api/live/status', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });

  const status = req.body.status;
  if (status === 'ended') {
    s.status = 'ended';
    s.endedAt = Date.now();
  } else if (status === 'active') {
    if (s.videoId) {
      const dup = Object.values(getLiveSessions(ctx.pageData)).find(x => x.id !== s.id && x.status === 'active' && x.videoId === s.videoId);
      if (dup) return res.json({ success: false, error: 'มี session อื่นที่ผูกกับไลฟ์นี้ทำงานอยู่แล้ว: ' + dup.name });
    }
    s.status = 'active';
    s.startedAt = Date.now();
    s.endedAt = null;
  } else {
    return res.json({ success: false, error: 'สถานะไม่ถูกต้อง' });
  }
  res.json({ success: true });
});

app.post('/api/live/delete', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  if (!ctx.live) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  ctx.live.broadcastStatus.shouldStop = true;
  delete getLiveSessions(ctx.pageData)[req.query.sid];
  res.json({ success: true });
});

async function runLiveBroadcast(live, pageToken, recipients, message, delaySec, batchSize, pauseMin) {
  const st = live.broadcastStatus;
  let batchCount = 0;
  for (let i = 0; i < recipients.length; i++) {
    if (st.shouldStop) break;
    st.current = i + 1;
    st.statusMessage = 'กำลังส่งหาผู้รับที่ ' + (i + 1) + '/' + recipients.length + '...';
    try {
      await axios.post('https://graph.facebook.com/v19.0/me/messages', {
        recipient: { id: recipients[i] },
        message: { text: message }
      }, { params: { access_token: pageToken }, timeout: 10000 });
      st.success++;
    } catch (err) {
      st.failed++;
    }

    batchCount++;
    if (batchCount >= batchSize && (i + 1) < recipients.length) {
      batchCount = 0;
      for (let m = pauseMin; m > 0; m--) {
        if (st.shouldStop) break;
        st.statusMessage = '⏳ พักระบบ ' + m + ' นาที...';
        await sleep(60 * 1000);
      }
    } else {
      await sleep(delaySec * 1000);
    }
  }
  st.isBroadcasting = false;
  st.statusMessage = st.shouldStop ? '⏹️ หยุดบรอดแคสแล้ว' : '✅ บรอดแคสเสร็จสิ้นสมบูรณ์!';
}

app.post('/api/live/broadcast/start', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (s.broadcastStatus.isBroadcasting) return res.json({ success: false, error: 'กำลังรันบรอดแคสอยู่แล้ว' });

  const { message, onlyMatched } = req.body;
  const delaySec = Math.max(1, parseInt(req.body.delaySec) || 3);
  const batchSize = Math.max(1, parseInt(req.body.batchSize) || 20);
  const pauseMin = Math.max(1, parseInt(req.body.pauseMin) || 10);
  if (!message || !String(message).trim()) return res.json({ success: false, error: 'กรุณากรอกข้อความบรอดแคส' });
  if (!ctx.pageData.config.pageAccessToken) return res.json({ success: false, error: 'เพจนี้ยังไม่มี Page Access Token' });

  const recipients = Array.from(s.commenters.entries())
    .filter(([, c]) => !onlyMatched || c.matchedCount > 0)
    .map(([id]) => id);
  if (recipients.length === 0) return res.json({ success: false, error: 'ยังไม่มีผู้รับใน session นี้' });

  s.broadcastStatus = { isBroadcasting: true, total: recipients.length, current: 0, success: 0, failed: 0, statusMessage: 'กำลังเริ่มส่ง...', shouldStop: false };
  res.json({ success: true });
  runLiveBroadcast(s, ctx.pageData.config.pageAccessToken, recipients, String(message), delaySec, batchSize, pauseMin);
});

app.post('/api/live/broadcast/stop', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  if (ctx.live) ctx.live.broadcastStatus.shouldStop = true;
  res.json({ success: true });
});

// -------------------------------------------------------------
// 6. Webhook Endpoints พร้อมระบบตรวจสอบสลิป EasySlip
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const verifyToken = req.query['hub.verify_token'];
  let isMatched = false;
  
  for (const pid in pageIndexMap) {
    if (pageIndexMap[pid].pageData.config.verifyToken === verifyToken) {
      isMatched = true;
      break;
    }
  }

  if (req.query['hub.mode'] === 'subscribe' && (isMatched || verifyToken === defaultPageConfig.verifyToken)) {
    console.log('✅ [Webhook Verify] ยืนยันตัวตนสำเร็จผ่าน Verify Token:', verifyToken);
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.log('❌ [Webhook Verify] ยืนยันตัวตนไม่สำเร็จ Verify Token ไม่ตรงกัน:', verifyToken);
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.status(200).send('EVENT_RECEIVED');

  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      const pageId = entry.id;
      console.log(`📥 [Webhook Received] ได้รับ Event จาก Page ID: ${pageId}`);

      let targetRecord = pageIndexMap[pageId];
      if (!targetRecord) {
        for (const uid in usersDB) {
          for (const pid in usersDB[uid].pages) {
            if (pid === pageId || usersDB[uid].pages[pid].config.pageId === pageId) {
              targetRecord = { username: uid, pageData: usersDB[uid].pages[pid] };
              pageIndexMap[pageId] = targetRecord;
              break;
            }
          }
          if (targetRecord) break;
        }
      }

      if (!targetRecord) {
        console.log(`⚠️ [Webhook Warning] ไม่พบ Page ID "${pageId}" ในระบบฐานข้อมูล`);
        continue;
      }

      const configStore = targetRecord.pageData.config;
      const subscribers = targetRecord.pageData.subscribers;
      const usedSlips = targetRecord.pageData.usedSlips;

      // 1. ตรวจสอบข้อความ / สลิปใน Inbox
      if (entry.messaging) {
        for (const msgEvent of entry.messaging) {
          const senderId = msgEvent.sender?.id;
          if (senderId) subscribers.add(senderId);

          if (msgEvent.message && msgEvent.message.attachments) {
            for (const att of msgEvent.message.attachments) {
              if (att.type === 'image' && configStore.enableSlipVerify) {
                const imageUrl = att.payload?.url;
                if (!imageUrl) continue;

                console.log(`🧾 [Page: ${pageId}] พบรูปภาพจากลูกค้า ID: ${senderId} กำลังตรวจสอบสลิป...`);
                const slipResult = await verifySlipByImageUrl(imageUrl, configStore.easySlipApiKey);

                const sendSlipReply = async (text) => {
                  if (!configStore.pageAccessToken) return;
                  try {
                    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
                      recipient: { id: senderId },
                      message: { text }
                    }, { params: { access_token: configStore.pageAccessToken }, timeout: 10000 });
                  } catch (sendErr) {
                    console.error('❌ [Send Slip Reply Error]', sendErr.response?.data || sendErr.message);
                  }
                };

                const slip = slipResult && slipResult.success ? normalizeSlip(slipResult.data) : null;

                if (!slip) {
                  const errCode = slipResult?.error?.error?.code || slipResult?.data?.error?.code || '';
                  console.log(`⚠️ [Page: ${pageId}] อ่านข้อมูลสลิปไม่สำเร็จจาก EasySlip`, errCode);
                  if (errCode === 'SLIP_PENDING') {
                    await sendSlipReply('⏳ สลิปธนาคารกรุงเทพเพิ่งโอนไม่ถึง 5 นาที กรุณารอสักครู่แล้วส่งสลิปอีกครั้งนะคะ');
                  } else {
                    await sendSlipReply(configStore.msgSlipUnreadable);
                  }
                  continue;
                }

                if (usedSlips.has(slip.transRef) || slip.isDuplicate) {
                  console.log(`🔄 [Page: ${pageId}] สลิปซ้ำ ถูกใช้งานไปแล้ว`);
                  await sendSlipReply(configStore.msgSlipDuplicate);
                  continue;
                }

                const receiverOk = slip.receiverAccounts.length > 0
                  ? accountMatches(configStore.merchantAccount, slip.receiverAccounts)
                  : (!configStore.merchantAccount && !configStore.merchantName) || nameMatches(configStore.merchantName, slip.receiverNameTh);

                if (!receiverOk) {
                  console.log(`❌ [Page: ${pageId}] เลขบัญชีผู้รับไม่ตรงกับร้านค้า`, slip.receiverAccounts, slip.receiverNameTh);
                  await sendSlipReply(configStore.msgSlipInvalid);
                  continue;
                }

                usedSlips.add(slip.transRef);

                const slipSession = findLiveSessionForSender(targetRecord.pageData, senderId);
                if (slipSession) {
                  slipSession.slips.push({
                    transRef: slip.transRef,
                    amount: Number(slip.amount) || 0,
                    senderId,
                    senderName: slipSession.commenters.get(senderId)?.name || '',
                    time: Date.now()
                  });
                }
                const replyText = (configStore.msgSlipSuccess || '')
                  .replace('{amount}', slip.amount)
                  .replace('{date}', slip.dateText);

                console.log(`✅ [Page: ${pageId}] สลิปถูกต้อง ส่งข้อความตอบกลับ`);
                await sendSlipReply(replyText);
              }
            }
          }
        }
      }

      // 2. ระบบบอตตอบคอมเมนต์อัตโนมัติ
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
            const comment = change.value;
            const senderId = comment.from?.id;
            if (senderId && (senderId === pageId || senderId === configStore.pageId)) continue;
            if (senderId) subscribers.add(senderId);

            const liveSession = findLiveSessionForComment(targetRecord.pageData, comment.post_id, comment.video_id);
            const cfg = liveSession ? { ...configStore, ...liveSession.config } : configStore;

            const commentText = comment.message || '';
            const matchedKw = findMatchedKeyword(cfg, commentText);
            const isMatched = !!matchedKw;

            if (liveSession) {
              liveSession.stats.comments++;
              if (isMatched) liveSession.stats.matched++;
              if (senderId) {
                const prev = liveSession.commenters.get(senderId) ||
                  { name: '', count: 0, matchedCount: 0, lastMessage: '', lastKeyword: '', lastTime: 0 };
                if (comment.from?.name) prev.name = comment.from.name;
                prev.count++;
                if (isMatched) { prev.matchedCount++; prev.lastKeyword = matchedKw; }
                prev.lastMessage = commentText.slice(0, 200);
                prev.lastTime = Date.now();
                liveSession.commenters.set(senderId, prev);
              }
            }

            if (isMatched && cfg.pageAccessToken) {
              // ไลก์คอมเมนต์อัตโนมัติ
              if (cfg.enableAutoLike) {
                try {
                  await axios.post('https://graph.facebook.com/v19.0/' + comment.comment_id + '/likes', {}, {
                    params: { access_token: cfg.pageAccessToken },
                    timeout: 10000
                  });
                } catch (likeErr) {}
              }

              // ตอบกลับใต้คอมเมนต์ (เช็คเปิด/ปิด ผ่าน cfg.enableCommentReply)
              if (cfg.enableCommentReply) {
                try {
                  await axios.post('https://graph.facebook.com/v19.0/' + comment.comment_id + '/comments', {
                    message: cfg.replyCommentText
                  }, { 
                    params: { access_token: cfg.pageAccessToken },
                    timeout: 10000 
                  });
                } catch (repErr) {
                  console.error('❌ [Comment Reply Error]', repErr.response?.data || repErr.message);
                }
              }

              // ส่งข้อความเข้า Inbox (เช็คเปิด/ปิด ผ่าน cfg.enableInbox)
              if (cfg.enableInbox) {
                try {
                  await axios.post('https://graph.facebook.com/v19.0/me/messages', {
                    recipient: { comment_id: comment.comment_id },
                    message: { text: cfg.inboxText }
                  }, { 
                    params: { access_token: cfg.pageAccessToken },
                    timeout: 10000 
                  });
                } catch (inbErr) {
                  console.error('❌ [Inbox Error]', inbErr.response?.data || inbErr.message);
                }
              }
            }
          }
        }
      }
    }
  }
});

// -------------------------------------------------------------
// 7. เริ่มต้นเซิร์ฟเวอร์
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);

app.listen(PORT, () => {
  console.log('Server is running on port ' + PORT);
  setInterval(async () => {
    try { await axios.get(serverUrl, { timeout: 5000 }); } catch (e) {}
  }, 10 * 60 * 1000);
});