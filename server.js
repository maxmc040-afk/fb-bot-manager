const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// หน่วยความจำเก็บค่าคอนฟิก
let configStore = {
  verifyToken: '14556456',
  pageAccessToken: '',
  pageId: '',
  matchType: 'contains',
  keywords: ['1', '11', '111', '11111', '111111', 'สนใจ', 'cf'],
  replyCommentText: 'แอดมินส่งรายละเอียดให้ในอินบ็อกซ์เรียบร้อยแล้วนะคะ 🙏',
  inboxText: `ร.กรุงศรี 6651198576\nชื่อภิญโญ แจ้งกระจ่าง\n\n🙏 โอนแล้วแจ้งสลิป พร้อมชื่อที่อยู่ ได้เลยคะ🥰\n✨ (ส่งฟรี) ส่งฟรี EMS ✨`,
  enableInbox: true,
  enableCommentReply: true
};

// หน่วยความจำเก็บรายชื่อผู้รับบรอดแคส (PSID) แบบไม่ซ้ำ
let subscribers = new Set();

// สถานะการทำงานของ บรอดแคส
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

// 1. หน้า UI แดชบอร์ด
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ระบบตอบกลับคอมเมนต์และบรอดแคส Facebook</title>
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
                <a href="#" onclick="switchTab('broadcast')" id="nav-broadcast" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">🚀 บรอดแคสควบคุมเวลา</a>
                <a href="#" onclick="switchTab('webhook')" id="nav-webhook" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">⚙️ ตั้งค่า Webhook & Dev</a>
            </div>
        </aside>

        <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <header class="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 z-10">
                <h1 id="page-title" class="text-lg font-bold text-slate-700">ตอบกลับคอมเมนต์ • เพจของคุณ</h1>
                <span class="text-xs bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-semibold">● ระบบออนไลน์</span>
            </header>

            <main class="flex-1 overflow-y-auto p-6">
                <!-- TAB 1 -->
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

                <!-- TAB 2: บรอดแคสควบคุมเวลา -->
                <div id="tab-broadcast" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                        <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-4">
                            <div>
                                <h3 class="text-base font-bold text-slate-700">🚀 บรอดแคสข้อความปลอดภัย (Safety Broadcast)</h3>
                                <p class="text-xs text-slate-500 mt-1">ตั้งค่าหน่วงเวลาและรอบพัก เพื่อป้องกันเพจถูกบล็อกจากการส่งข้อความถี่เกินไป</p>
                            </div>
                            <div class="text-right">
                                <span class="text-xs text-slate-400 block">ผู้รับที่สะสมในระบบ</span>
                                <span id="subscriber-count" class="text-lg font-bold text-blue-600">0 คน</span>
                            </div>
                        </div>

                        <div class="space-y-4">
                            <div>
                                <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความบรอดแคส:</label>
                                <textarea id="bc-message" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="พิมพ์ข้อความที่ต้องการส่งหาลูกค้าทุกคน..."></textarea>
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

                <!-- TAB 3: WEBHOOK & AUTO SELECT PAGE -->
                <div id="tab-webhook" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <h3 class="text-base font-bold text-slate-700">⚙️ ตั้งค่าเชื่อมต่อ Meta for Developers (เลือกเพจแบบออโต้)</h3>
                        
                        <!-- ปุ่มกดดึงเพจผ่าน Token -->
                        <div class="bg-blue-50 p-4 rounded-xl border border-blue-200 space-y-3">
                            <label class="text-xs font-semibold text-blue-800 block">✨ ตัวช่วยดึงรายชื่อเพจอัตโนมัติ:</label>
                            <p class="text-xs text-slate-600">คลิกปุ่มด้านล่างเพื่อวาง User Access Token แล้วระบบจะดึงรายชื่อเพจของคุณมาให้เลือกทันที</p>
                            
                            <button onclick="promptForTokenAndFetch()" class="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 shadow-sm flex items-center gap-2">
                                <span>🔑 วาง Token เพื่อดึงรายชื่อเพจ</span>
                            </button>
                            
                            <!-- กล่องแสดงรายการเพจหลังจากดึงสำเร็จ -->
                            <div id="page-select-container" class="hidden pt-2">
                                <label class="text-xs font-semibold text-slate-700 block mb-1">เลือกเพจที่ต้องการใช้งาน:</label>
                                <select id="page-select" onchange="onPageSelected()" class="w-full p-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-500">
                                    <option value="">-- กรุณาเลือกเพจ --</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Callback URL (Webhook URL):</label>
                            <input type="text" id="webhook-url-display" readonly class="w-full p-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-600">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Verify Token:</label>
                            <input type="text" id="conf-verify-token" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Page Access Token:</label>
                            <input type="text" id="conf-page-token" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500" placeholder="EAAG...">
                        </div>
                        <div>
                            <label class="text-xs font-semibold text-slate-500 block mb-1">Facebook Page ID:</label>
                            <input type="text" id="conf-page-id" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500" placeholder="122097146930008538">
                        </div>
                        <div class="pt-4 flex justify-end">
                            <button onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกค่า Webhook</button>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    </div>

    <script>
        let currentConfig = {};
        let statusInterval = null;

        async function loadConfig() {
            const res = await fetch('/api/config');
            const data = await res.json();
            currentConfig = data.config;
            document.getElementById('subscriber-count').innerText = (data.subscriberCount || 0) + ' คน';
            renderUI();
        }

        function renderUI() {
            document.getElementById('keywords-container').innerHTML = currentConfig.keywords.map((kw, i) => \`
                <span class="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white text-xs font-medium rounded-lg">
                    \${kw} <button onclick="removeKeyword(\${i})" class="hover:text-red-200 font-bold ml-1">×</button>
                </span>\`).join('');
            document.getElementById('reply-comment-input').value = currentConfig.replyCommentText || '';
            document.getElementById('inbox-input').value = currentConfig.inboxText || '';
            document.getElementById('enable-comment-reply').checked = !!currentConfig.enableCommentReply;
            document.getElementById('enable-inbox').checked = !!currentConfig.enableInbox;
            document.getElementById('conf-verify-token').value = currentConfig.verifyToken || '';
            document.getElementById('conf-page-token').value = currentConfig.pageAccessToken || '';
            document.getElementById('conf-page-id').value = currentConfig.pageId || '';
            document.getElementById('webhook-url-display').value = window.location.origin + '/webhook';
            
            const isExact = currentConfig.matchType === 'exact';
            document.getElementById('btn-exact').className = isExact ? "px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white" : "px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600";
            document.getElementById('btn-contains').className = !isExact ? "px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white" : "px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600";
        }

        function setMatchType(type) {
            currentConfig.matchType = type;
            renderUI();
        }

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
            currentConfig.verifyToken = document.getElementById('conf-verify-token').value;
            currentConfig.pageAccessToken = document.getElementById('conf-page-token').value;
            currentConfig.pageId = document.getElementById('conf-page-id').value;
            await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentConfig) });
            alert('✅ บันทึกการตั้งค่าสำเร็จ!');
        }

        function switchTab(tabId) {
            ['dashboard', 'broadcast', 'webhook'].forEach(id => {
                document.getElementById('tab-' + id).classList.add('hidden');
                document.getElementById('nav-' + id).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50";
            });
            document.getElementById('tab-' + tabId).classList.remove('hidden');
            document.getElementById('nav-' + tabId).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-50 text-blue-600";
        }

        // ฟังก์ชันรับ Token ผ่าน Prompt แล้วดึงรายชื่อเพจมาแสดงใน Dropdown
        async function promptForTokenAndFetch() {
            const token = prompt("กรุณาวาง User Access Token ของคุณ (จาก Graph API Explorer):");
            if (!token) return;

            const res = await fetch('/api/fetch-pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userAccessToken: token })
            });
            const data = await res.json();

            if(data.success && data.pages) {
                const select = document.getElementById('page-select');
                select.innerHTML = '<option value="">-- กรุณาเลือกเพจ --</option>';
                data.pages.forEach(p => {
                    select.innerHTML += \`<option value="\${p.access_token}" data-id="\${p.id}">\${p.name} (ID: \${p.id})</option>\`;
                });
                document.getElementById('page-select-container').classList.remove('hidden');
                alert(\`✅ ดึงข้อมูลสำเร็จ พบ \${data.pages.length} เพจ\`);
            } else {
                alert('❌ ดึงข้อมูลเพจไม่สำเร็จ: ' + (data.error || 'Token ไม่ถูกต้อง'));
            }
        }

        function onPageSelected() {
            const select = document.getElementById('page-select');
            const selectedOption = select.options[select.selectedIndex];
            if(selectedOption.value) {
                document.getElementById('conf-page-token').value = selectedOption.value;
                document.getElementById('conf-page-id').value = selectedOption.getAttribute('data-id');
            }
        }

        async function startBroadcast() {
            const message = document.getElementById('bc-message').value.trim();
            const delaySec = parseInt(document.getElementById('bc-delay').value) || 3;
            const batchSize = parseInt(document.getElementById('bc-batch-size').value) || 20;
            const pauseMin = parseInt(document.getElementById('bc-pause-min').value) || 10;

            if(!message) return alert('กรุณากรอกข้อความบรอดแคสก่อนครับ!');

            if(!confirm(\`ยืนยันเริ่มส่งบรอดแคส?\n- หน่วงเวลาคนละ: \${delaySec} วินาที\n- ส่งครบ: \${batchSize} คน ให้หยุดพัก \${pauseMin} นาที\`)) return;

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
            document.getElementById('bc-numbers').innerText = \`\${status.current}/\${status.total} (สำเร็จ: \${status.success}, ล้มเหลว: \${status.failed})\`;

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

// 2. API Config Routes
app.get('/api/config', (req, res) => res.json({ success: true, config: configStore, subscriberCount: subscribers.size }));
app.post('/api/config', (req, res) => {
  configStore = { ...configStore, ...req.body };
  res.json({ success: true });
});

// API สำหรับดึงรายชื่อเพจด้วย User Access Token
app.post('/api/fetch-pages', async (req, res) => {
  const { userAccessToken } = req.body;
  if (!userAccessToken) {
    return res.json({ success: false, error: 'กรุณากรอก User Access Token ก่อนครับ' });
  }
  try {
    const response = await axios.get(`https://graph.facebook.com/v19.0/me/accounts`, {
      params: { access_token: userAccessToken }
    });
    res.json({ success: true, pages: response.data.data });
  } catch (err) {
    res.json({ success: false, error: err.response?.data?.error?.message || err.message });
  }
});

