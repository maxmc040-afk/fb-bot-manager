const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------
// ค่าคอนฟิกเริ่มต้นของระบบ
// -------------------------------------------------------------
let configStore = {
  appId: '1611337127153323',
  verifyToken: '14556456',
  pageAccessToken: '',
  pageId: '',
  pageName: '',
  
  matchType: 'contains',
  keywords: ['1', '11', '111', '11111', '111111', 'สนใจ', 'cf'],
  replyCommentText: 'แอดมินส่งรายละเอียดให้ในอินบ็อกซ์เรียบร้อยแล้วนะคะ 🙏',
  inboxText: 'ร.กรุงศรี 6651198576\nชื่อภิญโญ แจ้งกระจ่าง\n\n🙏 โอนแล้วแจ้งสลิป พร้อมชื่อที่อยู่ ได้เลยคะ🥰\n✨ (ส่งฟรี) ส่งฟรี EMS ✨',
  enableInbox: true,
  enableCommentReply: true,
  enableAutoLike: true, // เพิ่มค่าตั้งค่าเปิด/ปิดกดไลก์คอมเมนต์
  
  enableSlipVerify: true,
  merchantBank: 'BAY', 
  merchantAccount: '6651198576',
  merchantName: 'ภิญโญ แจ้งกระจ่าง',
  msgSlipSuccess: 'สถานะ: ตรวจสอบถูกต้อง ✅\nยอดเงิน: {amount} บาท\nวันที่: {date}\n\nรับยอดค่ะพี่ ขอบคุณมากค่ะ 🙏 แจ้งชื่อที่อยู่เบอร์โทร ได้เลยค่ะ🥰',
  msgSlipInvalid: '❌ สลิปไม่ถูกต้อง หรือเลขบัญชีผู้รับไม่ตรงกับของทางร้าน กรุณาตรวจสอบอีกครั้งนะคะ',
  msgSlipUnreadable: '⚠️ ไม่สามารถอ่านข้อมูลจากสลิปนี้ได้ กรุณาส่งรูปสลิปที่ชัดเจนอีกครั้งนะคะ',
  msgSlipDuplicate: '🔄 สลิปนี้ถูกใช้งานไปแล้ว ไม่สามารถส่งซ้ำได้ค่ะ'
};

let subscribers = new Set();
let usedSlips = new Set();

let broadcastStatus = {
  isBroadcasting: false,
  total: 0,
  current: 0,
  success: 0,
  failed: 0,
  statusMessage: 'พร้อมใช้งาน',
  shouldStop: false
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function verifySlipWithEasySlip(imageUrl) {
  const EASYSLIP_API_KEY = '47f197e2-8c05-42bb-b9ad-9186f84faa82';
  try {
    const response = await axios.post('https://chatbot.easyslip.com/v1/public/verify', 
      { url: imageUrl },
      { headers: { 'Authorization': 'Bearer ' + EASYSLIP_API_KEY } }
    );
    return response.data;
  } catch (err) {
    console.error('❌ [EasySlip] ตรวจสอบล้มเหลว:', err.response?.data || err.message);
    return null;
  }
}

// -------------------------------------------------------------
// 1. หน้า Dashboard HTML UI + เพิ่ม UI กดไลก์คอมเมนต์
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ระบบจัดการเพจ ตรวจสลิป และบรอดแคส</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style> body { font-family: 'Sarabun', sans-serif; } </style>
</head>
<body class="bg-slate-100 text-slate-800 antialiased">
    <div class="flex h-screen overflow-hidden">
        <aside class="w-64 bg-white border-r border-slate-200 flex flex-col z-20">
            <div class="h-16 flex items-center px-6 border-b border-slate-100">
                <span class="font-bold text-lg text-blue-600">FB Bot Manager</span>
            </div>
            <div class="flex-1 overflow-y-auto py-4 px-3 space-y-1">
                <div class="text-xs font-semibold text-slate-400 px-3 mb-2">เมนูหลัก</div>
                <a href="#" onclick="switchTab('dashboard')" id="nav-dashboard" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600">💬 ตอบกลับคอมเมนต์</a>
                <a href="#" onclick="switchTab('slip')" id="nav-slip" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">💐 ตรวจสลิปอัตโนมัติ</a>
                <a href="#" onclick="switchTab('broadcast')" id="nav-broadcast" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">🚀 บรอดแคสควบคุมเวลา</a>
                <a href="#" onclick="switchTab('webhook')" id="nav-webhook" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">⚙️ เชื่อมต่อเพจ & Webhook</a>
            </div>
        </aside>

        <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <header class="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 z-10">
                <h1 id="page-title" class="text-lg font-bold text-slate-700">เพจที่เชื่อมต่อ: <span id="header-page-name" class="text-blue-600">ยังไม่ได้เชื่อมต่อ</span></h1>
                <span class="text-xs bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-semibold">● ระบบออนไลน์</span>
            </header>

            <main class="flex-1 overflow-y-auto p-6">
                <!-- TAB 1: ตอบกลับคอมเมนต์ -->
                <div id="tab-dashboard" class="space-y-6">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                        <label class="text-sm font-semibold text-slate-700 block mb-2">คำดัก: หากคอมเมนต์ของลูกเพจ :</label>
                        <div class="flex gap-2 mb-4">
                            <button onclick="setMatchType('exact')" id="btn-exact" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white">ตรงกับคำว่า</button>
                            <button onclick="setMatchType('contains')" id="btn-contains" class="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600">มีคำว่า</button>
                        </div>
                        <div id="keywords-container" class="flex flex-wrap items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl min-h-[50px]"></div>
                        <div class="mt-2 flex gap-2">
                            <input type="text" id="new-keyword-input" placeholder="พิมพ์คำดักเพิ่ม เช่น สนใจ, cf, 1" class="px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                            <button onclick="addKeyword()" class="px-4 py-1.5 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-700">เพิ่มคำ</button>
                        </div>
                    </div>

                    <!-- เพิ่ม Checkbox เปิด/ปิด กดไลก์คอมเมนต์ -->
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
                        <button onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่าระบบ</button>
                    </div>
                </div>

                <!-- TAB 2: SLIP VERIFY -->
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
                                <span class="ml-3 text-sm font-semibold text-slate-700">เปิดใช้งานบทสนทนา</span>
                            </label>
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
                                <button onclick="switchSlipTab('success')" id="tab-btn-success" class="pb-2.5 px-4 text-xs font-bold text-rose-600 border-b-2 border-rose-600">สลิปถูกต้อง</button>
                                <button onclick="switchSlipTab('invalid')" id="tab-btn-invalid" class="pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700">สลิปไม่ถูกต้อง</button>
                                <button onclick="switchSlipTab('unreadable')" id="tab-btn-unreadable" class="pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700">สลิปตรวจสอบไม่ได้</button>
                                <button onclick="switchSlipTab('duplicate')" id="tab-btn-duplicate" class="pb-2.5 px-4 text-xs font-medium text-slate-500 hover:text-slate-700">สลิปซ้ำ</button>
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
                            <button onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่าสลิป</button>
                        </div>
                    </div>
                </div>

                <!-- TAB 3: BROADCAST -->
                <div id="tab-broadcast" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                        <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-4">
                            <div>
                                <h3 class="text-base font-bold text-slate-700">🚀 บรอดแคสข้อความปลอดภัย (Safety Broadcast)</h3>
                            </div>
                            <div class="text-right">
                                <span class="text-xs text-slate-400 block">ผู้รับในระบบ</span>
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
                                <button id="btn-start-bc" onclick="startBroadcast()" class="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 shadow-sm">เริ่มส่งบรอดแคส</button>
                                <button id="btn-stop-bc" onclick="stopBroadcast()" class="hidden px-6 py-2.5 bg-rose-600 text-white font-medium rounded-xl hover:bg-rose-700 shadow-sm">หยุดบรอดแคส</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- TAB 4: WEBHOOK & FACEBOOK LOGIN OAUTH -->
                <div id="tab-webhook" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <h3 class="text-base font-bold text-slate-700">🌐 เชื่อมต่อกับ Facebook เพจแบบอัตโนมัติ</h3>
                        <p class="text-xs text-slate-500">คลิกปุ่มด้านล่างเพื่อเข้าสู่ระบบ Facebook และเลือกร้านค้าของคุณ ระบบจะดึง Token และจัดการเชื่อมต่อให้อัตโนมัติโดยไม่ต้องคัดลอกค่าใดๆ</p>
                        
                        <div class="flex items-center gap-4 pt-2">
                            <button type="button" onclick="loginWithFacebook()" class="px-6 py-3 bg-blue-600 text-white font-medium text-sm rounded-xl hover:bg-blue-700 shadow-md flex items-center gap-2 cursor-pointer">
                                <svg class="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                                <span>เข้าสู่ระบบด้วย Facebook เพื่อเลือกเพจ</span>
                            </button>
                        </div>

                        <!-- UI ส่วนเลือกเพจ -->
                        <div id="page-select-box" class="bg-slate-50 p-4 rounded-xl border border-slate-200 mt-4 space-y-2">
                            <label class="text-xs font-semibold text-slate-700 block">🏪 เลือกเพจที่ต้องการใช้งานบอต:</label>
                            <div class="flex gap-2">
                                <select id="page-select-dropdown" onchange="onPageDropdownSelected()" class="flex-1 p-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-500">
                                    <option value="">-- ยังไม่ได้เลือกเพจ (กดปุ่มเข้าสู่ระบบด้านบนก่อน) --</option>
                                </select>
                                <button type="button" onclick="fetchMyPagesManually()" class="px-4 py-2 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-700">รีเฟรชรายชื่อเพจ</button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <h3 class="text-base font-bold text-slate-700">⚙️ ตั้งค่า Webhook สำหรับ Meta for Developers</h3>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Callback URL (นำค่านี้ไปใส่ใน Meta Developers):</label>
                            <input type="text" id="webhook-url-display" readonly class="w-full p-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-600">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Verify Token:</label>
                            <input type="text" id="conf-verify-token" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Page Access Token (เชื่อมต่อแล้ว):</label>
                            <input type="text" id="conf-page-token" readonly class="w-full p-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-500" placeholder="เลือกเพจด้านบนเพื่อเติมค่าอัตโนมัติ">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Facebook Page ID:</label>
                            <input type="text" id="conf-page-id" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                        </div>
                        <div class="pt-4 flex justify-end">
                            <button onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกตั้งค่า Webhook</button>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    </div>

    <!-- Script จัดการหน้าเว็บ -->
    <script>
        let currentConfig = {};
        let statusInterval = null;
        let fetchedPagesList = [];

        function loginWithFacebook() {
            const appId = '1611337127153323';
            const redirectUri = encodeURIComponent(window.location.origin + '/auth/facebook/callback');
            const scope = encodeURIComponent('pages_show_list,pages_messaging,pages_read_engagement,pages_manage_posts');
            window.location.href = 'https://www.facebook.com/v19.0/dialog/oauth?client_id=' + appId + '&redirect_uri=' + redirectUri + '&scope=' + scope + '&response_type=token';
        }

        async function loadConfig() {
            const res = await fetch('/api/config');
            const data = await res.json();
            currentConfig = data.config;
            document.getElementById('subscriber-count').innerText = (data.subscriberCount || 0) + ' คน';
            renderUI();

            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('tab') === 'webhook') {
                switchTab('webhook');
            }

            const savedUserToken = localStorage.getItem('fb_user_token');
            if (savedUserToken) {
                fetchPagesWithToken(savedUserToken, false);
            }
        }

        function renderUI() {
            document.getElementById('header-page-name').innerText = currentConfig.pageName || (currentConfig.pageId ? 'ID: ' + currentConfig.pageId : 'ยังไม่ได้เชื่อมต่อ');
            
            const kwContainer = document.getElementById('keywords-container');
            kwContainer.innerHTML = '';
            currentConfig.keywords.forEach((kw, i) => {
                kwContainer.innerHTML += '<span class="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-lg">' + kw + ' <button onclick="removeKeyword(' + i + ')" class="hover:text-red-200 font-bold ml-1">×</button></span>';
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
                    dropdown.innerHTML = '<option value="">-- เลือกเพจที่ต้องการใช้งาน --</option>';
                    data.pages.forEach((p, idx) => {
                        const isSelected = p.id === currentConfig.pageId ? 'selected' : '';
                        dropdown.innerHTML += '<option value="' + idx + '" ' + isSelected + '>' + p.name + ' (ID: ' + p.id + ')</option>';
                    });
                    if(showAlert) alert('✅ ดึงข้อมูลสำเร็จ พบ ' + data.pages.length + ' เพจ');
                } else {
                    if(showAlert) alert('❌ ไม่สามารถดึงรายชื่อเพจได้: ' + (data.error || 'Token หมดอายุ'));
                }
            } catch(e) {
                console.error(e);
            }
        }

        function fetchMyPagesManually() {
            const token = localStorage.getItem('fb_user_token');
            if(!token) {
                alert('⚠️ กรุณากดปุ่ม "เข้าสู่ระบบด้วย Facebook เพื่อเลือกเพจ" ก่อนครับ');
                return;
            }
            fetchPagesWithToken(token, true);
        }

        function onPageDropdownSelected() {
            const idx = document.getElementById('page-select-dropdown').value;
            if (idx !== "") {
                const selected = fetchedPagesList[idx];
                document.getElementById('conf-page-token').value = selected.access_token;
                document.getElementById('conf-page-id').value = selected.id;
                currentConfig.pageName = selected.name;
                currentConfig.pageAccessToken = selected.access_token;
                currentConfig.pageId = selected.id;
                saveConfig();
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
            if(val && !currentConfig.keywords.includes(val)) {
                currentConfig.keywords.push(val);
                document.getElementById('new-keyword-input').value = '';
                renderUI();
            }
        }

        function removeKeyword(i) { currentConfig.keywords.splice(i, 1); renderUI(); }

        async function saveConfig() {
            currentConfig.replyCommentText = document.getElementById('reply-comment-input').value;
            currentConfig.inboxText = document.getElementById('inbox-input').value;
            currentConfig.enableCommentReply = document.getElementById('enable-comment-reply').checked;
            currentConfig.enableInbox = document.getElementById('enable-inbox').checked;
            currentConfig.enableAutoLike = document.getElementById('enable-auto-like').checked;
            currentConfig.verifyToken = document.getElementById('conf-verify-token').value;
            currentConfig.pageAccessToken = document.getElementById('conf-page-token').value;
            currentConfig.pageId = document.getElementById('conf-page-id').value;

            currentConfig.enableSlipVerify = document.getElementById('enable-slip-verify').checked;
            currentConfig.merchantBank = document.getElementById('merchant-bank').value;
            currentConfig.merchantAccount = document.getElementById('merchant-account').value;
            currentConfig.merchantName = document.getElementById('merchant-name').value;
            currentConfig.msgSlipSuccess = document.getElementById('msg-slip-success').value;
            currentConfig.msgSlipInvalid = document.getElementById('msg-slip-invalid').value;
            currentConfig.msgSlipUnreadable = document.getElementById('msg-slip-unreadable').value;
            currentConfig.msgSlipDuplicate = document.getElementById('msg-slip-duplicate').value;

            await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentConfig) });
            alert('✅ บันทึกการตั้งค่าระบบเรียบร้อยแล้ว!');
            renderUI();
        }

        function switchTab(tabId) {
            ['dashboard', 'slip', 'broadcast', 'webhook'].forEach(id => {
                document.getElementById('tab-' + id).classList.add('hidden');
                document.getElementById('nav-' + id).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50";
            });
            document.getElementById('tab-' + tabId).classList.remove('hidden');
            document.getElementById('nav-' + tabId).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600";
        }

        async function startBroadcast() {
            const message = document.getElementById('bc-message').value.trim();
            const delaySec = parseInt(document.getElementById('bc-delay').value) || 3;
            const batchSize = parseInt(document.getElementById('bc-batch-size').value) || 20;
            const pauseMin = parseInt(document.getElementById('bc-pause-min').value) || 10;

            if(!message) return alert('กรุณากรอกข้อความบรอดแคสก่อนครับ!');
            if(!confirm('ยืนยันเริ่มส่งบรอดแคส?')) return;

            const res = await fetch('/api/broadcast/start', {
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
            await fetch('/api/broadcast/stop', { method: 'POST' });
            alert('ส่งคำสั่งหยุดบรอดแคสเรียบร้อยแล้ว');
        }

        async function checkBroadcastStatus() {
            const res = await fetch('/api/broadcast/status');
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

        loadConfig();
    </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// 2. Endpoint สำหรับรับ Callback จาก Facebook OAuth
// -------------------------------------------------------------
app.get('/auth/facebook/callback', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>กำลังเชื่อมต่อ Facebook...</title></head>
<body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
    <h2>⏳ กำลังบันทึกสิทธิ์เข้าสู่ระบบ และดึงรายชื่อเพจของคุณ...</h2>
    <script>
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');

        if (accessToken) {
            localStorage.setItem('fb_user_token', accessToken);

            fetch('/api/fetch-pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userAccessToken: accessToken })
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success && data.pages && data.pages.length > 0) {
                    alert('✅ ล็อกอินสำเร็จ! ระบบดึงข้อมูลมาเรียบร้อยแล้ว');
                    window.location.href = '/?tab=webhook&connected=true';
                } else {
                    alert('❌ ไม่พบเพจภายใต้บัญชีนี้');
                    window.location.href = '/';
                }
            })
            .catch(function(err) {
                alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
                window.location.href = '/';
            });
        } else {
            alert('❌ การเข้าสู่ระบบถูกยกเลิก');
            window.location.href = '/';
        }
    </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// 3. API Config & Fetch Pages
// -------------------------------------------------------------
app.get('/api/config', (req, res) => res.json({ success: true, config: configStore, subscriberCount: subscribers.size }));

app.post('/api/config', (req, res) => {
  configStore = { ...configStore, ...req.body };
  res.json({ success: true });
});

app.post('/api/fetch-pages', async (req, res) => {
  const { userAccessToken } = req.body;
  if (!userAccessToken) return res.json({ success: false, error: 'ไม่พบ Access Token' });

  try {
    const response = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: userAccessToken }
    });
    res.json({ success: true, pages: response.data.data });
  } catch (err) {
    res.json({ success: false, error: err.response?.data?.error?.message || err.message });
  }
});