// 3. API ควบคุม บรอดแคส
app.post('/api/broadcast/start', async (req, res) => {
  const { message, delaySec, batchSize, pauseMin } = req.body;

  if (broadcastStatus.isBroadcasting) {
    return res.json({ success: false, error: 'กำลังรันบรอดแคสอยู่แล้ว' });
  }

  if (subscribers.size === 0) {
    return res.json({ success: false, error: 'ยังไม่มีรายชื่อผู้รับในระบบ (ต้องมีคนทักแชทหรือคอมเมนต์เข้ามาก่อน)' });
  }

  const subList = Array.from(subscribers);
  
  broadcastStatus = {
    isBroadcasting: true,
    total: subList.length,
    current: 0,
    success: 0,
    failed: 0,
    statusMessage: 'กำลังเริ่มส่ง...',
    shouldStop: false
  };

  res.json({ success: true });

  (async () => {
    let currentBatchCount = 0;

    for (let i = 0; i < subList.length; i++) {
      if (broadcastStatus.shouldStop) {
        broadcastStatus.statusMessage = 'หยุดการส่งตามคำสั่งผู้ใช้';
        break;
      }

      const recipientId = subList[i];
      broadcastStatus.current = i + 1;
      broadcastStatus.statusMessage = `กำลังส่งหาผู้รับที่ ${i + 1}/${subList.length}...`;

      try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
          recipient: { id: recipientId },
          message: { text: message }
        }, {
          params: { access_token: configStore.pageAccessToken }
        });
        broadcastStatus.success++;
      } catch (err) {
        console.error(`❌ ส่งบรอดแคสหา [${recipientId}] ล้มเหลว:`, err.response?.data || err.message);
        broadcastStatus.failed++;
      }

      currentBatchCount++;

      if (currentBatchCount >= batchSize && (i + 1) < subList.length) {
        currentBatchCount = 0;
        
        for (let m = pauseMin; m > 0; m--) {
          if (broadcastStatus.shouldStop) break;
          broadcastStatus.statusMessage = `⏳ ส่งครบ ${batchSize} คนแล้ว ระบบกำลังพัก ${m} นาที เพื่อความปลอดภัย...`;
          await sleep(60 * 1000);
        }
      } else {
        await sleep(delaySec * 1000);
      }
    }

    broadcastStatus.isBroadcasting = false;
    if (!broadcastStatus.shouldStop) {
      broadcastStatus.statusMessage = '✅ บรอดแคสเสร็จสิ้นสมบูรณ์!';
    }
  })();
});