// -------------------------------------------------------------
// 4. API บรอดแคส
// -------------------------------------------------------------
app.post('/api/broadcast/start', async (req, res) => {
  const { message, delaySec, batchSize, pauseMin } = req.body;
  if (broadcastStatus.isBroadcasting) return res.json({ success: false, error: 'กำลังรันบรอดแคสอยู่แล้ว' });
  if (subscribers.size === 0) return res.json({ success: false, error: 'ยังไม่มีผู้รับในระบบ' });

  const subList = Array.from(subscribers);
  broadcastStatus = { isBroadcasting: true, total: subList.length, current: 0, success: 0, failed: 0, statusMessage: 'กำลังเริ่มส่ง...', shouldStop: false };
  res.json({ success: true });

  (async () => {
    let currentBatchCount = 0;
    for (let i = 0; i < subList.length; i++) {
      if (broadcastStatus.shouldStop) break;
      const recipientId = subList[i];
      broadcastStatus.current = i + 1;
      broadcastStatus.statusMessage = 'กำลังส่งหาผู้รับที่ ' + (i + 1) + '/' + subList.length + '...';

      try {
        await axios.post('https://graph.facebook.com/v19.0/me/messages', {
          recipient: { id: recipientId },
          message: { text: message }
        }, { params: { access_token: configStore.pageAccessToken } });
        broadcastStatus.success++;
      } catch (err) {
        broadcastStatus.failed++;
      }

      currentBatchCount++;
      if (currentBatchCount >= batchSize && (i + 1) < subList.length) {
        currentBatchCount = 0;
        for (let m = pauseMin; m > 0; m--) {
          if (broadcastStatus.shouldStop) break;
          broadcastStatus.statusMessage = '⏳ พักระบบ ' + m + ' นาที...';
          await sleep(60 * 1000);
        }
      } else {
        await sleep(delaySec * 1000);
      }
    }
    broadcastStatus.isBroadcasting = false;
    if (!broadcastStatus.shouldStop) broadcastStatus.statusMessage = '✅ บรอดแคสเสร็จสิ้นสมบูรณ์!';
  })();
});

app.post('/api/broadcast/stop', (req, res) => {
  broadcastStatus.shouldStop = true;
  res.json({ success: true });
});

app.get('/api/broadcast/status', (req, res) => res.json(broadcastStatus));

// -------------------------------------------------------------
// 5. Webhook Endpoints (เพิ่มฟังก์ชันกดไลก์คอมเมนต์อัตโนมัติ)
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === configStore.verifyToken) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.status(200).send('EVENT_RECEIVED');

  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      if (entry.messaging) {
        for (const msgEvent of entry.messaging) {
          const senderId = msgEvent.sender?.id;
          if (senderId) subscribers.add(senderId);

          if (msgEvent.message && msgEvent.message.attachments) {
            for (const att of msgEvent.message.attachments) {
              if (att.type === 'image' && configStore.enableSlipVerify) {
                const imageUrl = att.payload?.url;
                const slipResult = await verifySlipWithEasySlip(imageUrl);

                if (slipResult && slipResult.status === 200) {
                  const data = slipResult.data;
                  const slipTransRef = data.transRef || data.id;

                  if (usedSlips.has(slipTransRef)) {
                    if (configStore.pageAccessToken) {
                      await axios.post('https://graph.facebook.com/v19.0/me/messages', {
                        recipient: { id: senderId },
                        message: { text: configStore.msgSlipDuplicate }
                      }, { params: { access_token: configStore.pageAccessToken } });
                    }
                    continue;
                  }

                  const recvAcc = data.receiver?.account?.bank?.account || data.receiver?.account?.proxy?.account || '';
                  const cleanMerchantAcc = (configStore.merchantAccount || '').replace(/[^0-9]/g, '');
                  const cleanRecvAcc = recvAcc.replace(/[^0-9]/g, '');

                  if (!cleanMerchantAcc || cleanRecvAcc.includes(cleanMerchantAcc) || cleanMerchantAcc.includes(cleanRecvAcc)) {
                    usedSlips.add(slipTransRef);
                    let replyText = configStore.msgSlipSuccess
                      .replace('{amount}', data.amount?.amount || 0)
                      .replace('{date}', data.transDate || '');

                    if (configStore.pageAccessToken) {
                      await axios.post('https://graph.facebook.com/v19.0/me/messages', {
                        recipient: { id: senderId },
                        message: { text: replyText }
                      }, { params: { access_token: configStore.pageAccessToken } });
                    }
                  } else {
                    if (configStore.pageAccessToken) {
                      await axios.post('https://graph.facebook.com/v19.0/me/messages', {
                        recipient: { id: senderId },
                        message: { text: configStore.msgSlipInvalid }
                      }, { params: { access_token: configStore.pageAccessToken } });
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
            const comment = change.value;
            const senderId = comment.from?.id;
            if (senderId) subscribers.add(senderId);

            const commentText = comment.message || '';
            let isMatched = configStore.matchType === 'exact' ?
              configStore.keywords.some(function(kw) { return commentText.trim().toLowerCase() === kw.toLowerCase(); }) :
              configStore.keywords.some(function(kw) { return commentText.toLowerCase().includes(kw.toLowerCase()); });

            if (isMatched && configStore.pageAccessToken) {
              // 1. กดไลก์คอมเมนต์ (ถ้าเปิดใช้งาน)
              if (configStore.enableAutoLike) {
                try {
                  await axios.post('https://graph.facebook.com/v19.0/' + comment.comment_id + '/likes', {}, {
                    params: { access_token: configStore.pageAccessToken }
                  });
                } catch (likeErr) {
                  console.error('❌ Auto-like error:', likeErr.response?.data || likeErr.message);
                }
              }

              // 2. ตอบกลับใต้คอมเมนต์
              if (configStore.enableCommentReply) {
                await axios.post('https://graph.facebook.com/v19.0/' + comment.comment_id + '/comments', {
                  message: configStore.replyCommentText
                }, { params: { access_token: configStore.pageAccessToken } });
              }

              // 3. ส่งข้อความเข้าแชทส่วนตัว (Inbox)
              if (configStore.enableInbox) {
                await axios.post('https://graph.facebook.com/v19.0/me/messages', {
                  recipient: { comment_id: comment.comment_id },
                  message: { text: configStore.inboxText }
                }, { params: { access_token: configStore.pageAccessToken } });
              }
            }
          }
        }
      }
    }
  }
});

// -------------------------------------------------------------
// 6. เริ่มต้นเซิร์ฟเวอร์ + Anti-Sleep Ping
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);

app.listen(PORT, () => {
  console.log('Server is running on port ' + PORT);
  setInterval(async () => {
    try { await axios.get(serverUrl); } catch (e) {}
  }, 10 * 60 * 1000);
});