app.post('/api/broadcast/stop', (req, res) => {
  broadcastStatus.shouldStop = true;
  res.json({ success: true });
});

app.get('/api/broadcast/status', (req, res) => {
  res.json(broadcastStatus);
});

// 4. Webhook Endpoints สำหรับ Facebook
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === configStore.verifyToken) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');
    
    for (const entry of body.entry || []) {
      
      if (entry.messaging) {
        for (const msgEvent of entry.messaging) {
          if (msgEvent.sender?.id && msgEvent.sender.id !== configStore.pageId) {
            subscribers.add(msgEvent.sender.id);
            console.log(`📌 เพิ่มรายชื่อบรอดแคสจาก Messenger ID: ${msgEvent.sender.id} (รวมสะสม: ${subscribers.size} คน)`);
          }
        }
      }

      for (const change of entry.changes || []) {
        if (change.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
          
          const commentId = change.value.comment_id;
          const text = change.value.message || '';
          const senderId = change.value.from?.id;

          if (senderId && senderId !== configStore.pageId) {
            subscribers.add(senderId);
          }

          console.log(`💬 พบคอมเมนต์ใหม่ [ID: ${senderId}]: "${text}" (Comment ID: ${commentId})`);

          if (configStore.pageId && senderId === configStore.pageId) {
            console.log('⚠️ ข้าม: เป็นคอมเมนต์ของแอดมินเพจเอง');
            continue;
          }

          const cleanText = text.trim();
          let matched = false;

          if (configStore.matchType === 'exact') {
            const words = cleanText.split(/\s+/);
            matched = configStore.keywords.some(kw => {
              return cleanText.toLowerCase() === kw.toLowerCase() || words.some(w => w.toLowerCase() === kw.toLowerCase());
            });
          } else {
            matched = configStore.keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
          }
          
          if (matched) {
            console.log('✨ ตรงกับ Keyword! กำลังดำเนินการตอบกลับ...');

            if (configStore.enableCommentReply && configStore.replyCommentText && configStore.pageAccessToken) {
              try {
                await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
                  message: configStore.replyCommentText
                }, {
                  params: { access_token: configStore.pageAccessToken }
                });
                console.log('✅ ตอบกลับใต้คอมเมนต์สำเร็จ!');
              } catch (err) {
                console.error('❌ ตอบกลับคอมเมนต์ไม่สำเร็จ:', err.response?.data?.error?.message || err.message);
              }
            }

            if (configStore.enableInbox && configStore.inboxText && configStore.pageAccessToken) {
              try {
                await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
                  recipient: { comment_id: commentId },
                  message: { text: configStore.inboxText }
                }, {
                  params: { access_token: configStore.pageAccessToken }
                });
                console.log('✅ ส่งข้อความเข้า Inbox สำเร็จ!');
              } catch (err) {
                console.error('❌ ส่ง Inbox ไม่สำเร็จ Error Detail:', JSON.stringify(err.response?.data || err.message));
              }
            }

          } else {
            console.log('ℹ️ คอมเมนต์นี้ไม่ตรงกับ Keyword ที่ตั้งไว้');
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// เริ่มต้นรันเซิร์ฟเวอร์ พร้อมระบบ Anti-Sleep (Self-Ping ทุก 10 นาที)
const PORT = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);

  setInterval(async () => {
    try {
      await axios.get(serverUrl);
      console.log('🔄 Anti-Sleep Ping สำเร็จ: เซิร์ฟเวอร์ตื่นอยู่เสมอ');
    } catch (err) {
      console.error('❌ Anti-Sleep Ping ล้มเหลว:', err.message);
    }
  }, 10 * 60 * 1000); // ทุก 10 นาที
});