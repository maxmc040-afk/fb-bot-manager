const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ⚡ ใช้การเชื่อมต่อเดิมซ้ำ (keep-alive) ไม่ต้องจับมือ TLS ใหม่ทุกครั้งที่เรียก Facebook / EasySlip
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000 });
axios.defaults.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// ⚡ ยิง Facebook พร้อมลองใหม่อัตโนมัติเมื่อ Facebook ขัดข้องชั่วคราว (เน็ตสะดุด / 5xx / code 1,2 / is_transient)
// ใช้กับ "ส่งเข้าแชทผ่านคอมเมนต์" ได้ปลอดภัย เพราะ Facebook บล็อกการส่งซ้ำต่อคอมเมนต์เดียวกันเองอยู่แล้ว
function isTransientFbError(err) {
  const e = err.response?.data?.error;
  if (!err.response) return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT'].includes(err.code);
  if (err.response.status >= 500 && !e) return true;
  return !!(e && (e.is_transient || e.code === 1 || e.code === 2));
}
async function fbPost(url, body, params, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await axios.post(url, body, { params, timeout: 15000 });
    } catch (err) {
      if (attempt >= retries || !isTransientFbError(err)) throw err;
      await sleep(600 * (attempt + 1));
    }
  }
}

// 💬 ข้อความตอบกลับ: รองรับหลายแบบ (คั่นด้วยบรรทัด ---) สุ่มส่ง + ใส่ชื่อลูกค้า {name} / {fullname}
// ข้อความไม่ซ้ำกันทุกครั้ง ช่วยลดโอกาส Facebook มองว่าเป็นสแปมแล้วบล็อกการตอบ
function renderReplyText(template, fullName) {
  const variants = String(template || '').split(/\r?\n[ \t]*---[ \t]*(?=\r?\n|$)/).map(t => t.trim()).filter(Boolean);
  if (!variants.length) return '';
  const pick = variants[Math.floor(Math.random() * variants.length)];
  const full = String(fullName || '').trim();
  const first = full.split(/\s+/)[0] || '';
  return pick.replace(/\{name\}/gi, first || 'คุณลูกค้า').replace(/\{fullname\}/gi, full || 'คุณลูกค้า');
}

// 🛡️ Facebook บล็อกชั่วคราวเพราะตอบถี่ (code 368 / spam) -> หยุดส่งประเภทนั้นสักพัก กันโดนแบนหนักขึ้น
const FB_PAUSE_MS = 15 * 60 * 1000;
function isFbSpamBlock(err) {
  const e = err.response?.data?.error || {};
  return e.code === 368 || e.error_subcode === 1390008 || /temporarily blocked|spam|ถูกบล็อกชั่วคราว/i.test(e.message || '');
}
function fbPaused(pageData, kind) {
  const p = pageData.fbPause && pageData.fbPause[kind];
  return !!(p && p.until > Date.now());
}
function setFbPause(pageData, kind, err) {
  if (!pageData.fbPause) pageData.fbPause = {};
  pageData.fbPause[kind] = { until: Date.now() + FB_PAUSE_MS, reason: err.response?.data?.error?.message || err.message };
  console.error('🛑 [FB Block] หยุด' + (kind === 'reply' ? 'ตอบคอมเมนต์' : 'ส่งเข้าแชท') + ' 15 นาที:', pageData.fbPause[kind].reason);
}
function fbPauseWarning(pageData) {
  const out = [];
  for (const [kind, label] of [['reply', 'ตอบใต้คอมเมนต์'], ['inbox', 'ส่งเข้าแชท']]) {
    const p = pageData.fbPause && pageData.fbPause[kind];
    if (p && p.until > Date.now()) out.push('⚠️ Facebook บล็อก' + label + 'ชั่วคราว (ตอบถี่เกินไป) ระบบพักให้อัตโนมัติถึง ' + new Date(p.until).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' }));
  }
  return out.join(' · ');
}

// ⚡ รันงานเบื้องหลังแบบไม่บล็อกกัน (คอมเมนต์ / สลิป แต่ละอันทำงานพร้อมกัน)
// สติกเกอร์ ปุ่มไลก์ (👍) และ GIF ใน Messenger มาเป็น attachment ชนิด image -> ไม่ใช่สลิป
function isStickerOrGif(message, att) {
  if (message && message.sticker_id) return true;
  const p = att && att.payload || {};
  if (p.sticker_id) return true;
  const url = String(p.url || '').toLowerCase();
  if (/\.gif(\?|$)/.test(url)) return true;
  if (/(^|\/\/)[^/]*(giphy|tenor)\./.test(url)) return true;
  return false;
}

// 🧾 ดึง URL รูปสลิปจากไฟล์แนบทุกรูปแบบ
// ปกติสลิปมาเป็น type "image" แต่ Messenger รุ่นใหม่ (ไทย) จะแปลงรูปสลิปเป็นการ์ด
// "ตรวจสอบยืนยันสลิปธนาคารโดยอัตโนมัติ" / "ส่งการชำระเงิน" ซึ่งอาจมาเป็น template / fallback / ชนิดอื่น
function slipImageUrlsFromMessage(message) {
  const out = [];
  const add = (u) => { u = typeof u === 'string' ? u.trim() : ''; if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
  const looksImage = (u) => /\.(jpe?g|png|webp|heic)(\?|$)/i.test(String(u || '')) || /(fbcdn\.net|fbsbx\.com|scontent)/i.test(String(u || ''));
  for (const att of (message && message.attachments) || []) {
    if (!att) continue;
    const p = att.payload || {};
    if (att.type === 'image') { if (!isStickerOrGif(message, att)) add(p.url); continue; }
    if (att.type === 'video' || att.type === 'audio' || att.type === 'file' || att.type === 'location') continue;
    // template / fallback / payment / ชนิดใหม่ ๆ: หารูปในทุกตำแหน่งที่ Facebook ใช้
    if (p.url && looksImage(p.url) && !/\.gif(\?|$)/i.test(p.url)) add(p.url);
    add(p.image_url); add(p.media_url);
    if (att.image_data) add(att.image_data.url);
    for (const el of p.elements || []) { if (el) { add(el.image_url); if (el.media_url) add(el.media_url); } }
    for (const m of p.media || []) { if (m) add(m.url || m.image_url); }
  }
  return out;
}
// 🧾 การ์ด "ตรวจสอบยืนยันสลิป" ของ Messenger ที่มาเปล่า ๆ: ขอรูปจากข้อความนั้นผ่าน Graph API
async function fetchSlipFromCard(targetRecord, pageId, senderId, mid) {
  const pd = targetRecord.pageData;
  // มีรูปสลิปของลูกค้าคนนี้เข้ามาตรวจแล้วในช่วงนี้ -> ไม่ต้องทำซ้ำ
  if ((pd.slipAttempts || []).some(a => a.senderId === senderId && a.result !== 'noimage' && Date.now() - a.time < 90000)) return;
  let urls = [], err = '';
  try {
    const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(mid), {
      params: { fields: 'message,attachments{mime_type,name,file_url,image_data{url,preview_url}}', access_token: pd.config.pageAccessToken }, timeout: 15000
    });
    for (const a of (r.data && r.data.attachments && r.data.attachments.data) || []) {
      const u = (a.image_data && (a.image_data.url || a.image_data.preview_url)) || (/^image\//.test(a.mime_type || '') ? a.file_url : '');
      if (u && !urls.includes(u)) urls.push(u);
    }
  } catch (e) { err = graphErrorMessage(e); }
  if (!urls.length) {
    logSlipAttempt(pd, { senderId, provider: '-', result: 'noimage', code: 'card',
      note: 'ลูกค้าส่งสลิปแต่ Messenger แปลงเป็นการ์ด "ตรวจสอบยืนยันสลิป" และ Facebook ไม่ส่งรูปมาให้' + (err ? ' (' + err + ')' : '') + ' · ตรวจในแชทแล้วบันทึกแบบแมนนวล' });
    return;
  }
  for (const u of urls) await processSlipImage(targetRecord, pageId, senderId, u, 0);
}

// ===================== 🔨 โหมดประมูล =====================
// ราคาบิด = คอมเมนต์ที่เป็น "ตัวเลขล้วน" และลงท้ายด้วย 0 (กติกาประมูลของร้าน) เช่น 380, 1,500, บิด 2500, 3000 บาท, ๓๘๐
// "1" / "11" / "111" ไม่ลงท้ายด้วย 0 จึงไม่ถูกนับเป็นราคา (ใช้เป็นคำดักรับของได้ตามปกติ)
function parseBid(text) {
  let t = String(text || '').trim();
  if (!t || t.length > 30) return null;
  t = t.replace(/[๐-๙]/g, d => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)));
  const m = t.match(/^(?:บิด|สู้|ประมูล|bid)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*(?:บาท|บ\.?|฿|\.-|-)?\s*$/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  if (!(n > 0) || n > 10000000 || n % 10 !== 0) return null;
  return n;
}
// 🔔 สัญญาณปิดการประมูล = เพจคอมเมนต์อีโมจิหัวใจ (เช่น ❤️❤️❤️❤️🙏)
function isAuctionCloseSignal(text) {
  const t = String(text || '').replace(/[\uFE0F\u200D\s]/g, '');
  if (!t || t.length > 60) return false;
  if (!/[❤♥💖💗💓💕💞💘💝🧡💛💚💙💜🤍🖤🤎❣]/u.test(t)) return false;
  return /^[❤♥💖💗💓💕💞💘💝🧡💛💚💙💜🤍🖤🤎❣🙏🎉✨👏]+$/u.test(t);
}

// ยอดของคนที่กด 1
// มีสัญญาณปิด (หัวใจของเพจ): รอบประมูล = ราคาที่บิดระหว่างสัญญาณปิดครั้งก่อน ถึงสัญญาณปิดล่าสุดก่อนกด 1
//   -> ยอด = ราคาสูงสุดที่คนกด 1 บิดในรอบนั้น (ราคาเท่ากัน ให้คนกด 1 เป็นผู้ชนะ ตามที่แอดมินประกาศหน้าไลฟ์)
// ไม่มีสัญญาณปิด: ยอด = ราคาล่าสุดที่คนนั้นบิด หลังการกด 1 ครั้งก่อนของเขา
function auctionAmountFor(session, uid, at) {
  const c = session.commenters.get(uid);
  if (!c) return null;
  const log = session.bidLog || [];
  const closes = (session.auctionCloses || []).filter(t => t <= at);
  const lotClose = closes.length ? closes[closes.length - 1] : 0;
  // ราคาที่บิดหลังหัวใจล่าสุด ไม่นับ (ปิดรอบไปแล้ว) ยกเว้นคนนี้ชนะรอบนั้นไปแล้วและบิดรอบใหม่ (แอดมินลืมส่งหัวใจ)
  const openBids = (c.bids || []).filter(b => b.time > Math.max(lotClose, c.lastWinAt || 0) && b.time <= at);
  const wonThisLot = Array.isArray(c.wonLots) && c.wonLots.includes(lotClose);
  if (lotClose && !(wonThisLot && openBids.length)) {
    const prevClose = closes.length > 1 ? closes[closes.length - 2] : 0;
    const lotBids = log.filter(b => b.time > prevClose && b.time <= lotClose);
    const mine = lotBids.filter(b => b.uid === uid);
    if (mine.length) {
      const myTop = mine.reduce((m, b) => b.amount > m.amount ? b : m, mine[0]);
      const top = lotBids.reduce((m, b) => b.amount > m.amount ? b : m, lotBids[0]);
      const dupLot = Array.isArray(c.wonLots) && c.wonLots.includes(lotClose);
      return {
        amount: myTop.amount, bidTime: myTop.time, lot: lotClose, dupLot,
        warning: dupLot ? 'กด 1 ซ้ำในรอบเดิม (ไม่บวกยอดซ้ำ)'
          : top.amount > myTop.amount ? ('ราคาสูงสุดก่อนปิดคือ ' + (top.name || top.uid) + ' ' + top.amount.toLocaleString('en-US')) : ''
      };
    }
  }
  // สำรอง: ไม่มีสัญญาณปิด / คนกด 1 ไม่ได้บิดในรอบที่ปิด
  if (!Array.isArray(c.bids)) return null;
  const from = Math.max(c.lastWinAt || 0, 0);
  const own = c.bids.filter(b => b.time > from && b.time <= at);
  if (!own.length) return null;
  const bid = own[own.length - 1];
  const higher = log.filter(b => b.uid !== uid && b.time >= bid.time && b.time <= at && b.amount > bid.amount)
    .sort((x, y) => y.amount - x.amount)[0];
  return { amount: bid.amount, bidTime: bid.time, lot: 0,
    warning: [lotClose ? (wonThisLot ? 'รอบใหม่ยังไม่มีหัวใจปิดรอบ ใช้ราคาล่าสุด' : 'ไม่ได้บิดในรอบที่เพิ่งปิด') : '',
      higher ? ('มีคนบิดสูงกว่า: ' + (higher.name || higher.uid) + ' ' + higher.amount.toLocaleString('en-US')) : ''].filter(Boolean).join(' · ') };
}

// สรุปแต่ละรอบประมูล (ใช้แสดงในหน้า session)
function auctionLotsSummary(session) {
  const closes = session.auctionCloses || [];
  const log = session.bidLog || [];
  const out = [];
  closes.forEach((close, i) => {
    const prev = i ? closes[i - 1] : 0;
    const bids = log.filter(b => b.time > prev && b.time <= close);
    if (!bids.length) return;
    const topAmt = Math.max(...bids.map(b => b.amount));
    const tops = bids.filter(b => b.amount === topAmt);
    const winners = [];
    for (const [uid, c] of session.commenters) for (const w of (c.wins || [])) if (w.lot === close && !w.dup) winners.push({ name: c.name || uid, amount: w.amount });
    out.push({ closeAt: close, topAmount: topAmt, topNames: Array.from(new Set(tops.map(b => b.name || b.uid))), bids: bids.length, winners });
  });
  return out.slice(-30).reverse();
}

function runTask(fn, label) {
  return Promise.resolve().then(fn).catch(e => console.error('❌ [Task Error]', label || '', e?.response?.data || e?.message || e));
}
// ⚡ จำกัดจำนวนงานยิง Facebook พร้อมกันต่อเพจ กันโดน rate limit ตอนไลฟ์คนคอมเมนต์รัว ๆ
const FB_CONCURRENCY = 10;
const fbQueues = {};
function fbLimit(pageId, fn) {
  const q = fbQueues[pageId] || (fbQueues[pageId] = { active: 0, waiting: [] });
  return new Promise((resolve, reject) => {
    const start = () => {
      q.active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        q.active--;
        const next = q.waiting.shift();
        if (next) next();
      });
    };
    if (q.active < FB_CONCURRENCY) start(); else q.waiting.push(start);
  });
}
// 🧾 ลูกค้า "กำลังจ่ายเงิน" อยู่ไหม: ใช้ตัดสินว่ารูปที่อ่านเป็นสลิปไม่ได้ ควรแจ้งลูกค้าหรือเงียบไว้
// (EasySlip v2 แยกไม่ได้ว่าเป็น "รูปทั่วไปไม่มี QR" หรือ "สลิปเบลอ" จึงดูจากบริบทในแชทแทน)
const PAY_WORDS = /โอน|สลิป|จ่าย|ชำระ|ยอด|บิล|มัดจำ|ค่าส่ง|เลขบัญชี|transfer|slip|paid|pay/i;
function isPaymentContext(pageData, psid) {
  const now = Date.now();
  // 1) ลูกค้าพิมพ์เรื่องโอน / สลิป มาภายใน 30 นาที (รวมข้อความที่ส่งมาพร้อมรูป)
  const texts = (pageData.inboxLog && pageData.inboxLog.get(String(psid))) || [];
  if (texts.some(m => now - (m.time || 0) < 30 * 60000 && PAY_WORDS.test(m.text || ''))) return true;
  // 2) เพิ่งคอมเมนต์ตรงคำดัก (กดสั่งซื้อ) ในไลฟ์ภายใน 2 ชม. และยังไม่มีสลิปที่ผ่าน
  for (const s of Object.values(pageData.liveSessions || {})) {
    for (const [uid, c] of s.commenters || []) {
      if ((c.psid === String(psid) || uid === String(psid)) && c.matchedCount > 0 && now - (c.lastTime || 0) < 2 * 3600000) {
        const paid = (s.slips || []).some(x => String(x.senderId) === String(psid));
        if (!paid) return true;
      }
    }
  }
  return false;
}

// ===================== 🏷️ ป้ายกำกับ (Custom Labels) ของ Facebook Inbox =====================
// ดึงรายชื่อป้ายกำกับทั้งหมดที่มีอยู่แล้วในเพจ
// - รวมป้ายที่ "ชื่อซ้ำกัน" (Facebook มีได้หลาย ID ชื่อเดียวกัน) ให้เหลือ 1 ตัวเลือก แต่จำทุก ID ไว้
// - ซ่อนป้ายระบบโฆษณา ad_id.xxxx ที่ Meta สร้างเอง
async function listPageLabels(pageData) {
  const cfg = pageData.config;
  const groups = new Map(); // ชื่อ -> { id, name, ids: [] }
  let url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(cfg.pageId) + '/custom_labels';
  let params = { fields: 'page_label_name', limit: 100, access_token: cfg.pageAccessToken };
  for (let i = 0; i < 30 && url; i++) {
    const r = await axios.get(url, { params, timeout: 15000 });
    for (const l of r.data.data || []) {
      if (!l.id || !l.page_label_name) continue;
      const name = String(l.page_label_name).trim();
      if (/^ad_id\./i.test(name)) continue;
      const key = name.toLowerCase();
      const g = groups.get(key) || { id: String(l.id), name, ids: [] };
      if (!g.ids.includes(String(l.id))) g.ids.push(String(l.id));
      groups.set(key, g);
    }
    url = r.data.paging?.next || null;
    params = undefined;
  }
  const out = Array.from(groups.values()).sort((x, y) => x.name.localeCompare(y.name, 'th'));
  // จำไว้ใช้ตอน "ลบป้าย" / "กรองป้าย" ให้ครอบคลุมทุก ID ที่ชื่อเดียวกัน
  pageData.labelGroups = { byId: new Map(), byName: new Map(), nameById: new Map(), at: Date.now() };
  for (const g of out) {
    for (const id of g.ids) { pageData.labelGroups.byId.set(id, g.ids); pageData.labelGroups.nameById.set(id, g.name); }
    pageData.labelGroups.byName.set(g.name.trim().toLowerCase(), g.ids);
  }
  return out;
}

// ID ทั้งหมดที่เป็นป้ายชื่อเดียวกับ id นี้ (ถ้ายังไม่เคยโหลดรายชื่อป้าย จะโหลดก่อน 1 ครั้ง)
// name (ถ้าส่งมา): ถ้า ID เดิมถูกลบไปแล้ว แต่มีป้าย "ชื่อเดียวกัน" สร้างใหม่ -> ใช้ป้ายใหม่นั้นให้อัตโนมัติ
async function sameNameLabelIds(pageData, id, name) {
  id = String(id);
  const stale = !pageData.labelGroups || Date.now() - pageData.labelGroups.at > 60 * 1000; // รายชื่อป้ายเก่ากว่า 1 นาที -> โหลดใหม่
  const unknown = pageData.labelGroups && !pageData.labelGroups.byId.has(id);
  // ไม่รู้จัก ID นี้ (เพิ่งลบ/สร้างป้ายใหม่) -> โหลดรายชื่อป้ายใหม่ (ไม่เกินทุก 30 วินาที)
  if (stale || (unknown && Date.now() - pageData.labelGroups.at > 30 * 1000)) {
    try { await listPageLabels(pageData); } catch (e) { /* ใช้ id เดิม */ }
  }
  const g = pageData.labelGroups;
  if (g && g.byId.has(id)) return g.byId.get(id);
  if (g && name && g.byName.has(String(name).trim().toLowerCase())) return g.byName.get(String(name).trim().toLowerCase());
  return [id];
}

// ป้ายที่จะ "ติด": ใช้ ID เดียวเท่านั้น (ติดหลาย ID จะเห็นป้ายซ้ำ / ไปติดป้ายที่ซ่อนอยู่ใน Business Suite)
// ใช้ ID ที่เลือกไว้ ถ้ายังมีอยู่ในเพจ · ถ้าถูกลบไปแล้ว ใช้ป้ายชื่อเดียวกันตัวแรก
async function labelIdForAdd(pageData, id, name) {
  const ids = await sameNameLabelIds(pageData, id, name).catch(() => [String(id)]);
  return ids.includes(String(id)) ? [String(id)] : ids.slice(0, 1);
}

// ป้ายกำกับทั้งหมดของลูกค้า 1 คน (คืนค่าเป็น Set ของ label id)
async function getUserLabelIds(pageData, psid) {
  const ids = new Set();
  let url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(psid) + '/custom_labels';
  let params = { fields: 'page_label_name', limit: 100, access_token: pageData.config.pageAccessToken };
  for (let i = 0; i < 5 && url; i++) {
    const r = await axios.get(url, { params, timeout: 15000 });
    for (const l of r.data.data || []) ids.add(String(l.id));
    url = r.data.paging?.next || null;
    params = undefined;
  }
  return ids;
}

async function setInboxLabelById(pageData, psid, labelId, remove) {
  await axios({
    method: remove ? 'delete' : 'post',
    url: 'https://graph.facebook.com/v19.0/' + encodeURIComponent(labelId) + '/label',
    params: { user: psid, access_token: pageData.config.pageAccessToken },
    timeout: 15000
  });
}

// คนคอมเมนต์ที่ไม่ได้อยู่ใน Live Session (โพสต์ทั่วไป): จำเวลาตอบล่าสุด / การติดป้าย ต่อคน
function pageCommenterRec(pageData, senderId) {
  if (!pageData.pageCommenters) pageData.pageCommenters = new Map();
  const m = pageData.pageCommenters;
  let r = m.get(String(senderId));
  if (!r) {
    r = { lastRepliedAt: 0, kwLabeled: false, kwLabeledAt: 0 };
    m.set(String(senderId), r);
    if (m.size > 5000) m.delete(m.keys().next().value);
  }
  // โพสต์ทั่วไป: ติด/ลบป้ายใหม่ได้วันละครั้งต่อคน
  if (r.kwLabeled && Date.now() - (r.kwLabeledAt || 0) > 24 * 3600 * 1000) r.kwLabeled = false;
  return r;
}

// 🔎 อ่านป้ายจริงของลูกค้ากลับมาจาก Facebook เพื่อยืนยันว่าติด/ลบสำเร็จจริง
// คืนค่า { ok, shown } หรือ null ถ้าอ่านไม่ได้ (เช่น บัญชีสมัครด้วยเบอร์โทร)
async function verifyUserLabels(pageData, psid, addList, removeList) {
  try {
    await sleep(1500);
    const have = await getUserLabelIds(pageData, psid);
    const g = pageData.labelGroups;
    const nameOf = (id) => (g && g.nameById && g.nameById.get(id)) || id;
    const lc = (x) => String(x || '').trim().toLowerCase();
    const names = new Set();
    for (const id of have) names.add(lc(nameOf(id)));
    const missing = addList.filter(l => !names.has(lc(l.name)) && !have.has(String(l.id))).map(l => l.name);
    const still = removeList.filter(l => names.has(lc(l.name)) || have.has(String(l.id))).map(l => l.name);
    const shown = Array.from(have).map(nameOf).filter(n => !/^[0-9]+$/.test(n)).join(', ') || 'ไม่มี';
    if (missing.length || still.length) {
      return { ok: false, shown, text: '⚠️ Facebook ตอบสำเร็จ แต่ตรวจแล้ว' + (missing.length ? ' ไม่พบป้าย ' + missing.join(', ') : '') + (still.length ? ' ป้าย ' + still.join(', ') + ' ยังอยู่' : '') + ' · ป้ายตอนนี้: ' + shown };
    }
    return { ok: true, shown };
  } catch (e) { return null; }
}

// ติด / ลบป้ายให้คนที่คอมเมนต์ตรงคำดัก (ทำครั้งเดียวต่อคนต่อ session)
// labels = ป้ายที่จะติด (array) หรือ config ของ session ({ keywordLabels, keywordRemoveLabels })
function labelKeywordCommenter(pageData, commenter, psid, labels) {
  const addList = (Array.isArray(labels) ? labels : (labels && labels.keywordLabels) || []).filter(l => l && l.id);
  const removeList = ((!Array.isArray(labels) && labels && labels.keywordRemoveLabels) || []).filter(l => l && l.id);
  if (!commenter || (!addList.length && !removeList.length)) return;
  if (!pageData.config.pageAccessToken) { commenter.kwLabelStatus = '❌ เพจไม่มี Token'; return; }
  if (!psid) { commenter.kwLabelStatus = '⏳ รอ ID แชทของลูกค้า (ต้องเปิดส่งข้อความเข้าแชท)'; return; }
  if (commenter.kwLabeled || commenter.kwLabelBusy) return;
  commenter.kwLabelBusy = true;
  runTask(async () => {
    const errors = [];
    const done = [];
    for (const l of addList) {
      let ids = await labelIdForAdd(pageData, l.id, l.name);
      let okCount = 0, lastErr = null;
      for (let round = 0; round < 2 && !okCount; round++) {
        if (round === 1) {
          // ป้ายเดิมถูกลบ (Facebook ตอบว่าไม่มีป้ายนี้) -> โหลดรายชื่อป้ายใหม่ แล้วหาจากชื่อ
          if (lastErr?.response?.data?.error?.code !== 100) break;
          pageData.labelGroups = null;
          const all = await sameNameLabelIds(pageData, '__deleted__', l.name).catch(() => ids);
          const again = all.filter(x => !ids.includes(x)).slice(0, 1);
          if (!again.length) break;
          ids = again;
        }
        for (const id of ids) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try { await setInboxLabelById(pageData, psid, id); okCount++; break; }
            catch (e) { lastErr = e; if (attempt === 1 || !isTransientFbError(e)) break; await sleep(800); }
          }
        }
      }
      if (okCount) { done.push('+' + l.name); console.log('🏷️ [Label] คำดัก: ติดป้าย "' + l.name + '" ให้ ' + psid + ' (' + okCount + '/' + ids.length + ' ID)'); }
      else errors.push('ติด "' + l.name + '": ' + graphErrorMessage(lastErr));
    }
    for (const l of removeList) {
      for (const id of await sameNameLabelIds(pageData, l.id, l.name).catch(() => [l.id])) {
        try { await setInboxLabelById(pageData, psid, id, true); }
        catch (e) {
          const code = e.response?.data?.error?.code;
          // ลูกค้าไม่มีป้ายนี้อยู่แล้ว (code 100) ไม่ถือว่าผิดพลาด
          if (code !== 100) errors.push('ลบ "' + l.name + '": ' + graphErrorMessage(e));
        }
      }
      done.push('-' + l.name);
    }
    commenter.kwLabelBusy = false;
    commenter.kwLabelAt = Date.now();
    commenter.kwLabeledAt = Date.now();
    if (errors.length) {
      commenter.kwLabeled = false; // ให้ลองใหม่ได้ (เช่น ตอนลูกค้าทักแชท หรือคอมเมนต์อีกครั้ง)
      commenter.kwLabelStatus = '❌ ' + errors.join(' · ').slice(0, 300);
      pageData.lastLabelError = errors[0];
      pageData.lastLabelErrorAt = Date.now();
      console.error('❌ [Label Error]', errors.join(' | '));
    } else {
      commenter.kwLabeled = true;
      commenter.kwLabelStatus = '✅ ' + done.join(' ');
      pageData.lastLabelError = ''; // ติดป้ายสำเร็จแล้ว ล้างคำเตือนเดิม
      const v = await verifyUserLabels(pageData, psid, addList, removeList);
      if (v && !v.ok) {
        commenter.kwLabelStatus = v.text;
        pageData.lastLabelError = v.text; pageData.lastLabelErrorAt = Date.now();
        commenter.kwLabeled = false;
      } else if (v) commenter.kwLabelStatus = '✅ ' + done.join(' ') + ' · ป้ายตอนนี้: ' + v.shown;
    }
  }, 'kw-label');
}

// ติด/ลบป้ายตามที่แอดมินเลือกไว้ในแต่ละผลตรวจสลิป: result = 'valid' | 'invalid' | 'unreadable' | 'duplicate'
const SLIP_RESULT_TH = { valid: 'สลิปถูกต้อง', invalid: 'สลิปไม่ถูกต้อง', unreadable: 'สลิปตรวจสอบไม่ได้', duplicate: 'สลิปซ้ำ' };
function labelSlipResult(pageData, psid, result) {
  const cfg = pageData.config;
  const rule = (cfg.slipLabels || {})[result] || {};
  const add = Array.isArray(rule.add) ? rule.add.filter(l => l && l.id) : [];
  const remove = Array.isArray(rule.remove) ? rule.remove.filter(l => l && l.id) : [];
  if (!psid || !cfg.pageAccessToken || (!add.length && !remove.length)) return;
  runTask(async () => {
    const errors = [], done = [];
    const trySet = async (id, del) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await setInboxLabelById(pageData, psid, id, del); return null; }
        catch (e) { if (attempt === 1 || !isTransientFbError(e)) return e; await sleep(800); }
      }
    };
    for (const l of add) {
      // ติด ID เดียว (ไม่ไปติดป้ายชื่อซ้ำที่ซ่อนอยู่ใน Business Suite)
      let ids = await labelIdForAdd(pageData, l.id, l.name);
      let lastErr = null, ok = false;
      for (const id of ids) { lastErr = await trySet(id); if (!lastErr) { ok = true; break; } }
      if (!ok && lastErr?.response?.data?.error?.code === 100) {
        // ป้ายเดิมถูกลบ -> โหลดใหม่แล้วหาจากชื่อ (ใช้ตัวเดียว)
        pageData.labelGroups = null;
        ids = (await sameNameLabelIds(pageData, '__deleted__', l.name).catch(() => [])).filter(x => !ids.includes(x)).slice(0, 1);
        for (const id of ids) { lastErr = await trySet(id); if (!lastErr) { ok = true; break; } }
      }
      if (ok) { done.push('+' + l.name); console.log('🏷️ [Label] สลิป: ติดป้าย "' + l.name + '" ให้ ' + psid); }
      else errors.push('ติด "' + l.name + '": ' + graphErrorMessage(lastErr));
    }
    for (const l of remove) {
      // ลบทุก ID ที่ชื่อเดียวกัน ให้ป้ายหายจริง
      for (const id of await sameNameLabelIds(pageData, l.id, l.name).catch(() => [l.id])) {
        const e = await trySet(id, true);
        if (e && e.response?.data?.error?.code !== 100) errors.push('ลบ "' + l.name + '": ' + graphErrorMessage(e));
      }
      done.push('-' + l.name);
    }
    let status;
    if (errors.length) status = '❌ ' + errors.join(' · ').slice(0, 300);
    else {
      const v = await verifyUserLabels(pageData, psid, add, remove);
      status = v ? (v.ok ? '✅ ' + done.join(' ') + ' · ป้ายตอนนี้: ' + v.shown : v.text) : '✅ ' + done.join(' ');
    }
    if (status.charAt(0) !== '✅') {
      pageData.lastLabelError = (SLIP_RESULT_TH[result] || result) + ': ' + status;
      pageData.lastLabelErrorAt = Date.now();
      console.error('❌ [Label Error]', pageData.lastLabelError);
    }
    // แสดงผลการติดป้ายในประวัติตรวจสลิป (รายการล่าสุดของลูกค้าคนนี้)
    const at = (pageData.slipAttempts || []).find(a => a.senderId === psid && a.result !== 'noimage' && Date.now() - a.time < 10 * 60000);
    if (at) at.labelStatus = status;
  }, 'label');
}

// กันประมวลผลคอมเมนต์ซ้ำ (Facebook ส่ง webhook ซ้ำได้)
function seenComment(pageData, commentId) {
  if (!commentId) return false;
  if (!pageData.seenComments) pageData.seenComments = new Set();
  const set = pageData.seenComments;
  if (set.has(commentId)) return true;
  set.add(commentId);
  if (set.size > 20000) { let i = 0; for (const k of set) { set.delete(k); if (++i >= 5000) break; } }
  return false;
}

const zlib = require('zlib');

const app = express();
app.use(cors());

// ⚡ บีบอัด (gzip) หน้าเว็บและข้อมูล JSON ก่อนส่ง: หน้า Dashboard ~350KB เหลือ ~60KB โหลดเร็วขึ้นมากบนมือถือ
const gzipCache = { body: null, buf: null };
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body !== 'string' || body.length < 1500 || res.get('Content-Encoding')) return origSend(body);
    if (!res.get('Content-Type')) res.type(/^\s*</.test(body) ? 'html' : 'json');
    let buf;
    if (body.length > 100000 && gzipCache.body === body) buf = gzipCache.buf; // หน้าเว็บเดิม ใช้ไฟล์บีบอัดซ้ำ
    else {
      buf = zlib.gzipSync(body, { level: 6 });
      if (body.length > 100000) { gzipCache.body = body; gzipCache.buf = buf; }
    }
    res.set('Content-Encoding', 'gzip');
    res.vary('Accept-Encoding');
    return origSend(buf);
  };
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const usersDB = {};       
const pageIndexMap = {};  
let sessions = {};        

// =====================================================================
// 💾 ฐานข้อมูลถาวร (Upstash Redis ผ่าน REST API — ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
// ตั้งค่าใน Render → Environment:
//   UPSTASH_REDIS_REST_URL   = https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN = (REST Token)
// ไม่ตั้งค่า = ทำงานแบบเดิม (เก็บในหน่วยความจำ ข้อมูลหายเมื่อรีสตาร์ท)
// =====================================================================
const DB_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DB_PREFIX = (process.env.DB_PREFIX || 'fbbot') + ':';
const DB_ENABLED = !!(DB_URL && DB_TOKEN);
const dbState = { enabled: DB_ENABLED, loaded: false, saving: false, lastSave: 0, lastError: '', lastErrorAt: 0, keys: 0, bytes: 0, cycle: 0 };
const dbHashes = new Map(); // key -> hash ของข้อมูลที่บันทึกล่าสุด (บันทึกเฉพาะส่วนที่เปลี่ยน)

async function redisPipeline(cmds) {
  const r = await axios.post(DB_URL + '/pipeline', cmds, {
    headers: { Authorization: 'Bearer ' + DB_TOKEN }, timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity
  });
  const out = Array.isArray(r.data) ? r.data : [];
  const bad = out.find(x => x && x.error);
  if (bad) throw new Error('Redis: ' + bad.error);
  return out.map(x => (x ? x.result : null));
}

// แปลง Map / Set ให้เก็บเป็น JSON ได้ และแปลงกลับตอนโหลด
function dbReplacer(k, v) {
  if (v instanceof Map) return { __m: Array.from(v.entries()) };
  if (v instanceof Set) return { __s: Array.from(v.values()) };
  return v;
}
function dbReviver(k, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (Array.isArray(v.__m) && Object.keys(v).length === 1) return new Map(v.__m);
    if (Array.isArray(v.__s) && Object.keys(v).length === 1) return new Set(v.__s);
  }
  return v;
}
const dbEnc = (str) => zlib.gzipSync(str, { level: 6 }).toString('base64');
const dbDec = (b64) => JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'), dbReviver);
const dbKeyPart = (x) => encodeURIComponent(String(x));

// ข้อมูลชั่วคราวที่ไม่ต้องบันทึก (สร้างใหม่ได้เอง)
const PAGE_TRANSIENT = new Set(['liveSessions', 'inboxLog', 'seenComments', 'labelGroups', 'labelIds', 'labelsLoaded', 'fbPause']);

// แบ่งข้อมูลเป็นส่วน ๆ: บัญชี / เพจ / แชท / ไลฟ์แต่ละ session -> บันทึกเฉพาะส่วนที่เปลี่ยน
function buildDbParts(includeInbox) {
  const parts = new Map();
  parts.set('sessions', sessions);
  const now = Date.now();
  for (const [username, u] of Object.entries(usersDB)) {
    const uk = dbKeyPart(username);
    const { pages, ...userCore } = u;
    parts.set('user:' + uk, { ...userCore, pageIds: Object.keys(pages || {}) });
    for (const [pid, pd] of Object.entries(pages || {})) {
      const pk = uk + ':' + dbKeyPart(pid);
      const core = {};
      for (const [k, v] of Object.entries(pd)) if (!PAGE_TRANSIENT.has(k)) core[k] = v;
      core.liveIds = Object.keys(pd.liveSessions || {});
      parts.set('page:' + pk, core);
      for (const [sid, sess] of Object.entries(pd.liveSessions || {})) parts.set('live:' + pk + ':' + dbKeyPart(sid), sess);
      if (includeInbox) {
        // แชทลูกค้า: เก็บ 30 ข้อความล่าสุด ของคนที่ทักมาใน 14 วัน (สูงสุด 8,000 คน)
        const inbox = [];
        for (const [psid, arr] of (pd.inboxLog || new Map())) {
          const last = arr[arr.length - 1];
          if (last && now - (last.time || 0) < 14 * 86400000) inbox.push([psid, arr.slice(-30)]);
        }
        parts.set('inbox:' + pk, new Map(inbox.slice(-8000)));
      }
    }
  }
  return parts;
}

async function saveDb(force) {
  if (!DB_ENABLED || !dbState.loaded || dbState.saving) return;
  dbState.saving = true;
  try {
    dbState.cycle++;
    const includeInbox = force || dbState.cycle % 4 === 0; // แชทบันทึกทุก ~1 นาที ส่วนอื่นทุก 15 วิ
    const parts = buildDbParts(includeInbox);
    const cmds = [];
    let bytes = 0;
    for (const [k, v] of parts) {
      const json = JSON.stringify(v, dbReplacer);
      const h = crypto.createHash('md5').update(json).digest('hex');
      if (dbHashes.get(k) === h) continue;
      const enc = dbEnc(json);
      cmds.push({ k, h, cmd: ['SET', DB_PREFIX + k, enc] });
      bytes += enc.length;
    }
    // ส่วนที่ถูกลบ (เช่น ลบ session / ลบเพจ)
    const allKeys = new Set(parts.keys());
    const dels = [];
    for (const k of dbHashes.keys()) {
      if (allKeys.has(k)) continue;
      if (!includeInbox && k.startsWith('inbox:')) { allKeys.add(k); continue; }
      dels.push(k);
    }
    if (cmds.length || dels.length) {
      const index = Array.from(allKeys);
      // ส่งเป็นชุด ชุดละไม่เกิน ~4MB
      let batch = [], size = 0;
      const flush = async () => { if (batch.length) { await redisPipeline(batch.map(x => x.cmd)); batch.forEach(x => x.h && dbHashes.set(x.k, x.h)); batch = []; size = 0; } };
      for (const c of cmds) {
        if (size + c.cmd[2].length > 4 * 1024 * 1024) await flush();
        batch.push(c); size += c.cmd[2].length;
      }
      for (const k of dels) batch.push({ k, h: '', cmd: ['DEL', DB_PREFIX + k] });
      batch.push({ k: '', h: '', cmd: ['SET', DB_PREFIX + 'index', JSON.stringify(index)] });
      await flush();
      dels.forEach(k => dbHashes.delete(k));
      dbState.bytes = bytes;
    }
    dbState.keys = allKeys.size;
    dbState.lastSave = Date.now();
    dbState.lastError = '';
  } catch (e) {
    dbState.lastError = e.response?.data?.error || e.message;
    dbState.lastErrorAt = Date.now();
    console.error('❌ [DB] บันทึกไม่สำเร็จ:', dbState.lastError);
  } finally {
    dbState.saving = false;
  }
}

async function loadDb() {
  if (!DB_ENABLED) { console.log('💾 [DB] ไม่ได้ตั้งค่า Upstash — ใช้หน่วยความจำอย่างเดียว (ข้อมูลหายเมื่อรีสตาร์ท)'); return; }
  const [indexRaw] = await redisPipeline([['GET', DB_PREFIX + 'index']]);
  const keys = indexRaw ? JSON.parse(indexRaw) : [];
  const data = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const vals = await redisPipeline([['MGET', ...chunk.map(k => DB_PREFIX + k)]]);
    const arr = vals[0] || [];
    chunk.forEach((k, j) => { if (arr[j]) data.set(k, arr[j]); });
  }
  const val = (k) => { try { return data.has(k) ? dbDec(data.get(k)) : null; } catch (e) { console.error('⚠️ [DB] อ่าน ' + k + ' ไม่ได้'); return null; } };

  const sess = val('sessions');
  if (sess) sessions = sess;
  let pageCount = 0, liveCount = 0;
  for (const k of keys) {
    if (!k.startsWith('user:')) continue;
    const uk = k.slice(5);
    const username = decodeURIComponent(uk);
    const { pageIds = [], ...userCore } = val(k) || {};
    const user = { ...userCore, pages: {} };
    for (const pid of pageIds) {
      const pk = uk + ':' + dbKeyPart(pid);
      const core = val('page:' + pk);
      if (!core) continue;
      const { liveIds = [], ...pd } = core;
      pd.config = { ...defaultPageConfig, ...(pd.config || {}) };
      if (!(pd.subscribers instanceof Set)) pd.subscribers = new Set();
      if (!(pd.usedSlips instanceof Set)) pd.usedSlips = new Set();
      if (!(pd.psidMap instanceof Map)) pd.psidMap = new Map();
      if (!(pd.lastInbound instanceof Map)) delete pd.lastInbound;
      const inbox = val('inbox:' + pk);
      pd.inboxLog = inbox instanceof Map ? inbox : new Map();
      if (pd.broadcastStatus && pd.broadcastStatus.isBroadcasting) {
        pd.broadcastStatus.isBroadcasting = false;
        pd.broadcastStatus.statusMessage = '⏹️ หยุด เพราะเซิร์ฟเวอร์รีสตาร์ท';
      }
      pd.liveSessions = {};
      for (const sid of liveIds) {
        const ls = val('live:' + pk + ':' + dbKeyPart(sid));
        if (!ls) continue;
        if (!(ls.commenters instanceof Map)) ls.commenters = new Map();
        if (!(ls.buyers instanceof Map)) ls.buyers = new Map();
        if (!Array.isArray(ls.slips)) ls.slips = [];
        for (const jobKey of ['buyersJob', 'shipJob']) {
          if (ls[jobKey] && ls[jobKey].running) { ls[jobKey].running = false; ls[jobKey].message = 'หยุด เพราะเซิร์ฟเวอร์รีสตาร์ท (กดใหม่อีกครั้ง)'; }
        }
        if (ls.broadcastStatus && ls.broadcastStatus.isBroadcasting) {
          ls.broadcastStatus.isBroadcasting = false;
          ls.broadcastStatus.statusMessage = '⏹️ หยุด เพราะเซิร์ฟเวอร์รีสตาร์ท';
        }
        pd.liveSessions[sid] = ls;
        liveCount++;
      }
      user.pages[pid] = pd;
      pageIndexMap[pid] = { username, pageData: pd };
      if (pd.config.pageId) pageIndexMap[pd.config.pageId] = { username, pageData: pd };
      pageCount++;
    }
    usersDB[username] = user;
  }
  // จำ hash ของที่โหลดมา จะได้ไม่บันทึกซ้ำทันที
  const parts = buildDbParts(true);
  for (const [k, v] of parts) dbHashes.set(k, crypto.createHash('md5').update(JSON.stringify(v, dbReplacer)).digest('hex'));
  for (const k of keys) if (!dbHashes.has(k)) dbHashes.set(k, 'loaded');
  dbState.keys = keys.length;
  console.log('💾 [DB] โหลดข้อมูลสำเร็จ: ผู้ใช้ ' + Object.keys(usersDB).length + ' · เพจ ' + pageCount + ' · ไลฟ์ ' + liveCount);
}

// โหลดตอนเริ่มเซิร์ฟเวอร์ (ลองซ้ำได้ ถ้าโหลดไม่สำเร็จจะ "ไม่บันทึกทับ" กันข้อมูลหาย)
async function initDb() {
  if (!DB_ENABLED) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await loadDb();
      dbState.loaded = true;
      return;
    } catch (e) {
      dbState.lastError = 'โหลดฐานข้อมูลไม่สำเร็จ: ' + (e.response?.data?.error || e.message);
      dbState.lastErrorAt = Date.now();
      console.error('❌ [DB] ' + dbState.lastError + ' (ครั้งที่ ' + attempt + ')');
      await sleep(2000 * attempt);
    }
  }
  console.error('🛑 [DB] โหลดไม่สำเร็จ ปิดการบันทึกไว้ก่อน เพื่อไม่ให้ทับข้อมูลเดิมในฐานข้อมูล');
}

const defaultPageConfig = {
  appId: '1611337127153323',
  verifyToken: '14556456',
  pageAccessToken: '',
  pageId: '',
  pageName: '',
  // 🔒 สมาชิกแต่ละคนต้องใส่ API Key / บัญชีรับเงินของตัวเอง (ไม่มีค่าเริ่มต้น กันคนอื่นใช้ของเจ้าของระบบ)
  easySlipApiKey: '',      // EasySlip API Key (สำรอง)
  slipProvider: 'zwiz',    // ผู้ให้บริการตรวจสลิป: 'zwiz' (หลัก) หรือ 'easyslip'
  zwizApiKey: '',          // ZWIZ.AI Slip Verification API Key
  enableCommentBot: true,  // สวิตช์หลัก เปิด/ปิด บอตตอบกลับคอมเมนต์ (โพสต์ทั่วไป)
  
  matchType: 'contains',
  keywords: ['1', '11', '111', '11111', '111111', 'สนใจ', 'cf'],
  replyCommentText: 'แอดมินส่งรายละเอียดให้ในอินบ็อกซ์เรียบร้อยแล้วนะคะ 🙏',
  inboxText: 'แอดมินส่งรายละเอียดให้แล้วนะคะ 🙏\n\n(ใส่เลขบัญชีของร้านที่เมนู ตอบกลับคอมเมนต์)\n\n🙏 โอนแล้วแจ้งสลิป พร้อมชื่อที่อยู่ ได้เลยค่ะ🥰',
  enableInbox: true,
  enableCommentReply: true,
  enableAutoLike: true,
  
  enableSlipVerify: false, // เปิดเองหลังใส่ API Key และบัญชีรับเงินแล้ว
  merchantBank: '',
  merchantAccount: '',
  merchantName: '',
  msgSlipSuccess: 'สถานะ: ตรวจสอบถูกต้อง ✅\nยอดเงิน: {amount} บาท\nวันที่: {date}\n\nรับยอดค่ะพี่ ขอบคุณมากค่ะ 🙏 แจ้งชื่อที่อยู่เบอร์โทร ได้เลยค่ะ🥰',
  msgSlipInvalid: '❌ สลิปไม่ถูกต้อง หรือเลขบัญชีผู้รับไม่ตรงกับของทางร้าน กรุณาตรวจสอบอีกครั้งนะคะ',
  msgSlipUnreadable: '⚠️ ไม่สามารถอ่านข้อมูลจากสลิปนี้ได้ กรุณาส่งรูปสลิปที่ชัดเจนอีกครั้งนะคะ',
  // เมื่อรูปที่ส่งมาอ่านเป็นสลิปไม่ได้: 'smart' = ตอบเฉพาะเมื่อลูกค้ากำลังจ่ายเงิน (แนะนำ) · 'always' = ตอบทุกครั้ง · 'never' = ไม่ตอบ
  slipUnreadableMode: 'smart',
  msgSlipDuplicate: '🔄 สลิปนี้ถูกใช้งานไปแล้ว ไม่สามารถส่งซ้ำได้ค่ะ',

  // 🏷️ ป้ายกำกับ Inbox ที่จะ "ติด" / "ลบ" ตามผลตรวจสลิป (แอดมินเลือกเองจากป้ายที่มีในเพจ ไม่มีค่าเริ่มต้น)
  // รูปแบบ: { valid: { add: [{id,name}], remove: [{id,name}] }, invalid: {...}, unreadable: {...}, duplicate: {...} }
  slipLabels: {}
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
  const keyToUse = apiKey; // 🔒 ใช้เฉพาะ Key ของเพจนั้น ไม่มี Key กลาง
  if (!keyToUse) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า EasySlip API Key');
    return { success: false, message: 'API Key missing' };
  }

  console.log('🔍 [EasySlip] กำลังส่งรูปไปตรวจ:', imageUrl);

  // วิธีที่ 1: ส่ง URL ให้ EasySlip โหลดรูปเอง
  try {
    const response = await callEasySlip({ url: imageUrl, checkDuplicate: true }, keyToUse);
    console.log('✅ [EasySlip] ตรวจสำเร็จ');
    return { success: true, data: response.data };
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('❌ [EasySlip] ส่งแบบ URL ไม่สำเร็จ:', JSON.stringify(errData));

    // ถ้าเป็นปัญหา key / quota / ip ไม่ต้องลองซ้ำ
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
    console.log('✅ [EasySlip] (base64) ตรวจสำเร็จ');
    return { success: true, data: response.data };
  } catch (err) {
    console.error('❌ [EasySlip] ส่งแบบ base64 ไม่สำเร็จ:', JSON.stringify(err.response?.data || err.message));
    return { success: false, error: err.response?.data || err.message };
  }
}

// 🔧 แปลงผลลัพธ์จาก EasySlip ให้อยู่ในรูปแบบเดียวกัน (รองรับทั้ง v2: data.rawSlip และแบบเก่า: data)
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

// ===================== 🧾 ZWIZ.AI Slip Verification API v2 =====================
// POST https://api-sme-prod.zwiz.app/api/slips/v1/verify  (multipart: image, match_bank_account_list, requested_by)
const ZWIZ_VERIFY_URL = 'https://api-sme-prod.zwiz.app/api/slips/v1/verify';
const ZWIZ_BANK_CODES = { BBL: '002', KBANK: '004', KTB: '006', TTB: '011', SCB: '014', CIMB: '022', UOB: '024', BAY: '025', GSB: '030', GHB: '033', BAAC: '034', TISCO: '067', KKP: '069', LHB: '073', PROMPTPAY: 'promptpay' };

function formatZwizDate(d, t) {
  const m = String(d || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return [d, t].filter(Boolean).join(' ');
  const dt = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (t || '00:00:00') + '+07:00');
  return isNaN(dt.getTime()) ? (d + ' ' + (t || '')) : dt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
}

// คืนค่า { slip, errCode, quota } โดย slip อยู่ในรูปแบบเดียวกับ normalizeSlip() เพื่อใช้ต่อได้เลย
async function verifySlipWithZwiz(imageUrl, cfg) {
  const key = cfg.zwizApiKey || ''; // 🔒 ใช้เฉพาะ Key ของเพจนั้น ไม่ใช้ Key กลางของเซิร์ฟเวอร์
  if (!key) return { slip: null, errCode: 'MISSING_API_KEY' };

  // ZWIZ รับเฉพาะไฟล์รูป -> โหลดรูปจาก Facebook ก่อน
  let img;
  try {
    img = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
  } catch (e) {
    return { slip: null, errCode: 'IMAGE_DOWNLOAD_FAILED' };
  }
  const buf = Buffer.from(img.data);
  if (buf.length > 5 * 1024 * 1024) return { slip: null, errCode: 'FILE_TOO_LARGE' };
  let type = String(img.headers?.['content-type'] || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpe?g|png|webp)$/.test(type)) type = 'image/jpeg';

  const fd = new FormData();
  fd.append('image', new Blob([buf], { type }), 'slip.' + (type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]));
  const acc = String(cfg.merchantAccount || '').replace(/[^0-9]/g, '');
  const code = ZWIZ_BANK_CODES[String(cfg.merchantBank || '').toUpperCase()] || (acc.length === 10 && /^0/.test(acc) && !cfg.merchantBank ? 'promptpay' : '');
  if (acc && code) fd.append('match_bank_account_list', JSON.stringify([{ account_no: acc, code }]));
  fd.append('requested_by', String(cfg.pageName || cfg.pageId || 'FB Bot').slice(0, 100));

  let r;
  try {
    r = await axios.post(ZWIZ_VERIFY_URL, fd, { headers: { 'x-api-key': key }, timeout: 30000 });
  } catch (err) {
    const e = err.response?.data?.error || {};
    const errCode = e.code || e.error || (err.response ? 'HTTP_' + err.response.status : 'NETWORK_ERROR');
    const detail = [e.message, err.response?.data?.details?.verify?.statusCode ? 'statusCode ' + err.response.data.details.verify.statusCode : ''].filter(Boolean).join(' · ');
    console.error('❌ [ZWIZ] ตรวจสลิปไม่สำเร็จ:', errCode, detail || err.message);
    return { slip: null, errCode, detail };
  }
  const res = r.data?.result || {};
  const vr = res.verification_result;
  const data = res.verify?.data || {};
  console.log('✅ [ZWIZ] ผลตรวจ:', vr, '| โควตาคงเหลือ', res.remaining_quota);
  if (vr === 'unable_to_verify') return { slip: null, errCode: 'UNABLE_TO_VERIFY', quota: res.remaining_quota };

  const rcvAcc = data.receiver?.account?.value;
  const slip = {
    transRef: String(data.transRef || ''),
    amount: data.amount !== undefined ? (Number(data.amount) || 0) : 0,
    dateText: formatZwizDate(data.transDate, data.transTime),
    receiverAccounts: rcvAcc ? [String(rcvAcc)] : [],
    receiverNameTh: data.receiver?.displayName || data.receiver?.name || '',
    receiverBank: data.receivingBank || '',
    isDuplicate: vr === 'duplicated',
    matchResult: vr, // matched | not_matched | duplicated | skipped
    provider: 'zwiz'
  };
  if (!slip.transRef && !slip.isDuplicate) return { slip: null, errCode: 'NO_TRANS_REF', quota: res.remaining_quota };
  if (!slip.transRef) slip.transRef = 'zwiz-dup-' + Date.now();
  return { slip, errCode: '', quota: res.remaining_quota };
}

// ตัวเลือกผู้ให้บริการ: ZWIZ (หลัก) หรือ EasySlip (สำรอง)
async function verifySlip(imageUrl, cfg, pageData) {
  if ((cfg.slipProvider || 'zwiz') === 'zwiz') {
    const out = await verifySlipWithZwiz(imageUrl, cfg);
    if (pageData && out.quota !== undefined) pageData.slipQuota = { provider: 'zwiz', remaining: out.quota, at: Date.now() };
    return out;
  }
  const r = await verifySlipByImageUrl(imageUrl, cfg.easySlipApiKey);
  const slip = r && r.success ? normalizeSlip(r.data) : null;
  return { slip, errCode: slip ? '' : (r?.error?.error?.code || r?.data?.error?.code || (r?.message === 'API Key missing' ? 'MISSING_API_KEY' : '')) };
}

// 🔧 เช็คเลขบัญชีผู้รับ (สลิปจะปิดเลขบางส่วน เช่น xxx-x-x9857-x) เทียบกับเลขบัญชีร้านค้า
function accountMatches(merchantAcc, slipAccounts) {
  const merchant = String(merchantAcc || '').replace(/[^0-9]/g, '');
  if (!merchant) return true; // ไม่ได้ตั้งเลขบัญชี = ไม่ตรวจ

  for (const acc of slipAccounts) {
    const raw = String(acc);
    // เทียบแบบ mask: ตัวเลขที่เห็นต้องอยู่ตำแหน่งเดียวกับเลขบัญชีร้าน (x = ถูกปิด)
    const chars = raw.replace(/[\s-]/g, '');
    if (chars.length === merchant.length) {
      let ok = true;
      for (let i = 0; i < chars.length; i++) {
        if (/[0-9]/.test(chars[i]) && chars[i] !== merchant[i]) { ok = false; break; }
      }
      if (ok) return true;
    }
    // กรณีเห็นเลขแค่บางส่วน: ตรวจว่าเลขที่เห็นเรียงต่อกันอยู่ในเลขบัญชีร้าน
    const visibleRuns = raw.split(/[^0-9]+/).filter(r => r.length >= 3);
    if (visibleRuns.length && visibleRuns.every(r => merchant.includes(r))) return true;
  }
  return false;
}

// 🔧 เทียบชื่อผู้รับ (ใช้เมื่อสลิปไม่ส่งเลขบัญชีมาให้)
function nameMatches(merchantName, slipName) {
  const clean = (v) => String(v || '')
    .replace(/(นางสาว|น\.ส\.|นาย|นาง|MISS|MRS|MR|MS)\.?/gi, '')
    .replace(/[\s.\-]/g, '')
    .toLowerCase();
  const a = clean(merchantName), b = clean(slipName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// -------------------------------------------------------------
// 📦 ค้นหาชื่อ ที่อยู่ เบอร์โทร จากข้อความในแชท (สำหรับทำใบแปะหน้า)
// -------------------------------------------------------------
const ADDR_PATTERNS = [
  /ตำบล|ต\.\s*\S/, /อำเภอ|อ\.\s*\S/, /จังหวัด|จ\.\s*\S/, /แขวง/, /เขต/,
  /ถนน|ถ\.\s*\S/, /ซอย|ซ\.\s*\S/, /หมู่\s*\d|หมู่ที่|ม\.\s*\d/, /บ้านเลขที่|เลขที่/,
  /\d+\/\d+/, /หมู่บ้าน|คอนโด|อาคาร|อพาร์ท|ห้องเลขที่/
];
const PHONE_RE = /(?<!\d)(?:\+?66[ -]?|0)\d(?:[ -]?\d){7,8}(?!\d)/;
const PHONE_RE_G = new RegExp(PHONE_RE.source, 'g');
const POSTCODE_RE = /(?<!\d)[1-9]\d{4}(?!\d)/g;
const CHAT_WORDS = /สลิป|โอน|ขอบคุณ|สนใจ|ราคา|เท่าไหร่|ไหม|มั้ย|\?|ค่ะ$|ครับ$|คะ$|จ้า|นะ|จัดส่ง|ส่งของ|ที่อยู่|บาท|ยอด|สั่ง/;
const LABEL_RE = /^(ข้อมูล\s*(ผู้รับ|การจัดส่ง|จัดส่ง)?|รายละเอียด\s*(ผู้รับ|การจัดส่ง|จัดส่ง|ที่อยู่)?|ชื่อ\s*-?\s*(สกุล|นามสกุล)?\s*(ที่อยู่)?\s*(ผู้รับ)?|ผู้รับ(สินค้า|ของ)?|ที่อยู่\s*(ใน)?\s*(การ)?\s*(จัดส่ง|ผู้รับ|ส่งของ)?|จัดส่ง(ที่|ไปที่|ถึง)?|ส่ง(ของ)?(ที่|ไปที่|ถึง)|name|address|ship\s*to)\s*[:：\-]?\s*/i;
// บรรทัดที่เป็นแค่หัวข้อ (ไม่ใช่ชื่อคน)
const HEADER_ONLY = /^(จัดส่ง|ส่ง|ส่งของ|ที่อยู่|ที่อยู่จัดส่ง|ข้อมูล|ข้อมูลจัดส่ง|ข้อมูลผู้รับ|ผู้รับ|รายละเอียด|ชื่อ|ชื่อที่อยู่|ชื่อ ที่อยู่ เบอร์|ชื่อที่อยู่เบอร์โทร|ตามนี้|ตามนี้ค่ะ|ตามนี้ครับ|ค่ะ|ครับ|คะ|นะคะ)[\s:：\-.]*$/i;
// คำนำหน้าชื่อ ยศทหาร/ตำรวจ และตำแหน่งวิชาการ (ยาวก่อนสั้น)
const RANK_SRC = String.raw`(?:ว่าที่\s*)?(?:พล\.(?:ร\.|ต\.|อ\.|ท\.)?[อทต]\.|[พร]\.ต\.[อทต]\.|จ\.ส\.[อทต]\.|[พรน]\.[อทต]\.|ส\.[อทต]\.|ด\.ต\.|จ\.ต\.|จ\.อ\.|พ\.จ\.[อทต]\.|ร\.ต\.)`;
const NAME_TITLES = String.raw`(?:` + RANK_SRC + String.raw`(?:\s*หญิง)?|ศ\.|รศ\.|ผศ\.|ดร\.|นพ\.|พญ\.|ทพญ?\.|ภ[กญ]\.|สพ\.ญ\.|น\.?สพ\.|ด\.ช\.|ด\.ญ\.|น\.ส\.|นางสาว|นาย|นาง|คุณ|mr\.?|mrs\.?|ms\.?|miss|dr\.?)`;
const NAME_TITLE_RE = new RegExp(String.raw`(?:^|\s)(` + NAME_TITLES + String.raw`\s*[^\s\d,]+(?:\s+[^\s\d,]+)?)`, 'i');
const NAME_TITLE_PREFIX_RE = new RegExp('^' + NAME_TITLES + String.raw`\s*`, 'i');
// ลบยศออกก่อนอ่าน ต./อ./จ. (กัน จ.ส.อ. ถูกมองเป็นจังหวัด/อำเภอ)
const RANK_MASK_RE = new RegExp(String.raw`(^|\s)` + RANK_SRC + String.raw`\s*[^\s\d,]*`, 'g');

function stripPhones(t) { return String(t || '').replace(PHONE_RE_G, ' '); }

// ตัวเลข 5 หลักที่เป็นจำนวนเงิน (เช่น "20000 บาท", "ยอด 15000", "15,000") ไม่ใช่รหัสไปรษณีย์
const MONEY_NUM_RE = /(?:ยอด|โอน|จ่าย|ค่า[^\s\d]{0,12}|ราคา|เงิน|มัดจำ|ผ่อน|ยืม|หนี้)\s*\d{4,6}|(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)|(?<!\d)\d{4,6}\s*(?:บาท|฿|บ\.|\.-|-\.|k\b|K\b)/g;
function stripMoney(t) { return String(t || '').replace(MONEY_NUM_RE, ' '); }
function postcodesIn(t) { return stripMoney(stripPhones(t)).match(POSTCODE_RE) || []; }

// มีหลักฐานว่าเป็นที่อยู่จริงไหม (ไม่ใช่แค่มีตัวเลข 5 หลัก)
// ต้องมีอย่างใดอย่างหนึ่ง: คำบอกที่อยู่ (ต./อ./จ./ม./ถนน/ซอย/บ้านเลขที่/เลข 12/3)
// หรือ ชื่อตำบล/อำเภอ/จังหวัด ที่ตรงกับรหัสไปรษณีย์ในข้อความ
function hasAddressEvidence(t) {
  const text = String(t || '');
  if (ADDR_PATTERNS.some(re => re.test(text))) return true;
  const zips = postcodesIn(text);
  if (!zips.length) return false;
  if (typeof thaiAddrDb === 'undefined' || !thaiAddrDb) return PHONE_RE.test(text); // ยังไม่มีฐานข้อมูลที่อยู่: ต้องมีเบอร์โทรด้วย
  const c = compactTh(text);
  for (const z of zips) {
    for (const row of thaiAddrByZip.get(z) || []) {
      if ((row.dn && row.dn.length >= 2 && c.includes(row.dn)) || (row.an && row.an.length >= 2 && c.includes(row.an)) || (row.pn && c.includes(row.pn))) return true;
    }
  }
  return false;
}

function hasAddressSignal(t) {
  const text = String(t || '');
  if (PHONE_RE.test(text)) return true;
  if (postcodesIn(text).length) return true;
  return ADDR_PATTERNS.some(re => re.test(text));
}

function scoreAddressText(t) {
  const text = String(t || '');
  if (!text.trim()) return 0;
  let score = 0;
  if (PHONE_RE.test(text)) score += 2;
  if (postcodesIn(text).length) score += 3;
  for (const re of ADDR_PATTERNS) if (re.test(text)) score++;
  if (text.length >= 25) score++;
  return score;
}

// คำที่ขึ้นต้นชื่อสถานที่ ไม่ใช่ชื่อคน
const PLACE_RE = /^(วัด|ร้าน|บริษัท|บจก|หจก|ห้าง|โรงเรียน|ร\.ร\.|โรงพยาบาล|รพ\.|รพ\.สต|คลินิก|การไฟฟ้า|การประปา|ไปรษณีย์|อบต|อบจ|เทศบาล|สำนักงาน|ที่ทำการ|สถานี|สภ\.|ตลาด|อาคาร|คอนโด|หอพัก|อพาร์ท|แฟลต|หมู่บ้าน|มหาวิทยาลัย|วิทยาลัย|ค่าย|กองร้อย|กองพัน|ฟาร์ม|สวน|โรงงาน|ศูนย์|ธนาคาร|ปั๊ม|มูลนิธิ|สหกรณ์|โรงแรม|รีสอร์ท)/;

function isNameLike(s) {
  const t = String(s || '').trim();
  if (PLACE_RE.test(t)) return false;
  if (t.length < 2 || t.length > 45) return false;
  if (/\d/.test(t)) return false;
  // หมายเหตุการส่ง ไม่ใช่ชื่อคน เช่น "(ส่งที่หอพักป้ามาลาเท่านั้น)", "ฝากไว้ที่ป้อม"
  if (/^[(\[（]/.test(t) || /(ส่งที่|เท่านั้น|หอพัก|ฝากไว้|ฝากที่|ฝากป้อม|วางไว้|โทรก่อน|ก่อนส่ง)/.test(t)) return false;
  if (NAME_TITLE_PREFIX_RE.test(t) && t.split(/\s+/).length <= 4 && !looksLikeLocation(t.replace(NAME_TITLE_PREFIX_RE, ''))) return true;
  if (CHAT_WORDS.test(t)) return false;
  if (looksLikeLocation(t)) return false;
  return !ADDR_PATTERNS.some(re => re.test(t));
}

// ข้อความที่มีชื่อจังหวัด/อำเภอ ไม่ใช่ชื่อคน
let locationNameCache = null;
function looksLikeLocation(t) {
  if (typeof thaiAddrDb === 'undefined' || !thaiAddrDb) return false;
  if (!locationNameCache) {
    const set = new Set();
    for (const r of thaiAddrDb) { set.add(r.pn); if (r.an.length >= 4) set.add(r.an); }
    locationNameCache = Array.from(set);
  }
  const c = compactTh(applyProvinceAliases(t));
  return locationNameCache.some(n => c.includes(n));
}

function cleanName(n) {
  return String(n || '').replace(/^[\s,.:\-]+|[\s,.:\-]+$/g, '').replace(/\s+/g, ' ').trim();
}

function parseAddressBlock(texts, nameHint) {
  const full = texts.join('\n');
  const phoneM = full.match(PHONE_RE);
  let phone = phoneM ? phoneM[0].replace(/\D/g, '') : '';
  if (phone.startsWith('66')) phone = '0' + phone.slice(2);
  const pcs = stripPhones(full).match(POSTCODE_RE) || [];
  const postcode = pcs.length ? pcs[pcs.length - 1] : '';

  // เบอร์โทรถือเป็นตัวคั่นบรรทัด: "ชื่อ 08xxxxxxxx บ้าน 2/5 ..." -> ชื่อ / บ้าน 2/5 ...
  // บรรทัดที่ตามหลังหัวข้อ "ผู้รับ" / "ชื่อ" = ชื่อผู้รับ (ถ้าดูเป็นชื่อคน)
  let labelledName = '';
  const rawLines = full.replace(PHONE_RE_G, '\n').split(/\n+/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < rawLines.length - 1 && !labelledName; i++) {
    if (/^(ผู้รับ(สินค้า|ของ)?|ชื่อ\s*(-?\s*(สกุล|นามสกุล))?\s*(ผู้รับ)?|name)\s*[:：\-]?\s*$/i.test(rawLines[i])) {
      const cand = rawLines[i + 1].replace(/[📞☎️📱]/g, '').trim();
      if (isNameLike(cand)) labelledName = cand;
    }
  }

  let lines = full.replace(PHONE_RE_G, '\n').split(/\n+/)
    .map(l => l.replace(LABEL_RE, '')
      .replace(/(เบอร์โทรศัพท์|เบอร์โทร|เบอร์|โทร\.?|tel\.?)\s*[:：]?\s*$/i, '')
      .replace(/[📞☎️📱✆]/g, '')
      .replace(/\s{2,}/g, ' ').trim())
    .filter(l => l && !/^[\s,.:\-]*$/.test(l));

  lines = lines.filter(l => !HEADER_ONLY.test(l.trim()));

  let recipientName = '';
  if (labelledName) {
    const k = lines.indexOf(labelledName);
    if (k >= 0) { recipientName = labelledName; lines.splice(k, 1); }
  }
  // มีคำนำหน้าชื่อ (นาย/นาง/นางสาว/คุณ): เอาคำนำหน้า + ชื่อ + นามสกุล
  for (let i = 0; i < lines.length && !recipientName; i++) {
    const m = lines[i].match(NAME_TITLE_RE);
    if (!m) continue;
    const before = lines[i].slice(0, m.index + (m[0].length - m[1].length));
    if (/\d/.test(before)) continue; // คำนำหน้าอยู่หลังบ้านเลขที่ ไม่น่าใช่ชื่อผู้รับ
    let name = m[1].trim();
    // ตัดคำที่เป็นที่อยู่ติดมาท้ายนามสกุล
    name = name.split(/\s+/).filter((w, k) => k === 0 || NAME_TITLE_PREFIX_RE.test(w) || !ADDR_PATTERNS.some(re => re.test(w))).join(' ');
    if (looksLikeLocation(name.replace(NAME_TITLE_PREFIX_RE, ''))) continue;
    recipientName = name;
    const rest = (lines[i].slice(0, m.index) + ' ' + lines[i].slice(m.index + m[0].length)).trim();
    lines[i] = rest;
    if (before.trim() && isNameLike(before.trim())) lines[i] = lines[i].replace(before.trim(), '').trim(); // คำนำหน้าบรรทัด เช่น "ส่ง"
  }
  lines = lines.filter(Boolean);
  if (recipientName) {
    // ได้ชื่อแล้ว
  } else if (lines.length > 1 && isNameLike(lines[0])) {
    recipientName = lines.shift();
  } else if (lines.length > 2 && (() => {
    // บรรทัดแรกไม่ใช่ชื่อคน (เช่น ชื่อร้าน) -> หาชื่อในบรรทัดถัดไป ก่อนเริ่มส่วนที่อยู่
    const sig = lines.findIndex(l => /\d/.test(l) || ADDR_PATTERNS.some(re => re.test(l)));
    const limit = Math.min(sig < 0 ? lines.length - 1 : sig, 3);
    for (let k = 1; k < limit; k++) {
      if (isNameLike(lines[k])) { recipientName = lines.splice(k, 1)[0]; return true; }
    }
    return false;
  })()) {
    // ได้ชื่อจากบรรทัดถัดไปแล้ว
  } else if (lines.length >= 1) {
    // กรณีพิมพ์ชื่อกับที่อยู่ในบรรทัดเดียว เช่น "สมชาย ใจดี 12/3 ม.4 ต.หาดใหญ่ ..."
    // รวมกรณีชื่อติดบ้านเลขที่ไม่เว้นวรรค เช่น "นันทพล นาคศรีโภชน์1952/21 ม.6"
    const m = lines[0].match(/^([^\d]{2,40}?)[\s,]*(?=\d)/);
    if (m && isNameLike(m[1])) {
      recipientName = m[1].trim();
      lines[0] = lines[0].slice(m[0].length).trim();
    }
  }
  if (!recipientName && nameHint && isNameLike(nameHint)) recipientName = String(nameHint).trim();
  recipientName = cleanName(recipientName);

  return { recipientName, address: lines.filter(Boolean).join(' '), phone, postcode, raw: full.slice(0, 1500) };
}

// msgs: [{ text, time }] เฉพาะข้อความที่ลูกค้าพิมพ์มา
function extractAddressInfo(msgs) {
  const list = (msgs || []).filter(m => m.text && String(m.text).trim()).sort((a, b) => a.time - b.time);
  if (!list.length) return null;

  // จัดกลุ่มข้อความที่ส่งติดๆ กัน (ห่างกันไม่เกิน 10 นาที) เพราะลูกค้ามักพิมพ์ชื่อ/ที่อยู่/เบอร์แยกข้อความ
  const blocks = [];
  let cur = null;
  for (const m of list) {
    if (cur && m.time - cur[cur.length - 1].time <= 10 * 60 * 1000) cur.push(m);
    else { cur = [m]; blocks.push(cur); }
  }

  // เลือกกลุ่มล่าสุดที่ดูเป็นที่อยู่ (ลูกค้าอาจเปลี่ยนที่อยู่ ใช้อันใหม่สุด)
  let best = null;
  for (const b of blocks) {
    const keptIdx = [];
    b.forEach((m, i) => { if (hasAddressSignal(m.text)) keptIdx.push(i); });
    if (!keptIdx.length) continue;
    const text = keptIdx.map(i => b[i].text).join('\n');
    // ต้องได้คะแนนพอ และต้องมีหลักฐานว่าเป็นที่อยู่จริง (กันข้อความคุยทั่วไปที่มีตัวเลข 5 หลัก เช่น "20000เลยนี้ ช่วยพี่หน่อยนะ")
    if (scoreAddressText(text) >= 4 && hasAddressEvidence(text)) best = { block: b, keptIdx };
  }
  if (!best) return null;

  // มีข้อความที่เป็นที่อยู่ครบในตัว (มีรหัสไปรษณีย์ + ลักษณะที่อยู่ชัด) -> ใช้ข้อความนั้นเป็นหลัก
  // กันข้อความอื่นในช่วงเดียวกัน (เช่น ชื่อร้าน + เบอร์อีกเบอร์) มาปนในที่อยู่
  const complete = best.keptIdx.filter(i => {
    const t = best.block[i].text;
    return postcodesIn(t).length > 0 && scoreAddressText(t) >= 6 && hasAddressEvidence(t);
  });
  if (complete.length) {
    const i = complete[complete.length - 1];
    const prev = i > 0 ? best.block[i - 1].text : '';
    const res = parseAddressBlock([best.block[i].text], isNameLike(prev) ? prev : '');
    if (!res.phone) {
      // เบอร์อยู่คนละข้อความ: ใช้เบอร์จากข้อความถัดไป/ก่อนหน้าที่ใกล้ที่สุด
      const order = best.block.map((m, k) => k).sort((a, b) => Math.abs(a - i) - Math.abs(b - i));
      for (const k of order) {
        const pm = String(best.block[k].text).match(PHONE_RE);
        if (pm) { res.phone = pm[0].replace(/\D/g, '').replace(/^66/, '0'); break; }
      }
    }
    return res;
  }

  const first = best.keptIdx[0];
  const prevMsg = first > 0 ? best.block[first - 1].text : '';
  const nameHint = isNameLike(prevMsg) ? prevMsg : '';
  return parseAddressBlock(best.keptIdx.map(i => best.block[i].text), nameHint);
}

function normName(n) { return String(n || '').toLowerCase().replace(/\s+/g, ''); }

function getInboxLog(pageData) {
  if (!pageData.inboxLog) pageData.inboxLog = new Map();
  return pageData.inboxLog;
}

function getPsidMap(pageData) {
  if (!pageData.psidMap) pageData.psidMap = new Map(); // feed user id -> Messenger PSID
  return pageData.psidMap;
}

function logInboxText(pageData, psid, text) {
  const log = getInboxLog(pageData);
  const arr = log.get(psid) || [];
  arr.push({ text: String(text).slice(0, 1000), time: Date.now() });
  if (arr.length > 50) arr.splice(0, arr.length - 50);
  log.delete(psid); // ย้ายไปท้ายสุด (ล่าสุด)
  log.set(psid, arr);
  // ⚡ กันหน่วยความจำเต็ม: เก็บแชทล่าสุดไม่เกิน 20,000 คน (ลบคนที่เงียบนานสุดออก)
  if (log.size > 20000) { let i = 0; for (const k of log.keys()) { log.delete(k); if (++i >= 2000) break; } }
}

async function fetchConversationMessages(pageId, token, psid) {
  const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(pageId) + '/conversations', {
    params: {
      user_id: psid,
      platform: 'messenger',
      fields: 'participants,messages.limit(50){message,from,created_time}',
      access_token: token
    },
    timeout: 15000
  });
  const conv = (r.data.data || [])[0];
  if (!conv) return null;
  return {
    participants: conv.participants?.data || [],
    messages: (conv.messages?.data || []).map(m => ({
      text: m.message || '',
      fromId: m.from?.id ? String(m.from.id) : '',
      time: new Date(m.created_time).getTime() || 0
    }))
  };
}

// อ่านข้อความในแชทย้อนหลังทีละหน้า จนเจอ "ที่อยู่ล่าสุด" ที่ลูกค้าส่งมา (หรือครบจำนวนหน้าที่กำหนด)
// คืนค่า { messages: [...ทุกข้อความที่อ่าน], customerMsgs, info, pagesRead }
async function scanConversationForAddress(convId, token, customerId, opts = {}) {
  const maxPages = opts.maxPages || 15;      // 15 หน้า x 100 = ย้อนหลังได้ราว 1,500 ข้อความ
  const deadline = opts.deadline || (Date.now() + 25000);
  const all = [];
  let url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(convId) + '/messages';
  let params = { fields: 'message,from,created_time', limit: 100, access_token: token };
  let info = null, pagesRead = 0, extraAfterFound = 0;
  while (url && pagesRead < maxPages && Date.now() < deadline) {
    const r = await axios.get(url, { params, timeout: 15000 });
    pagesRead++;
    for (const m of r.data.data || []) {
      all.push({ text: m.message || '', fromId: String(m.from?.id || ''), time: fbTime(m.created_time) });
    }
    url = r.data.paging?.next || null;
    params = undefined;
    const cust = all.filter(m => m.fromId === String(customerId));
    info = extractAddressInfo(cust.map(m => ({ text: m.text, time: m.time })));
    if (info) {
      // เจอแล้ว อ่านต่ออีก 1 หน้า เผื่อลูกค้าพิมพ์ชื่อ/ที่อยู่แยกหลายข้อความคร่อมหน้า
      if (extraAfterFound >= 1 || !url) break;
      extraAfterFound++;
    }
  }
  const customerMsgs = all.filter(m => m.fromId === String(customerId));
  if (customerMsgs.length) info = extractAddressInfo(customerMsgs.map(m => ({ text: m.text, time: m.time })));
  return { messages: all, customerMsgs, info, pagesRead, reachedEnd: !url };
}

async function findConversationId(pageId, token, psid) {
  const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(pageId) + '/conversations', {
    params: { user_id: psid, platform: 'messenger', fields: 'id', access_token: token }, timeout: 15000
  });
  return (r.data.data || [])[0]?.id || null;
}

// สร้างดัชนี ชื่อ -> PSID จากรายการแชทของเพจ (ใช้เมื่อไม่รู้ PSID ของคนคอมเมนต์)
async function buildConversationIndex(pageId, token) {
  const index = new Map();
  let url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(pageId) + '/conversations';
  let params = { platform: 'messenger', fields: 'participants', limit: 100, access_token: token };
  for (let i = 0; i < 10 && url; i++) {
    const r = await axios.get(url, { params, timeout: 15000 });
    for (const conv of r.data.data || []) {
      for (const p of conv.participants?.data || []) {
        if (String(p.id) !== String(pageId) && p.name && !index.has(normName(p.name))) {
          index.set(normName(p.name), String(p.id));
        }
      }
    }
    url = r.data.paging?.next || null;
    params = undefined; // ลิงก์ next มี token และพารามิเตอร์อยู่แล้ว
  }
  return index;
}

// -------------------------------------------------------------
// 🚚 เชื่อมต่อขนส่ง Bee Move (https://client.beemove.co.th)
// ใช้ API เดียวกับหน้าเว็บ Bee Move:
//   POST /client/v2/shipment-orders/partner-shipping-prices  (เช็คราคา/เลือกขนส่ง)
//   POST /client/v1/shipment-orders                         (สร้างพัสดุ -> ได้เลขพัสดุ partner_awb_no)
//   GET  /client/v1/label?ids=1,2&size=A6                  (ใบแปะหน้า PDF)
// -------------------------------------------------------------
const defaultBeemoveConfig = {
  authMode: 'login',           // login = เข้าสู่ระบบด้วยเบอร์โทร+รหัสผ่าน (แบบเดียวกับหน้าเว็บ), bearer/x-api-key/apikey = ใช้ API Key
  username: '',                // เบอร์โทรที่ใช้เข้าสู่ระบบ Bee Move
  password: '',
  accountId: '',               // กรณีมีหลายร้าน (บัญชีย่อย) ระบุ ID ร้าน
  apiKey: '',
  baseUrl: 'https://api.beemove.co.th',
  partnerKeyword: 'ไปรษณีย์, Thailand Post',   // เลือกขนส่งที่ชื่อมีคำนี้ (เช่น ไปรษณีย์ / Thailand Post / EMS / Flash)
  partnerId: '',               // ถ้าระบุ จะใช้ขนส่งนี้เสมอ
  pickupPointId: '',
  senderName: '', senderPhone: '', senderAddress: '',
  senderDistrict: '', senderCity: '', senderProvince: '', senderPostcode: '',
  packageName: 'กล่อง', width: 20, length: 30, height: 10, weight: 1,
  labelSize: 'A6',
  notifyCustomer: false,
  notifyStatus: false,         // แจ้งลูกค้าเมื่อพัสดุจัดส่งสำเร็จ (จาก Webhook)
  webhookKey: '',              // รหัสลับใน Webhook URL สร้างอัตโนมัติ
  notifyText: '📦 ร้านจัดส่งสินค้าแล้วค่ะ\nเลขพัสดุ: {tracking}\nขอบคุณที่อุดหนุนนะคะ 🙏'
};

function getBeemoveConfig(pageData) {
  pageData.config.beemove = { ...defaultBeemoveConfig, ...(pageData.config.beemove || {}) };
  if (!pageData.config.beemove.webhookKey) pageData.config.beemove.webhookKey = crypto.randomBytes(16).toString('hex');
  return pageData.config.beemove;
}

// ---------- 📡 Webhook สถานะพัสดุจาก Bee Move ----------
function bmPick(o, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((x, p) => (x && x[p] !== undefined ? x[p] : undefined), o);
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return String(v);
  }
  return '';
}

// แปลงข้อมูลที่ Bee Move ส่งมาเป็นรายการ { ids, awb, status }
function parseBeemoveWebhook(body) {
  const out = [];
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (Array.isArray(o)) { o.forEach(x => visit(x, depth + 1)); return; }
    const awb = bmPick(o, ['partner_awb_no', 'awb_no', 'tracking_no', 'tracking_number', 'shipment_order.partner_awb_no']);
    const ids = [bmPick(o, ['shipment_order_id']), bmPick(o, ['shipment_order.id']), bmPick(o, ['order_id']), bmPick(o, ['id'])].filter(Boolean);
    const status = bmPick(o, ['shipment_status_name', 'status_name', 'status_th', 'shipment_status.name', 'shipment_status.name_th',
      'shipment_status', 'order_status', 'status', 'event_status', 'description', 'shipment_order.shipment_status']);
    if (awb || (ids.length && status)) out.push({ ids, awb, status });
    for (const k of ['data', 'order', 'orders', 'shipment_order', 'shipment_orders', 'payload', 'items']) {
      if (o[k] && typeof o[k] === 'object') visit(o[k], depth + 1);
    }
  };
  visit(body, 0);
  return out;
}

function findBuyerByShipment(pageData, ids, awb) {
  for (const s of Object.values(getLiveSessions(pageData))) {
    if (!s.buyers) continue;
    for (const item of s.buyers.values()) {
      if ((item.beemoveOrderId && ids.includes(String(item.beemoveOrderId))) || (awb && item.trackingNo === awb)) return item;
    }
  }
  return null;
}

// ข้อความถูกปฏิเสธเพราะลูกค้าทักล่าสุดเกิน 24 ชม.
function isOutsideWindowError(e) {
  const er = e.response?.data?.error || {};
  return er.error_subcode === 2018278 || er.error_subcode === 2534022 || er.code === 10 ||
    /outside of allowed window|24 hour|allowed window/i.test(er.message || '');
}

// humanAgent = แอดมินกดส่งเอง -> ใช้แท็ก HUMAN_AGENT ส่งได้ภายใน 7 วันหลังลูกค้าทักล่าสุด
// (นโยบาย Meta: ห้ามใช้แท็กนี้กับข้อความอัตโนมัติ และแอปต้องได้สิทธิ์ Human Agent จาก App Review)
async function sendMessengerText(pageData, psid, text, opts = {}) {
  const token = pageData.config.pageAccessToken;
  if (!psid || !token) throw new Error('ไม่มี PSID หรือ Page token');
  const send = (tagged) => axios.post('https://graph.facebook.com/v19.0/me/messages', tagged
    ? { recipient: { id: psid }, messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT', message: { text } }
    : { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } },
  { params: { access_token: token }, timeout: 10000 });
  try {
    await send(false);
    return { ok: true, tagged: false };
  } catch (e) {
    if (!isOutsideWindowError(e)) throw e;
    if (!opts.humanAgent) { const err = new Error('OUTSIDE_24H'); err.outside24h = true; throw err; }
    try {
      await send(true);
      return { ok: true, tagged: true };
    } catch (e2) {
      const er = e2.response?.data?.error || {};
      if (er.code === 200 || /permission|human.?agent/i.test(er.message || '')) {
        throw new Error('ส่งเกิน 24 ชม. ต้องได้สิทธิ์ Human Agent: เปิด App Review ขอสิทธิ์ "Human Agent" ให้แอป (' + (er.message || '') + ')');
      }
      if (isOutsideWindowError(e2)) throw new Error('ลูกค้าทักล่าสุดเกิน 7 วันแล้ว Facebook ไม่ให้ส่งข้อความ');
      throw e2;
    }
  }
}

function trackingText(bm, item) {
  return String(bm.notifyText || '').replace('{tracking}', item.trackingNo || '').replace('{courier}', item.partnerName || '');
}

// ส่งเลขพัสดุอัตโนมัติ (ภายใน 24 ชม.) ถ้าเกิน 24 ชม. ตั้งเป็น "รอแอดมินกดส่ง"
async function autoNotifyTracking(pageData, bm, item) {
  if (!bm.notifyCustomer || !item.trackingNo || !item.psid || item.notified) return;
  try {
    await sendMessengerText(pageData, item.psid, trackingText(bm, item));
    item.notified = true;
    item.notifyPending = false;
  } catch (e) {
    item.notifyPending = true;
    item.shipNote = e.outside24h
      ? 'ลูกค้าทักเกิน 24 ชม. กดปุ่ม 💬 ส่งเลขพัสดุ เพื่อส่งเอง (ได้ภายใน 7 วัน)'
      : 'ส่งเลขพัสดุไม่สำเร็จ: ' + (e.response?.data?.error?.message || e.message);
  }
}

const BM_JSON = { Accept: 'application/json', 'Content-Type': 'application/json' };

function beemoveBase(bm) {
  return String(bm.baseUrl || defaultBeemoveConfig.baseUrl).replace(/\/+$/, '');
}

function beemoveHeaders(bm, sessionToken) {
  const h = { ...BM_JSON };
  if (sessionToken) { h['Authorization'] = 'Bearer ' + sessionToken; return h; }
  const key = String(bm.apiKey || '').trim();
  if (bm.authMode === 'x-api-key') h['x-api-key'] = key;
  else if (bm.authMode === 'apikey') h['apikey'] = key;
  else h['Authorization'] = 'Bearer ' + key;
  return h;
}

// เก็บ token ที่ได้จากการเข้าสู่ระบบไว้ในหน่วยความจำ (ไม่ส่งกลับไปหน้าเว็บ)
const beemoveTokenCache = new Map();
function beemoveCacheKey(bm) { return beemoveBase(bm) + '|' + String(bm.username || '').trim() + '|' + String(bm.accountId || ''); }

// เข้าสู่ระบบแบบเดียวกับหน้าเว็บ Bee Move: login -> เลือกร้าน -> ได้ token ของร้าน
async function beemoveLogin(bm, force) {
  const key = beemoveCacheKey(bm);
  const cached = beemoveTokenCache.get(key);
  if (!force && cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.token;
  if (!bm.username || !bm.password) throw new Error('ยังไม่ได้ใส่เบอร์โทรและรหัสผ่าน Bee Move (เมนู 🚚 ขนส่ง Bee Move)');
  const base = beemoveBase(bm);

  let firstToken;
  try {
    const r1 = await axios.post(base + '/client/v1/auth/login',
      { username: String(bm.username).trim(), password: String(bm.password) },
      { headers: BM_JSON, timeout: 20000 });
    firstToken = r1.data?.data?.access_token || r1.data?.access_token;
  } catch (e) {
    throw new Error('เข้าสู่ระบบ Bee Move ไม่สำเร็จ: ' + beemoveError(e));
  }
  if (!firstToken) throw new Error('เข้าสู่ระบบ Bee Move ไม่สำเร็จ: เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง');

  let token = firstToken;
  let accounts = [];
  try {
    const auth = { ...BM_JSON, Authorization: 'Bearer ' + firstToken };
    const r2 = await axios.get(base + '/client/v1/account-child-link', { params: { page: 1, limit: 50 }, headers: auth, timeout: 20000 });
    const list = r2.data?.data || [];
    accounts = (Array.isArray(list) ? list : []).map(x => ({
      id: x.parent_account?.id ?? x.parent_id,
      name: x.parent_account?.name || x.parent_account?.account_name || x.name || ''
    })).filter(a => a.id !== undefined && a.id !== null);
    const pick = bm.accountId ? accounts.find(a => String(a.id) === String(bm.accountId)) : accounts[0];
    if (bm.accountId && !pick) throw new Error('ไม่พบร้าน ID ' + bm.accountId + ' ในบัญชีนี้');
    if (pick) {
      const r3 = await axios.post(base + '/client/v1/account-child-link', { parent_id: pick.id }, { headers: auth, timeout: 20000 });
      token = r3.data?.data?.access_token || r3.data?.access_token || firstToken;
    }
  } catch (e) {
    if (/ไม่พบร้าน/.test(e.message)) throw e;
    console.error('⚠️ [Bee Move] เลือกร้านไม่สำเร็จ ใช้ token จากการ login แทน:', beemoveError(e));
  }
  beemoveTokenCache.set(key, { token, at: Date.now(), accounts });
  return token;
}

async function beemoveRequest(bm, method, path, opts = {}) {
  const send = (sessionToken) => axios({
    method, url: beemoveBase(bm) + path,
    headers: beemoveHeaders(bm, sessionToken),
    data: opts.data, params: opts.params,
    responseType: opts.responseType || 'json',
    timeout: opts.timeout || 30000
  });

  if (!bm.authMode || bm.authMode === 'login') {
    let token = await beemoveLogin(bm, false);
    try {
      return await send(token);
    } catch (e) {
      // token หมดอายุ -> เข้าสู่ระบบใหม่แล้วลองอีกครั้ง
      if ([401, 403].includes(e.response?.status)) {
        token = await beemoveLogin(bm, true);
        return await send(token);
      }
      throw e;
    }
  }
  if (!bm.apiKey) throw new Error('ยังไม่ได้ใส่ API Key ของ Bee Move');
  return send(null);
}

function beemoveError(err) {
  const d = err.response?.data;
  if (d && typeof d === 'object' && !Buffer.isBuffer(d)) {
    const msg = d.message || d.error?.message || d.error || d.errors;
    return (err.response.status ? '[' + err.response.status + '] ' : '') + (typeof msg === 'string' ? msg : JSON.stringify(msg || d).slice(0, 300));
  }
  if (err.response?.status === 401 || err.response?.status === 403) return '[' + err.response.status + '] API Key ไม่ถูกต้อง หรือไม่มีสิทธิ์';
  return err.message;
}

// แยกที่อยู่ไทยเป็น ตำบล/อำเภอ/จังหวัด (Bee Move ต้องการแยกช่อง)
// "ต ฉวาง อ ฉวาง จ นครศรีฯ" (ไม่มีจุด) -> "ต.ฉวาง อ.ฉวาง จ.นครศรีฯ"
function normalizeMarkers(t) {
  return String(t || '')
    .replace(/(^|[\s\d,])(ต|อ|จ)\s+(?=[ก-ฮ])/g, '$1$2.')
    .replace(/([ก-๙])(\d{5})(?!\d)/g, '$1 $2');   // นครศรีธรรมราช80150 -> นครศรีธรรมราช 80150
}

function parseThaiAddress(text, postcode) {
  let s = ' ' + normalizeMarkers(String(text || '').replace(RANK_MASK_RE, '$1')) + ' ';
  s = s.replace(/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/g, ' $1 ');
  const grab = (re) => {
    const m = s.match(re);
    if (!m) return '';
    s = s.replace(m[0], ' ');
    return m[1].trim();
  };
  let province = grab(/(?:จังหวัด|จ\.)\s*([^\s\d,]+)/);
  const district = grab(/(?:ตำบล|แขวง|ต\.)\s*([^\s\d,]+)/);
  const city = grab(/(?:อำเภอ|เขต|อ\.)\s*([^\s\d,]+)/);
  if (!province || /^(กรุงเทพ|กทม)/.test(province)) {
    if (/กรุงเทพ|กทม/.test(s) || /^(กรุงเทพ|กทม)/.test(province)) province = 'กรุงเทพมหานคร';
    s = s.replace(/กรุงเทพมหานคร|กรุงเทพฯ?|กทม\.?/g, ' ');
  }
  let pc = String(postcode || '').trim();
  const pcs = s.match(/(?<!\d)[1-9]\d{4}(?!\d)/g) || [];
  if (!pc && pcs.length) pc = pcs[pcs.length - 1];
  if (pc) s = s.split(pc).join(' ');
  const address = s.replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return { address, district, city, province, postal_code: pc };
}

// -------------------------------------------------------------
// 🗺️ ฐานข้อมูลที่อยู่ไทย (ตำบล/อำเภอ/จังหวัด/รหัสไปรษณีย์) ใช้แก้ที่อยู่ที่ลูกค้าไม่ได้พิมพ์ ต./อ./จ.
// โหลดจาก GitHub ตอนเปิดเซิร์ฟเวอร์ แล้วเก็บไว้ในหน่วยความจำ
// -------------------------------------------------------------
const THAI_ADDR_DB_URL = 'https://raw.githubusercontent.com/earthchie/jquery.Thailand.js/master/jquery.Thailand.js/database/raw_database/raw_database.json';
let thaiAddrDb = null;          // [{ d, a, p, z, dn, an, pn }]
let thaiAddrByZip = new Map();
let thaiAddrLoading = null;

const compactTh = (v) => String(v || '')
  .normalize('NFKD')                             // ตัวอักษรแฟนซี 𝐒𝐨𝐦𝐛𝐮𝐭 -> Sombut, é -> e
  .replace(/[̀-ͯ]/g, '')
  .normalize('NFC')
  .replace(/ํา/g, 'ำ')            // ํ + า -> ำ (พิมพ์ต่างกันแต่ตาเห็นเหมือนกัน)
  .replace(/[​-‍⁠﻿]/g, '')   // ตัวอักษรล่องหน
  .replace(/[\s.]/g, '').toLowerCase();

function loadThaiAddressDb() {
  if (thaiAddrDb) return Promise.resolve(true);
  if (thaiAddrLoading) return thaiAddrLoading;
  thaiAddrLoading = axios.get(THAI_ADDR_DB_URL, { timeout: 30000 }).then(r => {
    const rows = (Array.isArray(r.data) ? r.data : []).map(x => ({
      d: x.district, a: x.amphoe, p: x.province, z: String(x.zipcode),
      dn: compactTh(x.district), an: compactTh(x.amphoe), pn: compactTh(x.province)
    })).filter(x => x.d && x.a && x.p);
    if (!rows.length) throw new Error('ข้อมูลว่าง');
    thaiAddrDb = rows;
    locationNameCache = null;
    thaiAddrByZip = new Map();
    for (const x of rows) {
      if (!thaiAddrByZip.has(x.z)) thaiAddrByZip.set(x.z, []);
      thaiAddrByZip.get(x.z).push(x);
    }
    console.log('🗺️ โหลดฐานข้อมูลที่อยู่ไทยแล้ว ' + rows.length + ' ตำบล');
    return true;
  }).catch(e => {
    console.error('⚠️ โหลดฐานข้อมูลที่อยู่ไทยไม่สำเร็จ (จะลองใหม่):', e.message);
    thaiAddrLoading = null;
    return false;
  });
  return thaiAddrLoading;
}

// ลบชื่อออกจากข้อความ (ตัวท้ายสุด) พร้อมคำนำหน้า ต./อ./จ.
function removeLastName(text, name, prefixRe) {
  if (!name) return text;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:' + prefixRe + ')?\\s*' + esc, 'g');
  let last = null, m;
  while ((m = re.exec(text))) last = m;
  if (!last) return text;
  return text.slice(0, last.index) + ' ' + text.slice(last.index + last[0].length);
}

function isBangkok(p) { return /กรุงเทพ/.test(p || ''); }

function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = -1;
  while ((i = hay.indexOf(needle, i + 1)) >= 0) n++;
  return n;
}

// ความคล้ายของคำ (ใช้กับชื่อตำบลที่ลูกค้าพิมพ์ผิดเล็กน้อย)
function similarity(a, b) {
  a = String(a); b = String(b);
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// ชื่อเรียกย่อ/ชื่อเล่นของจังหวัดที่ลูกค้าชอบพิมพ์
// ชื่อย่อ/ชื่อเล่นของจังหวัด -> ชื่อเต็ม
// แทนเฉพาะเมื่อเป็น "คำเดี่ยว" (มีช่องว่าง/จ./จังหวัด นำหน้า และช่องว่าง/ตัวเลข/ท้ายข้อความ ตามหลัง)
// กันแทนผิดในชื่อที่มีคำนี้ซ่อนอยู่ เช่น อ.พระนครศรีอยุธยา, อ.อุบลรัตน์, อ.วาปีปทุม, ต.บ้านปทุม, ต.โคราช
const PROVINCE_ALIASES = [
  ['กทม\\.?|กรุงเทพฯ?|bangkok|bkk', 'กรุงเทพมหานคร'],
  ['โคราช', 'นครราชสีมา'], ['อยุธยา', 'พระนครศรีอยุธยา'], ['นครศรีฯ?', 'นครศรีธรรมราช'],
  ['สุราษฎร์ฯ?|สุราษฎร์|สุราษ', 'สุราษฎร์ธานี'], ['ประจวบฯ?', 'ประจวบคีรีขันธ์'],
  ['แปดริ้ว', 'ฉะเชิงเทรา'], ['อุบลฯ?', 'อุบลราชธานี'], ['ปทุม', 'ปทุมธานี']
].map(([pat, name]) => [new RegExp('(^|[\\s,(]|จ\\.\\s*|จังหวัด\\s*)(?:' + pat + ')(?=[\\s,.)\\d]|$)', 'gi'), name]);
function applyProvinceAliases(t) {
  let out = String(t || '');
  for (const [re, name] of PROVINCE_ALIASES) out = out.replace(re, (m, pre) => pre + name);
  return out;
}

// จัดบ้านเลขที่/หมู่ให้อ่านง่าย และตัดคำที่ไม่ใช่ที่อยู่
function tidyStreet(t) {
  return String(t || '')
    .replace(/(\d)\s*(ม\.?|หมู่)\s*(\d)/g, '$1 ม.$3')                    // 363/5ม2 -> 363/5 ม.2
    .replace(/(\d)(ต|อ|จ|ตำบล|อำเภอ|จังหวัด|แขวง|เขต)\.?\s*$/, '$1')     // 363/5 ม.2ต -> 363/5 ม.2
    .replace(/(^|\s)(ต|อ|จ|ตำบล|อำเภอ|จังหวัด|แขวง|เขต)\.?\s*$/, '$1')
    .replace(/^(ที่อยู่(จัดส่ง)?|ส่งที่|address)\s*[:：\-]?\s*/i, '')
    .replace(/(^|\s)(บ้านเลขที่|บ้าน|เลขที่)\s*(?=\d)/g, '$1')
    .replace(/(^|\s)(?:ม\.?|หมู่(?:ที่)?)\s*\.?\s*(\d{1,3})(?!\d|\/)/g, '$1ม.$2')
    .replace(/(^|\s)ถนน\s*/g, '$1ถ.').replace(/(^|\s)ซอย\s*/g, '$1ซ.')
    .replace(/ประเทศไทย|thailand/gi, ' ')
    .replace(/[,]+/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s\-–:]+|[\s\-–:,]+$/g, '').trim();
}

// หาตำแหน่งที่ส่วน ตำบล/อำเภอ/จังหวัด เริ่มต้น เพื่อตัดเอาเฉพาะบ้านเลขที่/หมู่/ซอย/ถนน ที่อยู่ข้างหน้า
function findLocationStart(raw, best) {
  let idx = raw.length;
  // ชื่อสถานที่ก่อนบ้านเลขที่ (เช่น "การไฟฟ้าส่วนภูมิภาคอำเภอเกาะจันทร์ 99/99") ไม่ใช่ส่วนตำบล/อำเภอ
  const firstDigit = raw.search(/\d/);
  const consider = (i) => {
    if (firstDigit >= 0 && i < firstDigit) return;
    const before = raw.slice(Math.max(0, i - 8), i);
    if (/(ถ\.|ถนน|ซ\.|ซอย|หมู่บ้าน|ม\.บ\.|มบ\.)\s*$/.test(before)) return; // ชื่อถนน/ซอย/หมู่บ้าน ที่ซ้ำกับชื่อตำบล
    if (i < idx) idx = i;
  };
  const names = [best.d, best.a, best.p, best.a.replace(/^เมือง/, '')].filter(n => n && n.length >= 2);
  for (const n of names) { let i = -1; while ((i = raw.indexOf(n, i + 1)) >= 0) consider(i); }
  const mk = /(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|(?<![ก-๙])ต\.|(?<![ก-๙])อ\.|(?<![ก-๙])จ\.)/g;
  let m;
  while ((m = mk.exec(raw))) consider(m.index);
  // คำที่สะกดคล้ายชื่อตำบล/อำเภอ/จังหวัด (พิมพ์ผิด เช่น พัทุลง)
  const wr = /[^\s,]+/g;
  while ((m = wr.exec(raw))) {
    if (/^(ถ\.|ถนน|ซ\.|ซอย|หมู่บ้าน|ม\.บ\.|มบ\.)/.test(m[0])) continue;
    const w = compactTh(m[0].replace(/^(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/, ''));
    if (w.length < 3 || /\d/.test(w)) continue;
    if ([best.dn, best.an, best.pn].some(n => similarity(w, n) >= 0.6)) consider(m.index);
  }
  return idx;
}

// ลบคำที่เป็นชื่อตำบล/อำเภอ/จังหวัด (รวมที่สะกดผิดเล็กน้อย) ออกจากข้อความ
function stripLocationWords(text, best) {
  return String(text || '').split(/(\s+)/).filter(w => {
    const t = w.trim();
    if (!t || /\d/.test(t)) return true;
    if (/^(ถ\.|ถนน|ซ\.|ซอย|หมู่บ้าน|ม\.บ\.|มบ\.)/.test(t)) return true; // ชื่อถนน/ซอย/หมู่บ้าน เก็บไว้
    const c = compactTh(t.replace(/^(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/, ''));
    if (!c) return false;
    if (c === 'เมือง' && best.an.startsWith('เมือง')) return false;
    return ![best.dn, best.an, best.pn].some(n => c === n || (c.length >= 3 && similarity(c, n) >= 0.6));
  }).join('');
}

function formatThaiAddress(parts) {
  if (!parts.district || !parts.city || !parts.province) return '';
  const bkk = isBangkok(parts.province);
  return [parts.address,
    (bkk ? 'แขวง' : 'ต.') + parts.district,
    (bkk ? 'เขต' : 'อ.') + parts.city,
    bkk ? parts.province : 'จ.' + parts.province,
    parts.postal_code].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// แยกที่อยู่แบบฉลาด: ใช้ ต./อ./จ. ถ้ามี ไม่มีก็จับคู่กับฐานข้อมูลตำบลด้วยรหัสไปรษณีย์และชื่อ
// ลูกค้าพิมพ์แค่ อำเภอ/เขต ไม่มีตำบล/แขวง (เช่น "ลาดพร้าว80 วังทองหลาง กรุงเทพฯ 10310")
// -> ใช้ตำบล/แขวงที่ชื่อเดียวกับอำเภอ (ตำบลหลักของอำเภอ) ถ้าไม่พบชื่อตำบลอื่นของอำเภอนั้นในข้อความ
function sameNameTambonOnly(rows, r, hay, raw) {
  if (r.dn !== r.an || countOcc(hay, r.dn) < 1) return false;
  if (rows.some(x => x !== r && x.an === r.an && x.dn !== r.dn && x.dn.length >= 2 && hay.includes(x.dn))) return false;
  // คำที่อยู่ก่อนชื่ออำเภอต้องเป็นส่วนบ้านเลขที่/ซอย/ถนน (มีตัวเลข หรือขึ้นต้นด้วย ถ./ซ./ม.)
  // ถ้าเป็นคำไทยอื่น อาจเป็นชื่อตำบลที่พิมพ์ผิด/อยู่คนละรหัส -> ไม่เดา ให้แอดมินเลือกเอง
  const t = String(raw || '');
  const i = t.indexOf(r.a);
  if (i < 0) return true;
  const toks = t.slice(0, i).replace(/(อำเภอ|เขต|อ\.)\s*$/, '').trim().split(/[\s,]+/).filter(Boolean);
  const prev = toks[toks.length - 1] || '';
  return !prev || /\d/.test(prev) || /^(ถ\.|ซ\.|ถนน|ซอย|ม\.|หมู่)/.test(prev);
}

function smartThaiAddress(text, postcode) {
  const raw = applyProvinceAliases(normalizeMarkers(String(text || '').replace(PHONE_RE_G, ' ').replace(RANK_MASK_RE, '$1'))).replace(/\s+/g, ' ').trim();
  const marked = parseThaiAddress(raw, postcode);
  const pcs = raw.match(/(?<!\d)[1-9]\d{4}(?!\d)/g) || [];
  const zip = String(postcode || '').trim() || (pcs.length ? pcs[pcs.length - 1] : '');

  if (thaiAddrDb) {
    const hay = compactTh(raw.replace(/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/g, ' '));
    const rows = zip && thaiAddrByZip.has(zip) ? thaiAddrByZip.get(zip) : thaiAddrDb;
    let best = null, bestScore = 0;
    for (const r of rows) {
      let sc = 0;
      // ตำบลชื่อเดียวกับอำเภอ (เช่น ปากพะยูน) ต้องพบชื่อนั้น 2 ครั้ง หรือมี ต. นำหน้า จึงนับเป็นตำบล
      const dCount = countOcc(hay, r.dn);
      const dHit = r.dn === r.an ? (dCount >= 2 || (marked.district && compactTh(marked.district) === r.dn) || sameNameTambonOnly(rows, r, hay, raw)) : dCount >= 1;
      if (dHit) sc += 4;
      const amphoeShort = r.an.replace(/^เมือง/, '');
      let aHit = false;
      if (hay.includes(r.an)) { sc += 3; aHit = true; }
      else if (r.an.startsWith('เมือง') && hay.includes('เมือง')) { sc += 2; aHit = true; }
      else if (amphoeShort && amphoeShort !== r.an && hay.includes(amphoeShort)) sc += 1;
      if (hay.includes(r.pn) || (isBangkok(r.p) && /กรุงเทพ/.test(raw))) sc += 2;
      if (zip && r.z === zip) sc += 2;
      // ให้ความสำคัญกับ marker ที่ลูกค้าพิมพ์มาเอง
      if (marked.district && compactTh(marked.district) === r.dn) sc += 2;
      if (sc > bestScore) { best = { ...r, _dHit: dHit, _aHit: aHit, _fuzzy: false }; bestScore = sc; }
    }
    // ไม่พบชื่อตำบลตรงๆ: ลองหาคำที่คล้ายชื่อตำบลในรหัสไปรษณีย์เดียวกัน (พิมพ์ผิดเล็กน้อย)
    if ((!best || !best._dHit) && zip && thaiAddrByZip.has(zip)) {
      const words = raw.replace(/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/g, ' ').split(/[\s,]+/).filter(w => w && !/\d/.test(w)).map(compactTh);
      let fz = null, fzSim = 0;
      for (const r of thaiAddrByZip.get(zip)) {
        if (r.dn === r.an) continue;
        for (const w of words) {
          const sim = similarity(w, r.dn);
          if (sim > fzSim) { fz = r; fzSim = sim; }
        }
      }
      if (fz && fzSim >= 0.7) { best = { ...fz, _dHit: true, _fuzzy: true }; bestScore = Math.max(bestScore, 6); }
    }
    const zipOnlyOne = zip && thaiAddrByZip.has(zip) && thaiAddrByZip.get(zip).length === 1;
    const districtMatched = best && best._dHit;
    if (best && (districtMatched || zipOnlyOne) && bestScore >= 5) {
      // บ้านเลขที่/หมู่/ซอย/ถนน = ข้อความก่อนส่วนตำบล/อำเภอ/จังหวัด
      const zipFree = zip ? raw.split(zip).join(' ') : raw;
      const cut = findLocationStart(zipFree, best);
      let rest = zipFree.slice(0, cut);
      if (!/\d/.test(rest)) {
        // ลูกค้าพิมพ์ ตำบล/อำเภอ ก่อนบ้านเลขที่: ใช้วิธีลบชื่อสถานที่ออกแทน
        rest = zipFree;
        rest = removeLastName(rest, best.p, 'จังหวัด|จ\\.');
        rest = removeLastName(rest, best.a, 'อำเภอ|เขต|อ\\.');
        rest = removeLastName(rest, best.d, 'ตำบล|แขวง|ต\\.');
      }
      rest = stripLocationWords(rest, best)
        .replace(/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|(?<![ก-๙])ต\.|(?<![ก-๙])อ\.|(?<![ก-๙])จ\.)\s*(?=$|\s)/g, ' ');
      rest = tidyStreet(rest);
      const parts = { address: rest, district: best.d, city: best.a, province: best.p, postal_code: best.z };
      // เดา = พิมพ์ตำบลผิด/ไม่มีตำบล/อำเภอไม่ตรง -> ให้แอดมินตรวจเลือกเอง
      const guess = !!(best._fuzzy || !best._dHit || !best._aHit || (zip && best.z !== zip));
      return { ...parts, ok: true, source: 'db', guess, formatted: formatThaiAddress(parts) };
    }
  }

  // มี ต. และ อ. แต่ไม่มี จ. นำหน้า: คำสุดท้ายที่เหลือคือจังหวัด
  if (marked.district && marked.city && !marked.province) {
    const words = String(marked.address || '').split(/\s+/).filter(Boolean);
    if (words.length && !/\d/.test(words[words.length - 1])) {
      marked.province = words.pop();
      marked.address = words.join(' ');
    }
  }
  if (marked.district && marked.city && marked.province && marked.postal_code) {
    const pseudo = { dn: compactTh(marked.district), an: compactTh(marked.city), pn: compactTh(marked.province) };
    const parts = { ...marked, address: tidyStreet(stripLocationWords(marked.address, pseudo)) };
    return { ...parts, ok: true, source: 'marker', guess: !!thaiAddrDb, formatted: formatThaiAddress(parts) };
  }

  // สำรอง (กรณีโหลดฐานข้อมูลไม่ได้): "... ตำบล อำเภอ จังหวัด รหัสไปรษณีย์" ไล่จากท้าย
  if (zip) {
    const before = raw.split(zip)[0].replace(/[,]/g, ' ')
      .replace(/(^|\s)(ตำบล|แขวง|อำเภอ|เขต|จังหวัด)(?=\s|$)/g, ' ').trim().split(/\s+/);
    const tail = [];
    while (before.length && tail.length < 3 && !/\d/.test(before[before.length - 1])) tail.unshift(before.pop());
    if (tail.length === 3) {
      const parts = { address: tidyStreet(before.join(' ')), district: tail[0].replace(/^(ตำบล|แขวง|ต\.)/, ''), city: tail[1].replace(/^(อำเภอ|เขต|อ\.)/, ''), province: tail[2].replace(/^(จังหวัด|จ\.)/, ''), postal_code: zip };
      return { ...parts, ok: true, source: 'position', guess: true, formatted: formatThaiAddress(parts) };
    }
  }
  return { ...marked, postal_code: marked.postal_code || zip, ok: false, source: 'none', formatted: '' };
}

// ตรวจว่า ตำบล/อำเภอ ในที่อยู่ ตรงกับรหัสไปรษณีย์หรือไม่ และคืนตัวเลือกทั้งหมดของรหัสไปรษณีย์นั้น
function checkAddressAgainstZip(address, postcode) {
  if (!thaiAddrDb) return { status: 'nodb', options: [] };
  const raw = applyProvinceAliases(String(address || ''));
  const pcs = raw.match(/(?<!\d)[1-9]\d{4}(?!\d)/g) || [];
  const zip = String(postcode || '').trim() || (pcs.length ? pcs[pcs.length - 1] : '');
  if (!zip) return { status: 'nozip', options: [] };
  const rows = thaiAddrByZip.get(zip);
  if (!rows) return { status: 'badzip', zip, options: [] };
  const options = rows.map(r => ({ d: r.d, a: r.a, p: r.p, z: r.z }));
  const marked = parseThaiAddress(raw, zip);
  const hay = compactTh(raw.replace(/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/g, ' '));
  const idx = rows.findIndex(r => {
    const dOk = marked.district ? compactTh(marked.district) === r.dn
      : (countOcc(hay, r.dn) >= (r.dn === r.an ? 2 : 1) || sameNameTambonOnly(rows, r, hay, raw));
    const mc = compactTh(marked.city);
    const aOk = marked.city ? (mc === r.an || (r.an.startsWith('เมือง') && (mc === 'เมือง' || mc === r.an.replace(/^เมือง/, ''))))
      : (hay.includes(r.an) || (r.an.startsWith('เมือง') && hay.includes('เมือง')));
    return dOk && aOk;
  });
  if (idx < 0) {
    // สำรอง: ชื่อตำบล/อำเภอที่มีคำว่า "เขต" / "ตำบล" อยู่ในชื่อ (เช่น ต.หลักเขต, อ.สนามชัยเขต, ต.สามตำบล)
    // ตัวตัดคำนำหน้าจะตัดคำในชื่อทิ้ง -> เทียบกับข้อความเต็มแทน (เลือกชื่อตำบลที่ยาวที่สุดที่เจอ)
    const full = compactTh(raw);
    let best = -1;
    rows.forEach((r, i) => {
      if (!/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|ต\.|อ\.|จ\.)/.test(r.d + ' ' + r.a)) return; // ใช้เฉพาะชื่อที่มีคำนำหน้าซ่อนอยู่
      if (full.includes(r.dn) && full.includes(r.an.replace(/^เมือง/, '')) && (best < 0 || r.dn.length > rows[best].dn.length)) best = i;
    });
    if (best >= 0) return { status: 'ok', zip, matchIndex: best, options };
  }
  if (idx < 0) {
    // ไม่ตรงกับรหัสไปรษณีย์นี้: อาจเป็นรหัสไปรษณีย์เก่า (เช่น ต.บางเสาธง เปลี่ยนจาก 10540 เป็น 10570)
    // -> หาตำบลชื่อเดียวกันในจังหวัดเดียวกันจากทั้งประเทศ แล้วเสนอให้เลือก (ระบบจะแก้รหัสไปรษณีย์ให้)
    const md = marked.district ? compactTh(marked.district) : '';
    const provs = new Set(rows.map(r => r.pn));
    const alts = thaiAddrDb.filter(r => r.z !== zip && r.dn.length >= 2 && (provs.has(r.pn) || hay.includes(r.pn)) &&
      (md ? md === r.dn : countOcc(hay, r.dn) >= (r.dn === r.an ? 2 : 1)));
    alts.sort((x, y) => (hay.includes(y.an) ? 1 : 0) - (hay.includes(x.an) ? 1 : 0));
    if (alts.length && alts.length <= 5) {
      return { status: 'check', zip, matchIndex: -1, altZip: true, options: alts.map(r => ({ d: r.d, a: r.a, p: r.p, z: r.z, alt: true })).concat(options) };
    }
  }
  return { status: idx >= 0 ? 'ok' : 'check', zip, matchIndex: idx, options };
}

// เปลี่ยน ตำบล/อำเภอ/จังหวัด ของที่อยู่เป็นค่าที่เลือก (เก็บบ้านเลขที่/หมู่/ซอย/ถนนไว้)
function rebuildAddressWithLocation(address, loc) {
  const best = { d: loc.d, a: loc.a, p: loc.p, dn: compactTh(loc.d), an: compactTh(loc.a), pn: compactTh(loc.p) };
  let raw = applyProvinceAliases(String(address || '').replace(PHONE_RE_G, ' '));
  raw = raw.replace(/(?<!\d)[1-9]\d{4}(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
  let street = raw.slice(0, findLocationStart(raw, best));
  if (!/\d/.test(street)) street = raw;
  street = stripLocationWords(street, best)
    .replace(/(ตำบล|แขวง|อำเภอ|เขต|จังหวัด|(?<![ก-๙])ต\.|(?<![ก-๙])อ\.|(?<![ก-๙])จ\.)\s*[^\s\d]*/g, ' ');
  return formatThaiAddress({ address: tidyStreet(street), district: loc.d, city: loc.a, province: loc.p, postal_code: String(loc.z) });
}

function unwrapData(body) {
  if (body && typeof body === 'object' && body.data !== undefined) return body.data;
  return body;
}

// เลือกขนส่งจากผลเช็คราคา
function pickPartner(bm, prices) {
  const ok = (prices || []).filter(p => !(p.errors && p.errors.length) && p.partner);
  if (bm.partnerId) return ok.find(p => String(p.partner.id) === String(bm.partnerId)) || null;
  const kws = String(bm.partnerKeyword || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  // ชื่อเรียกเดียวกันของขนส่งแต่ละเจ้า (Bee Move ใช้ชื่ออังกฤษ เช่น "Thailand Post")
  const ALIASES = [
    /ไปรษณีย์|ปณ|thai\s*post|thailand\s*post|ems|ems\s*thai|thp/i,
    /แฟลช|flash/i, /เคอรี่|kerry|kex/i, /เจแอนด์ที|j\s*&?\s*t/i, /เบส|best/i,
    /นินจา|ninja/i, /ช้อปปี้|shopee|spx/i, /ลาซาด้า|lazada|lex/i, /ดีเอชแอล|dhl/i, /ไปรษณีย์ด่วน|scg|nim/i
  ];
  const nameOf = p => String(p.partner.partner_name || '') + ' ' + String(p.partner.partner_code || '');
  for (const kw of kws) {
    let found = ok.find(p => nameOf(p).toLowerCase().includes(kw));
    if (!found) {
      const group = ALIASES.find(re => re.test(kw));
      if (group) found = ok.find(p => group.test(nameOf(p)));
    }
    if (found) return found;
  }
  return kws.length ? null : (ok[0] || null);
}

function beemoveSender(bm) {
  return {
    name: bm.senderName, address: bm.senderAddress, district: bm.senderDistrict,
    city: bm.senderCity, province: bm.senderProvince, postal_code: String(bm.senderPostcode || ''),
    phone_number: String(bm.senderPhone || '').replace(/\D/g, '')
  };
}

function beemoveParcel(bm) {
  return {
    package_name: bm.packageName || 'กล่อง',
    width: parseFloat(bm.width) || 1, height: parseFloat(bm.height) || 1,
    length: parseFloat(bm.length) || 1, weight: parseFloat(bm.weight) || 1
  };
}

async function beemoveEstimateRaw(bm, order) {
  const res = await beemoveRequest(bm, 'POST', '/client/v2/shipment-orders/partner-shipping-prices', { data: { orders: [order] } });
  const data = unwrapData(res.data) || {};
  const orders = data.orders || [];
  return { prices: (orders[0] && orders[0].estimate_prices) || [], raw: res.data };
}

async function beemoveEstimate(bm, order) {
  return (await beemoveEstimateRaw(bm, order)).prices;
}

// จุดเข้ารับพัสดุ (ที่อยู่ผู้ส่ง) ที่ตั้งไว้ในบัญชี Bee Move
async function beemoveGetPickupPoints(bm) {
  const res = await beemoveRequest(bm, 'GET', '/client/v1/pickup-points', { params: { page: 1, limit: 50 } });
  let list = unwrapData(res.data);
  if (list && !Array.isArray(list) && Array.isArray(list.data)) list = list.data;
  return (Array.isArray(list) ? list : []).map(p => ({
    id: p.id,
    name: p.pickup_point_name || p.name || '',
    responser: p.responser_name || '',
    tel: String(p.responser_tel || p.telephone || '').replace(/\D/g, ''),
    address: p.pickup_point_addr || '',
    district: p.pickup_point_district || '',
    city: p.pickup_point_city || '',
    province: p.pickup_point_province || '',
    postal_code: String(p.pickup_point_postal_code || '')
  })).filter(p => p.id !== undefined && p.id !== null);
}

// ที่อยู่ผู้ส่ง: ใช้จุดเข้ารับพัสดุใน Bee Move เป็นหลัก (หน้าเว็บ Bee Move ทำแบบนี้) ถ้าไม่มีจึงใช้ที่กรอกเอง
async function beemoveResolveSender(bm) {
  const manual = beemoveSender(bm);
  let points = [];
  try { points = await beemoveGetPickupPoints(bm); } catch (e) {
    console.error('⚠️ [Bee Move] ดึงจุดเข้ารับพัสดุไม่สำเร็จ:', beemoveError(e));
  }
  const p = bm.pickupPointId ? points.find(x => String(x.id) === String(bm.pickupPointId)) : points[0];
  if (p) {
    return {
      pickupPointId: p.id,
      from: {
        name: manual.name || p.responser || p.name,
        address: p.address || manual.address,
        district: p.district || manual.district,
        city: p.city || manual.city,
        province: p.province || manual.province,
        postal_code: p.postal_code || manual.postal_code,
        phone_number: manual.phone_number || p.tel
      },
      points
    };
  }
  return { pickupPointId: bm.pickupPointId || null, from: manual, points };
}

// ⚡ จำที่อยู่ผู้ส่ง/จุดเข้ารับพัสดุไว้ 10 นาที (เดิมดึงจาก Bee Move ใหม่ทุกพัสดุ)
const beemoveSenderCache = new Map();
async function beemoveResolveSenderCached(bm) {
  const key = beemoveCacheKey(bm) + '|' + (bm.pickupPointId || '') + '|' + JSON.stringify(beemoveSender(bm));
  const c = beemoveSenderCache.get(key);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.promise;
  const promise = beemoveResolveSender(bm);
  beemoveSenderCache.set(key, { promise, at: Date.now() });
  promise.then(v => { if (!v.points || !v.points.length) beemoveSenderCache.delete(key); }, () => beemoveSenderCache.delete(key));
  return promise;
}

// สร้างพัสดุ 1 รายการ คืนค่า { id, trackingNo, partnerName }
async function beemoveCreateShipment(bm, buyer, remark) {
  if (!thaiAddrDb) await loadThaiAddressDb();
  if (thaiAddrDb) {
    const chk = checkAddressAgainstZip(buyer.address, buyer.postcode);
    if (chk.status === 'badzip') throw new Error('รหัสไปรษณีย์ ' + chk.zip + ' ไม่มีอยู่จริง กรุณาตรวจรหัสไปรษณีย์');
    if (chk.status === 'check' || buyer.addrGuess) {
      throw new Error('ตำบล/อำเภอ ยังไม่ได้ยืนยัน กรุณาเลือกให้ถูกต้องจากช่องเลือกใต้ที่อยู่');
    }
  }
  const sm = smartThaiAddress(buyer.address, buyer.postcode);
  const addr = { address: sm.address, district: sm.district, city: sm.city, province: sm.province, postal_code: sm.postal_code };
  const phone = String(buyer.phone || '').replace(/\D/g, '');
  const missing = [];
  if (!(buyer.recipientName || buyer.fbName)) missing.push('ชื่อผู้รับ');
  if (!addr.address) missing.push('บ้านเลขที่/ถนน');
  if (!addr.district) missing.push('ตำบล/แขวง');
  if (!addr.city) missing.push('อำเภอ/เขต');
  if (!addr.province) missing.push('จังหวัด');
  if (!addr.postal_code) missing.push('รหัสไปรษณีย์');
  if (phone.length < 9) missing.push('เบอร์โทร');
  if (missing.length) throw new Error('ข้อมูลไม่ครบ: ' + missing.join(', ') + ' (ตรวจชื่อตำบล/อำเภอ/จังหวัดและรหัสไปรษณีย์ให้ตรงกัน เช่น "12/3 ม.4 ต.คอหงส์ อ.หาดใหญ่ จ.สงขลา 90110")');

  const sender = await beemoveResolveSenderCached(bm);
  const fs = sender.from;
  if (!fs.district || !fs.city || !fs.province || !fs.postal_code) {
    throw new Error('ไม่มีที่อยู่ผู้ส่ง: เพิ่ม "ที่อยู่รับสินค้า" ใน Bee Move (ตั้งค่า → ที่อยู่รับสินค้า) หรือกรอกที่อยู่ผู้ส่งในเมนู 🚚 ขนส่ง Bee Move');
  }
  const base = {
    from: fs,
    to: { name: buyer.recipientName || buyer.fbName, ...addr, phone_number: phone },
    parcel: beemoveParcel(bm)
  };
  if (sender.pickupPointId !== null && sender.pickupPointId !== undefined && sender.pickupPointId !== '') {
    base.pickup_point_id = isNaN(Number(sender.pickupPointId)) ? sender.pickupPointId : Number(sender.pickupPointId);
  }
  const est = await beemoveEstimateRaw(bm, base);
  const prices = est.prices;
  const chosen = pickPartner(bm, prices);
  if (!chosen) {
    if (!prices.length) {
      throw new Error('Bee Move ไม่ส่งราคาขนส่งกลับมา: ' + JSON.stringify(est.raw).slice(0, 250));
    }
    const names = prices.filter(p => p.partner).map(p => p.partner.partner_name +
      (p.errors && p.errors.length ? '(ใช้ไม่ได้: ' + [].concat(p.errors).map(x => typeof x === 'string' ? x : (x.message || JSON.stringify(x))).join(' ').slice(0, 80) + ')' : '')).join(', ');
    throw new Error('ไม่พบขนส่งที่ตั้งไว้ ขนส่งที่มี: ' + names);
  }
  const body = {
    ...base,
    parcel: { ...base.parcel, items: [] },
    partner_id: chosen.partner.id,
    estimate_price: {
      sell_price: chosen.price?.sell_price || 0,
      service_area_fee: chosen.price?.service_area_fee || 0,
      cod_fee: chosen.price?.cod_fee || 0
    },
    label_remark: String(remark || '').slice(0, 100)
  };
  const res = await beemoveRequest(bm, 'POST', '/client/v1/shipment-orders', { data: body });
  const d = unwrapData(res.data) || {};
  const id = d.id || d.shipment_order_id || d.order_id;
  const trackingNo = d.partner_awb_no || d.awb_no || d.tracking_no || '';
  if (!id) throw new Error('สร้างพัสดุไม่สำเร็จ: ' + JSON.stringify(res.data).slice(0, 300));
  return { id: String(id), trackingNo, partnerName: chosen.partner.partner_name || '', price: chosen.price?.sell_price || 0 };
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
                <a href="#" onclick="switchTab('beemove')" id="nav-beemove" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">🚚 ขนส่ง Bee Move</a>
                <a href="#" onclick="switchTab('webhook')" id="nav-webhook" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50">⚙️ เพิ่มเพจ & Webhook</a>
            </div>
        </aside>

        <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <header class="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 z-10">
                <h1 id="page-title" class="text-lg font-bold text-slate-700">กำลังจัดการเพจ: <span id="header-page-name" class="text-blue-600">ยังไม่ได้เลือกเพจ</span> <span id="db-status" class="ml-2 text-xs font-medium text-slate-400"></span></h1>
                <span class="text-xs bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-semibold">● User: <span id="current-username"></span></span>
            </header>

            <main class="flex-1 overflow-y-auto p-6">
                <div id="tab-dashboard" class="space-y-6">
                    <div id="bot-switch-card" class="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h3 class="text-base font-bold text-slate-800">🤖 บอตตอบกลับคอมเมนต์อัตโนมัติ</h3>
                            <p id="bot-switch-desc" class="text-xs text-slate-500 mt-1">เปิด = กดไลก์ / ตอบใต้คอมเมนต์ / ส่งเข้าแชท ตามที่ตั้งไว้ด้านล่าง · ปิด = หยุดตอบทั้งหมด (มีผลทันที ไม่ต้องกดบันทึก)</p>
                        </div>
                        <label class="flex items-center cursor-pointer">
                            <input type="checkbox" id="enable-comment-bot" class="sr-only peer" onchange="toggleCommentBot(this)">
                            <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 relative"></div>
                            <span id="bot-switch-label" class="ml-3 text-sm font-semibold text-slate-700">เปิดใช้งาน</span>
                        </label>
                    </div>
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
                            <div class="mb-4">
                                <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความตอบกลับใต้คอมเมนต์:</label>
                                <textarea id="reply-comment-input" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="ข้อความตอบกลับใต้คอมเมนต์..."></textarea>
                                <p class="text-xs text-slate-400 mt-1">ใส่ <b>{name}</b> = ชื่อลูกค้า · เขียนหลายแบบคั่นด้วยบรรทัด <b>---</b> ระบบจะสุ่มส่ง (ข้อความไม่ซ้ำกัน ลดโอกาสโดน Facebook มองเป็นสแปม)</p>
                            </div>
                            <label class="flex items-center gap-2 cursor-pointer pt-4 border-t border-slate-100">
                                <input type="checkbox" id="enable-comment-reply" class="w-4 h-4 text-blue-600 rounded">
                                <span class="text-sm font-medium text-slate-700">เปิดใช้งานตอบกลับคอมเมนต์อัตโนมัติ</span>
                            </label>
                        </div>
                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col justify-between">
                            <div class="mb-4">
                                <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความส่งเข้าแชทส่วนตัว:</label>
                                <textarea id="inbox-input" rows="5" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500" placeholder="ข้อความส่งเข้าแชทส่วนตัว..."></textarea>
                                <p class="text-xs text-slate-400 mt-1">ใส่ <b>{name}</b> = ชื่อลูกค้า · หลายแบบคั่นด้วยบรรทัด <b>---</b> ได้เหมือนกัน</p>
                            </div>
                            <label class="flex items-center gap-2 cursor-pointer pt-4 border-t border-slate-100">
                                <input type="checkbox" id="enable-inbox" class="w-4 h-4 text-blue-600 rounded">
                                <span class="text-sm font-medium text-slate-700">ส่งข้อความหาลูกค้าทางแชท (ดึงคอมเมนต์เข้าแชท)</span>
                            </label>
                        </div>
                    </div>
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
                        <label class="flex flex-wrap items-center gap-2 text-sm text-slate-700">⏱️ ไม่ตอบซ้ำคนเดิมภายใน
                            <input type="number" id="reply-cooldown" min="0" max="1440" value="0" class="w-20 p-1.5 text-sm border border-slate-200 rounded-lg bg-white"> นาที
                            <span class="text-xs text-slate-400">(0 = ตอบทุกครั้ง)</span></label>
                    </div>

                    <div class="bg-pink-50/50 border border-pink-200 rounded-2xl p-4 space-y-2">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div class="text-xs font-bold text-pink-600">🏷️ ติด / ลบป้ายกำกับอัตโนมัติ เมื่อคอมเมนต์ตรงคำดัก <span class="font-normal text-slate-500">(เช่น "ยังไม่โอน" · ต้องเปิด "ส่งข้อความหาลูกค้าทางแชท")</span></div>
                            <button type="button" onclick="loadPageLabels()" class="px-3 py-1 text-xs font-medium bg-white border border-pink-300 text-pink-600 rounded-lg hover:bg-pink-50">🔄 โหลดป้ายกำกับจากเพจ</button>
                        </div>
                        <div class="text-xs font-semibold text-pink-600">ติดป้ายกำกับ</div>
                        <div id="pg-kw-labels" class="flex flex-wrap items-center gap-2"></div>
                        <div class="text-xs font-semibold text-slate-600 pt-1">ลบป้ายกำกับ <span class="font-normal text-slate-400">(เช่น ลบ "โอนแล้ว" ที่ค้างจากครั้งก่อน เมื่อลูกค้ากด 1)</span></div>
                        <div id="pg-kw-remove-labels" class="flex flex-wrap items-center gap-2"></div>
                        <div class="text-xs text-slate-400">ใช้กับคอมเมนต์ในโพสต์ทั่วไป และเป็นค่าเริ่มต้นของ Live Session ที่สร้างใหม่ · เคล็ดลับ: ที่หน้าตั้งค่าสลิป แท็บ "สลิปถูกต้อง" ให้ติดป้าย "โอนแล้ว" และลบป้าย "ยังไม่โอน"</div>
                    </div>

                    <div class="flex justify-end">
                        <button type="button" onclick="saveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่าเพจนี้</button>
                    </div>
                </div>

                <div id="tab-slip" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-6">
                        <div class="flex items-center justify-between border-b border-slate-100 pb-4">
                            <div>
                                <h3 class="text-base font-bold text-slate-800">🧾 ตั้งค่าตรวจสลิปอัตโนมัติ (ZWIZ.AI / EasySlip)</h3>
                                <p class="text-xs text-slate-500 mt-1">เมื่อลูกค้าส่งรูปสลิปเข้ามาในแชท ระบบจะตรวจยอดเงิน เลขบัญชีผู้รับ และเช็คสลิปซ้ำให้อัตโนมัติ</p>
                            </div>
                            <label class="flex items-center cursor-pointer">
                                <input type="checkbox" id="enable-slip-verify" class="sr-only peer">
                                <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 relative"></div>
                                <span class="ml-3 text-sm font-semibold text-slate-700">เปิดใช้งานตรวจสอบ</span>
                            </label>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label class="text-xs font-semibold text-slate-600 block mb-1">ผู้ให้บริการตรวจสลิป:</label>
                                <select id="slip-provider" onchange="toggleSlipProvider()" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400">
                                    <option value="zwiz">ZWIZ.AI (หลัก)</option>
                                    <option value="easyslip">EasySlip (สำรอง)</option>
                                </select>
                            </div>
                            <div id="zwiz-key-box" class="md:col-span-2">
                                <label class="text-xs font-semibold text-slate-600 block mb-1">ZWIZ API Key (x-api-key):</label>
                                <input type="text" id="zwiz-api-key" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400" placeholder="กรอก API Key จาก ZWIZ.AI...">
                            </div>
                            <div id="easyslip-key-box" class="md:col-span-2 hidden">
                                <label class="text-xs font-semibold text-slate-600 block mb-1">EasySlip API Key:</label>
                                <input type="text" id="easyslip-api-key" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400" placeholder="กรอก API Key จาก EasySlip...">
                            </div>
                        </div>
                        <div id="slip-provider-status" class="text-xs text-slate-500 -mt-2"></div>

                        <div class="bg-rose-50/50 border border-rose-200 rounded-2xl p-5 space-y-4">
                            <h4 class="text-xs font-bold text-rose-700 uppercase tracking-wider">บัญชีผู้รับเงินที่ต้องตรวจสอบ</h4>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ธนาคารผู้รับ:</label>
                                    <select id="merchant-bank" class="w-full p-2.5 text-sm bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400">
                                        <option value="">-- เลือกธนาคาร --</option>
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
                                    <div class="slip-label-box border-t border-slate-200 pt-3 mt-2 space-y-2" data-key="valid">
                                        <div class="text-xs font-semibold text-pink-600">ป้ายกำกับ</div>
                                        <div id="lbl-add-valid" class="flex flex-wrap items-center gap-2"></div>
                                        <div class="text-xs font-semibold text-slate-500 pt-1">ลบป้ายกำกับ</div>
                                        <div id="lbl-remove-valid" class="flex flex-wrap items-center gap-2"></div>
                                    </div>
                                </div>
                                <div id="slip-msg-invalid" class="space-y-2 hidden">
                                    <textarea id="msg-slip-invalid" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                    <div class="slip-label-box border-t border-slate-200 pt-3 mt-2 space-y-2" data-key="invalid">
                                        <div class="text-xs font-semibold text-pink-600">ป้ายกำกับ</div>
                                        <div id="lbl-add-invalid" class="flex flex-wrap items-center gap-2"></div>
                                        <div class="text-xs font-semibold text-slate-500 pt-1">ลบป้ายกำกับ</div>
                                        <div id="lbl-remove-invalid" class="flex flex-wrap items-center gap-2"></div>
                                    </div>
                                </div>
                                <div id="slip-msg-unreadable" class="space-y-2 hidden">
                                    <label class="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-600">ส่งข้อความนี้เมื่อ:
                                        <select id="slip-unreadable-mode" class="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white font-normal">
                                            <option value="smart">ลูกค้ากำลังจ่ายเงิน — พิมพ์เรื่องโอน/สลิป หรือเพิ่งกดสั่งซื้อในไลฟ์ (แนะนำ)</option>
                                            <option value="always">ทุกครั้งที่อ่านรูปไม่ได้ (รูปสินค้า/รูปทั่วไปก็ตอบ)</option>
                                            <option value="never">ไม่ส่งเลย</option>
                                        </select>
                                    </label>
                                    <textarea id="msg-slip-unreadable" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                    <div class="slip-label-box border-t border-slate-200 pt-3 mt-2 space-y-2" data-key="unreadable">
                                        <div class="text-xs font-semibold text-pink-600">ป้ายกำกับ</div>
                                        <div id="lbl-add-unreadable" class="flex flex-wrap items-center gap-2"></div>
                                        <div class="text-xs font-semibold text-slate-500 pt-1">ลบป้ายกำกับ</div>
                                        <div id="lbl-remove-unreadable" class="flex flex-wrap items-center gap-2"></div>
                                    </div>
                                </div>
                                <div id="slip-msg-duplicate" class="space-y-2 hidden">
                                    <textarea id="msg-slip-duplicate" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-rose-400 bg-white"></textarea>
                                    <div class="slip-label-box border-t border-slate-200 pt-3 mt-2 space-y-2" data-key="duplicate">
                                        <div class="text-xs font-semibold text-pink-600">ป้ายกำกับ</div>
                                        <div id="lbl-add-duplicate" class="flex flex-wrap items-center gap-2"></div>
                                        <div class="text-xs font-semibold text-slate-500 pt-1">ลบป้ายกำกับ</div>
                                        <div id="lbl-remove-duplicate" class="flex flex-wrap items-center gap-2"></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="flex flex-wrap items-center gap-3 text-xs">
                            <button type="button" onclick="loadPageLabels()" class="px-3 py-1.5 font-medium bg-white border border-pink-300 text-pink-600 rounded-lg hover:bg-pink-50">🔄 โหลดป้ายกำกับจากเพจ</button>
                            <span id="label-load-status" class="text-slate-500">ป้ายกำกับเลือกจากที่มีในเพจ (สร้างป้ายใหม่ได้ที่ Meta Business Suite → จัดการป้ายกำกับ)</span>
                        </div>

                        <details id="slip-history" class="bg-slate-50 border border-slate-200 rounded-2xl p-4" ontoggle="if(this.open) loadSlipStatus()">
                            <summary class="cursor-pointer select-none text-sm font-semibold text-slate-700">📜 ประวัติการตรวจสลิปล่าสุด <span class="font-normal text-xs text-slate-500">(ดูสาเหตุที่สลิปไม่ผ่าน)</span></summary>
                            <div class="mt-3 overflow-auto max-h-96">
                                <div class="flex justify-end mb-2"><button type="button" onclick="loadSlipStatus()" class="px-3 py-1 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-100">🔄 รีเฟรช</button></div>
                                <table class="w-full text-xs">
                                    <thead class="text-left text-slate-500 border-b border-slate-200"><tr><th class="py-1.5 pr-2">เวลา</th><th class="py-1.5 pr-2">ชื่อเฟส</th><th class="py-1.5 pr-2">ผล</th><th class="py-1.5 pr-2 text-right">ยอด</th><th class="py-1.5 pr-2">รหัส</th><th class="py-1.5">รายละเอียด</th></tr></thead>
                                    <tbody id="slip-history-body"><tr><td colspan="6" class="py-3 text-slate-400">ยังไม่มีประวัติ</td></tr></tbody>
                                </table>
                            </div>
                        </details>

                        <details id="dup-tool" class="bg-amber-50/50 border border-amber-200 rounded-2xl p-4">
                            <summary class="cursor-pointer select-none text-sm font-semibold text-amber-800">🧹 เครื่องมือป้ายชื่อซ้ำ <span class="font-normal text-xs text-amber-700">(ป้ายชื่อเดียวกันหลาย ID · ทดสอบหาตัวที่ซ่อนอยู่ แล้วลบ)</span></summary>
                            <div class="mt-3 space-y-3 text-xs">
                                <ol class="list-decimal pl-5 text-slate-600 space-y-0.5">
                                    <li>กด "ค้นหาป้ายซ้ำ" แล้วเลือกบัญชีทดสอบ (บัญชีของคุณที่เคยคอมเมนต์ในไลฟ์)</li>
                                    <li>กด "ทดสอบติด" ทีละ ID แล้วรีเฟรชแชทของบัญชีนั้นใน Meta Business Suite ดูว่าป้ายขึ้นไหม (กด "ถอดออก" ก่อนทดสอบ ID ถัดไป)</li>
                                    <li>ID ที่ติดแล้ว "ไม่ขึ้น" ใน Business Suite = ตัวที่ซ่อนอยู่ → กด "ลบ"</li>
                                </ol>
                                <div class="flex flex-wrap items-center gap-2">
                                    <button type="button" onclick="loadDupLabels()" class="px-3 py-1.5 font-medium bg-white border border-amber-300 text-amber-800 rounded-lg hover:bg-amber-100">🔍 ค้นหาป้ายซ้ำ</button>
                                    <span>บัญชีทดสอบ:</span>
                                    <select id="dup-test-psid" class="px-2 py-1.5 border border-slate-300 rounded-lg bg-white max-w-xs"><option value="">-- กดค้นหาป้ายซ้ำก่อน --</option></select>
                                    <span id="dup-status" class="text-slate-500"></span>
                                </div>
                                <div id="dup-list" class="space-y-2"></div>
                            </div>
                        </details>

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
                                <p class="text-xs text-slate-500 mt-1">ตามกฎ Facebook ส่งได้เฉพาะลูกค้าที่ทักแชทเข้ามาภายใน 24 ชม. ล่าสุด (ส่งโปรโมชันหาลูกค้าเก่าให้ใช้ Marketing Messages ใน Meta Business Suite)</p>
                            </div>
                            <div class="text-right">
                                <span class="text-xs text-slate-400 block">ส่งได้ (ทักมาใน 24 ชม.)</span>
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
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                                <label class="block bg-white border border-slate-300 rounded-xl p-3 cursor-text focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"><div class="text-xs text-slate-500">📦 ต้นทุน (บาท) ✎</div><input type="number" min="0" step="0.01" id="lv-fin-cost" data-field="cost" onchange="saveLiveFinance(this)" onkeydown="if(event.key==='Enter') this.blur()" placeholder="0" class="w-full bg-transparent text-xl font-bold text-slate-800 focus:outline-none"></label>
                                <label class="block bg-white border border-slate-300 rounded-xl p-3 cursor-text focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"><div class="text-xs text-slate-500">📣 ค่าแอด (บาท) ✎</div><input type="number" min="0" step="0.01" id="lv-fin-ads" data-field="ads" onchange="saveLiveFinance(this)" onkeydown="if(event.key==='Enter') this.blur()" placeholder="0" class="w-full bg-transparent text-xl font-bold text-slate-800 focus:outline-none"></label>
                                <label class="block bg-white border border-slate-300 rounded-xl p-3 cursor-text focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"><div class="text-xs text-slate-500">🚚 ค่าส่ง (บาท) ✎</div><input type="number" min="0" step="0.01" id="lv-fin-shipping" data-field="shipping" onchange="saveLiveFinance(this)" onkeydown="if(event.key==='Enter') this.blur()" placeholder="0" class="w-full bg-transparent text-xl font-bold text-slate-800 focus:outline-none"></label>
                                <div id="lv-fin-profit-box" class="bg-emerald-50 border border-emerald-200 rounded-xl p-3"><div id="lv-fin-profit-label" class="text-xs text-emerald-700">💹 กำไร (บาท)</div><div id="lv-fin-profit" class="text-xl font-bold text-emerald-700">0</div><div id="lv-fin-profit-sub" class="text-[10px] text-slate-500 mt-0.5"></div></div>
                            </div>
                            <div class="grid grid-cols-2 md:grid-cols-6 gap-3">
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">คอมเมนต์ทั้งหมด</div><div id="lv-stat-comments" class="text-xl font-bold text-slate-800">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">ตรงคำดัก</div><div id="lv-stat-matched" class="text-xl font-bold text-blue-600">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">คนคอมเมนต์</div><div id="lv-stat-people" class="text-xl font-bold text-slate-800">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">สลิปที่ผ่าน</div><div id="lv-stat-slips" class="text-xl font-bold text-emerald-600">0</div></div>
                                <div class="bg-slate-50 border border-slate-200 rounded-xl p-3"><div class="text-xs text-slate-500">ยอดโอนรวม (บาท)</div><div id="lv-stat-total" class="text-xl font-bold text-emerald-600">0</div></div>
                                <div class="bg-rose-50 border border-rose-200 rounded-xl p-3" title="รวมเฉพาะลูกค้าที่ใส่ 'ยอดที่ต้องจ่าย' ไว้ในตารางรายชื่อคนคอมเมนต์"><div class="text-xs text-rose-600">ยอดที่ยังขาด (บาท)</div><div id="lv-stat-short" class="text-xl font-bold text-rose-600">0</div><div id="lv-stat-short-sub" class="text-[10px] text-rose-500 mt-0.5"></div></div>
                            </div>
                            <details id="lv-auction-box" class="hidden mt-3 bg-amber-50/60 border border-amber-200 rounded-xl p-3" open>
                                <summary class="cursor-pointer select-none text-sm font-bold text-amber-800">🔨 ผลประมูลแต่ละรอบ <span class="font-normal text-xs text-slate-500">(ปิดรอบเมื่อเพจคอมเมนต์ ❤️)</span></summary>
                                <div class="overflow-auto max-h-64 mt-2">
                                    <table class="w-full text-xs">
                                        <thead class="text-left text-slate-500 border-b border-amber-200"><tr><th class="py-1.5 pr-2">ปิดรอบ</th><th class="py-1.5 pr-2 text-right">ราคาสูงสุด</th><th class="py-1.5 pr-2">คนบิดสูงสุด</th><th class="py-1.5 pr-2">คนกด 1 (ยอด)</th><th class="py-1.5">บิด</th></tr></thead>
                                        <tbody id="lv-auction-lots"></tbody>
                                    </table>
                                </div>
                            </details>
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
                                    <p class="text-xs text-slate-400 mt-1">ใส่ <b>{name}</b> = ชื่อลูกค้า · เขียนหลายแบบคั่นด้วยบรรทัด <b>---</b> ระบบจะสุ่มส่ง (ข้อความไม่ซ้ำกัน ลดโอกาสโดน Facebook มองเป็นสแปม)</p>
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อความส่งเข้าแชทส่วนตัว:</label>
                                    <textarea id="lv-inbox-text" rows="4" class="w-full p-3 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500"></textarea>
                                    <p class="text-xs text-slate-400 mt-1">ใส่ <b>{name}</b> = ชื่อลูกค้า · หลายแบบคั่นด้วยบรรทัด <b>---</b> ได้เหมือนกัน</p>
                                </div>
                            </div>
                            <div id="lv-reply-warn" class="hidden text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"></div>
                            <div class="flex flex-wrap gap-5">
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-enable-like" class="w-4 h-4 rounded"><span class="text-sm text-slate-700">👍 กดไลก์คอมเมนต์</span></label>
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-enable-reply" class="w-4 h-4 rounded"><span class="text-sm text-slate-700">ตอบกลับคอมเมนต์</span></label>
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-enable-inbox" class="w-4 h-4 rounded"><span class="text-sm text-slate-700">ส่งข้อความเข้าแชท</span></label>
                                <label class="flex items-center gap-2 text-sm text-slate-700">⏱️ ไม่ตอบซ้ำคนเดิมภายใน
                                    <input type="number" id="lv-reply-cooldown" min="0" max="1440" value="0" class="w-20 p-1.5 text-sm border border-slate-200 rounded-lg bg-white"> นาที
                                    <span class="text-xs text-slate-400">(0 = ตอบทุกครั้ง)</span></label>
                            </div>
                            <div class="bg-amber-50/60 border border-amber-200 rounded-xl p-4 space-y-1">
                                <label class="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" id="lv-auction-mode" class="w-4 h-4 rounded">
                                    <span class="text-sm font-bold text-amber-800">🔨 โหมดประมูล: แจ้งยอดจบประมูลในแชทอัตโนมัติ</span>
                                </label>
                                <p class="text-xs text-slate-600 pl-6">ลูกค้าบิดราคาที่ <b>ลงท้ายด้วย 0</b> (เช่น 380, 1,500) → ผู้ชนะกด <b>1</b> → ระบบหาราคาล่าสุดที่คนนั้นบิด ใส่แทน <b>{amount}</b> ในข้อความ และบวกเข้า <b>"ยอดที่ต้องจ่าย"</b> ให้อัตโนมัติ (รอ 3 วินาทีก่อนส่ง เผื่อคอมเมนต์ราคามาช้า)</p>
                                <div class="pl-6 pt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <label class="block text-xs font-semibold text-amber-800">✏️ ข้อความแจ้งยอดประมูล (ส่งให้ผู้ชนะ)
                                        <textarea id="lv-auction-text" rows="3" class="mt-1 w-full p-2 text-sm font-normal border border-amber-300 rounded-lg bg-white focus:outline-none focus:border-amber-500" placeholder="🔨 ยอดประมูล {amount} บาท"></textarea>
                                        <span class="block text-[11px] font-normal text-slate-500 mt-0.5">ใส่ <b>{amount}</b> = ยอดที่ชนะ · <b>{name}</b> = ชื่อลูกค้า · ระบบวางข้อความนี้ไว้บนสุด ตามด้วย "ข้อความส่งเข้าแชทส่วนตัว" (ถ้าในข้อความส่งเข้าแชทมี {amount} อยู่แล้ว จะไม่ใส่ข้อความนี้ซ้ำ)</span>
                                    </label>
                                    <label class="block text-xs font-semibold text-amber-800">❔ ข้อความเมื่อหายอดไม่เจอ (กด 1 แต่ไม่ได้บิด)
                                        <input type="text" id="lv-auction-nobid" class="mt-1 w-full p-2 text-sm font-normal border border-amber-300 rounded-lg bg-white focus:outline-none focus:border-amber-500" placeholder="รอแอดมินแจ้งยอด">
                                        <span class="block text-[11px] font-normal text-slate-500 mt-0.5">ใช้แทนตำแหน่ง "{amount} บาท" เช่น "🔨 ยอดประมูล รอแอดมินแจ้งยอด"</span>
                                    </label>
                                </div>
                            </div>
                            <div class="bg-pink-50/50 border border-pink-200 rounded-xl p-4 space-y-2">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                    <div class="text-xs font-bold text-pink-600">🏷️ ติด / ลบป้ายกำกับอัตโนมัติ เมื่อคอมเมนต์ตรงคำดัก <span class="font-normal text-slate-500">(เช่น "ยังไม่โอน" · ต้องเปิด "ส่งข้อความเข้าแชท")</span></div>
                                    <button type="button" onclick="loadLiveBcLabels()" class="px-3 py-1 text-xs font-medium bg-white border border-pink-300 text-pink-600 rounded-lg hover:bg-pink-50">🔄 โหลดป้ายกำกับจากเพจ</button>
                                </div>
                                <div class="text-xs font-semibold text-pink-600">ติดป้ายกำกับ</div>
                                <div id="lv-kw-labels" class="flex flex-wrap items-center gap-2"></div>
                                <div class="text-xs font-semibold text-slate-600 pt-1">ลบป้ายกำกับ <span class="font-normal text-slate-400">(เช่น ลบ "โอนแล้ว" ที่ค้างจากไลฟ์ก่อน เมื่อลูกค้ากด 1 ในไลฟ์นี้)</span></div>
                                <div id="lv-kw-remove-labels" class="flex flex-wrap items-center gap-2"></div>
                                <div id="lv-kw-status" class="hidden text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"></div>
                                <div class="text-xs text-slate-400">เคล็ดลับ: ที่หน้าตั้งค่าสลิป แท็บ "สลิปถูกต้อง" ให้ติดป้าย "โอนแล้ว" และลบป้าย "ยังไม่โอน" ป้ายจะเปลี่ยนเองเมื่อลูกค้าโอน</div>
                            </div>
                            <div class="flex justify-end">
                                <button type="button" onclick="saveLiveConfig()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่า session นี้</button>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
                            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                                <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                                    <h3 class="text-base font-bold text-slate-700">💬 รายชื่อคนคอมเมนต์ (ล่าสุด 300 คน)</h3>
                                    <div class="flex flex-wrap gap-2">
                                        <button type="button" onclick="deleteSelectedCommenters()" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white text-rose-600 border border-rose-300 hover:bg-rose-50 shadow-sm">🗑️ ลบคนที่เลือก</button>
                                        <button type="button" onclick="pullSelectedCommenters()" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm">📥 ดึงข้อมูลคนที่เลือก</button>
                                    </div>
                                </div>
                                <div class="flex flex-wrap items-center gap-3 mb-2 text-xs text-slate-600">
                                    <label class="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" id="lv-cm-all" onchange="toggleAllCommenters(this.checked)" class="w-4 h-4 rounded"> เลือกทั้งหมด</label>
                                    <select id="lv-cm-filter" onchange="renderCommenters()" class="p-1 border border-slate-200 rounded-md bg-white">
                                        <option value="matched">เฉพาะคนที่ตรงคำดัก</option>
                                        <option value="unpaid">ตรงคำดัก · ยังไม่โอน</option>
                                        <option value="paid">ตรงคำดัก · โอนแล้ว</option>
                                        <option value="paidNotBuyer">โอนแล้ว · ยังไม่อยู่ในรายชื่อลูกค้า</option>
                                        <option value="short">💰 ยอดยังไม่ครบ (โอนขาด)</option>
                                        <option value="over">💰 โอนเกิน</option>
                                        <option value="full">💰 โอนครบแล้ว</option>
                                        <option value="noDue">💰 ยังไม่ได้ใส่ยอดที่ต้องจ่าย</option>
                                        <option value="all">ทุกคนที่คอมเมนต์</option>
                                    </select>
                                    <span id="lv-cm-summary"></span>
                                </div>
                                <div id="pager-cm" class="pager-bar flex flex-wrap items-center gap-2 text-xs text-slate-600 mb-2"></div>
                                <div class="overflow-auto max-h-96">
                                    <table class="w-full text-xs">
                                        <thead class="text-left text-slate-500 border-b border-slate-200"><tr><th class="py-2 pr-2">✓</th><th class="py-2 pr-2">ชื่อ</th><th class="py-2 pr-2">ครั้ง</th><th class="py-2 pr-2">ตรงคำดัก</th><th class="py-2 pr-2 whitespace-nowrap">ยอดที่ต้องจ่าย</th><th class="py-2 pr-2">สถานะโอน</th><th class="py-2 pr-2">คอมเมนต์ล่าสุด</th><th class="py-2 pr-2 text-center">แชท</th><th class="py-2">เวลา</th></tr></thead>
                                        <tbody id="lv-commenters"></tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
                                <h3 class="text-base font-bold text-slate-700 mb-3">🧾 สลิปที่ตรวจผ่านใน session นี้</h3>
                                <div id="pager-slips" class="pager-bar flex flex-wrap items-center gap-2 text-xs text-slate-600 mb-2"></div>
                                <div class="overflow-auto max-h-96">
                                    <table class="w-full text-xs">
                                        <thead class="text-left text-slate-500 border-b border-slate-200"><tr><th class="py-2 pr-2">เวลา</th><th class="py-2 pr-2">ลูกค้า</th><th class="py-2 pr-2 text-right">ยอด (บาท)</th><th class="py-2">เลขอ้างอิง</th></tr></thead>
                                        <tbody id="lv-slips"></tbody>
                                    </table>
                                </div>
                            </div>
                        </div>

                        <!-- 💬 ค้นหารายชื่อจากแชทเพจ -->
                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                            <div>
                                <h3 class="text-base font-bold text-slate-700">💬 ค้นหารายชื่อจากแชทเพจ</h3>
                                <p class="text-xs text-slate-500 mt-1">ค้นหาจากชื่อบัญชีเฟสบุ๊ค หรือข้อความในแชท (ชื่อผู้รับ ที่อยู่ เบอร์โทร) ตามช่วงวันที่ แล้วเลือกเพิ่มเข้าตารางรายชื่อลูกค้าด้านล่าง</p>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">ข้อมูล</label>
                                    <input type="text" id="lv-chat-q" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500" placeholder="ค้นหา ชื่อเฟสบุ๊ค, ชื่อผู้รับ, ที่อยู่, เบอร์โทร (เว้นว่าง = ทุกแชทในช่วงวันที่)">
                                </div>
                                <div class="relative">
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">วันที่</label>
                                    <div id="lv-chat-range" onclick="toggleChatCal()" class="w-full p-2.5 text-sm border border-slate-200 rounded-lg bg-white flex items-center justify-between cursor-pointer hover:border-blue-400">
                                        <span id="lv-chat-range-text">-</span><span class="text-slate-400">📅</span>
                                    </div>
                                    <div id="lv-chat-cal" class="hidden absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-lg p-3"></div>
                                </div>
                            </div>
                            <div class="flex flex-wrap items-center justify-between gap-3">
                                <div class="flex flex-wrap gap-4">
                                    <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-600"><input type="checkbox" id="lv-chat-onlyaddr" class="w-4 h-4 rounded"> เฉพาะคนที่ส่งที่อยู่มาในแชทแล้ว</label>
                                    <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-600"><input type="checkbox" id="lv-chat-deep" class="w-4 h-4 rounded"> ค้นในข้อความแชทด้วย (ที่อยู่/เบอร์ · ช้ากว่า)</label>
                                </div>
                                <button type="button" id="lv-chat-btn" onclick="searchChats()" class="px-5 py-2 text-sm font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 shadow-sm">🔍 ค้นหา</button>
                            </div>
                            <div id="lv-chat-status" class="hidden text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2"></div>
                            <div id="lv-chat-results-box" class="hidden space-y-3">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                    <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-600"><input type="checkbox" id="lv-chat-all" onchange="toggleAllChats(this.checked)" class="w-4 h-4 rounded"> เลือกทั้งหมด <span id="lv-chat-count"></span></label>
                                    <button type="button" onclick="addChatsToBuyers()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm">➕ เพิ่มที่เลือกเข้ารายชื่อลูกค้า</button>
                                </div>
                                <div id="pager-chat" class="pager-bar flex flex-wrap items-center gap-2 text-xs text-slate-600 mb-2"></div>
                                <div class="overflow-auto max-h-96">
                                    <table class="w-full text-xs">
                                        <thead class="text-left text-slate-500 border-b border-slate-200"><tr>
                                            <th class="py-2 pr-2">✓</th><th class="py-2 pr-2">บัญชีเฟสบุ๊ค</th><th class="py-2 pr-2">ข้อความที่พบ</th><th class="py-2 pr-2">ที่อยู่ในแชท</th><th class="py-2">แชทล่าสุด</th>
                                        </tr></thead>
                                        <tbody id="lv-chat-results"></tbody>
                                    </table>
                                </div>
                            </div>
                        </div>

                        <!-- 📦 รายชื่อลูกค้า + ที่อยู่จากแชท สำหรับใบแปะหน้า -->
                        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <h3 class="text-base font-bold text-slate-700">📦 รายชื่อลูกค้า (คนที่กดตามคำดัก) + ที่อยู่จากแชท</h3>
                                    <p class="text-xs text-slate-500 mt-1">ดึงคนที่คอมเมนต์ตรงคำดักใน session นี้ แล้วค้นหาชื่อ ที่อยู่ เบอร์โทร ที่ลูกค้าพิมพ์ส่งมาในแชท แก้ไขข้อมูลในตารางได้ (บันทึกอัตโนมัติ) ก่อนพิมพ์ใบแปะหน้า</p>
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    <button type="button" id="lv-btn-buyers" onclick="fetchBuyers()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm">🔍 ดึงรายชื่อ + ค้นหาที่อยู่</button>
                                    <button type="button" onclick="fixBuyerAddresses()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-500 text-white hover:bg-amber-600">🗺️ จัดรูปแบบที่อยู่ให้ถูกต้อง</button>
                                    <button type="button" onclick="exportBuyersCSV()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200">⬇️ ดาวน์โหลด CSV</button>
                                    <button type="button" onclick="deleteSelectedBuyers()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-100">🗑️ ลบที่เลือก</button>
                                </div>
                            </div>
                            <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3">
                                <div class="text-sm font-bold text-emerald-800">🚚 ส่งผ่าน Bee Move (ได้เลขพัสดุจริง · ใบแปะหน้า A6)</div>
                                <div class="flex flex-wrap gap-2">
                                    <button type="button" id="lv-btn-ship" onclick="createShipmentsAndPrint()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm">🚚 สร้างเลขพัสดุ + พิมพ์ใบแปะหน้า A6</button>
                                    <button type="button" onclick="printBeemoveLabels()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-100">🖨️ พิมพ์ใบแปะหน้า Bee Move ซ้ำ</button>
                                    <button type="button" onclick="notifySelectedBuyers()" class="px-4 py-2 text-xs font-semibold rounded-lg bg-white text-blue-700 border border-blue-300 hover:bg-blue-50">💬 ส่งเลขพัสดุให้ลูกค้าที่เลือก</button>
                                </div>
                                <div class="text-xs text-emerald-700">ที่อยู่ต้องมี ต./อ./จ. และรหัสไปรษณีย์ (เช่น 12/3 ม.4 ต.คอหงส์ อ.หาดใหญ่ จ.สงขลา 90110) ลูกค้าที่มีเลขพัสดุแล้วจะไม่ถูกสร้างซ้ำ · ตั้งค่า API Key ที่เมนู 🚚 ขนส่ง Bee Move</div>
                            </div>
                            <details class="bg-slate-50 rounded-xl border border-slate-200 p-4">
                                <summary class="cursor-pointer text-xs font-semibold text-slate-600">🖨️ พิมพ์ใบแปะหน้าเอง (A6) แบบไม่ผ่านขนส่ง</summary>
                                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                                    <div><label class="text-xs font-semibold text-slate-600 block mb-1">ชื่อผู้ส่ง (บนใบแปะหน้า):</label><input type="text" id="lv-sender-name" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                    <div><label class="text-xs font-semibold text-slate-600 block mb-1">ที่อยู่ / เบอร์ผู้ส่ง:</label><input type="text" id="lv-sender-addr" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                    <div class="flex items-end"><button type="button" onclick="printLabels()" class="w-full px-4 py-2 text-xs font-semibold rounded-lg bg-slate-800 text-white hover:bg-slate-700">🖨️ พิมพ์ใบแปะหน้าเอง A6</button></div>
                                </div>
                            </details>
                            <div id="lv-buyers-progress" class="hidden text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl p-3"></div>
                            <div id="lv-ship-progress" class="hidden text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3"></div>
                            <div class="flex flex-wrap items-center gap-4 text-xs text-slate-600">
                                <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="lv-buyers-all" onchange="toggleAllBuyers(this.checked)" class="w-4 h-4 rounded"> เลือกทั้งหมด</label>
                                <span id="lv-buyers-summary"></span>
                            </div>
                            <div id="pager-buyers" class="pager-bar flex flex-wrap items-center gap-2 text-xs text-slate-600 mb-2"></div>
                            <div class="overflow-auto max-h-[36rem]">
                                <table class="w-full text-xs">
                                    <thead class="text-left text-slate-500 border-b border-slate-200"><tr>
                                        <th class="py-2 pr-2">✓</th><th class="py-2 pr-2">ลูกค้า (เฟส)</th><th class="py-2 pr-2">คำดัก</th><th class="py-2 pr-2 text-right">ยอดโอน</th>
                                        <th class="py-2 pr-2">ชื่อผู้รับ</th><th class="py-2 pr-2">ที่อยู่</th><th class="py-2 pr-2">รหัส ปณ.</th><th class="py-2 pr-2">เบอร์โทร</th><th class="py-2 pr-2">เลขพัสดุ</th><th class="py-2 pr-2 whitespace-nowrap">แยกที่อยู่</th><th class="py-2">สถานะ</th>
                                    </tr></thead>
                                    <tbody id="lv-buyers"><tr><td colspan="11" class="py-3 text-slate-400">กด "ดึงรายชื่อ + ค้นหาที่อยู่" เพื่อเริ่ม</td></tr></tbody>
                                </table>
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
                            <div class="bg-pink-50/50 border border-pink-200 rounded-xl p-4 space-y-2">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                    <div class="text-xs font-bold text-pink-600">🏷️ เลือกผู้รับจากป้ายกำกับ <span class="font-normal text-slate-500">(ไม่เลือก = ไม่กรองป้าย)</span></div>
                                    <button type="button" onclick="loadLiveBcLabels()" class="px-3 py-1 text-xs font-medium bg-white border border-pink-300 text-pink-600 rounded-lg hover:bg-pink-50">🔄 โหลดป้ายกำกับจากเพจ</button>
                                </div>
                                <div class="text-xs font-semibold text-slate-600">ส่งเฉพาะคนที่มีป้าย <span class="font-normal text-slate-400">(มีป้ายใดป้ายหนึ่ง)</span></div>
                                <div id="lv-bc-lbl-include" class="flex flex-wrap items-center gap-2"></div>
                                <div class="text-xs font-semibold text-slate-600 pt-1">ยกเว้นคนที่มีป้าย <span class="font-normal text-slate-400">(เช่น ยกเว้น "โอนแล้ว" = ทวงโอนเฉพาะคนที่ยังไม่โอน)</span></div>
                                <div id="lv-bc-lbl-exclude" class="flex flex-wrap items-center gap-2"></div>
                                <div id="lv-bc-lbl-status" class="text-xs text-slate-400"></div>
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

                <div id="tab-beemove" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <div>
                            <h3 class="text-base font-bold text-slate-800">🚚 เชื่อมต่อขนส่ง Bee Move (client.beemove.co.th)</h3>
                            <p class="text-xs text-slate-500 mt-1">เมื่อเชื่อมแล้ว กดปุ่ม "สร้างเลขพัสดุ + พิมพ์ใบแปะหน้า" ในหน้าไลฟ์ ระบบจะสร้างพัสดุใน Bee Move ให้ลูกค้าแต่ละคน ได้เลขพัสดุทันที และเปิดใบแปะหน้า A6 ของขนส่งให้พิมพ์</p>
                        </div>
                        <div class="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                            <h4 class="text-sm font-bold text-slate-700">🔐 บัญชี Bee Move</h4>
                            <p class="text-xs text-slate-500">ใช้เบอร์โทรและรหัสผ่านเดียวกับที่เข้า client.beemove.co.th ระบบจะเข้าสู่ระบบให้อัตโนมัติ และเข้าใหม่เองเมื่อหมดอายุ</p>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">เบอร์โทร (ที่ใช้เข้าสู่ระบบ) *</label><input id="bm-username" autocomplete="off" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">รหัสผ่าน * <span id="bm-pass-state" class="font-normal text-slate-400"></span></label><input type="password" id="bm-password" autocomplete="new-password" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white" placeholder="เว้นว่าง = ใช้รหัสเดิม"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ร้าน (ถ้ามีหลายร้าน):</label>
                                    <select id="bm-account-id" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"><option value="">-- ร้านแรก (ค่าเริ่มต้น) --</option></select>
                                </div>
                            </div>
                            <div class="text-xs text-amber-700">⚠️ การสร้างพัสดุจะตัดเงินจาก Wallet ของ Bee Move ตามค่าส่งจริง</div>
                            <details class="text-xs text-slate-600">
                                <summary class="cursor-pointer font-semibold">ขั้นสูง: เชื่อมต่อด้วย API Key แทน (ใช้เมื่อ Bee Move แจ้งวิธีใช้ Key ให้แล้ว)</summary>
                                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                                    <div>
                                        <label class="font-semibold block mb-1">วิธีเชื่อมต่อ:</label>
                                        <select id="bm-auth-mode" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white">
                                            <option value="login">เบอร์โทร + รหัสผ่าน (แนะนำ)</option>
                                            <option value="bearer">API Key: Authorization Bearer</option>
                                            <option value="x-api-key">API Key: x-api-key</option>
                                            <option value="apikey">API Key: apikey</option>
                                        </select>
                                    </div>
                                    <div class="md:col-span-2">
                                        <label class="font-semibold block mb-1">API Key: <span id="bm-key-state" class="font-normal text-slate-400"></span></label>
                                        <input type="password" id="bm-api-key" autocomplete="off" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white" placeholder="เว้นว่าง = ใช้ Key เดิม">
                                    </div>
                                </div>
                            </details>
                        </div>

                        <div class="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                            <h4 class="text-sm font-bold text-slate-700">📮 ข้อมูลผู้ส่ง (ที่อยู่ร้าน)</h4>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ชื่อผู้ส่ง *</label><input id="bm-sender-name" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">เบอร์โทรผู้ส่ง *</label><input id="bm-sender-phone" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div class="md:col-span-2"><label class="text-xs font-semibold text-slate-600 block mb-1">บ้านเลขที่ / หมู่ / ซอย / ถนน *</label><input id="bm-sender-address" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                            </div>
                            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ตำบล/แขวง *</label><input id="bm-sender-district" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">อำเภอ/เขต *</label><input id="bm-sender-city" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">จังหวัด *</label><input id="bm-sender-province" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">รหัสไปรษณีย์ *</label><input id="bm-sender-postcode" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                            </div>
                            <div><label class="text-xs font-semibold text-slate-600 block mb-1">ที่อยู่รับสินค้าใน Bee Move (กด "ทดสอบ + ดึงขนส่ง" เพื่อโหลดรายการ):</label>
                                <select id="bm-pickup-id" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"><option value="">-- ใช้ที่อยู่แรกในบัญชี Bee Move --</option></select>
                                <div class="text-[11px] text-slate-500 mt-1">ถ้าเลือกที่อยู่รับสินค้า ระบบจะใช้ที่อยู่นั้นเป็นผู้ส่ง ช่องด้านบนใช้เฉพาะชื่อ/เบอร์ผู้ส่ง (เว้นว่างได้) หรือเมื่อบัญชีไม่มีที่อยู่รับสินค้า</div>
                            </div>
                        </div>

                        <div class="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                            <h4 class="text-sm font-bold text-slate-700">📦 ขนส่งและขนาดพัสดุเริ่มต้น</h4>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">เลือกขนส่งจากชื่อ (คั่นด้วย , ได้หลายตัว ตัวแรกที่เจอจะถูกใช้):</label>
                                    <input id="bm-partner-kw" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white" placeholder="ไปรษณีย์, Thailand Post, EMS">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-600 block mb-1">หรือเลือกขนส่งแบบระบุ (กด "ทดสอบ + ดึงขนส่ง" ก่อน):</label>
                                    <select id="bm-partner-id" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"><option value="">-- ใช้ตามชื่อด้านซ้าย --</option></select>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ชื่อพัสดุ</label><input id="bm-pkg-name" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">กว้าง (ซม.)</label><input type="number" id="bm-width" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">ยาว (ซม.)</label><input type="number" id="bm-length" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">สูง (ซม.)</label><input type="number" id="bm-height" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                                <div><label class="text-xs font-semibold text-slate-600 block mb-1">น้ำหนัก (กก.)</label><input type="number" step="0.1" id="bm-weight" class="w-full p-2 text-sm border border-slate-200 rounded-lg bg-white"></div>
                            </div>
                        </div>

                        <div class="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                            <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="bm-notify" class="w-4 h-4 rounded"><span class="text-sm font-semibold text-slate-700">💬 ส่งเลขพัสดุให้ลูกค้าทางแชทอัตโนมัติหลังสร้างพัสดุ</span></label>
                            <textarea id="bm-notify-text" rows="3" class="w-full p-3 text-sm border border-slate-200 rounded-xl bg-white" placeholder="ใช้ {tracking} = เลขพัสดุ, {courier} = ชื่อขนส่ง"></textarea>
                        </div>

                        <div class="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 space-y-3">
                            <h4 class="text-sm font-bold text-indigo-800">📡 Webhook สถานะพัสดุ (Bee Move ส่งสถานะกลับมาที่เว็บนี้)</h4>
                            <ol class="list-decimal pl-5 text-xs text-indigo-900 space-y-1">
                                <li>ที่ client.beemove.co.th ไปที่ ตั้งค่า → การเชื่อมต่อ API → จัดการ Webhook</li>
                                <li>ชื่อ ใส่อะไรก็ได้ · Webhook URL เลือก "กำหนดเอง" แล้ววางลิงก์ด้านล่าง · Event: Order status Updated</li>
                                <li>ติ๊กยอมรับเงื่อนไข แล้วกดบันทึก</li>
                            </ol>
                            <div class="flex gap-2">
                                <input id="bm-webhook-url" readonly class="flex-1 p-2 text-xs border border-indigo-200 rounded-lg bg-white text-slate-700">
                                <button type="button" onclick="copyBmWebhook()" class="px-3 py-2 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">คัดลอก</button>
                            </div>
                            <div class="text-xs text-amber-700">⚠️ Bee Move ตั้ง Webhook ได้ 1 ลิงก์ ถ้าเปลี่ยนจากลิงก์ Page365 เดิม Page365 จะไม่ได้รับสถานะพัสดุจาก Bee Move อีก</div>
                            <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" id="bm-notify-status" class="w-4 h-4 rounded"><span class="text-xs text-slate-700">💬 แจ้งลูกค้าทางแชทเมื่อพัสดุจัดส่งสำเร็จ</span></label>
                            <details class="text-xs text-slate-600">
                                <summary class="cursor-pointer font-semibold">ข้อมูลล่าสุดที่ Bee Move ส่งมา <span id="bm-hook-count"></span></summary>
                                <div id="bm-hook-list" class="mt-2 space-y-2"></div>
                            </details>
                        </div>

                        <div id="bm-test-result" class="hidden text-sm p-3 rounded-xl border"></div>
                        <div class="flex flex-wrap justify-end gap-3">
                            <button type="button" onclick="testBeemove()" class="px-5 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-xl hover:bg-slate-200">🔌 ทดสอบ + ดึงขนส่ง</button>
                            <button type="button" onclick="saveBeemove()" class="px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-xl hover:bg-emerald-700 shadow-sm">บันทึกการตั้งค่า Bee Move</button>
                        </div>
                    </div>
                </div>

                <div id="tab-webhook" class="space-y-6 hidden">
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
                        <h3 class="text-base font-bold text-slate-700">🌐 เพิ่มเพจเข้าระบบอัตโนมัติ (สูงสุด 5 เพจ)</h3>
                        <p class="text-xs text-slate-500">คลิกปุ่มด้านล่างเพื่อเข้าสู่ระบบ Facebook เลือกร้านค้าของคุณ ระบบจะดึงรายชื่อทุกเพจมาให้เลือกเพิ่มเข้าบัญชีของคุณ</p>
                        
                        <div class="flex items-center gap-4 pt-2">
                            <button type="button" onclick="loginWithFacebook()" class="px-6 py-3 bg-blue-600 text-white font-medium text-sm rounded-xl hover:bg-blue-700 shadow-md flex items-center gap-2 cursor-pointer">
                                <svg class="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.830c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.470h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
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

<details class="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 group">
                        <summary class="cursor-pointer select-none text-sm font-semibold text-slate-500 hover:text-slate-700">⚙️ ตั้งค่าขั้นสูง: Webhook สำหรับ Meta for Developers <span class="font-normal text-xs text-slate-400">(ระบบตั้งให้อัตโนมัติตอนเพิ่มเพจ ปกติไม่ต้องแก้)</span></summary>
                        <div class="space-y-4 mt-4">
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
                    </details>
                </div>
            </main>
            <div id="pay-editor" class="hidden fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onclick="if(event.target===this) closePayEditor()">
                <div class="bg-white rounded-2xl shadow-xl border border-slate-200 p-5 w-full max-w-sm space-y-3">
                    <h3 class="text-base font-bold text-slate-800">✍️ บันทึกการโอนเงิน (แมนนวล)</h3>
                    <div class="text-sm text-slate-600">ลูกค้า: <b id="pay-editor-name"></b></div>
                    <div id="pay-editor-current" class="text-xs text-slate-500"></div>
                    <label class="block text-xs font-semibold text-slate-600">ยอดเงินที่โอน (บาท)
                        <input type="number" id="pay-editor-amount" min="0" step="0.01" class="mt-1 w-full p-2.5 text-lg border border-slate-300 rounded-xl focus:outline-none focus:border-emerald-500" placeholder="เช่น 690">
                    </label>
                    <label class="block text-xs font-semibold text-slate-600">หมายเหตุ (ไม่บังคับ)
                        <input type="text" id="pay-editor-note" maxlength="100" class="mt-1 w-full p-2 text-sm border border-slate-300 rounded-xl" placeholder="เช่น โอนกรุงเทพ ตรวจเองแล้ว">
                    </label>
                    <div id="pay-editor-msg" class="text-xs text-rose-600"></div>
                    <div class="flex justify-end gap-2 pt-1">
                        <button type="button" onclick="closePayEditor()" class="px-4 py-2 text-sm rounded-xl border border-slate-300 bg-white hover:bg-slate-50">ยกเลิก</button>
                        <button type="button" id="pay-editor-save" onclick="savePayEditor()" class="px-4 py-2 text-sm font-semibold rounded-xl bg-emerald-600 text-white hover:bg-emerald-700">💾 บันทึก เป็นโอนแล้ว</button>
                    </div>
                </div>
            </div>
            <div id="due-editor" class="hidden fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onclick="if(event.target===this) closeDueEditor()">
                <div class="bg-white rounded-2xl shadow-xl border border-slate-200 p-5 w-full max-w-sm space-y-3">
                    <h3 class="text-base font-bold text-slate-800">💰 ยอดที่ลูกค้าต้องจ่าย</h3>
                    <div class="text-sm text-slate-600">ลูกค้า: <b id="due-editor-name"></b></div>
                    <div class="text-xs text-slate-500">โอนมาแล้ว: <b id="due-editor-paid" class="text-emerald-700"></b></div>
                    <label class="block text-xs font-semibold text-slate-600">ยอดที่ต้องจ่าย (บาท) <span class="font-normal text-slate-400">· บวกหลายรายการได้ เช่น 250+300+100</span>
                        <input type="text" inputmode="decimal" autocomplete="off" id="due-editor-amount" oninput="previewDue()" class="mt-1 w-full p-2.5 text-lg border border-slate-300 rounded-xl focus:outline-none focus:border-indigo-500" placeholder="เช่น 650 หรือ 250+300+100">
                    </label>
                    <div id="due-editor-sum" class="hidden text-sm text-slate-600 px-1"></div>
                    <div id="due-editor-preview" class="hidden text-sm font-semibold px-3 py-2 rounded-xl"></div>
                    <div id="due-editor-msg" class="text-xs text-rose-600"></div>
                    <div class="flex items-center gap-2 pt-1">
                        <button type="button" id="due-editor-del" onclick="saveDueEditor(true)" class="hidden px-3 py-2 text-sm rounded-xl text-rose-600 hover:bg-rose-50">🗑️ ลบยอด</button>
                        <div class="flex-1"></div>
                        <button type="button" onclick="closeDueEditor()" class="px-4 py-2 text-sm rounded-xl border border-slate-300 bg-white hover:bg-slate-50">ยกเลิก</button>
                        <button type="button" id="due-editor-save" onclick="saveDueEditor(false)" class="px-4 py-2 text-sm font-semibold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">💾 บันทึกยอด</button>
                    </div>
                </div>
            </div>
            <div id="chat-box" class="hidden fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-2 sm:p-4" onclick="if(event.target===this) closeChatBox()">
                <div class="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg flex flex-col" style="height:min(640px,92vh)">
                    <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
                        <div class="w-8 h-8 rounded-full bg-[#0866FF] text-white flex items-center justify-center text-sm font-bold" id="chat-box-avatar">?</div>
                        <div class="flex-1 min-w-0">
                            <div class="font-bold text-slate-800 truncate" id="chat-box-name"></div>
                            <div class="text-[11px] text-slate-500 truncate" id="chat-box-sub"></div>
                        </div>
                        <button type="button" onclick="loadChatBox(true)" title="โหลดใหม่" class="px-2 py-1 text-sm rounded-lg hover:bg-slate-100">🔄</button>
                        <button type="button" onclick="closeChatBox()" title="ปิด" class="px-2 py-1 text-sm rounded-lg hover:bg-slate-100">✕</button>
                    </div>
                    <div id="chat-box-list" class="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50"></div>
                    <div class="border-t border-slate-200 p-3 space-y-2">
                        <div id="chat-box-msg" class="text-xs text-rose-600"></div>
                        <div class="flex gap-2 items-end">
                            <textarea id="chat-box-input" rows="2" class="flex-1 p-2 text-sm border border-slate-300 rounded-xl resize-none focus:outline-none focus:border-[#0866FF]" placeholder="พิมพ์ข้อความ... (Enter = ส่ง · Shift+Enter = ขึ้นบรรทัดใหม่)"></textarea>
                            <button type="button" id="chat-box-send" onclick="sendChatBox()" class="px-4 py-2 text-sm font-semibold rounded-xl bg-[#0866FF] text-white hover:opacity-90">ส่ง</button>
                        </div>
                        <div class="text-[10px] text-slate-400">ส่งข้อความได้ภายใน 24 ชม. หลังลูกค้าทักล่าสุด (กฎ Facebook) · <a href="#" onclick="copyNameOpenInbox(); return false;" class="text-[#0866FF] hover:underline">คัดลอกชื่อ + เปิด Business Suite</a></div>
                    </div>
                </div>
            </div>
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
            resetBuyers();
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
                // เติมข้อมูลเมนู Bee Move ด้วย (ลิงก์ Webhook + ข้อความแจ้งลูกค้า) ทุกครั้งที่เลือก/เปลี่ยนเพจ
                loadBeemove();
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
            document.getElementById('reply-cooldown').value = currentConfig.replyCooldownMin || 0;
            renderBotSwitch();
            if (!Array.isArray(currentConfig.keywordLabels)) currentConfig.keywordLabels = [];
            if (!Array.isArray(currentConfig.keywordRemoveLabels)) currentConfig.keywordRemoveLabels = [];
            renderPgKwLabels();

            document.getElementById('conf-verify-token').value = currentConfig.verifyToken || '';
            document.getElementById('conf-page-token').value = currentConfig.pageAccessToken || '';
            document.getElementById('conf-page-id').value = currentConfig.pageId || '';
            document.getElementById('webhook-url-display').value = window.location.origin + '/webhook';
            
            document.getElementById('enable-slip-verify').checked = !!currentConfig.enableSlipVerify;
            document.getElementById('easyslip-api-key').value = currentConfig.easySlipApiKey || '';
            document.getElementById('zwiz-api-key').value = currentConfig.zwizApiKey || '';
            document.getElementById('slip-provider').value = currentConfig.slipProvider || 'zwiz';
            toggleSlipProvider();
            loadSlipStatus();
            document.getElementById('merchant-bank').value = currentConfig.merchantBank || '';
            document.getElementById('merchant-account').value = currentConfig.merchantAccount || '';
            document.getElementById('merchant-name').value = currentConfig.merchantName || '';
            document.getElementById('msg-slip-success').value = currentConfig.msgSlipSuccess || '';
            document.getElementById('msg-slip-invalid').value = currentConfig.msgSlipInvalid || '';
            document.getElementById('msg-slip-unreadable').value = currentConfig.msgSlipUnreadable || '';
            document.getElementById('slip-unreadable-mode').value = currentConfig.slipUnreadableMode || 'smart';
            document.getElementById('msg-slip-duplicate').value = currentConfig.msgSlipDuplicate || '';
            if (!currentConfig.slipLabels || typeof currentConfig.slipLabels !== 'object') currentConfig.slipLabels = {};
            renderAllLabelChips();
            loadPageLabels();

            const isExact = currentConfig.matchType === 'exact';
            document.getElementById('btn-exact').className = isExact ? "px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white" : "px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600";
            document.getElementById('btn-contains').className = !isExact ? "px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white" : "px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 text-slate-600";

            loadSenderInfo();
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
                    if (data.userAccessToken) localStorage.setItem('fb_user_token', data.userAccessToken);
                    if (showAlert && data.warning) alert('⚠️ ' + data.warning);
                    const dropdown = document.getElementById('page-select-dropdown');
                    dropdown.innerHTML = '<option value="">-- เลือกเพจ --</option>';
                    data.pages.forEach((p, idx) => {
                        dropdown.innerHTML += '<option value="' + idx + '">' + escapeHtml(p.name) + ' (ID: ' + escapeHtml(p.id) + ')</option>';
                    });
                    if(showAlert) alert('✅ ดึงข้อมูลสำเร็จ พบ ' + data.pages.length + ' เพจ' + (data.neverExpires ? ' (Page Token แบบไม่หมดอายุ ✅)' : ''));
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
                try {
                    const ts = await (await fetch('/api/page-token-status?token=' + authToken + '&pageId=' + encodeURIComponent(selected.id))).json();
                    if (ts.success && ts.neverExpires) msg += NL + NL + '🔑 Page Token แบบไม่หมดอายุ ✅';
                    else if (ts.success && ts.expiresAt) msg += NL + NL + '⚠️ Token ยังเป็นแบบอายุสั้น หมดอายุ ' + new Date(ts.expiresAt * 1000).toLocaleString('th-TH') + ' (ให้กดเข้าสู่ระบบด้วย Facebook ใหม่ แล้วเพิ่มเพจอีกครั้ง)';
                    else if (ts.success && !ts.valid) msg += NL + NL + '❌ Token ใช้งานไม่ได้';
                    else msg += NL + NL + '⚠️ ตรวจอายุ Token ไม่ได้: ' + (ts.error || '');
                } catch (e) {}
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
            currentConfig.replyCooldownMin = Math.min(1440, Math.max(0, parseInt(document.getElementById('reply-cooldown').value, 10) || 0));
            currentConfig.enableCommentBot = document.getElementById('enable-comment-bot').checked;
            // currentConfig.keywordLabels / keywordRemoveLabels แก้สดจากปุ่มเพิ่ม/ลบป้ายแล้ว
            
            currentConfig.verifyToken = document.getElementById('conf-verify-token').value.trim();
            currentConfig.pageAccessToken = document.getElementById('conf-page-token').value.trim();
            currentConfig.pageId = document.getElementById('conf-page-id').value.trim();

            currentConfig.enableSlipVerify = document.getElementById('enable-slip-verify').checked;
            currentConfig.easySlipApiKey = document.getElementById('easyslip-api-key').value.trim();
            currentConfig.zwizApiKey = document.getElementById('zwiz-api-key').value.trim();
            currentConfig.slipProvider = document.getElementById('slip-provider').value;
            currentConfig.merchantBank = document.getElementById('merchant-bank').value;
            currentConfig.merchantAccount = document.getElementById('merchant-account').value;
            currentConfig.merchantName = document.getElementById('merchant-name').value;
            currentConfig.msgSlipSuccess = document.getElementById('msg-slip-success').value;
            currentConfig.msgSlipInvalid = document.getElementById('msg-slip-invalid').value;
            currentConfig.msgSlipUnreadable = document.getElementById('msg-slip-unreadable').value;
            currentConfig.slipUnreadableMode = document.getElementById('slip-unreadable-mode').value;
            currentConfig.msgSlipDuplicate = document.getElementById('msg-slip-duplicate').value;
            // currentConfig.slipLabels ถูกแก้ไขสดจากปุ่มเพิ่ม/ลบป้ายกำกับแล้ว

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

        // ===== 💾 สถานะฐานข้อมูล =====
        async function loadDbStatus() {
            if (!authToken) return;
            const el = document.getElementById('db-status');
            try {
                const r = await (await fetch('/api/db/status?token=' + authToken)).json();
                if (!r.success) return;
                if (!r.enabled) { el.innerText = '⚠️ ยังไม่ได้เชื่อมฐานข้อมูล (ข้อมูลหายเมื่อรีสตาร์ท)'; el.className = 'ml-2 text-xs font-medium text-amber-600'; return; }
                if (r.lastError && (!r.lastSave || r.lastErrorAt > r.lastSave)) { el.innerText = '❌ ฐานข้อมูล: ' + r.lastError; el.className = 'ml-2 text-xs font-medium text-rose-600'; return; }
                if (!r.loaded) { el.innerText = '⏳ กำลังโหลดฐานข้อมูล...'; el.className = 'ml-2 text-xs font-medium text-slate-400'; return; }
                el.innerText = '💾 บันทึกอัตโนมัติ' + (r.lastSave ? ' · ล่าสุด ' + new Date(r.lastSave).toLocaleTimeString('th-TH') : '');
                el.className = 'ml-2 text-xs font-medium text-emerald-600';
            } catch (e) {}
        }
        setInterval(loadDbStatus, 30000);
        setTimeout(loadDbStatus, 1500);

        // ===== 🧹 เครื่องมือป้ายชื่อซ้ำ =====
        async function loadDupLabels() {
            if (!currentActivePageId) return alert('กรุณาเลือกเพจก่อน');
            const st = document.getElementById('dup-status');
            st.innerText = '⏳ กำลังค้นหา...';
            try {
                const r = await (await fetch('/api/labels/duplicates?token=' + authToken + '&pageId=' + currentActivePageId)).json();
                if (!r.success) { st.innerText = '❌ ' + r.error; return; }
                const sel = document.getElementById('dup-test-psid');
                const prev = sel.value;
                let opts = '<option value="">-- เลือกบัญชีทดสอบ --</option>';
                (r.people || []).forEach(function(p) { opts += '<option value="' + escapeHtml(p.psid) + '">' + escapeHtml(p.name) + '</option>'; });
                sel.innerHTML = opts;
                if (prev) sel.value = prev;
                st.innerText = r.duplicates.length ? ('พบป้ายชื่อซ้ำ ' + r.duplicates.length + ' ชื่อ') : '✅ ไม่มีป้ายชื่อซ้ำแล้ว';
                let html = '';
                r.duplicates.forEach(function(g) {
                    html += '<div class="bg-white border border-amber-200 rounded-xl p-3"><div class="font-bold text-slate-700 mb-2">🏷️ ' + escapeHtml(g.name) + ' <span class="font-normal text-slate-400">(' + g.ids.length + ' ID)</span></div>';
                    g.ids.forEach(function(id, i) {
                        const b = 'px-2 py-1 rounded-md border text-xs ';
                        html += '<div class="flex flex-wrap items-center gap-2 py-1 border-t border-slate-100">'
                            + '<span class="font-mono text-slate-600 min-w-[11rem]">#' + (i + 1) + ' ID ' + escapeHtml(id) + '</span>'
                            + '<button type="button" class="' + b + 'border-pink-300 text-pink-700 bg-white hover:bg-pink-50" data-id="' + escapeHtml(id) + '" data-act="add" onclick="dupTest(this)">ทดสอบติด</button>'
                            + '<button type="button" class="' + b + 'border-slate-300 text-slate-600 bg-white hover:bg-slate-50" data-id="' + escapeHtml(id) + '" data-act="remove" onclick="dupTest(this)">ถอดออก</button>'
                            + '<button type="button" class="' + b + 'border-rose-300 text-rose-700 bg-white hover:bg-rose-50" data-id="' + escapeHtml(id) + '" data-name="' + escapeHtml(g.name) + '" onclick="dupDelete(this)">🗑️ ลบ ID นี้</button>'
                            + '<span class="dup-res text-slate-500" data-for="' + escapeHtml(id) + '"></span></div>';
                    });
                    html += '</div>';
                });
                document.getElementById('dup-list').innerHTML = html;
            } catch (e) { st.innerText = '❌ ' + e.message; }
        }
        function dupResult(id, text) {
            document.querySelectorAll('.dup-res').forEach(function(el) { if (el.getAttribute('data-for') === id) el.innerText = text; });
        }
        async function dupTest(btn) {
            const id = btn.getAttribute('data-id');
            const remove = btn.getAttribute('data-act') === 'remove';
            const psid = document.getElementById('dup-test-psid').value;
            if (!psid) return alert('กรุณาเลือกบัญชีทดสอบก่อน');
            dupResult(id, '⏳ ...');
            const r = await (await fetch('/api/labels/test?token=' + authToken + '&pageId=' + currentActivePageId, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labelId: id, psid: psid, remove: remove })
            })).json();
            dupResult(id, r.success ? (remove ? '✅ ถอดออกแล้ว' : '✅ ติดแล้ว → รีเฟรชแชทใน Business Suite ดูว่าป้ายขึ้นไหม') : ('❌ ' + r.error));
        }
        async function dupDelete(btn) {
            const id = btn.getAttribute('data-id');
            const name = btn.getAttribute('data-name');
            if (!confirm('ลบป้าย "' + name + '" ID ' + id + ' ถาวร?' + NL + NL + 'ลบเฉพาะตัวที่ทดสอบแล้ว "ไม่ขึ้น" ใน Business Suite เท่านั้น' + NL + 'ลูกค้าที่ติดป้าย ID นี้ไว้จะหลุดป้ายนี้ และกู้คืนไม่ได้')) return;
            dupResult(id, '⏳ กำลังลบ...');
            const r = await (await fetch('/api/labels/delete?token=' + authToken + '&pageId=' + currentActivePageId, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labelId: id })
            })).json();
            if (!r.success) { dupResult(id, '❌ ' + r.error); return; }
            alert('✅ ลบป้าย "' + r.name + '" ID ' + id + ' แล้ว' + NL + 'การตั้งค่าที่เคยเลือก ID นี้ ถูกเปลี่ยนเป็น ID ' + r.kept + ' ให้อัตโนมัติ');
            loadDupLabels();
            loadPageLabels();
        }

        // ===== 🧾 ผู้ให้บริการตรวจสลิป =====
        function toggleSlipProvider() {
            const v = document.getElementById('slip-provider').value;
            document.getElementById('zwiz-key-box').classList.toggle('hidden', v !== 'zwiz');
            document.getElementById('easyslip-key-box').classList.toggle('hidden', v !== 'easyslip');
        }

        async function loadSlipStatus() {
            if (!currentActivePageId) return;
            const el = document.getElementById('slip-provider-status');
            try {
                const r = await (await fetch('/api/slip/status?token=' + authToken + '&pageId=' + currentActivePageId)).json();
                if (!r.success) { el.innerText = ''; return; }
                let t = '';
                if (r.quota && r.quota.remaining !== undefined && r.quota.remaining !== null) t += '📊 โควตาตรวจสลิปคงเหลือ ' + r.quota.remaining + ' ครั้ง';
                if (r.lastError && Date.now() - r.lastError.at < 6 * 3600000) t += (t ? ' · ' : '') + '⚠️ ตรวจสลิปผิดพลาดล่าสุด: ' + r.lastError.code + ' (' + new Date(r.lastError.at).toLocaleTimeString('th-TH') + ')';
                el.innerText = t;
                const RES = { valid: ['✅ ผ่าน', 'text-emerald-700'], invalid: ['❌ บัญชีไม่ตรง', 'text-rose-700'], duplicate: ['🔄 สลิปซ้ำ', 'text-slate-600'], retry: ['⏳ รอธนาคาร', 'text-amber-700'], unreadable: ['⚠️ ตรวจไม่ได้', 'text-amber-700'], system: ['🛠️ ปัญหาระบบ', 'text-rose-700'], noimage: ['📎 ไม่พบรูป', 'text-slate-500'] };
                let rows = '';
                (r.attempts || []).forEach(function(a) {
                    const m = RES[a.result] || [a.result, ''];
                    rows += '<tr class="border-b border-slate-100 align-top"><td class="py-1.5 pr-2 whitespace-nowrap text-slate-500">' + new Date(a.time).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' }) + '</td>'
                        + '<td class="py-1.5 pr-2 text-slate-700 font-medium">' + (a.name ? escapeHtml(a.name) : '<span class="text-slate-400 font-mono text-[10px]">' + escapeHtml(a.senderId || '-') + '</span>') + '</td>'
                        + '<td class="py-1.5 pr-2 whitespace-nowrap font-semibold ' + m[1] + '">' + m[0] + '</td>'
                        + '<td class="py-1.5 pr-2 text-right">' + (a.amount !== undefined && a.amount !== null ? fmtMoney(a.amount) : '-') + '</td>'
                        + '<td class="py-1.5 pr-2 font-mono text-slate-500">' + escapeHtml(a.code || '') + '</td>'
                        + '<td class="py-1.5 text-slate-600">' + escapeHtml(a.note || '') + (a.labelStatus ? '<div class="text-[11px] ' + (a.labelStatus.charAt(0) === '✅' ? 'text-pink-600' : 'text-rose-600') + '">🏷️ ' + escapeHtml(a.labelStatus) + '</div>' : '') + (a.replyStatus ? '<div class="text-[11px] ' + (a.replyStatus.charAt(0) === '💬' ? 'text-blue-600' : 'text-rose-600 font-semibold') + '">' + escapeHtml(a.replyStatus) + '</div>' : '') + '</td></tr>';
                });
                const hb = document.getElementById('slip-history-body');
                if (hb) hb.innerHTML = rows || '<tr><td colspan="6" class="py-3 text-slate-400">ยังไม่มีประวัติ</td></tr>';
            } catch (e) { el.innerText = ''; }
        }

        // ===== 🏷️ ป้ายกำกับตามผลตรวจสลิป (แอดมินเลือกเองจากป้ายที่มีในเพจ) =====
        let pageLabels = [];
        const SLIP_LABEL_KEYS = ['valid', 'invalid', 'unreadable', 'duplicate'];

        function slipRule(key) {
            if (!currentConfig.slipLabels || typeof currentConfig.slipLabels !== 'object') currentConfig.slipLabels = {};
            const r = currentConfig.slipLabels[key] || (currentConfig.slipLabels[key] = { add: [], remove: [] });
            if (!Array.isArray(r.add)) r.add = [];
            if (!Array.isArray(r.remove)) r.remove = [];
            return r;
        }

        function renderAllLabelChips() {
            SLIP_LABEL_KEYS.forEach(function(k) { renderLabelChips(k, 'add'); renderLabelChips(k, 'remove'); });
        }

        // 🏷️ ป้ายชื่อซ้ำ (Facebook มีหลาย ID ชื่อเดียวกันได้): เทียบด้วยชื่อ ไม่สนตัวพิมพ์/ช่องว่าง
        function labelKey(l) { return String((l && l.name) || '').trim().toLowerCase(); }
        function labelFree(used, l) { return !used[l.id] && !used['n:' + labelKey(l)]; }
        // ลบรายการซ้ำชื่อออกจากป้ายที่เลือกไว้ (เก็บอันแรก) และกันชื่อเดียวกันอยู่ทั้งฝั่งติดและฝั่งลบ
        function dedupeLabelLists(lists) {
            const seen = {};
            lists.forEach(function(list) {
                if (!Array.isArray(list)) return;
                for (let i = 0; i < list.length; i++) {
                    const k = labelKey(list[i]);
                    if (k && seen[k]) { list.splice(i, 1); i--; } else if (k) seen[k] = 1;
                }
            });
        }

        function renderLabelChips(key, kind) {
            const box = document.getElementById('lbl-' + kind + '-' + key);
            if (!box) return;
            dedupeLabelLists([slipRule(key).add, slipRule(key).remove]);
            const list = slipRule(key)[kind];
            const isAdd = kind === 'add';
            let html = '';
            list.forEach(function(l, i) {
                const missing = pageLabels.length && !pageLabels.some(function(x) { return x.id === l.id; });
                html += '<span class="inline-flex items-center rounded-full overflow-hidden text-xs font-semibold ' + (isAdd ? 'bg-pink-600 text-white' : 'bg-slate-200 text-slate-700') + '">'
                    + '<span class="px-3 py-1">' + escapeHtml(l.name) + (missing ? ' (ไม่พบในเพจ)' : '') + '</span>'
                    + '<button type="button" class="px-2 py-1 ' + (isAdd ? 'border-l border-pink-400 hover:bg-pink-700' : 'border-l border-slate-300 hover:bg-slate-300') + '" data-key="' + key + '" data-kind="' + kind + '" data-idx="' + i + '" onclick="removeSlipLabel(this)">✕</button></span>';
            });
            const used = {};
            list.forEach(function(l) { used[l.id] = 1; used['n:' + labelKey(l)] = 1; });
            const avail = pageLabels.filter(function(l) { return labelFree(used, l); });
            html += '<select class="text-xs border ' + (isAdd ? 'border-pink-300 text-pink-600' : 'border-slate-300 text-slate-600') + ' rounded-full px-3 py-1 bg-white" data-key="' + key + '" data-kind="' + kind + '" onchange="addSlipLabel(this)">'
                + '<option value="">' + (isAdd ? '+ เพิ่มป้ายกำกับ' : '+ ลบป้ายกำกับ') + '</option>';
            avail.forEach(function(l) { html += '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '</option>'; });
            if (!pageLabels.length) html += '<option value="" disabled>(กดโหลดป้ายกำกับจากเพจก่อน)</option>';
            html += '</select>';
            box.innerHTML = html;
        }

        function addSlipLabel(sel) {
            const key = sel.getAttribute('data-key');
            const kind = sel.getAttribute('data-kind');
            const id = sel.value;
            if (!id) return;
            const l = pageLabels.find(function(x) { return x.id === id; });
            if (l) slipRule(key)[kind].push({ id: l.id, name: l.name });
            renderLabelChips(key, kind);
        }

        function removeSlipLabel(btn) {
            const key = btn.getAttribute('data-key');
            const kind = btn.getAttribute('data-kind');
            slipRule(key)[kind].splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
            renderLabelChips(key, kind);
        }

        async function loadPageLabels() {
            if(!currentActivePageId) return;
            const out = document.getElementById('label-load-status');
            out.innerText = '⏳ กำลังโหลดป้ายกำกับจากเพจ...';
            try {
                const r = await (await fetch('/api/labels?token=' + authToken + '&pageId=' + currentActivePageId)).json();
                if (r.success) {
                    pageLabels = r.labels || [];
                    out.innerText = pageLabels.length
                        ? ('✅ พบป้ายกำกับในเพจ ' + pageLabels.length + ' ป้าย · เลือกแล้วกด "บันทึกการตั้งค่าสลิป"' + (r.lastError ? ' · ⚠️ ติดป้ายล่าสุดไม่สำเร็จ ' + r.lastError : ''))
                        : '⚠️ เพจนี้ยังไม่มีป้ายกำกับ ให้สร้างที่ Meta Business Suite → จัดการป้ายกำกับ แล้วกดโหลดใหม่';
                } else {
                    out.innerText = '❌ โหลดป้ายไม่สำเร็จ: ' + r.error;
                }
            } catch (e) { out.innerText = '❌ ' + e.message; }
            renderAllLabelChips();
            renderPgKwLabels();
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
            if (document.hidden) return; // ⚡ ไม่ดึงข้อมูลตอนสลับไปแท็บอื่น
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
            const changed = sid !== currentLiveId;
            currentLiveId = sid;
            if(changed) { resetBuyers(); loadBuyers(); commenterSel = new Set(); commenterList = []; }
            initChatRange();
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
            document.getElementById('lv-reply-cooldown').value = liveCfg.replyCooldownMin || 0;
            document.getElementById('lv-auction-mode').checked = !!liveCfg.auctionMode;
            document.getElementById('lv-auction-text').value = typeof liveCfg.auctionText === 'string' ? liveCfg.auctionText : '🔨 ยอดประมูล {amount} บาท';
            document.getElementById('lv-auction-nobid').value = liveCfg.auctionNoBidText || 'รอแอดมินแจ้งยอด';
            if (!Array.isArray(liveCfg.keywordLabels)) liveCfg.keywordLabels = [];
            if (!Array.isArray(liveCfg.keywordRemoveLabels)) liveCfg.keywordRemoveLabels = [];
            renderLiveKeywords();
            renderKwLabels();
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
            const kwSt = document.getElementById('lv-kw-status');
            if (kwSt) { kwSt.innerText = d.labelError ? ('⚠️ ติดป้ายล่าสุดไม่สำเร็จ: ' + d.labelError) : ''; kwSt.classList.toggle('hidden', !d.labelError); }
            const warn = document.getElementById('lv-reply-warn');
            if (warn) { warn.innerText = d.replyWarning || ''; warn.classList.toggle('hidden', !d.replyWarning); }
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
            renderLiveFinance(s);
            renderAuctionLots(d);
            const ds = d.dueSummary || {};
            document.getElementById('lv-stat-short').innerText = fmtMoney(ds.short || 0);
            document.getElementById('lv-stat-short-sub').innerText = ds.people
                ? ('ขาด ' + (ds.shortPeople || 0) + ' คน · ยังไม่โอนเลย ' + (ds.unpaidPeople || 0) + ' คน (จาก ' + ds.people + ' คนที่ใส่ยอด)')
                : 'ใส่ "ยอดที่ต้องจ่าย" ในตารางรายชื่อก่อน';

            commenterList = d.commenters || [];
            renderCommenters();

            slipsList = d.slips || [];
            renderSlips();

            const bc = d.broadcastStatus;
            const area = document.getElementById('lv-bc-progress');
            if(bc.isBroadcasting || bc.total > 0) {
                area.classList.remove('hidden');
                let bcText = bc.statusMessage || '';
                const bcErr = bc.errors || {};
                const bcKeys = Object.keys(bcErr);
                if (bcKeys.length) bcText += ' | ส่งไม่สำเร็จเพราะ: ' + bcKeys.map(function(k) { return k + ' (' + bcErr[k] + ')'; }).join(', ');
                document.getElementById('lv-bc-status').innerText = bcText;
                document.getElementById('lv-bc-numbers').innerText = (bc.current || 0) + '/' + (bc.total || 0) + ' (สำเร็จ: ' + (bc.success || 0) + (bc.viaComment ? ' · ผ่านคอมเมนต์ ' + bc.viaComment : '') + ', ล้มเหลว: ' + (bc.failed || 0) + (bc.skipped ? ', ข้าม: ' + bc.skipped : '') + ')';
                document.getElementById('lv-bc-bar').style.width = (bc.total > 0 ? (bc.current / bc.total) * 100 : 0) + '%';
            } else {
                area.classList.add('hidden');
            }
            document.getElementById('lv-btn-bc-start').classList.toggle('hidden', !!bc.isBroadcasting);
            document.getElementById('lv-btn-bc-stop').classList.toggle('hidden', !bc.isBroadcasting);
        }

        // ===== 📄 แบ่งหน้าตาราง (รายการต่อหน้า 10/20/50/100) =====
        const PAGER_SIZES = [10, 20, 50, 100];
        const pagers = {};
        const PAGER_RENDER = {
            buyers: function() { renderBuyers(); },
            chat: function() { renderChatResults(); },
            slips: function() { renderSlips(); },
            cm: function() { renderCommenters(); }
        };
        function pagerState(key) {
            if (!pagers[key]) {
                let size = 10;
                try { const v = parseInt(localStorage.getItem('pager_' + key), 10); if (PAGER_SIZES.indexOf(v) >= 0) size = v; } catch (e) {}
                pagers[key] = { page: 1, size: size };
            }
            return pagers[key];
        }
        // ตัดรายการเฉพาะหน้าปัจจุบัน + วาดแถบเลือกหน้า
        function pageSlice(key, list) {
            const st = pagerState(key);
            const total = list.length;
            const pages = Math.max(1, Math.ceil(total / st.size));
            if (st.page > pages) st.page = pages;
            if (st.page < 1) st.page = 1;
            renderPagerBar(key, total, pages);
            return list.slice((st.page - 1) * st.size, st.page * st.size);
        }
        function renderPagerBar(key, total, pages) {
            const box = document.getElementById('pager-' + key);
            if (!box) return;
            const st = pagerState(key);
            const from = total ? (st.page - 1) * st.size + 1 : 0;
            const to = Math.min(total, st.page * st.size);
            let opts = '';
            PAGER_SIZES.forEach(function(n) { opts += '<option value="' + n + '"' + (n === st.size ? ' selected' : '') + '>' + n + '</option>'; });
            const btn = 'px-2 py-1 rounded-md border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed';
            box.innerHTML = '<span>รายการต่อหน้า</span>'
                + '<select class="px-2 py-1 border border-slate-300 rounded-md bg-white text-xs" data-key="' + key + '" onchange="pagerSetSize(this)">' + opts + '</select>'
                + '<span class="text-slate-400">' + from + '-' + to + ' จาก ' + total + '</span>'
                + (pages > 1
                    ? '<span class="ml-auto flex items-center gap-1">'
                        + '<button type="button" class="' + btn + '" data-key="' + key + '" data-go="first" onclick="pagerGo(this)"' + (st.page <= 1 ? ' disabled' : '') + '>«</button>'
                        + '<button type="button" class="' + btn + '" data-key="' + key + '" data-go="prev" onclick="pagerGo(this)"' + (st.page <= 1 ? ' disabled' : '') + '>‹</button>'
                        + '<span class="px-2">หน้า ' + st.page + ' / ' + pages + '</span>'
                        + '<button type="button" class="' + btn + '" data-key="' + key + '" data-go="next" onclick="pagerGo(this)"' + (st.page >= pages ? ' disabled' : '') + '>›</button>'
                        + '<button type="button" class="' + btn + '" data-key="' + key + '" data-go="last" onclick="pagerGo(this)"' + (st.page >= pages ? ' disabled' : '') + '>»</button>'
                      + '</span>'
                    : '');
        }
        function pagerSetSize(sel) {
            const key = sel.getAttribute('data-key');
            const st = pagerState(key);
            st.size = parseInt(sel.value, 10) || 10;
            st.page = 1;
            try { localStorage.setItem('pager_' + key, String(st.size)); } catch (e) {}
            PAGER_RENDER[key]();
        }
        function pagerGo(btn) {
            const key = btn.getAttribute('data-key');
            const st = pagerState(key);
            const go = btn.getAttribute('data-go');
            if (go === 'first') st.page = 1;
            else if (go === 'prev') st.page = st.page - 1;
            else if (go === 'next') st.page = st.page + 1;
            else if (go === 'last') st.page = 999999;
            PAGER_RENDER[key]();
        }

        // ===== ตารางสลิปที่ตรวจผ่าน =====
        let slipsList = [];
        function renderSlips() {
            let sh = '';
            pageSlice('slips', slipsList).forEach(function(x) {
                sh += '<tr class="border-b border-slate-100"><td class="py-1.5 pr-2 text-slate-500">' + fmtTime(x.time) + '</td>'
                    + '<td class="py-1.5 pr-2 font-medium text-slate-700">' + escapeHtml(x.senderName || x.senderId) + '</td>'
                    + '<td class="py-1.5 pr-2 text-right text-emerald-600 font-semibold">' + fmtMoney(x.amount) + '</td>'
                    + '<td class="py-1.5 text-slate-500">' + (x.manual
                        ? '<span class="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-semibold">✍️ แมนนวล</span>' + (x.note ? ' <span class="text-slate-400">' + escapeHtml(x.note) + '</span>' : '')
                          + ' <button type="button" class="ml-1 text-rose-500 hover:underline" data-ref="' + escapeHtml(x.transRef) + '" onclick="deleteManualPay(this)">🗑️ ลบ</button>'
                        : escapeHtml(x.transRef)) + '</td></tr>';
            });
            document.getElementById('lv-slips').innerHTML = sh || '<tr><td colspan="4" class="py-3 text-slate-400">ยังไม่มีสลิป</td></tr>';
        }

        // ===== ✍️ แก้สถานะโอนเงินแบบแมนนวล =====
        let payEditUid = '';
        function openPayEditor(btn) {
            payEditUid = btn.getAttribute('data-uid');
            const c = commenterList.find(function(x) { return x.userId === payEditUid; }) || {};
            document.getElementById('pay-editor-name').innerText = btn.getAttribute('data-name') || payEditUid;
            document.getElementById('pay-editor-current').innerText = c.paid ? ('ตอนนี้: โอนแล้ว ' + fmtMoney(c.paidTotal) + ' ฿ (บันทึกเพิ่ม = รวมยอดเพิ่ม)') : 'ตอนนี้: ยังไม่โอน';
            document.getElementById('pay-editor-amount').value = '';
            document.getElementById('pay-editor-note').value = '';
            document.getElementById('pay-editor-msg').innerText = '';
            document.getElementById('pay-editor').classList.remove('hidden');
            setTimeout(function() { document.getElementById('pay-editor-amount').focus(); }, 50);
        }
        function closePayEditor() {
            document.getElementById('pay-editor').classList.add('hidden');
            payEditUid = '';
        }
        async function savePayEditor() {
            if (!payEditUid || !currentLiveId) return;
            const amount = document.getElementById('pay-editor-amount').value;
            const msg = document.getElementById('pay-editor-msg');
            if (!(parseFloat(amount) > 0)) { msg.innerText = 'กรุณากรอกยอดเงิน'; return; }
            const btn = document.getElementById('pay-editor-save');
            btn.disabled = true;
            try {
                const r = await (await fetch(liveUrl('/api/live/manual-payment', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: payEditUid, amount: amount, note: document.getElementById('pay-editor-note').value })
                })).json();
                if (!r.success) { msg.innerText = '❌ ' + r.error; return; }
                closePayEditor();
                loadLiveDetail(false);
            } catch (e) { msg.innerText = '❌ ' + e.message; }
            finally { btn.disabled = false; }
        }
        async function deleteManualPay(btn) {
            if (!currentLiveId) return;
            if (!confirm('ลบรายการโอนแบบแมนนวลนี้?')) return;
            const r = await (await fetch(liveUrl('/api/live/manual-payment/delete', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transRef: btn.getAttribute('data-ref') })
            })).json();
            if (!r.success) return alert('❌ ' + r.error);
            loadLiveDetail(false);
        }
        document.addEventListener('keydown', function(e) {
            if (!payEditUid) return;
            if (e.key === 'Escape') closePayEditor();
            if (e.key === 'Enter' && e.target && e.target.id && e.target.id.indexOf('pay-editor') === 0) savePayEditor();
        });

        // ===== ตารางคนคอมเมนต์: ติ๊กเลือก + สถานะโอน + ดึงข้อมูลรายคน =====
        let commenterList = [];
        let commenterSel = new Set();

        function filteredCommenters() {
            const fEl = document.getElementById('lv-cm-filter');
            if (fEl && fEl.getAttribute('data-last') !== fEl.value) { fEl.setAttribute('data-last', fEl.value); pagerState('cm').page = 1; }
            const f = document.getElementById('lv-cm-filter').value;
            return commenterList.filter(function(c) {
                if(f === 'all') return true;
                if(!(c.matchedCount > 0)) return false;
                if(f === 'paid') return c.paid;
                if(f === 'paidNotBuyer') return c.paid && !c.inBuyers;
                const due = Number(c.dueAmount) || 0, got = Math.round((Number(c.paidTotal) || 0) * 100) / 100;
                if(f === 'short') return due > 0 && got < due;
                if(f === 'over') return due > 0 && got > due;
                if(f === 'full') return due > 0 && got === due;
                if(f === 'noDue') return !(due > 0);
                if(f === 'unpaid') return !c.paid;
                return true;
            });
        }

        function renderCommenters() {
            const list = filteredCommenters();
            let ch = '';
            pageSlice('cm', list).forEach(function(c) {
                const payBtn = ' data-uid="' + escapeHtml(c.userId) + '" data-name="' + escapeHtml(c.name || c.userId) + '" onclick="openPayEditor(this)" title="คลิกเพื่อบันทึกการโอนแบบแมนนวล"';
                const pay = c.matchedCount > 0
                    ? (c.paid
                        ? '<button type="button" class="inline-block px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold whitespace-nowrap hover:ring-2 hover:ring-emerald-300"' + payBtn + '>✅ โอนแล้ว ' + fmtMoney(c.paidTotal) + ' ฿</button>' + (c.slipCount > 1 ? '<div class="text-[10px] text-slate-400">' + c.slipCount + ' รายการ</div>' : '')
                        : '<button type="button" class="inline-block px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold whitespace-nowrap hover:ring-2 hover:ring-amber-300"' + payBtn + '>⏳ ยังไม่โอน ✎</button>')
                    : '<span class="text-slate-300">-</span>';
                const due = Number(c.dueAmount) || 0, got = Math.round((Number(c.paidTotal) || 0) * 100) / 100;
                const dueCell = '<button type="button" data-uid="' + escapeHtml(c.userId) + '" data-name="' + escapeHtml(c.name || c.userId) + '" onclick="editDueAmount(this)" title="คลิกเพื่อใส่/แก้ยอดที่ลูกค้าต้องจ่าย" class="px-2 py-0.5 rounded-md border whitespace-nowrap '
                    + (due > 0 ? 'border-slate-300 bg-white text-slate-800 font-semibold hover:bg-slate-50">' + fmtMoney(due) + ' ฿ ✎' + (c.dueExpr ? '<div class="text-[10px] font-normal text-slate-400">' + escapeHtml(c.dueExpr) + '</div>' : '') + (c.auctionWins ? '<div class="text-[10px] font-normal text-amber-700">🔨 ชนะประมูล ' + c.auctionWins + ' รายการ</div>' : '') : 'border-dashed border-slate-300 text-slate-400 hover:bg-slate-50">+ ใส่ยอด') + '</button>';
                let cmp = '';
                if(due > 0) {
                    if(got === due) cmp = '<div class="mt-0.5 text-[11px] font-semibold text-emerald-700">✔ โอนครบ</div>';
                    else if(got < due) cmp = '<div class="mt-0.5 text-[11px] font-semibold text-rose-600">✖ ขาด ' + fmtMoney(due - got) + ' ฿</div>';
                    else cmp = '<div class="mt-0.5 text-[11px] font-semibold text-blue-600">▲ เกิน ' + fmtMoney(got - due) + ' ฿</div>';
                }
                const dueWarn = c.auctionWarn ? '<div class="mt-0.5 text-[10px] text-rose-600 whitespace-normal max-w-[11rem]">⚠️ ' + escapeHtml(c.auctionWarn) + '</div>' : '';
                ch += '<tr data-cid="' + escapeHtml(c.userId) + '" class="border-b border-slate-100">'
                    + '<td class="py-1.5 pr-2"><input type="checkbox" class="cm-sel w-4 h-4 rounded"' + (commenterSel.has(c.userId) ? ' checked' : '') + '></td>'
                    + '<td class="py-1.5 pr-2 font-medium text-slate-700">' + escapeHtml(c.name || c.userId) + (c.inBuyers ? '<div class="text-[10px] text-indigo-500 font-normal">อยู่ในรายชื่อลูกค้าแล้ว</div>' : '')
                        + (c.kwLabelStatus ? '<div class="text-[10px] font-normal ' + (c.kwLabelStatus.charAt(0) === '❌' ? 'text-rose-600' : (c.kwLabelStatus.charAt(0) === '⏳' ? 'text-amber-600' : 'text-pink-600')) + '">🏷️ ' + escapeHtml(c.kwLabelStatus) + '</div>' : '') + '</td>'
                    + '<td class="py-1.5 pr-2">' + c.count + '</td>'
                    + '<td class="py-1.5 pr-2">' + (c.matchedCount > 0 ? '<span class="text-blue-600 font-semibold">' + c.matchedCount + ' (' + escapeHtml(c.lastKeyword) + ')</span>' : '-') + '</td>'
                    + '<td class="py-1.5 pr-2">' + dueCell + dueWarn + '</td>'
                    + '<td class="py-1.5 pr-2">' + pay + cmp + '</td>'
                    + '<td class="py-1.5 pr-2 text-slate-600">' + escapeHtml(c.lastMessage) + '</td>'
                    + '<td class="py-1.5 pr-2 text-center">' + messengerLinkHtml(c) + '</td>'
                    + '<td class="py-1.5 text-slate-500">' + fmtTime(c.lastTime) + '</td></tr>';
            });
            document.getElementById('lv-commenters').innerHTML = ch || '<tr><td colspan="9" class="py-3 text-slate-400">ยังไม่มีคอมเมนต์</td></tr>';
            const matched = commenterList.filter(function(c) { return c.matchedCount > 0; });
            const paid = matched.filter(function(c) { return c.paid; }).length;
            const withDue = commenterList.filter(function(c) { return Number(c.dueAmount) > 0; });
            let dueSum = 0, gotSum = 0, nFull = 0, nShort = 0, nOver = 0;
            withDue.forEach(function(c) { const d = Number(c.dueAmount) || 0, g = Math.round((Number(c.paidTotal) || 0) * 100) / 100; dueSum += d; gotSum += g; if(g === d) nFull++; else if(g < d) nShort++; else nOver++; });
            document.getElementById('lv-cm-summary').innerText = 'ตรงคำดัก ' + matched.length + ' คน · โอนแล้ว ' + paid + ' · ยังไม่โอน ' + (matched.length - paid) + ' · เลือกไว้ ' + commenterSel.size
                + (withDue.length ? ' | 💰 ใส่ยอดแล้ว ' + withDue.length + ' คน: ครบ ' + nFull + ' · ขาด ' + nShort + ' · เกิน ' + nOver + ' (ยอดรวม ' + fmtMoney(dueSum) + ' / ได้รับ ' + fmtMoney(gotSum) + ' ฿)' : '');
            document.getElementById('lv-cm-all').checked = list.length > 0 && list.every(function(c) { return commenterSel.has(c.userId); });
        }

        // 💰 ยอดที่ลูกค้าต้องจ่าย (แอดมินใส่เอง) เทียบกับยอดสลิปรวมทุกใบ
        // 🔨 ตารางผลประมูลแต่ละรอบ (รอบปิดเมื่อเพจคอมเมนต์หัวใจ)
        function renderAuctionLots(d) {
            const box = document.getElementById('lv-auction-box');
            const on = !!(d.config && d.config.auctionMode);
            box.classList.toggle('hidden', !on);
            if(!on) return;
            let html = '';
            (d.auctionLots || []).forEach(function(l) {
                const w = l.winners || [];
                const ok = w.length === 1 && w[0].amount === l.topAmount;
                html += '<tr class="border-b border-amber-100 align-top"><td class="py-1.5 pr-2 text-slate-500 whitespace-nowrap">' + fmtTime(l.closeAt) + '</td>'
                    + '<td class="py-1.5 pr-2 text-right font-bold text-slate-800">' + fmtMoney(l.topAmount) + '</td>'
                    + '<td class="py-1.5 pr-2">' + escapeHtml(l.topNames.join(', ')) + (l.topNames.length > 1 ? ' <span class="text-[10px] text-amber-700">(ราคาเท่ากัน)</span>' : '') + '</td>'
                    + '<td class="py-1.5 pr-2 ' + (w.length ? (ok ? 'text-emerald-700 font-semibold' : 'text-rose-600 font-semibold') : 'text-slate-400') + '">'
                        + (w.length ? w.map(function(x) { return escapeHtml(x.name) + ' (' + fmtMoney(x.amount) + ')'; }).join(', ') + (ok ? ' ✓' : ' ⚠️') : 'ยังไม่มีคนกด 1') + '</td>'
                    + '<td class="py-1.5 text-slate-400">' + l.bids + '</td></tr>';
            });
            document.getElementById('lv-auction-lots').innerHTML = html || '<tr><td colspan="5" class="py-2 text-slate-400">ยังไม่มีรอบที่ปิด · เพจคอมเมนต์ ❤️ ในไลฟ์เพื่อปิดรอบประมูล</td></tr>';
        }

        // 📊 กำไร/ขาดทุน ของ session = ยอดโอนรวม - ต้นทุน - ค่าแอด - ค่าส่ง
        let lastLiveSummary = null;
        function renderLiveFinance(s) {
            lastLiveSummary = s;
            const f = s.finance || {};
            ['cost', 'ads', 'shipping'].forEach(function(k) {
                const el = document.getElementById('lv-fin-' + k);
                if (el && document.activeElement !== el) el.value = Number(f[k]) > 0 ? String(f[k]) : '';
            });
            const income = Number(s.stats.slipTotal) || 0;
            const spend = (Number(f.cost) || 0) + (Number(f.ads) || 0) + (Number(f.shipping) || 0);
            const profit = Math.round((income - spend) * 100) / 100;
            const loss = profit < 0;
            document.getElementById('lv-fin-profit-box').className = (loss ? 'bg-rose-50 border border-rose-200' : 'bg-emerald-50 border border-emerald-200') + ' rounded-xl p-3';
            document.getElementById('lv-fin-profit-label').className = 'text-xs ' + (loss ? 'text-rose-600' : 'text-emerald-700');
            document.getElementById('lv-fin-profit-label').innerText = loss ? '📉 ขาดทุน (บาท)' : '💹 กำไร (บาท)';
            const pv = document.getElementById('lv-fin-profit');
            pv.className = 'text-xl font-bold ' + (loss ? 'text-rose-600' : 'text-emerald-700');
            pv.innerText = (loss ? '-' : '') + fmtMoney(Math.abs(profit));
            document.getElementById('lv-fin-profit-sub').innerText = 'ยอดโอน ' + fmtMoney(income) + ' - ค่าใช้จ่าย ' + fmtMoney(spend);
        }
        async function saveLiveFinance(el) {
            if(!currentLiveId) return;
            try {
                const r = await (await fetch(liveUrl('/api/live/finance', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field: el.getAttribute('data-field'), amount: el.value })
                })).json();
                if(!r.success) return alert('❌ ' + r.error);
                if(lastLiveSummary) { lastLiveSummary.finance = r.finance; renderLiveFinance(lastLiveSummary); }
            } catch(e) { alert('❌ ' + e.message); }
        }

        let dueEditUid = '';
        function editDueAmount(btn) {
            if(!currentLiveId) return;
            dueEditUid = btn.getAttribute('data-uid');
            const c = commenterList.find(function(x) { return x.userId === dueEditUid; }) || {};
            document.getElementById('due-editor-name').innerText = btn.getAttribute('data-name') || dueEditUid;
            document.getElementById('due-editor-paid').innerText = fmtMoney(Number(c.paidTotal) || 0) + ' ฿ (' + (c.slipCount || 0) + ' สลิป)';
            document.getElementById('due-editor-amount').value = Number(c.dueAmount) > 0 ? String(c.dueExpr || c.dueAmount) : '';
            document.getElementById('due-editor-del').classList.toggle('hidden', !(Number(c.dueAmount) > 0));
            document.getElementById('due-editor-msg').innerText = '';
            previewDue();
            document.getElementById('due-editor').classList.remove('hidden');
            setTimeout(function() { const i = document.getElementById('due-editor-amount'); i.focus(); i.select(); }, 50);
        }
        function closeDueEditor() {
            document.getElementById('due-editor').classList.add('hidden');
            dueEditUid = '';
        }
        // แปลงข้อความยอด เช่น "2+3+5", "250 + 300 - 50", "๑,๒๐๐" -> ผลรวม (ไม่ถูกต้อง = NaN)
        function parseDueExpr(str) {
            const t = String(str || '').replace(/[๐-๙]/g, function(d) { return String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)); }).replace(/[, ฿]|บาท/g, '');
            if(!t) return 0;
            if(!/^[+-]?[0-9]+([.][0-9]+)?([+-][0-9]+([.][0-9]+)?)*$/.test(t)) return NaN;
            let sum = 0;
            (t.match(/[+-]?[0-9]+([.][0-9]+)?/g) || []).forEach(function(x) { sum += parseFloat(x); });
            return Math.round(sum * 100) / 100;
        }
        function previewDue() {
            const el = document.getElementById('due-editor-preview');
            const sumEl = document.getElementById('due-editor-sum');
            const c = commenterList.find(function(x) { return x.userId === dueEditUid; }) || {};
            const raw = document.getElementById('due-editor-amount').value;
            const due = parseDueExpr(raw);
            const got = Math.round((Number(c.paidTotal) || 0) * 100) / 100;
            const norm = String(raw || '').replace(/[๐-๙]/g, function(d) { return String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)); });
            const isExpr = /[0-9,] *[+-] *[0-9]/.test(norm);
            if(isNaN(due)) { sumEl.classList.remove('hidden'); sumEl.innerHTML = '<span class="text-rose-600">⚠️ ใส่ได้เฉพาะตัวเลข และเครื่องหมาย + หรือ -</span>'; el.classList.add('hidden'); return; }
            if(isExpr) { sumEl.classList.remove('hidden'); sumEl.innerHTML = '🧮 ' + escapeHtml(raw.replace(/ +/g, '').split('+').join(' + ').split('-').join(' - ')) + ' = <b class="text-lg text-indigo-700">' + fmtMoney(due) + ' ฿</b>'; }
            else sumEl.classList.add('hidden');
            if(!(due > 0)) { el.classList.add('hidden'); return; }
            el.classList.remove('hidden', 'bg-emerald-50', 'text-emerald-700', 'bg-rose-50', 'text-rose-600', 'bg-blue-50', 'text-blue-600');
            if(got === due) { el.classList.add('bg-emerald-50', 'text-emerald-700'); el.innerText = '✔ โอนครบแล้ว'; }
            else if(got < due) { el.classList.add('bg-rose-50', 'text-rose-600'); el.innerText = '✖ ยังขาดอีก ' + fmtMoney(due - got) + ' ฿'; }
            else { el.classList.add('bg-blue-50', 'text-blue-600'); el.innerText = '▲ โอนเกิน ' + fmtMoney(got - due) + ' ฿'; }
        }
        async function saveDueEditor(remove) {
            if(!dueEditUid || !currentLiveId) return;
            const expr = remove ? '' : document.getElementById('due-editor-amount').value.trim();
            const total = parseDueExpr(expr);
            const msg = document.getElementById('due-editor-msg');
            if(!remove && isNaN(total)) { msg.innerText = 'ใส่ได้เฉพาะตัวเลข และเครื่องหมาย + หรือ -'; return; }
            if(!remove && !(total > 0)) { msg.innerText = 'กรุณากรอกยอดเงิน'; return; }
            const v = remove ? '' : String(total);
            const btn = document.getElementById('due-editor-save');
            btn.disabled = true;
            try {
                const r = await (await fetch(liveUrl('/api/live/due-amount', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: dueEditUid, amount: v, expr: /[0-9๐-๙,] *[+-] *[0-9๐-๙]/.test(expr) ? expr : '' })
                })).json();
                if(!r.success) { msg.innerText = '❌ ' + r.error; return; }
                const c = commenterList.find(function(x) { return x.userId === dueEditUid; });
                if(c) { c.dueAmount = r.dueAmount; c.dueExpr = r.dueExpr || ''; }
                closeDueEditor();
                renderCommenters();
                loadLiveDetail(false); // อัปเดตการ์ด "ยอดที่ยังขาด" ด้านบน
            } catch(e) { msg.innerText = '❌ ' + e.message; }
            finally { btn.disabled = false; }
        }
        document.addEventListener('keydown', function(e) {
            if(!dueEditUid) return;
            if(e.key === 'Escape') closeDueEditor();
            if(e.key === 'Enter' && e.target && e.target.id === 'due-editor-amount') saveDueEditor(false);
        });

        // 💬 หน้าต่างแชทในแดชบอร์ด (อ่าน + ตอบลูกค้าผ่าน Facebook API)
        let chatBoxUid = '', chatBoxPsid = '', chatBoxName = '', chatBoxPoll = null, chatBoxLastKey = '';
        function openChatBox(btn) {
            chatBoxUid = btn.getAttribute('data-uid') || '';
            chatBoxPsid = btn.getAttribute('data-psid') || '';
            chatBoxName = btn.getAttribute('data-name') || '';
            chatBoxLastKey = '';
            document.getElementById('chat-box-name').innerText = chatBoxName;
            document.getElementById('chat-box-avatar').innerText = (chatBoxName || '?').charAt(0);
            document.getElementById('chat-box-sub').innerText = 'กำลังโหลด...';
            document.getElementById('chat-box-list').innerHTML = '<div class="text-center text-xs text-slate-400 py-8">กำลังโหลดข้อความ...</div>';
            document.getElementById('chat-box-msg').innerText = '';
            document.getElementById('chat-box-input').value = '';
            document.getElementById('chat-box').classList.remove('hidden');
            loadChatBox(true);
            if(chatBoxPoll) clearInterval(chatBoxPoll);
            chatBoxPoll = setInterval(function() { if(!document.hidden) loadChatBox(false); }, 5000);
            setTimeout(function() { document.getElementById('chat-box-input').focus(); }, 50);
        }
        function closeChatBox() {
            document.getElementById('chat-box').classList.add('hidden');
            if(chatBoxPoll) clearInterval(chatBoxPoll);
            chatBoxPoll = null; chatBoxUid = '';
        }
        function chatQuery() {
            return '?token=' + encodeURIComponent(authToken) + '&pageId=' + encodeURIComponent(currentActivePageId) + '&sid=' + encodeURIComponent(currentLiveId || '')
                + '&uid=' + encodeURIComponent(chatBoxUid) + '&psid=' + encodeURIComponent(chatBoxPsid);
        }
        function chatTime(t) {
            const d = new Date(t);
            const today = new Date().toDateString() === d.toDateString();
            return today ? d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
        }
        async function loadChatBox(force) {
            if(!chatBoxUid) return;
            const uid = chatBoxUid;
            try {
                const r = await (await fetch('/api/chat/messages' + chatQuery())).json();
                if(uid !== chatBoxUid) return;
                const sub = document.getElementById('chat-box-sub');
                const list = document.getElementById('chat-box-list');
                if(!r.success) { sub.innerText = ''; list.innerHTML = '<div class="text-center text-xs text-rose-500 py-8">❌ ' + escapeHtml(r.error || 'โหลดไม่สำเร็จ') + '</div>'; return; }
                if(r.psid) chatBoxPsid = r.psid;
                sub.innerText = r.psid ? (r.canReply ? '🟢 ตอบได้ (ลูกค้าทักล่าสุด ' + (r.lastInbound ? chatTime(r.lastInbound) : '-') + ')' : '⚪ เกิน 24 ชม. หลังลูกค้าทักล่าสุด (ส่งไม่ได้จนกว่าลูกค้าจะทักมาใหม่)')
                    : (r.canPrivateReply ? '💬 ยังไม่มีแชท · ส่งข้อความแรกจากคอมเมนต์ได้ 1 ครั้ง' : 'ลูกค้ายังไม่มีแชทกับเพจ');
                const key = (r.messages || []).map(function(m) { return m.id; }).join(',');
                if(!force && key === chatBoxLastKey) return;
                chatBoxLastKey = key;
                let html = '';
                (r.messages || []).forEach(function(m) {
                    const mine = m.fromPage;
                    let body = m.text ? escapeHtml(m.text).split(NL).join('<br>') : '';
                    (m.images || []).forEach(function(u) { body += '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(u) + '" class="mt-1 max-w-[220px] max-h-[260px] rounded-lg border border-slate-200"></a>'; });
                    (m.files || []).forEach(function(f) { body += '<div class="mt-1"><a href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener" class="underline">📎 ' + escapeHtml(f.name || 'ไฟล์แนบ') + '</a></div>'; });
                    if(!body) body = '<span class="italic opacity-60">(สติกเกอร์ / ไฟล์แนบ)</span>';
                    html += '<div class="flex ' + (mine ? 'justify-end' : 'justify-start') + '"><div class="max-w-[80%]">'
                        + '<div class="px-3 py-2 rounded-2xl text-sm whitespace-normal break-words ' + (mine ? 'bg-[#0866FF] text-white rounded-br-md' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md') + '">' + body + '</div>'
                        + '<div class="text-[10px] text-slate-400 mt-0.5 ' + (mine ? 'text-right' : '') + '">' + chatTime(m.time) + '</div></div></div>';
                });
                list.innerHTML = html || '<div class="text-center text-xs text-slate-400 py-8">' + (r.psid ? 'ยังไม่มีข้อความ' : 'ลูกค้ายังไม่เคยแชทกับเพจ') + '</div>';
                list.scrollTop = list.scrollHeight;
            } catch(e) { document.getElementById('chat-box-sub').innerText = '❌ ' + e.message; }
        }
        async function sendChatBox() {
            const input = document.getElementById('chat-box-input');
            const text = input.value.trim();
            const msg = document.getElementById('chat-box-msg');
            if(!text || !chatBoxUid) return;
            const btn = document.getElementById('chat-box-send');
            btn.disabled = true; msg.innerText = '';
            try {
                const r = await (await fetch('/api/chat/send' + chatQuery(), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text })
                })).json();
                if(!r.success) { msg.innerText = '❌ ' + r.error; return; }
                if(r.psid) chatBoxPsid = r.psid;
                input.value = '';
                setTimeout(function() { loadChatBox(true); }, 800);
            } catch(e) { msg.innerText = '❌ ' + e.message; }
            finally { btn.disabled = false; input.focus(); }
        }
        document.addEventListener('keydown', function(e) {
            if(!chatBoxUid) return;
            if(e.key === 'Escape') closeChatBox();
            if(e.key === 'Enter' && !e.shiftKey && e.target && e.target.id === 'chat-box-input') { e.preventDefault(); sendChatBox(); }
        });
        function copyNameOpenInbox() {
            const pid = (currentConfig && currentConfig.pageId) || currentActivePageId;
            try { navigator.clipboard.writeText(chatBoxName); } catch(e) {}
            window.open('https://business.facebook.com/latest/inbox/all?asset_id=' + encodeURIComponent(pid) + '&mailbox_id=' + encodeURIComponent(pid), '_blank');
        }

        function messengerLinkHtml(c) {
            if(!currentActivePageId || !c.userId) return '';
            const svg = '<svg viewBox="0 0 24 24" class="w-5 h-5"><circle cx="12" cy="12" r="12" fill="#0866FF"/><path fill="#fff" d="M5.9 14.6l3.1-4.9c.5-.8 1.5-1 2.3-.4l2.4 1.8c.2.2.5.2.8 0l3.3-2.5c.4-.3 1 .2.7.6l-3.1 4.9c-.5.8-1.5 1-2.3.4l-2.4-1.8c-.2-.2-.5-.2-.8 0l-3.3 2.5c-.4.3-1-.2-.7-.6z"/></svg>';
            return '<button type="button" data-uid="' + escapeHtml(c.userId) + '" data-psid="' + escapeHtml(c.chatId || '') + '" data-name="' + escapeHtml(c.name || c.userId) + '" onclick="openChatBox(this)" title="แชทกับ ' + escapeHtml(c.name || '') + (c.chatId ? '' : ' (ยังไม่มีแชท ส่งข้อความแรกจากคอมเมนต์ได้)') + '" class="inline-flex items-center justify-center hover:scale-110 transition' + (c.chatId ? '' : ' opacity-50') + '">' + svg + '</button>';
        }

        function toggleAllCommenters(on) {
            filteredCommenters().forEach(function(c) { if(on) commenterSel.add(c.userId); else commenterSel.delete(c.userId); });
            renderCommenters();
        }

        document.addEventListener('change', function(e) {
            if(!e.target.classList.contains('cm-sel')) return;
            const tr = e.target.closest('tr[data-cid]');
            const id = tr.getAttribute('data-cid');
            if(e.target.checked) commenterSel.add(id); else commenterSel.delete(id);
            renderCommenters();
        });

        async function deleteSelectedCommenters() {
            if(!currentLiveId) return;
            const ids = Array.from(commenterSel).filter(function(id) { return commenterList.some(function(c) { return c.userId === id; }); });
            if(!ids.length) return alert('กรุณาติ๊กเลือกรายชื่อที่จะลบก่อน');
            if(!confirm('ลบ ' + ids.length + ' รายชื่อออกจากตารางนี้?' + NL + '(สลิปที่โอนแล้วยังเก็บไว้ · ถ้าคนนี้คอมเมนต์ใหม่จะกลับมาในรายชื่ออีกครั้ง)')) return;
            try {
                const r = await (await fetch(liveUrl('/api/live/commenters/delete', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds: ids })
                })).json();
                if(!r.success) return alert('❌ ' + r.error);
                ids.forEach(function(id) { commenterSel.delete(id); });
                await loadLiveDetail(false);
            } catch(e) { alert('❌ ' + e.message); }
        }

        async function pullSelectedCommenters() {
            if(!currentLiveId) return;
            const ids = Array.from(commenterSel).filter(function(id) { return commenterList.some(function(c) { return c.userId === id; }); });
            if(!ids.length) return alert('กรุณาติ๊กเลือกคนที่ต้องการดึงข้อมูลก่อน');
            const res = await fetch(liveUrl('/api/live/buyers/fetch', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds: ids })
            });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            commenterSel = new Set();
            renderCommenters();
            if(buyersPoll) clearInterval(buyersPoll);
            buyersPoll = setInterval(function() { loadBuyers(true); }, 2000);
            await loadBuyers();
            document.getElementById('lv-buyers').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
                enableInbox: document.getElementById('lv-enable-inbox').checked,
                keywordLabels: liveCfg.keywordLabels || [],
                keywordRemoveLabels: liveCfg.keywordRemoveLabels || [],
                replyCooldownMin: parseInt(document.getElementById('lv-reply-cooldown').value, 10) || 0,
                auctionMode: document.getElementById('lv-auction-mode').checked,
                auctionText: document.getElementById('lv-auction-text').value,
                auctionNoBidText: document.getElementById('lv-auction-nobid').value
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
            resetBuyers();
            document.getElementById('live-detail').classList.add('hidden');
            loadLiveList();
        }

        // ===== 🏷️ กรองผู้รับบรอดแคสต์ตามป้ายกำกับ =====
        let lvBcLabels = { include: [], exclude: [] };

        function renderLiveBcLabels() {
            dedupeLabelLists([lvBcLabels.include, lvBcLabels.exclude]);
            ['include', 'exclude'].forEach(function(kind) {
                const box = document.getElementById('lv-bc-lbl-' + kind);
                if (!box) return;
                const list = lvBcLabels[kind];
                const inc = kind === 'include';
                let html = '';
                list.forEach(function(l, i) {
                    html += '<span class="inline-flex items-center rounded-full overflow-hidden text-xs font-semibold ' + (inc ? 'bg-pink-600 text-white' : 'bg-slate-600 text-white') + '">'
                        + '<span class="px-3 py-1">' + (inc ? '' : '🚫 ') + escapeHtml(l.name) + '</span>'
                        + '<button type="button" class="px-2 py-1 border-l border-white/30 hover:bg-black/20" data-kind="' + kind + '" data-idx="' + i + '" onclick="removeLiveBcLabel(this)">✕</button></span>';
                });
                const used = {};
                lvBcLabels.include.concat(lvBcLabels.exclude).forEach(function(l) { used[l.id] = 1; used['n:' + labelKey(l)] = 1; });
                html += '<select class="text-xs border ' + (inc ? 'border-pink-300 text-pink-600' : 'border-slate-300 text-slate-600') + ' rounded-full px-3 py-1 bg-white" data-kind="' + kind + '" onchange="addLiveBcLabel(this)">'
                    + '<option value="">' + (inc ? '+ เลือกป้ายที่จะส่ง' : '+ เลือกป้ายที่จะยกเว้น') + '</option>';
                pageLabels.filter(function(l) { return labelFree(used, l); }).forEach(function(l) {
                    html += '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '</option>';
                });
                if (!pageLabels.length) html += '<option value="" disabled>(กดโหลดป้ายกำกับจากเพจก่อน)</option>';
                html += '</select>';
                box.innerHTML = html;
            });
        }

        // ===== 🤖 สวิตช์หลัก เปิด/ปิด บอตตอบกลับคอมเมนต์ =====
        function renderBotSwitch() {
            const on = currentConfig.enableCommentBot !== false;
            document.getElementById('enable-comment-bot').checked = on;
            document.getElementById('bot-switch-label').innerText = on ? 'เปิดใช้งาน' : 'ปิดอยู่';
            document.getElementById('bot-switch-label').className = 'ml-3 text-sm font-semibold ' + (on ? 'text-emerald-600' : 'text-rose-600');
            document.getElementById('bot-switch-card').className = 'rounded-2xl shadow-sm border p-5 flex flex-wrap items-center justify-between gap-3 ' + (on ? 'bg-white border-slate-200' : 'bg-rose-50 border-rose-200');
        }
        async function toggleCommentBot(cb) {
            if (!currentActivePageId) { cb.checked = !cb.checked; return alert('กรุณาเลือกเพจก่อน'); }
            const on = cb.checked;
            try {
                const r = await (await fetch('/api/config?token=' + authToken + '&pageId=' + currentActivePageId, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enableCommentBot: on })
                })).json();
                if (!r.success) throw new Error(r.error || 'บันทึกไม่สำเร็จ');
                currentConfig.enableCommentBot = on;
            } catch (e) {
                cb.checked = !on;
                alert('❌ ' + e.message);
            }
            renderBotSwitch();
        }

        // ===== 🏷️ ป้ายคำดัก ระดับเพจ (เมนูตอบกลับคอมเมนต์) =====
        function renderPgKwLabels() {
            dedupeLabelLists([currentConfig.keywordLabels, currentConfig.keywordRemoveLabels]);
            [['pg-kw-labels', 'keywordLabels', true], ['pg-kw-remove-labels', 'keywordRemoveLabels', false]].forEach(function(row) {
                const box = document.getElementById(row[0]);
                if (!box) return;
                const field = row[1];
                const isAdd = row[2];
                const list = Array.isArray(currentConfig[field]) ? currentConfig[field] : (currentConfig[field] = []);
                let html = '';
                list.forEach(function(l, i) {
                    html += '<span class="inline-flex items-center rounded-full overflow-hidden text-xs font-semibold ' + (isAdd ? 'bg-pink-600 text-white' : 'bg-slate-600 text-white') + '">'
                        + '<span class="px-3 py-1">' + (isAdd ? '' : '🗑️ ') + escapeHtml(l.name) + '</span>'
                        + '<button type="button" class="px-2 py-1 border-l border-white/30 hover:bg-black/20" data-field="' + field + '" data-idx="' + i + '" onclick="removePgKwLabel(this)">✕</button></span>';
                });
                const used = {};
                (currentConfig.keywordLabels || []).concat(currentConfig.keywordRemoveLabels || []).forEach(function(l) { used[l.id] = 1; used['n:' + labelKey(l)] = 1; });
                html += '<select class="text-xs border ' + (isAdd ? 'border-pink-300 text-pink-600' : 'border-slate-300 text-slate-600') + ' rounded-full px-3 py-1 bg-white" data-field="' + field + '" onchange="addPgKwLabel(this)">'
                    + '<option value="">' + (isAdd ? '+ เพิ่มป้ายกำกับ' : '+ ลบป้ายกำกับ') + '</option>';
                pageLabels.filter(function(l) { return labelFree(used, l); }).forEach(function(l) {
                    html += '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '</option>';
                });
                if (!pageLabels.length) html += '<option value="" disabled>(กดโหลดป้ายกำกับจากเพจก่อน)</option>';
                html += '</select>';
                if (isAdd && ((currentConfig.keywordLabels || []).length || (currentConfig.keywordRemoveLabels || []).length)) html += '<span class="text-xs text-slate-500">กด "บันทึกการตั้งค่าเพจนี้" เพื่อใช้งาน</span>';
                box.innerHTML = html;
            });
        }
        function addPgKwLabel(sel) {
            const field = sel.getAttribute('data-field');
            const l = pageLabels.find(function(x) { return x.id === sel.value; });
            if (l) currentConfig[field].push({ id: l.id, name: l.name });
            renderPgKwLabels();
        }
        function removePgKwLabel(btn) {
            currentConfig[btn.getAttribute('data-field')].splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
            renderPgKwLabels();
        }

        function renderKwLabels() {
            dedupeLabelLists([liveCfg.keywordLabels, liveCfg.keywordRemoveLabels]);
            [['lv-kw-labels', 'keywordLabels', true], ['lv-kw-remove-labels', 'keywordRemoveLabels', false]].forEach(function(cfgRow) {
                const box = document.getElementById(cfgRow[0]);
                if (!box) return;
                const field = cfgRow[1];
                const isAdd = cfgRow[2];
                const list = Array.isArray(liveCfg[field]) ? liveCfg[field] : (liveCfg[field] = []);
                let html = '';
                list.forEach(function(l, i) {
                    html += '<span class="inline-flex items-center rounded-full overflow-hidden text-xs font-semibold ' + (isAdd ? 'bg-pink-600 text-white' : 'bg-slate-600 text-white') + '">'
                        + '<span class="px-3 py-1">' + (isAdd ? '' : '🗑️ ') + escapeHtml(l.name) + '</span>'
                        + '<button type="button" class="px-2 py-1 border-l border-white/30 hover:bg-black/20" data-field="' + field + '" data-idx="' + i + '" onclick="removeKwLabel(this)">✕</button></span>';
                });
                // ป้ายเดียวกันจะอยู่ได้แค่ฝั่งติด หรือฝั่งลบ อย่างใดอย่างหนึ่ง
                const used = {};
                (liveCfg.keywordLabels || []).concat(liveCfg.keywordRemoveLabels || []).forEach(function(l) { used[l.id] = 1; used['n:' + labelKey(l)] = 1; });
                html += '<select class="text-xs border ' + (isAdd ? 'border-pink-300 text-pink-600' : 'border-slate-300 text-slate-600') + ' rounded-full px-3 py-1 bg-white" data-field="' + field + '" onchange="addKwLabel(this)">'
                    + '<option value="">' + (isAdd ? '+ เพิ่มป้ายกำกับ' : '+ ลบป้ายกำกับ') + '</option>';
                pageLabels.filter(function(l) { return labelFree(used, l); }).forEach(function(l) {
                    html += '<option value="' + escapeHtml(l.id) + '">' + escapeHtml(l.name) + '</option>';
                });
                if (!pageLabels.length) html += '<option value="" disabled>(กดโหลดป้ายกำกับจากเพจก่อน)</option>';
                html += '</select>';
                if (isAdd && ((liveCfg.keywordLabels || []).length || (liveCfg.keywordRemoveLabels || []).length)) html += '<span class="text-xs text-slate-500">กด "บันทึกการตั้งค่า session นี้" เพื่อใช้งาน</span>';
                box.innerHTML = html;
            });
        }

        function addKwLabel(sel) {
            const field = sel.getAttribute('data-field') || 'keywordLabels';
            const l = pageLabels.find(function(x) { return x.id === sel.value; });
            if (!Array.isArray(liveCfg[field])) liveCfg[field] = [];
            if (l) liveCfg[field].push({ id: l.id, name: l.name });
            renderKwLabels();
        }

        function removeKwLabel(btn) {
            const field = btn.getAttribute('data-field') || 'keywordLabels';
            liveCfg[field].splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
            renderKwLabels();
        }

        function addLiveBcLabel(sel) {
            const l = pageLabels.find(function(x) { return x.id === sel.value; });
            if (l) lvBcLabels[sel.getAttribute('data-kind')].push({ id: l.id, name: l.name });
            renderLiveBcLabels();
        }

        function removeLiveBcLabel(btn) {
            lvBcLabels[btn.getAttribute('data-kind')].splice(parseInt(btn.getAttribute('data-idx'), 10), 1);
            renderLiveBcLabels();
        }

        async function loadLiveBcLabels() {
            if(!currentActivePageId) return;
            const st = document.getElementById('lv-bc-lbl-status');
            st.innerText = '⏳ กำลังโหลดป้ายกำกับ...';
            try {
                const r = await (await fetch('/api/labels?token=' + authToken + '&pageId=' + currentActivePageId)).json();
                if (r.success) {
                    pageLabels = r.labels || [];
                    st.innerText = pageLabels.length ? ('พบป้ายกำกับในเพจ ' + pageLabels.length + ' ป้าย') : '⚠️ เพจนี้ยังไม่มีป้ายกำกับ (สร้างได้ที่ Meta Business Suite → จัดการป้ายกำกับ)';
                } else {
                    st.innerText = '❌ โหลดป้ายไม่สำเร็จ: ' + r.error;
                }
            } catch (e) { st.innerText = '❌ ' + e.message; }
            renderLiveBcLabels();
            renderKwLabels();
            renderPgKwLabels();
        }

        async function startLiveBroadcast() {
            if(!currentLiveId) return;
            const message = document.getElementById('lv-bc-message').value.trim();
            if(!message) return alert('กรุณากรอกข้อความบรอดแคสก่อนครับ!');
            const lblText = (lvBcLabels.include.length ? NL + 'ส่งเฉพาะป้าย: ' + lvBcLabels.include.map(function(l) { return l.name; }).join(', ') : '')
                + (lvBcLabels.exclude.length ? NL + 'ยกเว้นป้าย: ' + lvBcLabels.exclude.map(function(l) { return l.name; }).join(', ') : '');
            if(!confirm('ยืนยันเริ่มส่งบรอดแคสต์ให้คนใน session นี้?' + lblText)) return;
            const startBtn = document.getElementById('lv-btn-bc-start');
            startBtn.disabled = true;
            startBtn.innerText = (lvBcLabels.include.length || lvBcLabels.exclude.length) ? 'กำลังตรวจป้ายกำกับของลูกค้า...' : 'กำลังเตรียมรายชื่อ...';
            const res = await fetch(liveUrl('/api/live/broadcast/start', '&sid=' + currentLiveId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    delaySec: parseInt(document.getElementById('lv-bc-delay').value) || 3,
                    batchSize: parseInt(document.getElementById('lv-bc-batch').value) || 20,
                    pauseMin: parseInt(document.getElementById('lv-bc-pause').value) || 10,
                    onlyMatched: document.getElementById('lv-bc-target').value === 'matched',
                    includeLabels: lvBcLabels.include.map(function(l) { return l.id; }),
                    excludeLabels: lvBcLabels.exclude.map(function(l) { return l.id; })
                })
            });
            const data = await res.json();
            startBtn.disabled = false;
            startBtn.innerText = 'เริ่มส่งบรอดแคสต์';
            if(!data.success) alert('❌ ' + data.error);
            else if (data.skipped || data.labelFiltered) alert('เริ่มส่ง ' + data.total + ' คน'
                + (data.labelFiltered ? NL + 'ไม่ตรงเงื่อนไขป้ายกำกับ ' + data.labelFiltered + ' คน' : '')
                + (data.skipped ? NL + 'ข้าม ' + data.skipped + ' คน: ยังไม่ทักแชทใน 24 ชม. และคอมเมนต์ถูกใช้ส่งข้อความส่วนตัวไปแล้ว (กฎ Facebook)' : ''));
            loadLiveDetail(false);
        }

        async function stopLiveBroadcast() {
            if(!currentLiveId) return;
            await fetch(liveUrl('/api/live/broadcast/stop', '&sid=' + currentLiveId), { method: 'POST' });
            loadLiveDetail(false);
        }

        // ============ 📦 รายชื่อลูกค้า + ที่อยู่ + ใบแปะหน้า ============
        const NL = String.fromCharCode(10);
        let buyersList = [];
        let buyersPoll = null;
        let buyersSelected = new Set();
        let buyersSeen = new Set();
        const BUYER_STATUS = {
            found: ['พบที่อยู่', 'bg-emerald-100 text-emerald-700'],
            manual: ['แก้ไขเองแล้ว', 'bg-blue-100 text-blue-700'],
            notfound: ['ไม่พบที่อยู่ในแชท', 'bg-amber-100 text-amber-700'],
            nochat: ['ไม่พบแชท', 'bg-rose-100 text-rose-700'],
            error: ['ผิดพลาด', 'bg-rose-100 text-rose-700'],
            pending: ['รอค้นหา', 'bg-slate-200 text-slate-600']
        };

        function loadSenderInfo() {
            const n = document.getElementById('lv-sender-name');
            const a = document.getElementById('lv-sender-addr');
            const key = 'label_sender_' + currentActivePageId;
            let saved = {};
            try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch(e) {}
            n.value = saved.name || currentConfig.merchantName || '';
            a.value = saved.addr || '';
        }

        function saveSenderInfo() {
            try {
                localStorage.setItem('label_sender_' + currentActivePageId, JSON.stringify({
                    name: document.getElementById('lv-sender-name').value,
                    addr: document.getElementById('lv-sender-addr').value
                }));
            } catch(e) {}
        }

        function resetBuyers() {
            if(buyersPoll) { clearInterval(buyersPoll); buyersPoll = null; }
            buyersList = [];
            buyersSelected = new Set();
            buyersSeen = new Set();
            document.getElementById('lv-buyers').innerHTML = '<tr><td colspan="10" class="py-3 text-slate-400">กด "ดึงรายชื่อ + ค้นหาที่อยู่" เพื่อเริ่ม</td></tr>';
            document.getElementById('lv-buyers-progress').classList.add('hidden');
            document.getElementById('lv-buyers-summary').innerText = '';
            document.getElementById('lv-buyers-all').checked = false;
        }

        async function fetchBuyers() {
            if(!currentLiveId) return;
            const res = await fetch(liveUrl('/api/live/buyers/fetch', '&sid=' + currentLiveId), { method: 'POST' });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            if(buyersPoll) clearInterval(buyersPoll);
            buyersPoll = setInterval(function() { loadBuyers(true); }, 2000);
            loadBuyers();
        }

        // fromPoll = true เฉพาะการรีเฟรชอัตโนมัติทุก 2 วิ (ข้ามได้ตอนสลับไปแท็บอื่น)
        // การเรียกตรง ๆ จากปุ่ม/งานที่รอผล (เช่น สร้างพัสดุ แล้วเปิดหน้าใบแปะหน้า) ต้องดึงข้อมูลเสมอ
        async function loadBuyers(fromPoll) {
            if (fromPoll === true && document.hidden && buyersList.length) return; // ⚡ ประหยัดเฉพาะการรีเฟรชอัตโนมัติ
            if(!currentLiveId) return;
            const sid = currentLiveId;
            try {
                const res = await fetch(liveUrl('/api/live/buyers', '&sid=' + sid));
                const d = await res.json();
                if(!d.success || sid !== currentLiveId) return;
                const job = d.job;
                const prog = document.getElementById('lv-buyers-progress');
                const btn = document.getElementById('lv-btn-buyers');
                if(job && (job.running || job.message)) {
                    prog.classList.remove('hidden');
                    prog.innerText = (job.running ? '⏳ ' : '') + job.message + ' (' + job.done + '/' + job.total + ')' + (job.warning ? ' · ⚠️ ' + job.warning : '');
                } else {
                    prog.classList.add('hidden');
                }
                btn.disabled = !!(job && job.running);
                btn.classList.toggle('opacity-50', !!(job && job.running));

                const sj = d.shipJob;
                lastShipJob = sj;
                const sp = document.getElementById('lv-ship-progress');
                if(sj && (sj.running || sj.message)) {
                    sp.classList.remove('hidden');
                    sp.innerText = (sj.running ? '⏳ ' : '✅ ') + sj.message + ' (' + sj.done + '/' + sj.total + ')';
                } else {
                    sp.classList.add('hidden');
                }
                const sbtn = document.getElementById('lv-btn-ship');
                sbtn.disabled = !!(sj && sj.running);
                sbtn.classList.toggle('opacity-50', !!(sj && sj.running));

                if(!(job && job.running) && !(sj && sj.running) && buyersPoll) { clearInterval(buyersPoll); buyersPoll = null; }

                buyersList = d.buyers || [];
                buyersList.forEach(function(b) {
                    if(!buyersSeen.has(b.userId) && b.status !== 'pending') {
                        buyersSeen.add(b.userId);
                        if(b.address) buyersSelected.add(b.userId);
                    }
                });
                const tbody = document.getElementById('lv-buyers');
                if(!tbody.contains(document.activeElement)) renderBuyers();
                else updateBuyersSummary();
            } catch(e) { console.error(e); }
        }

        function renderBuyers() {
            const tbody = document.getElementById('lv-buyers');
            if(!buyersList.length) {
                tbody.innerHTML = '<tr><td colspan="11" class="py-3 text-slate-400">ยังไม่มีข้อมูล กด "ดึงรายชื่อ + ค้นหาที่อยู่"</td></tr>';
                renderPagerBar('buyers', 0, 1);
                updateBuyersSummary();
                return;
            }
            let html = '';
            pageSlice('buyers', buyersList).forEach(function(b) {
                const st = BUYER_STATUS[b.status] || BUYER_STATUS.pending;
                const inp = 'w-full p-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-indigo-400';
                html += '<tr data-uid="' + escapeHtml(b.userId) + '" class="border-b border-slate-100 align-top">'
                    + '<td class="py-2 pr-2"><input type="checkbox" class="bf-sel w-4 h-4 rounded"' + (buyersSelected.has(b.userId) ? ' checked' : '') + '></td>'
                    + '<td class="py-2 pr-2 font-medium text-slate-700 min-w-[7rem]">' + escapeHtml(b.fbName || b.userId) + '<div class="text-[10px] text-slate-400 font-normal">' + escapeHtml(b.lastMessage || '') + '</div></td>'
                    + '<td class="py-2 pr-2 text-blue-600 font-semibold whitespace-nowrap">' + (b.source === 'chat' && !b.matchedCount ? '<span class="text-violet-600">💬 จากแชท</span>' : escapeHtml(b.keyword || '') + ' ×' + (b.matchedCount || 0)) + '</td>'
                    + '<td class="py-2 pr-2 text-right text-emerald-600 font-semibold whitespace-nowrap">' + (b.slipTotal ? fmtMoney(b.slipTotal) : '-') + '</td>'
                    + '<td class="py-2 pr-2 min-w-[8rem]"><input type="text" class="bf-name ' + inp + '" value="' + escapeHtml(b.recipientName || '') + '"></td>'
                    + '<td class="py-2 pr-2 min-w-[16rem]"><textarea rows="2" class="bf-addr ' + inp + '">' + escapeHtml(b.address || '') + '</textarea>'
                    + renderLocationPicker(b)
                    + (b.raw ? '<details class="text-[10px] text-slate-400 mt-1"><summary class="cursor-pointer">ข้อความต้นฉบับ</summary><div class="whitespace-pre-wrap">' + escapeHtml(b.raw) + '</div></details>' : '')
                    + '</td>'
                    + '<td class="py-2 pr-2 w-20"><input type="text" class="bf-post ' + inp + '" value="' + escapeHtml(b.postcode || '') + '"></td>'
                    + '<td class="py-2 pr-2 w-28"><input type="text" class="bf-phone ' + inp + '" value="' + escapeHtml(b.phone || '') + '"></td>'
                    + '<td class="py-2 pr-2 min-w-[7rem]">' + (b.trackingNo
                        ? '<div class="font-bold text-emerald-700 whitespace-nowrap">' + escapeHtml(b.trackingNo) + '</div><div class="text-[10px] text-slate-400">' + escapeHtml(b.partnerName || '') + (b.notified ? ' · ✅ แจ้งลูกค้าแล้ว' : '') + '</div>'
                            + (!b.notified ? '<button type="button" class="bf-notify mt-1 px-2 py-0.5 text-[10px] font-semibold rounded bg-blue-600 text-white hover:bg-blue-700">💬 ส่งเลขพัสดุ' + (b.shipNote && /24/.test(b.shipNote) ? ' (ได้ภายใน 7 วัน)' : '') + '</button>' : '')
                            + (b.bmStatus ? '<div class="text-[10px] font-semibold text-indigo-600">' + escapeHtml(b.bmStatus) + '</div>' : '')
                        : (b.shipStatus === 'error' ? '<div class="text-[10px] text-rose-600">❌ ' + escapeHtml(b.shipNote || '') + '</div>' : (b.beemoveOrderId ? '<span class="text-[10px] text-amber-600">รอเลขพัสดุ</span>' : '<span class="text-slate-300">-</span>')))
                        + (b.trackingNo && b.shipNote && !b.notified ? '<div class="text-[10px] text-amber-600">' + escapeHtml(/เกิน 24 ชม/.test(b.shipNote) ? 'ลูกค้าทักเกิน 24 ชม. กดปุ่มด้านบนเพื่อส่ง (ได้ภายใน 7 วันหลังลูกค้าทักล่าสุด)' : b.shipNote) + '</div>' : '')
                        + '</td>'
                    + '<td class="py-2 pr-2"><button type="button" class="bf-split px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 whitespace-nowrap" title="แยกชื่อ / ที่อยู่ / รหัสไปรษณีย์ / เบอร์โทร จากข้อความในช่องที่อยู่ (วางข้อความที่ลูกค้าส่งมาทั้งก้อนได้เลย)">✂️ แยกที่อยู่</button></td>'
                    + '<td class="py-2"><span class="text-[10px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ' + st[1] + '">' + st[0] + '</span>'
                    + (b.note ? '<div class="text-[10px] text-slate-400 mt-1">' + escapeHtml(b.note) + '</div>' : '')
                    + '<button type="button" class="bf-del mt-2 block text-[11px] text-rose-500 hover:text-rose-700 hover:underline" title="ลบออกจากรายชื่อ">🗑️ ลบ</button></td>'
                    + '</tr>';
            });
            tbody.innerHTML = html;
            updateBuyersSummary();
        }

        // ============ 💬 ค้นหารายชื่อจากแชทเพจ + ปฏิทินเลือกช่วงวันที่ ============
        const TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
        const TH_DOW = ['จ.','อ.','พ.','พฤ.','ศ.','ส.','อา.'];
        let chatRange = null;
        let chatCalView = null;
        let chatPicking = false;
        let chatResults = [];
        let chatSel = new Set();

        function pad2(n) { return (n < 10 ? '0' : '') + n; }
        function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
        function dayOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

        function initChatRange() {
            if(chatRange) return;
            const end = dayOnly(new Date());
            const start = new Date(end.getFullYear(), end.getMonth() - 1, end.getDate());
            chatRange = { start: start, end: end };
            chatCalView = new Date(start.getFullYear(), start.getMonth(), 1);
            updateChatRangeText();
        }

        function updateChatRangeText() {
            document.getElementById('lv-chat-range-text').innerText = ymd(chatRange.start) + ' ถึง ' + (chatRange.end ? ymd(chatRange.end) : '...');
        }

        function toggleChatCal() {
            initChatRange();
            const cal = document.getElementById('lv-chat-cal');
            if(cal.classList.contains('hidden')) {
                chatCalView = new Date(chatRange.start.getFullYear(), chatRange.start.getMonth(), 1);
                renderChatCal();
                cal.classList.remove('hidden');
            } else {
                cal.classList.add('hidden');
            }
        }

        function renderMonth(year, month, navLeft, navRight) {
            const first = new Date(year, month, 1);
            const offset = (first.getDay() + 6) % 7; // เริ่มวันจันทร์
            const startDay = new Date(year, month, 1 - offset);
            const s = chatRange.start ? chatRange.start.getTime() : 0;
            const e = chatRange.end ? chatRange.end.getTime() : s;
            const today = dayOnly(new Date()).getTime();
            let html = '<div class="w-64">';
            html += '<div class="flex items-center justify-between text-xs text-slate-500 mb-2">';
            html += navLeft ? '<span><button type="button" data-nav="-12" class="px-1 hover:text-blue-600">«</button><button type="button" data-nav="-1" class="px-1 hover:text-blue-600">‹</button></span>' : '<span class="w-8"></span>';
            html += '<span class="font-semibold text-slate-700">' + year + ' ' + TH_MONTHS[month] + '</span>';
            html += navRight ? '<span><button type="button" data-nav="1" class="px-1 hover:text-blue-600">›</button><button type="button" data-nav="12" class="px-1 hover:text-blue-600">»</button></span>' : '<span class="w-8"></span>';
            html += '</div><div class="grid grid-cols-7 text-center text-[11px] text-slate-400 mb-1">';
            TH_DOW.forEach(function(d) { html += '<div>' + d + '</div>'; });
            html += '</div><div class="grid grid-cols-7 text-center text-xs">';
            for(let i = 0; i < 42; i++) {
                const d = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
                const t = d.getTime();
                const inMonth = d.getMonth() === month;
                const isEdge = inMonth && (t === s || (chatRange.end && t === e));
                const inRange = inMonth && t > Math.min(s, e) && t < Math.max(s, e);
                let cls = 'py-1.5 cursor-pointer ';
                if(isEdge) cls += 'bg-blue-600 text-white font-semibold rounded ';
                else if(inRange) cls += 'bg-blue-100 text-slate-700 ';
                else if(!inMonth) cls += 'text-slate-300 hover:bg-slate-100 rounded ';
                else cls += 'text-slate-700 hover:bg-slate-100 rounded ';
                if(t > today) cls += 'opacity-40 ';
                html += '<div class="' + cls + '" data-day="' + ymd(d) + '">' + d.getDate() + '</div>';
            }
            html += '</div></div>';
            return html;
        }

        function renderChatCal() {
            const cal = document.getElementById('lv-chat-cal');
            const y = chatCalView.getFullYear(), m = chatCalView.getMonth();
            const next = new Date(y, m + 1, 1);
            let html = '<div class="flex gap-4">' + renderMonth(y, m, true, false) + '<div class="w-px bg-slate-200"></div>' + renderMonth(next.getFullYear(), next.getMonth(), false, true) + '</div>';
            html += '<div class="flex flex-wrap gap-2 mt-3 pt-2 border-t border-slate-100 text-xs">';
            [['วันนี้', 0], ['7 วัน', 7], ['30 วัน', 30], ['90 วัน', 90]].forEach(function(q) {
                html += '<button type="button" data-quick="' + q[1] + '" class="px-2 py-1 rounded bg-slate-100 hover:bg-blue-100 text-slate-600">' + q[0] + '</button>';
            });
            html += '<span class="ml-auto text-slate-400">' + (chatPicking ? 'เลือกวันสิ้นสุด' : 'คลิกวันเริ่มต้น') + '</span></div>';
            cal.innerHTML = html;
        }

        document.addEventListener('click', function(e) {
            const cal = document.getElementById('lv-chat-cal');
            if(!cal || cal.classList.contains('hidden')) return;
            const nav = e.target.closest('[data-nav]');
            const day = e.target.closest('[data-day]');
            const quick = e.target.closest('[data-quick]');
            if(nav && cal.contains(nav)) {
                const n = parseInt(nav.getAttribute('data-nav'), 10);
                chatCalView = new Date(chatCalView.getFullYear(), chatCalView.getMonth() + n, 1);
                renderChatCal();
                return;
            }
            if(quick && cal.contains(quick)) {
                const n = parseInt(quick.getAttribute('data-quick'), 10);
                const end = dayOnly(new Date());
                chatRange = { start: new Date(end.getFullYear(), end.getMonth(), end.getDate() - n), end: end };
                chatPicking = false;
                updateChatRangeText();
                cal.classList.add('hidden');
                return;
            }
            if(day && cal.contains(day)) {
                const p = day.getAttribute('data-day').split('-');
                const d = new Date(+p[0], +p[1] - 1, +p[2]);
                if(!chatPicking) {
                    chatRange = { start: d, end: null };
                    chatPicking = true;
                    updateChatRangeText();
                    renderChatCal();
                } else {
                    if(d < chatRange.start) { chatRange.end = chatRange.start; chatRange.start = d; } else { chatRange.end = d; }
                    chatPicking = false;
                    updateChatRangeText();
                    cal.classList.add('hidden');
                }
                return;
            }
            if(!cal.contains(e.target) && !e.target.closest('#lv-chat-range')) {
                if(chatPicking) { chatRange.end = chatRange.start; chatPicking = false; updateChatRangeText(); }
                cal.classList.add('hidden');
            }
        });

        async function searchChats() {
            if(!currentActivePageId) return alert('กรุณาเลือกเพจก่อน');
            initChatRange();
            if(!chatRange.end) chatRange.end = chatRange.start;
            const from = chatRange.start.getTime();
            const to = new Date(chatRange.end.getFullYear(), chatRange.end.getMonth(), chatRange.end.getDate() + 1).getTime() - 1;
            const q = document.getElementById('lv-chat-q').value.trim();
            const onlyAddr = document.getElementById('lv-chat-onlyaddr').checked ? '1' : '0';
            const deep = document.getElementById('lv-chat-deep').checked ? '1' : '0';
            const btn = document.getElementById('lv-chat-btn');
            const st = document.getElementById('lv-chat-status');
            btn.disabled = true; btn.classList.add('opacity-50');
            st.classList.remove('hidden');
            st.innerText = '⏳ กำลังค้นหาแชท ' + ymd(chatRange.start) + ' ถึง ' + ymd(chatRange.end) + ' ...';
            try {
                const res = await fetch('/api/chats/search?token=' + authToken + '&pageId=' + currentActivePageId
                    + '&from=' + from + '&to=' + to + '&onlyAddr=' + onlyAddr + '&deep=' + deep + '&q=' + encodeURIComponent(q));
                const d = await res.json();
                if(!d.success) { st.innerText = '❌ ' + d.error; return; }
                chatResults = d.results || [];
                pagerState('chat').page = 1; // ค้นหาใหม่ เริ่มหน้า 1
                chatSel = new Set(chatResults.filter(function(r) { return r.hasAddress; }).map(function(r) { return r.psid; }));
                let info = 'พบ ' + chatResults.length + ' แชท · ตรวจ ' + d.scanned + ' แชทในช่วงวันที่ (อ่านข้อความ ' + d.readCount + ' แชท)';
                if(d.oldestSeen) info += ' · ย้อนไปถึง ' + new Date(d.oldestSeen).toLocaleDateString('th-TH', { dateStyle: 'medium' });
                if(d.hiddenNoAddr) info += ' · ซ่อน ' + d.hiddenNoAddr + ' คนที่ยังไม่พบที่อยู่ในแชท (เอาติ๊ก "เฉพาะคนที่ส่งที่อยู่" ออกเพื่อดู)';
                if(d.endReason === 'time' || d.endReason === 'maxpages') info += ' · ⚠️ แชทเยอะมาก ค้นได้ไม่ครบช่วงวันที่ ลองย่อช่วงวันที่';
                if(d.readLimited) info += ' · ⚠️ อ่านข้อความได้ไม่ครบทุกแชท (ค้นชื่อเฟสได้ครบ) ลองย่อช่วงวันที่ถ้าค้นจากที่อยู่/เบอร์';
                st.innerText = info;
                renderChatResults();
            } catch(e) {
                st.innerText = '❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
            } finally {
                btn.disabled = false; btn.classList.remove('opacity-50');
            }
        }

        function renderChatResults() {
            const box = document.getElementById('lv-chat-results-box');
            const tbody = document.getElementById('lv-chat-results');
            box.classList.toggle('hidden', !chatResults.length);
            const inList = new Set(buyersList.map(function(b) { return b.psid; }).filter(Boolean));
            tbody.innerHTML = pageSlice('chat', chatResults).map(function(r) {
                const added = inList.has(r.psid);
                return '<tr data-psid="' + escapeHtml(r.psid) + '" class="border-b border-slate-100 align-top">'
                    + '<td class="py-2 pr-2"><input type="checkbox" class="cs-sel w-4 h-4 rounded"' + (chatSel.has(r.psid) ? ' checked' : '') + '></td>'
                    + '<td class="py-2 pr-2 font-medium text-slate-700 min-w-[8rem]">' + escapeHtml(r.name || r.psid) + (added ? '<div class="text-[10px] text-emerald-600">อยู่ในรายชื่อแล้ว</div>' : '') + '</td>'
                    + '<td class="py-2 pr-2 text-slate-600 max-w-xs">' + escapeHtml(r.matchedText || r.snippet || '') + '</td>'
                    + '<td class="py-2 pr-2 min-w-[14rem]">' + (r.hasAddress
                        ? '<div class="text-slate-700">' + escapeHtml(r.recipientName || '') + (r.phone ? ' · ' + escapeHtml(r.phone) : '') + '</div><div class="text-slate-500">' + escapeHtml(r.addressPreview || '') + '</div>'
                        : '<span class="text-slate-300">ยังไม่มีที่อยู่ในแชท</span>') + '</td>'
                    + '<td class="py-2 text-slate-500 whitespace-nowrap">' + escapeHtml(new Date(r.updatedTime).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })) + '</td>'
                    + '</tr>';
            }).join('');
            document.getElementById('lv-chat-count').innerText = '(เลือกไว้ ' + chatSel.size + ' / ' + chatResults.length + ')';
            document.getElementById('lv-chat-all').checked = chatResults.length > 0 && chatSel.size === chatResults.length;
        }

        function toggleAllChats(on) {
            chatSel = new Set(on ? chatResults.map(function(r) { return r.psid; }) : []);
            renderChatResults();
        }

        document.addEventListener('change', function(e) {
            if(!e.target.classList.contains('cs-sel')) return;
            const tr = e.target.closest('tr[data-psid]');
            const id = tr.getAttribute('data-psid');
            if(e.target.checked) chatSel.add(id); else chatSel.delete(id);
            document.getElementById('lv-chat-count').innerText = '(เลือกไว้ ' + chatSel.size + ' / ' + chatResults.length + ')';
        });

        async function addChatsToBuyers() {
            if(!currentLiveId) return alert('กรุณาเลือก session ไลฟ์ก่อน');
            const people = chatResults.filter(function(r) { return chatSel.has(r.psid); }).map(function(r) { return { psid: r.psid, name: r.name }; });
            if(!people.length) return alert('กรุณาเลือกอย่างน้อย 1 คน');
            const res = await fetch(liveUrl('/api/live/buyers/add-from-chat', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ people: people })
            });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            if(buyersPoll) clearInterval(buyersPoll);
            buyersPoll = setInterval(function() { loadBuyers(true).then(renderChatResults); }, 2000);
            await loadBuyers();
            document.getElementById('lv-buyers').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // ช่องเลือก ตำบล › อำเภอ › จังหวัด จากรหัสไปรษณีย์
        function renderLocationPicker(b) {
            if(b.addrCheck === 'badzip') {
                return '<div class="mt-1 text-[11px] font-semibold text-rose-600">❌ ไม่มีรหัสไปรษณีย์ ' + escapeHtml(b.addrZip) + ' ในประเทศไทย ตรวจช่องรหัส ปณ.</div>';
            }
            const opts = b.addrOptions || [];
            if(!opts.length) return '';
            const needCheck = b.addrCheck === 'check' || b.addrGuess;
            const sel = needCheck && b.addrGuess && b.addrMatch >= 0 ? -1 : b.addrMatch;
            let html = '<div class="mt-1 rounded-md ' + (needCheck ? 'bg-amber-50 border border-amber-300 p-1.5' : '') + '">';
            if(needCheck && b.addrAltZip) {
                const a0 = opts[0];
                html += '<div class="text-[11px] font-semibold text-amber-700 mb-1">⚠️ ต.' + escapeHtml(a0.d) + ' อ.' + escapeHtml(a0.a) + ' ใช้รหัสไปรษณีย์ ' + escapeHtml(a0.z) + ' (ลูกค้าพิมพ์ ' + escapeHtml(b.addrZip) + ' อาจเป็นรหัสเก่า) เลือกด้านล่างเพื่อแก้ให้</div>';
            } else if(needCheck) {
                html += '<div class="text-[11px] font-semibold text-amber-700 mb-1">⚠️ ' + (b.addrCheck === 'check'
                    ? 'ตำบล/อำเภอไม่ตรงกับรหัสไปรษณีย์ ' + escapeHtml(b.addrZip) + ' กรุณาเลือกที่ถูกต้อง'
                    : 'ระบบเดาตำบล/อำเภอให้ (ลูกค้าพิมพ์ไม่ชัด) กรุณาเลือกยืนยัน') + '</div>';
            }
            html += '<select class="bf-loc w-full p-1 text-[11px] border rounded-md ' + (needCheck ? 'border-amber-400 bg-white text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-600') + '">';
            html += '<option value="">' + (needCheck ? '-- เลือก ตำบล › อำเภอ (รหัส ปณ. ' + escapeHtml(b.addrZip) + ') --' : '') + '</option>';
            opts.forEach(function(o, i) {
                const isBkk = o.p.indexOf('กรุงเทพ') >= 0;
                const label = (isBkk ? 'แขวง' : 'ต.') + o.d + ' › ' + (isBkk ? 'เขต' : 'อ.') + o.a + ' › ' + o.p + ' ' + o.z;
                const mark = o.alt ? '★ ' : ((i === b.addrMatch && !needCheck) ? '✓ ' : (i === b.addrMatch ? '★ ' : ''));
                html += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + escapeHtml(mark + label) + '</option>';
            });
            html += '</select></div>';
            return html;
        }

        async function setBuyerLocation(tr, idx) {
            const uid = tr.getAttribute('data-uid');
            const b = buyersList.find(function(x) { return x.userId === uid; });
            if(!b || !b.addrOptions || !b.addrOptions[idx]) return;
            // บันทึกข้อมูลที่แก้ในแถวก่อน
            const row = readBuyerRow(tr);
            await fetch(liveUrl('/api/live/buyers/update', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row)
            });
            const o = b.addrOptions[idx];
            const res = await fetch(liveUrl('/api/live/buyers/set-location', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: uid, d: o.d, a: o.a, p: o.p, z: o.z })
            });
            const d = await res.json();
            if(!d.success) alert('❌ ' + d.error);
            if(document.activeElement) document.activeElement.blur();
            await loadBuyers();
        }

        function updateBuyersSummary() {
            const found = buyersList.filter(function(b) { return b.address; }).length;
            document.getElementById('lv-buyers-summary').innerText = 'ทั้งหมด ' + buyersList.length + ' คน · มีที่อยู่ ' + found + ' คน · เลือกไว้ ' + buyersSelected.size + ' คน';
            document.getElementById('lv-buyers-all').checked = buyersList.length > 0 && buyersSelected.size === buyersList.length;
        }

        function toggleAllBuyers(on) {
            buyersSelected = new Set(on ? buyersList.map(function(b) { return b.userId; }) : []);
            document.querySelectorAll('#lv-buyers .bf-sel').forEach(function(cb) { cb.checked = on; });
            updateBuyersSummary();
        }

        function readBuyerRow(tr) {
            return {
                userId: tr.getAttribute('data-uid'),
                recipientName: tr.querySelector('.bf-name').value.trim(),
                address: tr.querySelector('.bf-addr').value.trim(),
                postcode: tr.querySelector('.bf-post').value.trim(),
                phone: tr.querySelector('.bf-phone').value.trim()
            };
        }

        document.addEventListener('change', async function(e) {
            const tr = e.target.closest('#lv-buyers tr[data-uid]');
            if(!tr) {
                if(e.target.id === 'lv-sender-name' || e.target.id === 'lv-sender-addr') saveSenderInfo();
                return;
            }
            const uid = tr.getAttribute('data-uid');
            if(e.target.classList.contains('bf-sel')) {
                if(e.target.checked) buyersSelected.add(uid); else buyersSelected.delete(uid);
                updateBuyersSummary();
                return;
            }
            if(e.target.classList.contains('bf-loc')) {
                if(e.target.value !== '') await setBuyerLocation(tr, parseInt(e.target.value, 10));
                return;
            }
            const row = readBuyerRow(tr);
            const item = buyersList.find(function(b) { return b.userId === uid; });
            if(item) Object.assign(item, row, { status: 'manual' });
            try {
                await fetch(liveUrl('/api/live/buyers/update', '&sid=' + currentLiveId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(row)
                });
                // แก้รหัสไปรษณีย์/ที่อยู่แล้ว โหลดตัวเลือกตำบลใหม่
                if(e.target.classList.contains('bf-post') || e.target.classList.contains('bf-addr')) {
                    e.target.blur();
                    await loadBuyers();
                }
            } catch(err) { console.error(err); }
        });

        // รวมคนที่ติ๊กไว้ "ทุกหน้า" (แถวที่แสดงอยู่ใช้ค่าที่แก้ในช่องล่าสุด หน้าอื่นใช้ค่าที่บันทึกไว้)
        function getSelectedBuyers() {
            const rows = {};
            document.querySelectorAll('#lv-buyers tr[data-uid]').forEach(function(tr) { rows[tr.getAttribute('data-uid')] = tr; });
            return buyersList.filter(function(b) { return buyersSelected.has(b.userId); }).map(function(b) {
                return rows[b.userId] ? Object.assign({}, b, readBuyerRow(rows[b.userId])) : Object.assign({}, b);
            });
        }

        async function notifyBuyers(ids) {
            const list = buyersList.filter(function(b) { return ids.indexOf(b.userId) >= 0 && b.trackingNo; });
            if(!list.length) return alert('ลูกค้าที่เลือกยังไม่มีเลขพัสดุ');
            const again = list.filter(function(b) { return b.notified; }).length;
            if(!confirm('ส่งเลขพัสดุทางแชทให้ ' + list.length + ' คน?' + (again ? NL + '(มี ' + again + ' คนที่เคยส่งแล้ว จะส่งซ้ำ)' : '') + NL + NL + 'ถ้าลูกค้าทักเกิน 24 ชม. ระบบจะส่งแบบแอดมินตอบกลับ (ได้ภายใน 7 วัน)')) return;
            const res = await fetch(liveUrl('/api/live/buyers/notify', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userIds: list.map(function(b) { return b.userId; }) })
            });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            let msg = '✅ ส่งแล้ว ' + d.sent + ' คน' + (d.tagged ? ' (ส่งแบบเกิน 24 ชม. ' + d.tagged + ' คน)' : '');
            if(d.errors && d.errors.length) msg += NL + NL + '❌ ไม่สำเร็จ:' + NL + d.errors.join(NL);
            alert(msg);
            await loadBuyers();
        }

        function notifySelectedBuyers() {
            if(!currentLiveId) return;
            notifyBuyers(Array.from(buyersSelected));
        }

        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.bf-notify');
            if(!btn) return;
            const tr = btn.closest('tr[data-uid]');
            if(tr) notifyBuyers([tr.getAttribute('data-uid')]);
        });

        async function deleteBuyers(ids) {
            if(!ids.length) return alert('กรุณาเลือกลูกค้าอย่างน้อย 1 คน');
            const shipped = buyersList.filter(function(b) { return ids.indexOf(b.userId) >= 0 && (b.trackingNo || b.beemoveOrderId); }).length;
            let msg = 'ลบ ' + ids.length + ' คนออกจากรายชื่อ?';
            if(shipped) msg += NL + NL + '⚠️ มี ' + shipped + ' คนที่สร้างพัสดุใน Bee Move แล้ว การลบที่นี่ไม่ได้ยกเลิกพัสดุ (ต้องยกเลิกใน Bee Move เอง)';
            if(!confirm(msg)) return;
            const res = await fetch(liveUrl('/api/live/buyers/delete', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds: ids })
            });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            ids.forEach(function(id) { buyersSelected.delete(id); });
            if(document.activeElement) document.activeElement.blur();
            await loadBuyers();
            if(typeof renderChatResults === 'function' && chatResults.length) renderChatResults();
        }

        function deleteSelectedBuyers() {
            if(!currentLiveId) return;
            deleteBuyers(Array.from(buyersSelected));
        }

        // ✂️ แยกที่อยู่: อ่านข้อความในแถว (วางทั้งก้อนในช่องที่อยู่ได้) แล้วแยกเป็น ชื่อ / ที่อยู่ / รหัส ปณ. / เบอร์โทร
        document.addEventListener('click', async function(e) {
            const btn = e.target.closest('.bf-split');
            if(!btn || !currentLiveId) return;
            const tr = btn.closest('tr[data-uid]');
            if(!tr) return;
            const row = readBuyerRow(tr);
            if(!row.address && !row.recipientName) return alert('ช่องที่อยู่ว่าง: วางข้อความที่อยู่ที่ลูกค้าส่งมาในช่องที่อยู่ก่อน');
            btn.disabled = true; const old = btn.innerText; btn.innerText = '⏳ กำลังแยก...';
            try {
                const r = await (await fetch(liveUrl('/api/live/buyers/split-address', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row)
                })).json();
                if(!r.success) { alert('❌ ' + r.error); return; }
                await loadBuyers();
                const nt = document.querySelector('#lv-buyers tr[data-uid="' + row.userId + '"]');
                if(nt) { nt.classList.add('bg-indigo-50'); setTimeout(function() { nt.classList.remove('bg-indigo-50'); }, 1500); }
                if(r.message) showSplitNote(r.message);
            } catch(err) { alert('❌ ' + err.message); }
            finally { btn.disabled = false; btn.innerText = old; }
        });
        function showSplitNote(t) {
            let el = document.getElementById('split-toast');
            if(!el) {
                el = document.createElement('div'); el.id = 'split-toast';
                el.className = 'fixed bottom-6 z-[60] px-4 py-2 rounded-xl bg-slate-800 text-white text-sm shadow-lg';
                el.style.left = '50%'; el.style.transform = 'translateX(-50%)';
                document.body.appendChild(el);
            }
            el.innerText = t; el.style.display = 'block';
            clearTimeout(el._t); el._t = setTimeout(function() { el.style.display = 'none'; }, 4000);
        }

        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.bf-del');
            if(!btn) return;
            const tr = btn.closest('tr[data-uid]');
            if(tr) deleteBuyers([tr.getAttribute('data-uid')]);
        });

        async function fixBuyerAddresses() {
            if(!currentLiveId) return;
            const list = getSelectedBuyers();
            if(!list.length) return alert('กรุณาเลือกลูกค้าอย่างน้อย 1 คน');
            // บันทึกที่อยู่ที่แก้ในตารางก่อน
            for(const b of list) {
                await fetch(liveUrl('/api/live/buyers/update', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: b.userId, recipientName: b.recipientName, address: b.address, postcode: b.postcode, phone: b.phone })
                });
            }
            const res = await fetch(liveUrl('/api/live/buyers/fix-address', '&sid=' + currentLiveId), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userIds: list.map(function(b) { return b.userId; }) })
            });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            if(document.activeElement) document.activeElement.blur();
            await loadBuyers();
            alert('🗺️ จัดรูปแบบที่อยู่แล้ว ' + d.fixed + ' คน' + (d.failed ? ' · แก้ไม่ได้ ' + d.failed + ' คน (ตรวจชื่อตำบล/อำเภอ/จังหวัด)' : '') + (d.dbLoaded ? '' : NL + '⚠️ ยังโหลดฐานข้อมูลที่อยู่ไม่ได้ ใช้วิธีเดาจากตำแหน่งแทน'));
        }

        function exportBuyersCSV() {
            const list = getSelectedBuyers();
            if(!list.length) return alert('กรุณาเลือกลูกค้าอย่างน้อย 1 คน');
            const q = function(v) { return '"' + String(v == null ? '' : v).split('"').join('""') + '"'; };
            const rows = [['ชื่อเฟส', 'ชื่อผู้รับ', 'ที่อยู่', 'รหัสไปรษณีย์', 'เบอร์โทร', 'ยอดโอน', 'คำดัก', 'จำนวนครั้ง', 'เลขพัสดุ', 'ขนส่ง']];
            list.forEach(function(b) {
                rows.push([b.fbName, b.recipientName || b.fbName, b.address, b.postcode, b.phone, b.slipTotal || 0, b.keyword, b.matchedCount, b.trackingNo || '', b.partnerName || '']);
            });
            const csv = String.fromCharCode(65279) + rows.map(function(r) { return r.map(q).join(','); }).join(String.fromCharCode(13, 10));
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'customers-' + (document.getElementById('live-name-input').value || 'live') + '.csv';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }

        function printLabels() {
            const list = getSelectedBuyers();
            if(!list.length) return alert('กรุณาเลือกลูกค้าอย่างน้อย 1 คน');
            const missing = list.filter(function(b) { return !b.address; }).length;
            if(missing && !confirm('มี ' + missing + ' คนที่ยังไม่มีที่อยู่ พิมพ์ต่อหรือไม่?')) return;
            saveSenderInfo();

            const senderName = escapeHtml(document.getElementById('lv-sender-name').value);
            const senderAddr = escapeHtml(document.getElementById('lv-sender-addr').value);
            const br = function(s) { return escapeHtml(s || '').split(NL).join('<br>'); };

            // กระดาษ A6 (105 x 148 มม.) 1 ใบต่อแผ่น
            const pageCss = '@page { size: 105mm 148mm; margin: 4mm; }';
            const gridCss = '.grid { display: block; }';
            const labelCss = '.label { height: 139mm; page-break-after: always; } .label:last-child { page-break-after: auto; }';

            let body = '';
            list.forEach(function(b) {
                body += '<div class="label">'
                    + '<div class="sender"><b>ผู้ส่ง:</b> ' + senderName + (senderAddr ? ' · ' + senderAddr : '') + '</div>'
                    + '<div class="recv"><div class="tag">ผู้รับ</div>'
                    + '<div class="rname">' + escapeHtml(b.recipientName || b.fbName || '') + '</div>'
                    + '<div class="raddr">' + br(b.address) + '</div>'
                    + '<div class="rfoot"><span class="phone">' + (b.phone ? 'โทร ' + escapeHtml(b.phone) : '') + '</span>'
                    + '<span class="post">' + escapeHtml(b.postcode || '') + '</span></div>'
                    + (b.trackingNo ? '<div class="track">เลขพัสดุ: ' + escapeHtml(b.trackingNo) + (b.partnerName ? ' (' + escapeHtml(b.partnerName) + ')' : '') + '</div>' : '')
                    + '</div>'
                    + '<div class="meta">' + escapeHtml(b.fbName || '') + ' · ' + escapeHtml(b.keyword || '') + ' ×' + (b.matchedCount || 0) + (b.slipTotal ? ' · ' + fmtMoney(b.slipTotal) + ' บาท' : '') + '</div>'
                    + '</div>';
            });

            const css = pageCss + gridCss + labelCss
                + 'body { font-family: Sarabun, sans-serif; margin: 0; color: #111; }'
                + '.label { box-sizing: border-box; border: 1.5px dashed #444; padding: 3.5mm 4mm; break-inside: avoid; display: flex; flex-direction: column; overflow: hidden; }'
                + '.sender { font-size: 11px; color: #333; border-bottom: 1px solid #ccc; padding-bottom: 2mm; }'
                + '.recv { flex: 1; padding-top: 2mm; display: flex; flex-direction: column; }'
                + '.tag { font-size: 11px; font-weight: 700; color: #555; }'
                + '.rname { font-size: 18px; font-weight: 700; margin: 1mm 0; }'
                + '.raddr { font-size: 15px; line-height: 1.35; flex: 1; }'
                + '.rfoot { display: flex; justify-content: space-between; align-items: flex-end; font-size: 14px; font-weight: 600; }'
                + '.post { font-size: 22px; font-weight: 700; letter-spacing: 3px; border: 1.5px solid #111; padding: 0 2mm; }'
                + '.track { font-size: 14px; font-weight: 700; margin-top: 2mm; border-top: 1px solid #ccc; padding-top: 1.5mm; }'
                + '.meta { font-size: 10px; color: #777; margin-top: 1mm; }';

            const w = window.open('', '_blank');
            if(!w) return alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาต pop-up แล้วลองอีกครั้ง');
            w.document.open();
            w.document.write('<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>ใบแปะหน้า</title>'
                + '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">'
                + '<style>' + css + '</style></head><body><div class="grid">' + body + '</div></body></html>');
            w.document.close();
            setTimeout(function() { w.focus(); w.print(); }, 800);
        }

        // ================= 🚚 Bee Move =================
        let lastShipJob = null;
        const BM_FIELDS = {
            'bm-auth-mode': 'authMode', 'bm-username': 'username', 'bm-sender-name': 'senderName', 'bm-sender-phone': 'senderPhone',
            'bm-sender-address': 'senderAddress', 'bm-sender-district': 'senderDistrict', 'bm-sender-city': 'senderCity',
            'bm-sender-province': 'senderProvince', 'bm-sender-postcode': 'senderPostcode', 'bm-pickup-id': 'pickupPointId',
            'bm-partner-kw': 'partnerKeyword', 'bm-pkg-name': 'packageName', 'bm-width': 'width', 'bm-length': 'length',
            'bm-height': 'height', 'bm-weight': 'weight', 'bm-notify-text': 'notifyText'
        };

        function bmUrl(path, extra) {
            return path + '?token=' + authToken + '&pageId=' + currentActivePageId + (extra || '');
        }

        async function loadBeemove() {
            const hookEl = document.getElementById('bm-webhook-url');
            if(!currentActivePageId) { hookEl.value = ''; hookEl.placeholder = 'กรุณาเลือกเพจก่อน (เมนูด้านซ้าย) ลิงก์จะสร้างให้อัตโนมัติ'; return; }
            let d;
            try { d = await (await fetch(bmUrl('/api/beemove/config'))).json(); }
            catch (e) { hookEl.placeholder = 'โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรชหน้า'; return; }
            if(!d.success) { hookEl.placeholder = d.error || 'โหลดข้อมูลไม่สำเร็จ'; return; }
            const c = d.config;
            Object.keys(BM_FIELDS).forEach(function(id) { document.getElementById(id).value = c[BM_FIELDS[id]] == null ? '' : c[BM_FIELDS[id]]; });
            if (!c.notifyText) document.getElementById('bm-notify-text').value = c.defaultNotifyText || '';
            document.getElementById('bm-api-key').value = '';
            document.getElementById('bm-password').value = '';
            document.getElementById('bm-key-state').innerText = c.hasKey ? '(บันทึกแล้ว: ' + c.apiKeyMasked + ')' : '(ยังไม่ได้ใส่)';
            document.getElementById('bm-pass-state').innerText = c.hasPassword ? '(บันทึกแล้ว)' : '(ยังไม่ได้ใส่)';
            if(!c.authMode) document.getElementById('bm-auth-mode').value = 'login';
            fillBmAccounts(c.accounts || [], c.accountId || '');
            fillBmPickups(c.pickupPoints || bmPickupCache, c.pickupPointId || '');
            document.getElementById('bm-webhook-url').value = window.location.origin + c.webhookPath;
            document.getElementById('bm-notify-status').checked = !!c.notifyStatus;
            const hooks = c.recentHooks || [];
            document.getElementById('bm-hook-count').innerText = hooks.length ? '(' + hooks.length + ')' : '(ยังไม่มี)';
            document.getElementById('bm-hook-list').innerHTML = hooks.map(function(h) {
                return '<div class="bg-white border border-slate-200 rounded-lg p-2"><div class="text-slate-400">' + escapeHtml(new Date(h.time).toLocaleString('th-TH')) + '</div><div class="font-mono break-all">' + escapeHtml(h.body) + '</div></div>';
            }).join('') || '<div class="text-slate-400">ยังไม่ได้รับข้อมูล</div>';
            document.getElementById('bm-notify').checked = !!c.notifyCustomer;
            const sel = document.getElementById('bm-partner-id');
            if(c.partnerId && !Array.from(sel.options).some(function(o) { return o.value === String(c.partnerId); })) {
                sel.innerHTML += '<option value="' + escapeHtml(c.partnerId) + '">ขนส่ง ID ' + escapeHtml(c.partnerId) + '</option>';
            }
            sel.value = c.partnerId || '';
        }

        function copyBmWebhook() {
            const v = document.getElementById('bm-webhook-url').value;
            navigator.clipboard.writeText(v).then(function() { alert('✅ คัดลอก Webhook URL แล้ว นำไปวางใน Bee Move ได้เลย'); }, function() { alert(v); });
        }

        let bmPickupCache = [];
        function fillBmPickups(points, selected) {
            const sel = document.getElementById('bm-pickup-id');
            sel.innerHTML = '<option value="">-- ใช้ที่อยู่แรกในบัญชี Bee Move --</option>';
            points.forEach(function(p) { sel.innerHTML += '<option value="' + escapeHtml(p.id) + '">' + escapeHtml((p.name ? p.name + ' · ' : '') + p.address) + '</option>'; });
            if(selected && !points.some(function(p) { return String(p.id) === String(selected); })) {
                sel.innerHTML += '<option value="' + escapeHtml(selected) + '">ที่อยู่ ID ' + escapeHtml(selected) + '</option>';
            }
            sel.value = selected || '';
        }

        function fillBmAccounts(accounts, selected) {
            const sel = document.getElementById('bm-account-id');
            sel.innerHTML = '<option value="">-- ร้านแรก (ค่าเริ่มต้น) --</option>';
            accounts.forEach(function(a) { sel.innerHTML += '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name || ('ร้าน ID ' + a.id)) + '</option>'; });
            if(selected && !accounts.some(function(a) { return String(a.id) === String(selected); })) {
                sel.innerHTML += '<option value="' + escapeHtml(selected) + '">ร้าน ID ' + escapeHtml(selected) + '</option>';
            }
            sel.value = selected || '';
        }

        function collectBeemove() {
            const body = {};
            Object.keys(BM_FIELDS).forEach(function(id) { body[BM_FIELDS[id]] = document.getElementById(id).value.trim(); });
            body.partnerId = document.getElementById('bm-partner-id').value;
            body.accountId = document.getElementById('bm-account-id').value;
            const pass = document.getElementById('bm-password').value;
            if(pass) body.password = pass;
            body.notifyCustomer = document.getElementById('bm-notify').checked;
            body.notifyStatus = document.getElementById('bm-notify-status').checked;
            const key = document.getElementById('bm-api-key').value.trim();
            if(key) body.apiKey = key;
            return body;
        }

        async function saveBeemove(silent) {
            if(!currentActivePageId) return alert('กรุณาเลือกเพจก่อน');
            const res = await fetch(bmUrl('/api/beemove/config'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectBeemove())
            });
            const d = await res.json();
            if(!d.success) return alert('❌ ' + d.error);
            if(silent !== true) alert('✅ บันทึกการตั้งค่า Bee Move แล้ว');
            await loadBeemove();
        }

        async function testBeemove() {
            await saveBeemove(true);
            const box = document.getElementById('bm-test-result');
            box.className = 'text-sm p-3 rounded-xl border bg-slate-50 border-slate-200 text-slate-600';
            box.classList.remove('hidden');
            box.innerText = 'กำลังทดสอบการเชื่อมต่อ...';
            const res = await fetch(bmUrl('/api/beemove/test'), { method: 'POST' });
            const d = await res.json();
            let html = '';
            if(d.accounts && d.accounts.length) {
                fillBmAccounts(d.accounts, document.getElementById('bm-account-id').value);
                if(d.accounts.length > 1) html += '<div>🏪 บัญชีนี้มี ' + d.accounts.length + ' ร้าน เลือกร้านที่ช่อง "ร้าน" แล้วกดบันทึก</div>';
            }
            if(d.pickupPoints) {
                bmPickupCache = d.pickupPoints;
                fillBmPickups(d.pickupPoints, document.getElementById('bm-pickup-id').value);
                if(d.pickupPoints.length) html += '<div>📍 พบที่อยู่รับสินค้า ' + d.pickupPoints.length + ' แห่ง (เลือกได้ในช่อง "ที่อยู่รับสินค้าใน Bee Move")</div>';
            }
            if(d.account) html += '<div>✅ เชื่อมต่อบัญชีสำเร็จ: <b>' + escapeHtml(d.account.name || '-') + '</b>' + (d.account.wallet != null ? ' · Wallet ' + fmtMoney(d.account.wallet) + ' บาท' : '') + '</div>';
            if(d.partners && d.partners.length) {
                html += '<div class="mt-2 font-semibold">ขนส่งที่ใช้ได้:</div><ul class="list-disc pl-5">';
                const sel = document.getElementById('bm-partner-id');
                const cur = sel.value;
                sel.innerHTML = '<option value="">-- ใช้ตามชื่อด้านซ้าย --</option>';
                d.partners.forEach(function(p) {
                    html += '<li>' + escapeHtml(p.name) + ' (ID ' + escapeHtml(p.id) + ')' + (p.price != null ? ' · ' + fmtMoney(p.price) + ' บาท' : '') + (p.usable ? '' : ' · ใช้ไม่ได้') + '</li>';
                    if(p.usable) sel.innerHTML += '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>';
                });
                html += '</ul>';
                sel.value = cur;
            }
            (d.warnings || []).forEach(function(w) { html += '<div class="text-amber-700">⚠️ ' + escapeHtml(w) + '</div>'; });
            box.className = 'text-sm p-3 rounded-xl border ' + (d.success ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700');
            box.innerHTML = html || '❌ เชื่อมต่อไม่สำเร็จ';
        }

        function writeWaitPage(w, text) {
            try {
                w.document.open();
                w.document.write('<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>ใบแปะหน้า Bee Move</title></head>'
                    + '<body style="font-family:sans-serif;text-align:center;padding-top:60px;color:#334155"><h3>' + escapeHtml(text) + '</h3></body></html>');
                w.document.close();
            } catch(e) {}
        }

        async function openBeemoveLabel(w, orderIds) {
            writeWaitPage(w, 'กำลังโหลดใบแปะหน้า A6 จาก Bee Move...');
            try {
                const res = await fetch(bmUrl('/api/beemove/label', '&size=A6&ids=' + encodeURIComponent(orderIds.join(','))));
                if(!res.ok) {
                    let msg = 'HTTP ' + res.status;
                    try { msg = (await res.json()).error || msg; } catch(e) {}
                    writeWaitPage(w, '❌ ' + msg);
                    return;
                }
                const blob = await res.blob();
                w.location.href = URL.createObjectURL(blob);
            } catch(e) {
                writeWaitPage(w, '❌ ดึงใบแปะหน้าไม่สำเร็จ: ' + e.message);
            }
        }

        function selectedBeemoveIds() {
            return getSelectedBuyers().filter(function(b) { return b.beemoveOrderId; }).map(function(b) { return b.beemoveOrderId; });
        }

        async function printBeemoveLabels() {
            const ids = selectedBeemoveIds();
            if(!ids.length) return alert('ลูกค้าที่เลือกยังไม่มีพัสดุใน Bee Move กด "สร้างเลขพัสดุ + พิมพ์ใบแปะหน้า A6" ก่อน');
            const w = window.open('', '_blank');
            if(!w) return alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาต pop-up แล้วลองอีกครั้ง');
            openBeemoveLabel(w, ids);
        }

        async function createShipmentsAndPrint() {
            if(!currentLiveId) return;
            const list = getSelectedBuyers();
            if(!list.length) return alert('กรุณาเลือกลูกค้าอย่างน้อย 1 คน');
            const todo = list.filter(function(b) { return !b.trackingNo && !b.beemoveOrderId; });
            const noAddr = todo.filter(function(b) { return !b.address; }).length;
            let msg = 'สร้างพัสดุใน Bee Move ' + todo.length + ' รายการ (มีเลขพัสดุแล้ว ' + (list.length - todo.length) + ' รายการ จะไม่สร้างซ้ำ)';
            if(noAddr) msg += NL + '⚠️ มี ' + noAddr + ' คนที่ยังไม่มีที่อยู่ จะสร้างไม่สำเร็จ';
            msg += NL + NL + 'ระบบจะตัดค่าส่งจาก Wallet ของ Bee Move ยืนยันหรือไม่?';
            if(todo.length && !confirm(msg)) return;

            // เปิดหน้าต่างไว้ก่อน (กันเบราว์เซอร์บล็อก pop-up) แล้วค่อยใส่ใบแปะหน้าเมื่อสร้างเสร็จ
            const w = window.open('', '_blank');
            if(!w) return alert('เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาต pop-up แล้วลองอีกครั้ง');
            const uids = list.map(function(b) { return b.userId; });

            if(todo.length) {
                writeWaitPage(w, 'กำลังสร้างเลขพัสดุใน Bee Move...');
                const res = await fetch(liveUrl('/api/live/beemove/create', '&sid=' + currentLiveId), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: todo.map(function(b) { return b.userId; }), labelUserIds: uids })
                });
                let d = await res.json();
                if(!d.success && d.duplicates && d.duplicates.length) {
                    // 🛡️ กันสร้างใบแปะหน้าซ้ำ: เคยสร้างพัสดุให้คนนี้แล้วภายใน 1 วัน
                    let dm = '⚠️ พบ ' + d.duplicates.length + ' คนที่เคยสร้างพัสดุไปแล้วภายใน 1 วัน (24 ชม.):' + NL;
                    d.duplicates.slice(0, 15).forEach(function(x) { dm += '• ' + x.name + ' · ' + (x.trackingNo || 'รอเลขพัสดุ') + ' (' + x.session + ' ' + new Date(x.at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) + ')' + NL; });
                    dm += NL + 'กด "ตกลง" = สร้างใหม่ทั้งหมด (ซ้ำ)' + NL + 'กด "ยกเลิก" = ข้ามคนที่ซ้ำ สร้างเฉพาะคนที่เหลือ';
                    const dupIds = d.duplicates.map(function(x) { return x.userId; });
                    const again = confirm(dm);
                    const sendIds = todo.map(function(b) { return b.userId; }).filter(function(id) { return again || dupIds.indexOf(id) < 0; });
                    if(!sendIds.length) { w.close(); return alert('ไม่มีรายการที่ต้องสร้างใหม่'); }
                    d = await (await fetch(liveUrl('/api/live/beemove/create', '&sid=' + currentLiveId), {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userIds: sendIds, labelUserIds: uids, force: true })
                    })).json();
                }
                if(!d.success) { w.close(); return alert('❌ ' + d.error); }
                lastShipJob = null; // ไม่ใช้สถานะของรอบก่อน
                if(buyersPoll) clearInterval(buyersPoll);
                buyersPoll = setInterval(function() { loadBuyers(true); }, 2000);
                const sid = currentLiveId;
                for(let i = 0; i < 1800; i++) {
                    await new Promise(function(r) { setTimeout(r, 1000); });
                    if(sid !== currentLiveId) return;
                    await loadBuyers();
                    if(lastShipJob) writeWaitPage(w, '⏳ ' + lastShipJob.message + ' (' + lastShipJob.done + '/' + lastShipJob.total + ')');
                    if(lastShipJob && !lastShipJob.running) break;
                }
            }
            await loadBuyers();
            const ids = buyersList.filter(function(b) { return uids.indexOf(b.userId) >= 0 && b.beemoveOrderId; })
                .map(function(b) { return b.beemoveOrderId; });
            if(!ids.length) {
                writeWaitPage(w, '❌ ไม่มีพัสดุที่สร้างสำเร็จ ดูสาเหตุในช่องเลขพัสดุของตาราง');
                return;
            }
            openBeemoveLabel(w, ids);
        }
        // =========================================================

        function switchTab(tabId) {
            ['dashboard', 'slip', 'broadcast', 'live', 'beemove', 'webhook'].forEach(id => {
                document.getElementById('tab-' + id).classList.add('hidden');
                document.getElementById('nav-' + id).className = "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50";
            });
            document.getElementById('tab-' + tabId).classList.remove('hidden');
            if(tabId === 'beemove') loadBeemove();
            if(tabId === 'broadcast') loadBroadcastInfo();
            if(tabId === 'live') { loadLiveList(); startLivePolling(); if (!pageLabels.length) loadLiveBcLabels(); else { renderLiveBcLabels(); renderKwLabels(); } } else { stopLivePolling(); }
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

            document.getElementById('btn-start-bc').disabled = true;
            document.getElementById('btn-start-bc').innerText = 'กำลังรวบรวมผู้รับ...';
            const res = await fetch('/api/broadcast/start?token=' + authToken + '&pageId=' + currentActivePageId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, delaySec, batchSize, pauseMin })
            });
            const data = await res.json();
            document.getElementById('btn-start-bc').disabled = false;
            document.getElementById('btn-start-bc').innerText = 'เริ่มส่งบรอดแคส';
            if(data.success) {
                showBroadcastRunning();
            } else {
                alert('เกิดข้อผิดพลาด: ' + data.error);
            }
        }

        function showBroadcastRunning() {
            document.getElementById('bc-progress-area').classList.remove('hidden');
            document.getElementById('btn-start-bc').classList.add('hidden');
            document.getElementById('btn-stop-bc').classList.remove('hidden');
            if (statusInterval) clearInterval(statusInterval);
            statusInterval = setInterval(checkBroadcastStatus, 1500);
            checkBroadcastStatus();
        }

        // เปิดแท็บบรอดแคส: นับผู้รับที่ส่งได้จริง (ทักมาใน 24 ชม.) และกลับมาดูความคืบหน้าถ้ากำลังส่งอยู่
        async function loadBroadcastInfo() {
            if(!currentActivePageId) return;
            const el = document.getElementById('subscriber-count');
            el.innerText = 'กำลังนับ...';
            try {
                const r = await (await fetch('/api/broadcast/recipients?token=' + authToken + '&pageId=' + currentActivePageId)).json();
                el.innerText = r.success ? (r.count + ' คน') : '-';
                el.title = r.fbError ? ('ดึงรายการแชทไม่สำเร็จ: ' + r.fbError) : '';
            } catch (e) { el.innerText = '-'; }
            try {
                const st = await (await fetch('/api/broadcast/status?token=' + authToken + '&pageId=' + currentActivePageId)).json();
                if (st.isBroadcasting) showBroadcastRunning();
                else if (st.total) { document.getElementById('bc-progress-area').classList.remove('hidden'); renderBroadcastStatus(st); }
            } catch (e) {}
        }

        async function stopBroadcast() {
            await fetch('/api/broadcast/stop?token=' + authToken + '&pageId=' + currentActivePageId, { method: 'POST' });
            alert('ส่งคำสั่งหยุดบรอดแคสเรียบร้อยแล้ว');
        }

        function renderBroadcastStatus(status) {
            let txt = status.statusMessage || '';
            const errs = status.errors || {};
            const keys = Object.keys(errs);
            if (keys.length) txt += ' | ส่งไม่สำเร็จเพราะ: ' + keys.map(function(k) { return k + ' (' + errs[k] + ')'; }).join(', ');
            document.getElementById('bc-status-text').innerText = txt;
            document.getElementById('bc-numbers').innerText = (status.current || 0) + '/' + (status.total || 0) + ' (สำเร็จ: ' + (status.success || 0) + ', ล้มเหลว: ' + (status.failed || 0) + ')';
            const pct = status.total > 0 ? (status.current / status.total) * 100 : 0;
            document.getElementById('bc-progress-bar').style.width = pct + '%';
        }

        async function checkBroadcastStatus() {
            const res = await fetch('/api/broadcast/status?token=' + authToken + '&pageId=' + currentActivePageId);
            const status = await res.json();
            renderBroadcastStatus(status);

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
// ผูก/ตรวจสอบ Webhook ของเพจ (เทียบเท่าการยิง POST {PAGE_ID}/subscribed_apps ใน Graph API Explorer)
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
    // เพจอยู่ในระบบแล้ว: อัปเดต Token ใหม่ (เช่น หลังขอสิทธิ์เพิ่ม) โดยไม่ต้องลบเพจทิ้ง
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
    inboxLog: new Map(),
    psidMap: new Map(),
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

  const { beemove, ...publicConfig } = pageData.config;
  res.json({ 
    success: true, 
    config: publicConfig, 
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

// 🔑 แลก User Token อายุสั้น (1-2 ชม.) เป็นอายุยาว (60 วัน)
// Page Token ที่ดึงจาก User Token อายุยาว จะ "ไม่มีวันหมดอายุ"
// ต้องตั้งค่า Environment Variable ใน Render: FB_APP_SECRET (และ FB_APP_ID ถ้าใช้แอปอื่น)
const FB_APP_ID = process.env.FB_APP_ID || defaultPageConfig.appId;
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';

async function toLongLivedUserToken(userToken) {
  if (!FB_APP_SECRET) return { token: userToken, longLived: false, error: 'ยังไม่ได้ตั้งค่า FB_APP_SECRET ใน Render' };
  try {
    const r = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: FB_APP_ID, client_secret: FB_APP_SECRET, fb_exchange_token: userToken },
      timeout: 10000
    });
    return { token: r.data.access_token, longLived: true, expiresIn: r.data.expires_in };
  } catch (err) {
    return { token: userToken, longLived: false, error: err.response?.data?.error?.message || err.message };
  }
}

// ตรวจอายุ Token (expires_at = 0 แปลว่าไม่หมดอายุ)
async function inspectToken(token) {
  if (!FB_APP_SECRET || !token) return null;
  try {
    const r = await axios.get('https://graph.facebook.com/v19.0/debug_token', {
      params: { input_token: token, access_token: FB_APP_ID + '|' + FB_APP_SECRET },
      timeout: 10000
    });
    const d = r.data?.data || {};
    return { valid: !!d.is_valid, expiresAt: d.expires_at || 0, neverExpires: d.is_valid && !d.expires_at };
  } catch (e) { return null; }
}

app.post('/api/fetch-pages', async (req, res) => {
  const { userAccessToken } = req.body;
  if (!userAccessToken) return res.json({ success: false, error: 'ไม่พบ Access Token' });

  const ll = await toLongLivedUserToken(userAccessToken);
  if (!ll.longLived) console.log('⚠️ [Token] แลก Token อายุยาวไม่สำเร็จ:', ll.error);

  try {
    const response = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token: ll.token, fields: 'id,name,access_token,category', limit: 100 },
      timeout: 10000
    });
    const pages = response.data.data || [];
    const check = pages[0] ? await inspectToken(pages[0].access_token) : null;
    res.json({
      success: true,
      pages,
      userAccessToken: ll.token,
      longLived: ll.longLived,
      neverExpires: !!check?.neverExpires,
      warning: ll.longLived ? '' : ('Token ยังเป็นแบบอายุสั้น (หมดใน 1-2 ชม.) สาเหตุ: ' + ll.error)
    });
  } catch (err) {
    res.json({ success: false, error: err.response?.data?.error?.message || err.message });
  }
});

// เช็กอายุ Page Token ของเพจที่เพิ่มไว้แล้ว
app.get('/api/page-token-status', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const info = await inspectToken(pageData.config.pageAccessToken);
  if (!info) return res.json({ success: false, error: FB_APP_SECRET ? 'ตรวจสอบไม่สำเร็จ' : 'ยังไม่ได้ตั้งค่า FB_APP_SECRET' });
  res.json({ success: true, ...info });
});

// 🧾 สถานะผู้ให้บริการตรวจสลิป (โควตาคงเหลือ / error ล่าสุด)
// 👤 ชื่อเฟสของลูกค้าจาก ID แชท (PSID): หาจากรายชื่อในไลฟ์ก่อน ถ้าไม่เจอถาม Facebook แล้วจำไว้
function knownNameForPsid(pageData, psid) {
  psid = String(psid || '');
  if (!psid) return '';
  const cache = pageData.psidNames || (pageData.psidNames = {});
  if (cache[psid]) return cache[psid];
  for (const ls of Object.values(pageData.liveSessions || {})) {
    for (const c of ls.commenters ? ls.commenters.values() : []) if (c && c.psid === psid && c.name) return (cache[psid] = c.name);
    if (ls.buyers) for (const b of ls.buyers.values()) if (b && b.psid === psid && b.fbName) return (cache[psid] = b.fbName);
  }
  return '';
}
async function nameForPsid(pageData, psid) {
  const known = knownNameForPsid(pageData, psid);
  if (known || !pageData.config.pageAccessToken) return known;
  try {
    const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(psid), { params: { fields: 'name', access_token: pageData.config.pageAccessToken }, timeout: 5000 });
    const n = r.data && r.data.name ? String(r.data.name) : '';
    if (n) {
      const cache = pageData.psidNames || (pageData.psidNames = {});
      cache[psid] = n;
      const keys = Object.keys(cache);
      if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete cache[k];
    }
    return n;
  } catch (e) { return ''; }
}

app.get('/api/slip/status', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const attempts = (pageData.slipAttempts || []).slice(0, 30);
  // เติมชื่อเฟสของคนส่ง (ถาม Facebook เฉพาะคนที่ยังไม่รู้ชื่อ ไม่เกิน 10 คนต่อครั้ง)
  const missing = Array.from(new Set(attempts.filter(a => a.senderId && !a.name && !knownNameForPsid(pageData, a.senderId)).map(a => a.senderId))).slice(0, 10);
  await Promise.all(missing.map(id => nameForPsid(pageData, id)));
  for (const a of attempts) if (!a.name && a.senderId) { const n = knownNameForPsid(pageData, a.senderId); if (n) a.name = n; }
  res.json({ success: true, provider: pageData.config.slipProvider || 'zwiz', quota: pageData.slipQuota || null, lastError: pageData.lastSlipError || null, attempts });
});

// 🏷️ รายชื่อป้ายกำกับที่มีอยู่ในเพจ (ตัวเลือกในหน้าตั้งค่าสลิป)
// 🧹 เครื่องมือป้ายซ้ำ: ป้ายชื่อเดียวกันที่มีหลาย ID + รายชื่อลูกค้าที่ใช้ทดสอบได้
app.get('/api/labels/duplicates', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  try {
    const labels = await listPageLabels(pageData);
    const dups = labels.filter(l => l.ids.length > 1).map(l => ({ name: l.name, ids: l.ids }));
    // คนที่ใช้ทดสอบได้ (มี ID แชท): จากคนคอมเมนต์ในไลฟ์ (ล่าสุดก่อน)
    const people = new Map();
    for (const ls of Object.values(pageData.liveSessions || {})) {
      for (const c of ls.commenters.values()) if (c.psid) people.set(c.psid, { psid: c.psid, name: c.name || c.psid, time: c.lastTime || 0 });
      for (const b of (ls.buyers || new Map()).values()) if (b.psid && !people.has(b.psid)) people.set(b.psid, { psid: b.psid, name: b.fbName || b.psid, time: 0 });
    }
    res.json({ success: true, duplicates: dups, people: Array.from(people.values()).sort((a, b) => b.time - a.time).slice(0, 100) });
  } catch (e) {
    res.json({ success: false, error: graphErrorMessage(e) });
  }
});

// ทดสอบ: ติด / ถอด ป้าย "ID เดียว" กับบัญชีที่เลือก (ไม่ขยายไปป้ายชื่อเดียวกัน)
app.post('/api/labels/test', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const labelId = String(req.body.labelId || '');
  const psid = String(req.body.psid || '').trim();
  if (!labelId || !psid) return res.json({ success: false, error: 'กรุณาเลือกบัญชีทดสอบ' });
  try {
    await setInboxLabelById(pageData, psid, labelId, !!req.body.remove);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: graphErrorMessage(e) });
  }
});

// ลบป้าย 1 ID (อนุญาตเฉพาะป้ายที่ยังมีชื่อเดียวกันเหลืออยู่ กันลบป้ายสุดท้าย)
app.post('/api/labels/delete', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const labelId = String(req.body.labelId || '');
  try {
    const labels = await listPageLabels(pageData);
    const group = labels.find(l => l.ids.includes(labelId));
    if (!group) return res.json({ success: false, error: 'ไม่พบป้ายนี้ในเพจ (อาจถูกลบไปแล้ว)' });
    if (group.ids.length < 2) return res.json({ success: false, error: 'ป้าย "' + group.name + '" เหลืออันเดียวแล้ว ไม่อนุญาตให้ลบจากที่นี่' });
    await axios.delete('https://graph.facebook.com/v19.0/' + encodeURIComponent(labelId), {
      params: { access_token: pageData.config.pageAccessToken }, timeout: 15000
    });
    // เปลี่ยน ID ที่ถูกลบในการตั้งค่า -> เป็นป้ายชื่อเดียวกันที่เหลืออยู่
    const keep = group.ids.find(id => id !== labelId);
    const fix = (list) => (Array.isArray(list) ? list : []).forEach(l => { if (l && String(l.id) === labelId) l.id = keep; });
    const cfg = pageData.config;
    fix(cfg.keywordLabels); fix(cfg.keywordRemoveLabels);
    for (const rule of Object.values(cfg.slipLabels || {})) { fix(rule && rule.add); fix(rule && rule.remove); }
    for (const ls of Object.values(pageData.liveSessions || {})) { fix(ls.config.keywordLabels); fix(ls.config.keywordRemoveLabels); }
    pageData.labelGroups = null; // โหลดรายชื่อป้ายใหม่ครั้งถัดไป
    res.json({ success: true, name: group.name, kept: keep });
  } catch (e) {
    res.json({ success: false, error: graphErrorMessage(e) });
  }
});

app.get('/api/labels', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  if (!pageData.config.pageAccessToken) return res.json({ success: false, error: 'เพจนี้ยังไม่มี Page Access Token' });
  try {
    res.json({ success: true, labels: await listPageLabels(pageData), lastError: pageData.lastLabelError || '' });
  } catch (e) {
    res.json({ success: false, error: graphErrorMessage(e) });
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
// ⚠️ กฎ Facebook: ส่งข้อความหาลูกค้าได้เฉพาะคนที่ "ทักแชทมาภายใน 24 ชั่วโมง" เท่านั้น
// คนที่เกิน 24 ชม. Facebook จะปฏิเสธ (ส่งโปรโมชันนอกเวลา 24 ชม. ต้องใช้ Marketing Messages ใน Meta Business Suite)
const BC_WINDOW_MS = 24 * 3600 * 1000;

// รวบรวมผู้รับที่อยู่ในช่วง 24 ชม.: จากรายการแชทของ Facebook (ไม่หายแม้เซิร์ฟเวอร์รีสตาร์ท) + ข้อความที่เข้ามาทาง Webhook
async function collectBroadcastRecipients(pageData) {
  const cfg = pageData.config;
  const pageId = String(cfg.pageId || '');
  const cutoff = Date.now() - BC_WINDOW_MS;
  const ids = new Map(); // psid -> เวลาล่าสุด
  let fbError = '';

  if (cfg.pageAccessToken && pageId) {
    let url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(pageId) + '/conversations';
    let params = { platform: 'messenger', fields: 'participants,updated_time', limit: 100, access_token: cfg.pageAccessToken };
    try {
      for (let i = 0; i < 30 && url; i++) {
        const r = await axios.get(url, { params, timeout: 15000 });
        let older = false;
        for (const conv of r.data.data || []) {
          const t = Date.parse(conv.updated_time || '') || 0;
          if (t < cutoff) { older = true; continue; }
          for (const p of conv.participants?.data || []) {
            if (String(p.id) !== pageId) ids.set(String(p.id), Math.max(ids.get(String(p.id)) || 0, t));
          }
        }
        if (older) break; // รายการเรียงจากใหม่ไปเก่า เจอเก่ากว่า 24 ชม. แล้วหยุด
        url = r.data.paging?.next || null;
        params = undefined;
      }
    } catch (e) {
      fbError = graphErrorMessage(e);
    }
  }
  for (const [psid, t] of (pageData.lastInbound || new Map())) {
    if (t >= cutoff) ids.set(psid, Math.max(ids.get(psid) || 0, t));
  }
  return { recipients: Array.from(ids.keys()), fbError };
}

// เก็บสาเหตุที่ส่งไม่สำเร็จ ให้แอดมินเห็น
function recordBroadcastError(st, err) {
  const e = err.response?.data?.error || {};
  let reason = e.message || err.message || 'ไม่ทราบสาเหตุ';
  if (e.error_subcode === 2018278 || e.code === 10 || /outside of allowed window/i.test(reason)) reason = 'เกิน 24 ชม. หลังลูกค้าทักล่าสุด (กฎ Facebook)';
  else if (e.code === 551 || e.error_subcode === 1545041) reason = 'ลูกค้าไม่รับข้อความ / บล็อกเพจ';
  else if (e.code === 100 && /No matching user/i.test(reason)) reason = 'ไม่ใช่ ID แชทของลูกค้า';
  else if (e.code === 190) reason = 'Token หมดอายุ (เพิ่มเพจใหม่)';
  else if (e.code === 613 || e.code === 4 || e.code === 32) reason = 'ส่งถี่เกินไป Facebook จำกัดชั่วคราว (เพิ่มเวลาหน่วง)';
  st.errors = st.errors || {};
  st.errors[reason] = (st.errors[reason] || 0) + 1;
}

app.get('/api/broadcast/recipients', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const r = await collectBroadcastRecipients(pageData);
  res.json({ success: true, count: r.recipients.length, fbError: r.fbError });
});

app.post('/api/broadcast/start', checkAuth, async (req, res) => {
  const username = req.userId;
  const pageId = req.query.pageId;
  const message = String(req.body.message || '').trim();
  const delaySec = Math.max(1, parseInt(req.body.delaySec) || 3);
  const batchSize = Math.max(1, parseInt(req.body.batchSize) || 20);
  const pauseMin = Math.max(1, parseInt(req.body.pauseMin) || 10);

  const pageData = usersDB[username]?.pages[pageId];
  if (!pageData) return res.json({ success: false, error: 'กรุณาเลือกเพจก่อนทำรายการ' });
  if (!message) return res.json({ success: false, error: 'กรุณากรอกข้อความบรอดแคส' });
  if (!pageData.config.pageAccessToken) return res.json({ success: false, error: 'เพจนี้ยังไม่มี Page Access Token' });
  if (pageData.broadcastStatus.isBroadcasting) return res.json({ success: false, error: 'กำลังรันบรอดแคสอยู่แล้ว' });

  const { recipients: subList, fbError } = await collectBroadcastRecipients(pageData);
  if (subList.length === 0) {
    return res.json({ success: false, error: 'ไม่มีลูกค้าที่ทักแชทมาภายใน 24 ชม. (Facebook อนุญาตให้ส่งเฉพาะกลุ่มนี้)' + (fbError ? ' | ' + fbError : '') });
  }

  pageData.broadcastStatus = { isBroadcasting: true, total: subList.length, current: 0, success: 0, failed: 0, errors: {}, statusMessage: 'กำลังเริ่มส่ง...', shouldStop: false };
  res.json({ success: true, total: subList.length });

  (async () => {
    const st = pageData.broadcastStatus;
    let currentBatchCount = 0;
    for (let i = 0; i < subList.length; i++) {
      if (st.shouldStop) break;
      const recipientId = subList[i];
      st.current = i + 1;
      st.statusMessage = 'กำลังส่งหาผู้รับที่ ' + (i + 1) + '/' + subList.length + '...';

      try {
        await axios.post('https://graph.facebook.com/v19.0/me/messages', {
          recipient: { id: recipientId },
          messaging_type: 'RESPONSE',
          message: { text: message }
        }, {
          params: { access_token: pageData.config.pageAccessToken },
          timeout: 15000
        });
        st.success++;
      } catch (err) {
        st.failed++;
        recordBroadcastError(st, err);
        if (err.response?.data?.error?.code === 190) { st.statusMessage = '❌ Token หมดอายุ หยุดส่ง'; st.shouldStop = true; break; }
      }

      currentBatchCount++;
      if (currentBatchCount >= batchSize && (i + 1) < subList.length) {
        currentBatchCount = 0;
        for (let m = pauseMin; m > 0; m--) {
          if (st.shouldStop) break;
          st.statusMessage = '⏳ พักระบบ ' + m + ' นาที...';
          for (let k = 0; k < 12 && !st.shouldStop; k++) await sleep(5000); // เช็กปุ่มหยุดทุก 5 วิ
        }
      } else if ((i + 1) < subList.length) {
        await sleep(delaySec * 1000);
      }
    }
    st.isBroadcasting = false;
    if (st.shouldStop) { if (!/Token/.test(st.statusMessage)) st.statusMessage = '⏹️ หยุดบรอดแคสแล้ว'; }
    else st.statusMessage = '✅ บรอดแคสเสร็จสิ้น';
  })().catch(e => {
    pageData.broadcastStatus.isBroadcasting = false;
    pageData.broadcastStatus.statusMessage = '❌ เกิดข้อผิดพลาด: ' + e.message;
  });
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

// รับได้ทั้ง Video ID ตรงๆ หรือลิงก์ไลฟ์ แล้วดึงเฉพาะ ID ออกมา
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

// หา session ที่ตรงกับคอมเมนต์: 1) ตรงกับ Video/Post ID  2) session แบบเปิดเองที่ active ล่าสุด
function findLiveSessionForComment(pageData, postId, videoId) {
  const active = Object.values(getLiveSessions(pageData)).filter(s => s.status === 'active');
  const ids = [postId, videoId].filter(Boolean).map(String);
  const byVideo = active.find(s => s.videoId && ids.some(id =>
    id === s.videoId || id.endsWith('_' + s.videoId) || s.videoId.endsWith('_' + id)));
  if (byVideo) return byVideo;
  const manual = active.filter(s => !s.videoId).sort((a, b) => b.startedAt - a.startedAt);
  return manual[0] || null;
}

// หาข้อมูลคนคอมเมนต์จาก ID ผู้ส่งในแชท (PSID) ซึ่งอาจไม่ตรงกับ ID ในคอมเมนต์
function findCommenterBySender(s, senderId) {
  const direct = s.commenters.get(senderId);
  if (direct) return direct;
  for (const c of s.commenters.values()) if (c.psid === senderId) return c;
  return null;
}

// หา session ของลูกค้าที่ส่งสลิป: session ล่าสุดที่เขาเคยคอมเมนต์ ถ้าไม่เจอใช้ session ที่ active ล่าสุด
function findLiveSessionForSender(pageData, senderId) {
  const all = Object.values(getLiveSessions(pageData));
  let best = null, bestTime = 0;
  for (const s of all) {
    const c = findCommenterBySender(s, senderId);
    if (c && c.lastTime > bestTime) { best = s; bestTime = c.lastTime; }
  }
  if (best) return best;
  const active = all.filter(s => s.status === 'active').sort((a, b) => b.startedAt - a.startedAt);
  return active[0] || null;
}

// ⚡ จัดกลุ่มสลิปตามผู้ส่งครั้งเดียวต่อคำขอ (เดิมวนสลิปทั้งหมดใหม่ทุกคน)
function buildSlipIndex(pageData, s) {
  const since = s.firstStartedAt || s.startedAt || 0;
  const idx = new Map();
  const add = (x) => {
    if (!x || (x.time || 0) < since) return;
    const k = String(x.senderId);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(x);
  };
  (s.slips || []).forEach(add);
  (pageData.slipLog || []).forEach(add);
  return idx;
}

function paymentStatusFromIndex(idx, userId, psid) {
  const seen = new Set();
  let total = 0, count = 0, last = 0;
  for (const k of [String(userId), psid ? String(psid) : '']) {
    if (!k) continue;
    for (const x of idx.get(k) || []) {
      if (seen.has(x.transRef)) continue;
      seen.add(x.transRef); total += Number(x.amount) || 0; count++; last = Math.max(last, x.time || 0);
    }
  }
  return { paid: count > 0, paidTotal: total, slipCount: count, lastSlipTime: last };
}

// สถานะโอนเงินของลูกค้าใน session: สลิปที่ตรวจผ่านตั้งแต่เริ่ม session (หรือที่ถูกบันทึกเข้า session นี้)
function paymentStatus(pageData, s, userId, psid) {
  const ids = new Set([String(userId), psid ? String(psid) : ''].filter(Boolean));
  const seen = new Set();
  let total = 0, count = 0, last = 0;
  const add = (x) => {
    if (!x || !ids.has(String(x.senderId)) || seen.has(x.transRef)) return;
    seen.add(x.transRef); total += Number(x.amount) || 0; count++; last = Math.max(last, x.time || 0);
  };
  // นับเฉพาะสลิปที่เข้ามาหลังกด "เริ่ม session" เท่านั้น (ก่อนกดเริ่มจะไม่นับ)
  const since = s.firstStartedAt || s.startedAt || 0;
  const inRange = (x) => (x.time || 0) >= since;
  (s.slips || []).forEach(x => { if (inRange(x)) add(x); });
  (pageData.slipLog || []).forEach(x => { if (inRange(x)) add(x); });
  return { paid: count > 0, paidTotal: total, slipCount: count, lastSlipTime: last };
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
    },
    finance: { cost: Number(s.finance?.cost) || 0, ads: Number(s.finance?.ads) || 0, shipping: Number(s.finance?.shipping) || 0 }
  };
}

function getLiveContext(req, res) {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) { res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' }); return null; }
  const live = getLiveSessions(pageData)[req.query.sid];
  return { pageData, live };
}

// 💬 หน้าต่างแชทในแดชบอร์ด: อ่านข้อความ / ตอบลูกค้า ผ่าน Graph API
function chatTarget(req) {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return null;
  const uid = String(req.query.uid || '');
  const live = req.query.sid ? getLiveSessions(pageData)[req.query.sid] : null;
  const c = live && uid ? live.commenters.get(uid) : null;
  const psid = String(req.query.psid || (c && c.psid) || (uid && getPsidMap(pageData).get(uid)) || '');
  return { pageData, pid: pageData.config.pageId || req.query.pageId, uid, live, c, psid };
}
const convIdCache = new Map();
async function findChatConversationId(pageData, pid, psid) {
  const key = pid + ':' + psid;
  const hit = convIdCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600000) return hit.id;
  const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(pid) + '/conversations', {
    params: { platform: 'messenger', user_id: psid, fields: 'id', access_token: pageData.config.pageAccessToken }, timeout: 15000
  });
  const id = ((r.data && r.data.data) || [])[0]?.id || '';
  if (id) { convIdCache.set(key, { id, at: Date.now() }); if (convIdCache.size > 5000) convIdCache.delete(convIdCache.keys().next().value); }
  return id;
}

app.get('/api/chat/messages', checkAuth, async (req, res) => {
  const t = chatTarget(req);
  if (!t) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  if (!t.pageData.config.pageAccessToken) return res.json({ success: false, error: 'เพจไม่มี Token' });
  const pending = t.c && Array.isArray(t.c.pendingComments) ? t.c.pendingComments.filter(x => Date.now() - x.time < 7 * 86400000) : [];
  if (!t.psid) return res.json({ success: true, psid: '', messages: [], canReply: false, canPrivateReply: pending.length > 0 });
  try {
    const convId = await findChatConversationId(t.pageData, t.pid, t.psid);
    let messages = [];
    if (convId) {
      const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(convId) + '/messages', {
        params: { fields: 'id,message,from,created_time,attachments{mime_type,name,file_url,image_data{url,preview_url}},sticker', limit: 50, access_token: t.pageData.config.pageAccessToken }, timeout: 15000
      });
      messages = ((r.data && r.data.data) || []).map(m => {
        const images = [], files = [];
        for (const a of (m.attachments && m.attachments.data) || []) {
          if (a.image_data && (a.image_data.url || a.image_data.preview_url)) images.push(a.image_data.url || a.image_data.preview_url);
          else if (a.file_url) files.push({ url: a.file_url, name: a.name || '' });
        }
        if (m.sticker) images.push(m.sticker);
        return { id: m.id, text: m.message || '', time: Date.parse(m.created_time) || 0, fromPage: String(m.from?.id || '') === String(t.pid), images, files };
      }).reverse();
    }
    const li = t.pageData.lastInbound && t.pageData.lastInbound.get(t.psid);
    const lastCust = messages.filter(m => !m.fromPage).reduce((a, m) => Math.max(a, m.time), 0);
    const lastInbound = Math.max(li || 0, lastCust);
    res.json({ success: true, psid: t.psid, convId, messages, lastInbound, canReply: !!lastInbound && Date.now() - lastInbound < 24 * 3600000, canPrivateReply: false });
  } catch (e) {
    res.json({ success: false, error: graphErrorMessage(e) });
  }
});

app.post('/api/chat/send', checkAuth, async (req, res) => {
  const t = chatTarget(req);
  if (!t) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.json({ success: false, error: 'กรุณาพิมพ์ข้อความ' });
  const token = t.pageData.config.pageAccessToken;
  if (!token) return res.json({ success: false, error: 'เพจไม่มี Token' });
  try {
    if (t.psid) {
      await fbPost('https://graph.facebook.com/v19.0/me/messages', { recipient: { id: t.psid }, messaging_type: 'RESPONSE', message: { text } }, { access_token: token });
      return res.json({ success: true, psid: t.psid });
    }
    // ยังไม่มีแชท: ส่งข้อความแรกแบบตอบกลับคอมเมนต์ (Private Reply · 1 ครั้งต่อคอมเมนต์ ภายใน 7 วัน)
    const pending = t.c && Array.isArray(t.c.pendingComments) ? t.c.pendingComments.filter(x => Date.now() - x.time < 7 * 86400000) : [];
    const pc = pending[pending.length - 1];
    if (!pc) return res.json({ success: false, error: 'ลูกค้ายังไม่มีแชทกับเพจ และไม่มีคอมเมนต์ที่ส่งข้อความส่วนตัวได้' });
    const r = await fbPost('https://graph.facebook.com/v19.0/me/messages', { recipient: { comment_id: pc.id }, message: { text } }, { access_token: token });
    t.c.pendingComments = t.c.pendingComments.filter(x => x.id !== pc.id);
    const psid = r.data && r.data.recipient_id ? String(r.data.recipient_id) : '';
    if (psid) { t.c.psid = psid; getPsidMap(t.pageData).set(t.uid, psid); }
    res.json({ success: true, psid });
  } catch (e) {
    const code = e.response?.data?.error?.code, sub = e.response?.data?.error?.error_subcode;
    if (code === 10 || sub === 2018278) return res.json({ success: false, error: 'ส่งไม่ได้: เกิน 24 ชม. หลังลูกค้าทักล่าสุด (กฎ Facebook) ให้รอลูกค้าทักมาก่อน' });
    if (code === 551 || sub === 1545041) return res.json({ success: false, error: 'ส่งไม่ได้: ลูกค้าไม่รับข้อความจากเพจ หรือปิดการติดต่อ' });
    res.json({ success: false, error: graphErrorMessage(e) });
  }
});

// 💬 เปิดแชทของลูกค้า: หาห้องแชทจริงจาก Facebook (conversations?user_id=PSID) แล้วพาไปที่ลิงก์ของห้องนั้น
const chatLinkCache = new Map();
app.get('/api/chat-link', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  const pid = pageData ? (pageData.config.pageId || req.query.pageId) : '';
  const inbox = 'https://business.facebook.com/latest/inbox/all?asset_id=' + encodeURIComponent(pid) + '&mailbox_id=' + encodeURIComponent(pid);
  if (!pageData) return res.status(404).send('ไม่พบข้อมูลเพจนี้');
  const uid = String(req.query.uid || '');
  const live = req.query.sid ? getLiveSessions(pageData)[req.query.sid] : null;
  const c = live && live.commenters.get(uid);
  const psid = String(req.query.psid || (c && c.psid) || getPsidMap(pageData).get(uid) || '');
  if (!psid) return res.redirect(inbox); // ยังไม่มี ID แชท (ยังไม่เคยส่งข้อความเข้าแชท) -> เปิดกล่องข้อความรวม
  const key = pid + ':' + psid;
  const hit = chatLinkCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000) return res.redirect(hit.url);
  let url = '';
  try {
    const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(pid) + '/conversations', {
      params: { platform: 'messenger', user_id: psid, fields: 'id,link', access_token: pageData.config.pageAccessToken }, timeout: 15000
    });
    const conv = (r.data && r.data.data || [])[0];
    if (conv && conv.link) url = /^https?:/i.test(conv.link) ? conv.link : 'https://www.facebook.com' + (conv.link.charAt(0) === '/' ? '' : '/') + conv.link;
    console.log('💬 [Chat Link] ' + psid + ' -> ' + (conv ? conv.id + ' ' + conv.link : 'ไม่พบห้องแชท'));
  } catch (e) {
    console.error('❌ [Chat Link]', e.response?.data?.error?.message || e.message);
  }
  if (!url) url = inbox + '&selected_item_id=' + encodeURIComponent(psid) + '&thread_type=FB_MESSAGE';
  chatLinkCache.set(key, { url, at: Date.now() });
  if (chatLinkCache.size > 5000) chatLinkCache.delete(chatLinkCache.keys().next().value);
  res.redirect(url);
});

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
    // เริ่มต้นคัดลอกค่าจากหน้าตั้งค่าหลักของเพจ แล้วแก้แยกอิสระได้
    config: {
      keywords: [...(c.keywords || [])],
      matchType: c.matchType || 'contains',
      replyCommentText: c.replyCommentText || '',
      inboxText: c.inboxText || '',
      enableCommentReply: !!c.enableCommentReply,
      enableInbox: !!c.enableInbox,
      enableAutoLike: !!c.enableAutoLike,
      // 🏷️ ป้ายที่ติดให้อัตโนมัติเมื่อคอมเมนต์ตรงคำดัก (เลือกเองจากป้ายในเพจ)
      keywordLabels: Array.isArray(c.keywordLabels) ? c.keywordLabels.slice() : [],
      // 🏷️ ป้ายที่ถอดออกอัตโนมัติเมื่อคอมเมนต์ตรงคำดัก (เช่น "โอนแล้ว" ของไลฟ์ก่อน)
      keywordRemoveLabels: Array.isArray(c.keywordRemoveLabels) ? c.keywordRemoveLabels.slice() : [],
      replyCooldownMin: Number(c.replyCooldownMin) || 0,
      auctionMode: !!c.auctionMode,
      auctionNoBidText: c.auctionNoBidText || 'รอแอดมินแจ้งยอด',
      auctionText: typeof c.auctionText === 'string' ? c.auctionText : '🔨 ยอดประมูล {amount} บาท'
    },
    stats: { comments: 0, matched: 0 },
    commenters: new Map(),
    slips: [],
    buyers: new Map(),
    buyersJob: null,
    broadcastStatus: { isBroadcasting: false, total: 0, current: 0, success: 0, failed: 0, statusMessage: 'พร้อมใช้งาน', shouldStop: false }
  };
  res.json({ success: true, id });
});

// ✍️ บันทึกการโอนเงินแบบแมนนวล (สลิปที่ระบบตรวจไม่ได้ / โอนช่องทางอื่น)
app.post('/api/live/manual-payment', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const userId = String(req.body.userId || '');
  const amount = Math.round((parseFloat(String(req.body.amount || '').replace(/[^0-9.]/g, '')) || 0) * 100) / 100;
  if (!userId || !s.commenters.has(userId)) return res.json({ success: false, error: 'ไม่พบลูกค้าคนนี้ใน session' });
  if (!(amount > 0) || amount > 10000000) return res.json({ success: false, error: 'กรุณากรอกยอดเงินให้ถูกต้อง' });
  const c = s.commenters.get(userId);
  const rec = {
    transRef: 'MANUAL-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    amount, senderId: userId, senderName: c.name || '', time: Date.now(), manual: true,
    note: String(req.body.note || '').slice(0, 100)
  };
  s.slips.push(rec);
  // ติด/ลบป้ายเหมือนสลิปผ่าน (เช่น ติด "โอนแล้ว" ลบ "ยังไม่โอน")
  const psid = c.psid || getPsidMap(ctx.pageData).get(userId);
  if (psid) labelSlipResult(ctx.pageData, psid, 'valid');
  res.json({ success: true, slip: rec });
});

// 📊 ต้นทุน / ค่าแอด / ค่าส่ง ของ session (แอดมินใส่เอง) ใช้คำนวณกำไร = ยอดโอนรวม - ต้นทุน - ค่าแอด - ค่าส่ง
app.post('/api/live/finance', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const field = String(req.body.field || '');
  if (!['cost', 'ads', 'shipping'].includes(field)) return res.json({ success: false, error: 'ช่องไม่ถูกต้อง' });
  const raw = String(req.body.amount ?? '').replace(/[๐-๙]/g, d => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d))).replace(/[^0-9.]/g, '');
  const amount = raw ? Math.round(parseFloat(raw) * 100) / 100 : 0;
  if (!(amount >= 0) || amount > 100000000) return res.json({ success: false, error: 'กรุณาใส่ยอดเงินให้ถูกต้อง' });
  if (!s.finance) s.finance = {};
  s.finance[field] = amount;
  res.json({ success: true, finance: liveSummary(s).finance });
});

// 💰 ใส่/แก้ ยอดที่ลูกค้าต้องจ่าย (เทียบกับยอดสลิปรวม)
app.post('/api/live/due-amount', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const c = s.commenters.get(String(req.body.userId || ''));
  if (!c) return res.json({ success: false, error: 'ไม่พบลูกค้าคนนี้ใน session' });
  const raw = String(req.body.amount ?? '').replace(/[๐-๙]/g, d => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d))).replace(/[^0-9.]/g, '');
  if (!raw) { delete c.dueAmount; delete c.dueExpr; return res.json({ success: true, dueAmount: 0 }); }
  const amount = Math.round(parseFloat(raw) * 100) / 100;
  if (!(amount > 0) || amount > 10000000) return res.json({ success: false, error: 'กรุณาใส่ยอดเงินให้ถูกต้อง' });
  c.dueAmount = amount;
  // เก็บสูตรที่แอดมินพิมพ์ (เช่น 250+300+100) ไว้แก้ไขภายหลัง
  const expr = String(req.body.expr || '').replace(/[^0-9๐-๙+\-., ]/g, '').trim().slice(0, 200);
  if (expr) c.dueExpr = expr; else delete c.dueExpr;
  res.json({ success: true, dueAmount: amount, dueExpr: c.dueExpr || '' });
});

// 🗑️ ลบรายชื่อคนคอมเมนต์ออกจากตาราง (ไม่ลบสลิป · คอมเมนต์ใหม่จะกลับมาเอง)
app.post('/api/live/commenters/delete', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(String).slice(0, 5000) : [];
  if (!ids.length) return res.json({ success: false, error: 'ยังไม่ได้เลือกรายชื่อ' });
  let removed = 0;
  for (const id of ids) if (s.commenters.delete(id)) removed++;
  res.json({ success: true, removed });
});

app.post('/api/live/manual-payment/delete', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const ref = String(req.body.transRef || '');
  const i = s.slips.findIndex(x => x.transRef === ref && x.manual);
  if (i < 0) return res.json({ success: false, error: 'ลบได้เฉพาะรายการที่บันทึกแบบแมนนวล' });
  s.slips.splice(i, 1);
  res.json({ success: true });
});

app.get('/api/live/detail', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });

  const slipIdx = buildSlipIndex(ctx.pageData, s);
  const psidMap = getPsidMap(ctx.pageData);
  const commenters = Array.from(s.commenters.entries())
    .map(([userId, c]) => {
      const { pendingComments, kwLabeled, kwLabelBusy, bids, wonLots, ...pub } = c; // ข้อมูลภายใน ไม่ต้องส่งไปหน้าเว็บ
      const wins = Array.isArray(c.wins) ? c.wins : [];
      pub.auctionWins = wins.length;
      pub.auctionWarn = wins.map(w => w.warning).filter(Boolean).slice(-2).join(' · ');
      delete pub.wins;
      return {
        userId, ...pub,
        ...paymentStatusFromIndex(slipIdx, userId, c.psid || psidMap.get(userId)),
        chatId: c.psid || psidMap.get(userId) || '',
        inBuyers: !!(s.buyers && s.buyers.has(userId))
      };
    })
    .sort((a, b) => b.lastTime - a.lastTime)
    .slice(0, 300);

  // 💰 สรุปยอดที่ยังขาด (เฉพาะคนที่แอดมินใส่ยอดที่ต้องจ่ายไว้) คิดจากทุกคนใน session
  const dueSummary = { people: 0, due: 0, paid: 0, short: 0, shortPeople: 0, unpaidPeople: 0 };
  for (const [userId, c] of s.commenters) {
    const due = Number(c.dueAmount) || 0;
    if (!(due > 0)) continue;
    const got = Math.round((paymentStatusFromIndex(slipIdx, userId, c.psid || psidMap.get(userId)).paidTotal || 0) * 100) / 100;
    dueSummary.people++; dueSummary.due += due; dueSummary.paid += got;
    if (got < due) { dueSummary.short += due - got; dueSummary.shortPeople++; if (!(got > 0)) dueSummary.unpaidPeople++; }
  }
  dueSummary.short = Math.round(dueSummary.short * 100) / 100;

  res.json({
    success: true,
    session: liveSummary(s),
    config: s.config,
    dueSummary,
    auctionLots: s.config.auctionMode ? auctionLotsSummary(s) : [],
    commenters,
    slips: s.slips.slice(-200).reverse(),
    broadcastStatus: s.broadcastStatus,
    replyWarning: fbPauseWarning(ctx.pageData),
    labelError: ctx.pageData.lastLabelError && Date.now() - (ctx.pageData.lastLabelErrorAt || 0) < 6 * 3600000 ? ctx.pageData.lastLabelError : ''
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
  if (typeof b.auctionMode === 'boolean') { s.config.auctionMode = b.auctionMode; ctx.pageData.config.auctionMode = b.auctionMode; }
  if (typeof b.auctionText === 'string') { s.config.auctionText = b.auctionText.slice(0, 1000); ctx.pageData.config.auctionText = s.config.auctionText; }
  if (typeof b.auctionNoBidText === 'string') { s.config.auctionNoBidText = b.auctionNoBidText.trim().slice(0, 200) || 'รอแอดมินแจ้งยอด'; ctx.pageData.config.auctionNoBidText = s.config.auctionNoBidText; }
  if (b.replyCooldownMin !== undefined) {
    s.config.replyCooldownMin = Math.min(1440, Math.max(0, parseInt(b.replyCooldownMin, 10) || 0));
    ctx.pageData.config.replyCooldownMin = s.config.replyCooldownMin;
  }
  if (Array.isArray(b.keywordLabels)) {
    s.config.keywordLabels = b.keywordLabels
      .filter(l => l && l.id).map(l => ({ id: String(l.id), name: String(l.name || '') })).slice(0, 10);
    // จำไว้เป็นค่าเริ่มต้นของ session ถัดไปด้วย
    ctx.pageData.config.keywordLabels = s.config.keywordLabels.slice();
  }
  if (Array.isArray(b.keywordRemoveLabels)) {
    s.config.keywordRemoveLabels = b.keywordRemoveLabels
      .filter(l => l && l.id).map(l => ({ id: String(l.id), name: String(l.name || '') })).slice(0, 10);
    ctx.pageData.config.keywordRemoveLabels = s.config.keywordRemoveLabels.slice();
  }
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
    if (!s.firstStartedAt) s.firstStartedAt = s.startedAt; // จำเวลาที่กดเริ่มครั้งแรก ไม่ให้สลิปช่วงก่อนหน้าหายเมื่อกดเริ่มใหม่
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
  if (ctx.live.buyersJob) ctx.live.buyersJob.shouldStop = true;
  delete getLiveSessions(ctx.pageData)[req.query.sid];
  res.json({ success: true });
});

// -------------------------------------------------------------
// 5.6 📦 ดึงรายชื่อลูกค้า (คนที่คอมเมนต์ตรงคำดัก) + ค้นหาชื่อที่อยู่จากแชท
// -------------------------------------------------------------
async function runBuyersJob(pageData, s, matched) {
  const job = s.buyersJob;
  const cfg = pageData.config;
  const pageId = cfg.pageId;
  const token = cfg.pageAccessToken;
  const psidMap = getPsidMap(pageData);
  const inboxLog = getInboxLog(pageData);
  // ⚡ สร้างดัชนีชื่อแชทครั้งเดียว ใช้ร่วมกันทุกคน
  let convIndexP = null;
  const getConvIndex = () => convIndexP || (convIndexP = buildConversationIndex(pageId, token).catch(e => {
    job.warning = 'ดึงรายการแชทไม่สำเร็จ: ' + graphErrorMessage(e);
    return new Map();
  }));

  const processOne = async ([userId, c]) => {
    job.message = 'กำลังค้นหาที่อยู่ของ ' + (c.name || userId);

    const prev = s.buyers.get(userId);
    const item = {
      userId,
      fbName: c.name || '',
      keyword: c.lastKeyword || '',
      matchedCount: c.matchedCount || 0,
      lastMessage: c.lastMessage || '',
      psid: c.psid || psidMap.get(userId) || '',
      source: c.source || (prev && prev.source) || 'comment',
      recipientName: '', address: '', phone: '', postcode: '', raw: '',
      status: 'pending', note: ''
    };

    // ลูกค้าที่แอดมินแก้ไขข้อมูลเองแล้ว ไม่เขียนทับ อัปเดตเฉพาะจำนวนครั้ง/คำดัก
    if (prev && prev.status === 'manual') {
      Object.assign(prev, { fbName: item.fbName || prev.fbName, keyword: item.keyword, matchedCount: item.matchedCount, lastMessage: item.lastMessage });
      job.done++;
      if (prev.address) job.found++;
      return;
    }

    try {
      if (!item.psid && inboxLog.has(userId)) item.psid = userId;
      if (!item.psid && item.fbName) {
        const convIndex = await getConvIndex();
        item.psid = convIndex.get(normName(item.fbName)) || '';
      }

      if (!item.psid) {
        item.status = 'nochat';
        item.note = 'ไม่พบแชทของลูกค้าคนนี้ (ลูกค้าอาจยังไม่ได้ทักแชท)';
      } else {
        if (!c.psid) c.psid = item.psid;
        psidMap.set(userId, item.psid);

        let msgs = [];
        try {
          const convId = await findConversationId(pageId, token, item.psid);
          if (convId) {
            job.message = 'กำลังอ่านแชทย้อนหลังของ ' + (c.name || userId);
            const scan = await scanConversationForAddress(convId, token, item.psid);
            msgs = scan.customerMsgs;
            if (!scan.info && scan.pagesRead > 1) item.note = 'อ่านย้อนหลัง ' + scan.messages.length + ' ข้อความ ยังไม่พบที่อยู่';
          }
        } catch (e) {
          item.note = 'อ่านแชทจาก Facebook ไม่สำเร็จ: ' + graphErrorMessage(e);
        }
        // สำรอง: ใช้ข้อความที่ระบบเก็บไว้จาก Webhook
        if (!msgs.length) msgs = (inboxLog.get(item.psid) || []).map(m => ({ text: m.text, time: m.time }));

        const info = extractAddressInfo(msgs);
        if (info) {
          Object.assign(item, info);
          // จัดรูปแบบที่อยู่ให้ถูกต้อง (เติม ต./อ./จ. และรหัสไปรษณีย์จากฐานข้อมูล)
          if (!thaiAddrDb) await loadThaiAddressDb();
          const fixed = smartThaiAddress(item.address, item.postcode);
          if (fixed.ok && fixed.formatted) {
            item.address = fixed.formatted;
            item.postcode = fixed.postal_code;
            item.addrGuess = !!fixed.guess;
            if (fixed.source !== 'marker') item.note = 'ระบบจัดรูปแบบที่อยู่ให้แล้ว';
          }
          if (!item.recipientName) item.recipientName = item.fbName;
          item.status = 'found';
          job.found++;
        } else {
          item.status = msgs.length ? 'notfound' : 'nochat';
          if (!item.note) item.note = msgs.length ? 'ยังไม่พบข้อความที่เป็นที่อยู่' : 'ไม่พบข้อความในแชท';
        }
      }
    } catch (e) {
      item.status = 'error';
      item.note = e.message;
    }

    // เก็บเลขพัสดุเดิมไว้ ไม่ให้หายเมื่อค้นหาที่อยู่ซ้ำ
    if (prev) {
      for (const k of ['beemoveOrderId', 'trackingNo', 'partnerName', 'shipStatus', 'shipNote', 'notified']) {
        if (prev[k] !== undefined) item[k] = prev[k];
      }
    }
    s.buyers.set(userId, item);
    job.done++;
  };

  // ⚡ ค้นหาที่อยู่พร้อมกันครั้งละ 4 คน (เดิมทำทีละคน + หน่วง 0.25 วิ)
  const list = Array.from(matched);
  let nextIdx = 0;
  const worker = async () => {
    while (!job.shouldStop && nextIdx < list.length) {
      const entry = list[nextIdx++];
      try { await processOne(entry); } catch (e) { console.error('❌ [Buyers Job]', e.message); job.done++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));

  job.running = false;
  job.message = job.shouldStop ? 'หยุดการค้นหาแล้ว' : ('เสร็จสิ้น: มีที่อยู่ ' + job.found + ' จาก ' + job.total + ' คน');
}

app.post('/api/live/buyers/fetch', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (s.buyersJob && s.buyersJob.running) return res.json({ success: false, error: 'กำลังค้นหาอยู่ กรุณารอสักครู่' });
  if (!ctx.pageData.config.pageAccessToken) return res.json({ success: false, error: 'เพจนี้ยังไม่มี Page Access Token' });

  const removedSet = s.buyersRemoved || new Set();
  const picked = Array.isArray(req.body?.userIds) ? new Set(req.body.userIds.map(String)) : null;
  let matched;
  if (picked) {
    // เลือกดึงรายคน (ติ๊กจากตารางคนคอมเมนต์) -> ดึงคนที่เลือก แม้เคยลบไปแล้ว
    matched = Array.from(s.commenters.entries()).filter(([uid]) => picked.has(uid));
    matched.forEach(([uid]) => removedSet.delete(uid));
    if (!matched.length) return res.json({ success: false, error: 'กรุณาเลือกอย่างน้อย 1 คน' });
  } else {
    matched = Array.from(s.commenters.entries()).filter(([uid, c]) => c.matchedCount > 0 && !removedSet.has(uid));
    if (!matched.length) return res.json({ success: false, error: removedSet.size ? 'ไม่มีรายชื่อใหม่ (คนที่ลบไปแล้วจะไม่ถูกดึงกลับมา)' : 'ยังไม่มีคนที่คอมเมนต์ตรงคำดักใน session นี้' });
  }

  if (!s.buyers) s.buyers = new Map();
  s.buyersJob = { running: true, total: matched.length, done: 0, found: 0, message: 'กำลังเริ่มค้นหา...', warning: '', shouldStop: false };
  res.json({ success: true, total: matched.length });
  runBuyersJob(ctx.pageData, s, matched).catch(e => {
    s.buyersJob.running = false;
    s.buyersJob.message = 'เกิดข้อผิดพลาด: ' + e.message;
  });
});

// -------------------------------------------------------------
// 💬 ค้นหารายชื่อจากแชทเพจ (ชื่อเฟสบุ๊ค / ชื่อ / ที่อยู่ / เบอร์ / ข้อความ) ตามช่วงวันที่
// -------------------------------------------------------------
function fbTime(t) {
  const ms = Date.parse(String(t || '').replace(/\+0000$/, 'Z'));
  return isNaN(ms) ? 0 : ms;
}

app.get('/api/chats/search', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const cfg = pageData.config;
  const token = cfg.pageAccessToken;
  if (!token) return res.json({ success: false, error: 'เพจนี้ยังไม่มี Page Access Token' });
  if (!thaiAddrDb) loadThaiAddressDb();

  const from = Number(req.query.from) || (Date.now() - 30 * 86400000);
  const to = Number(req.query.to) || Date.now();
  const qRaw = String(req.query.q || '').trim();
  const qTokens = qRaw.split(/\s+/).map(compactTh).filter(Boolean);   // ทุกคำต้องเจอ (ไม่สนลำดับ/เว้นวรรค)
  const qDigits = qRaw.replace(/\D/g, '');
  const onlyAddr = req.query.onlyAddr === '1';
  const pageId = cfg.pageId || req.query.pageId;
  const started = Date.now();
  const textHit = (t) => {
    const c = compactTh(t);
    if (qTokens.length && qTokens.every(k => c.includes(k))) return true;
    return qDigits.length >= 4 && String(t || '').replace(/\D/g, '').includes(qDigits);
  };

  // ขั้นที่ 1: ดึงรายชื่อแชททั้งหมดในช่วงวันที่ (เบา เร็ว)
  const convs = [];
  let listed = 0, oldestSeen = null, endReason = 'end';
  let url = 'https://graph.facebook.com/v19.0/' + encodeURIComponent(pageId) + '/conversations';
  let params = { platform: 'messenger', limit: 100, fields: 'participants,updated_time,snippet', access_token: token };
  try {
    for (let pageNo = 0; url; pageNo++) {
      if (pageNo >= 80) { endReason = 'maxpages'; break; }
      if (Date.now() - started > 25000) { endReason = 'time'; break; }
      const r = await axios.get(url, { params, timeout: 20000 });
      const list = r.data.data || [];
      let stop = false;
      for (const conv of list) {
        listed++;
        const updated = fbTime(conv.updated_time);
        oldestSeen = updated;
        if (updated < from) { stop = true; endReason = 'range'; break; }
        if (updated > to) continue;
        const person = (conv.participants?.data || []).find(p => String(p.id) !== String(pageId));
        if (!person) continue;
        convs.push({ id: conv.id, psid: String(person.id), name: person.name || '', updated, snippet: String(conv.snippet || '') });
      }
      if (stop) break;
      url = r.data.paging?.next || null;
      params = undefined;
    }
  } catch (e) {
    return res.json({ success: false, error: 'ดึงรายการแชทไม่สำเร็จ: ' + graphErrorMessage(e) });
  }

  // ขั้นที่ 2: เลือกแชทที่ต้องอ่านข้อความ
  const hasQuery = qTokens.length > 0 || qDigits.length >= 4;
  const nameHits = new Set();
  if (hasQuery) convs.forEach(c => { if (textHit(c.name)) nameHits.add(c.id); });
  // เจอชื่อเฟสตรงแล้ว อ่านเฉพาะแชทของคนนั้น (เร็ว) ไม่เจอค่อยค้นในข้อความทุกแชท
  const deep = req.query.deep === '1';
  const MAX_READ = nameHits.size && !deep ? 60 : 300;
  let toRead = hasQuery
    ? (nameHits.size && !deep ? convs.filter(c => nameHits.has(c.id))
      : convs.filter(c => nameHits.has(c.id)).concat(convs.filter(c => !nameHits.has(c.id))))
    : convs.slice();
  const readLimited = toRead.length > MAX_READ;
  toRead = toRead.slice(0, MAX_READ);

  const msgsById = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < toRead.length && Date.now() - started < 50000) {
      const c = toRead[idx++];
      try {
        const r = await axios.get('https://graph.facebook.com/v19.0/' + encodeURIComponent(c.id), {
          params: { fields: 'messages.limit(40){message,from,created_time}', access_token: token }, timeout: 15000
        });
        msgsById.set(c.id, (r.data.messages?.data || []).map(m => ({
          text: m.message || '', fromId: String(m.from?.id || ''), time: fbTime(m.created_time)
        })));
      } catch (e) { msgsById.set(c.id, []); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const timeCut = idx < toRead.length;

  // ที่อยู่อยู่ในข้อความเก่า: อ่านย้อนหลังเพิ่มเฉพาะแชทที่ชื่อตรง (สูงสุด 15 แชท)
  const deepTargets = convs.filter(c => (nameHits.has(c.id) || (!hasQuery && onlyAddr)) && msgsById.has(c.id))
    .filter(c => {
      const cust = msgsById.get(c.id).filter(m => m.fromId === c.psid);
      return !extractAddressInfo(cust.map(m => ({ text: m.text, time: m.time })));
    }).slice(0, 15);
  let deepScanned = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (deepTargets.length && Date.now() - started < 55000) {
      const c = deepTargets.shift();
      try {
        const scan = await scanConversationForAddress(c.id, token, c.psid, { deadline: started + 55000 });
        msgsById.set(c.id, scan.messages);
        deepScanned++;
      } catch (e) { /* ใช้ข้อความเดิม */ }
    }
  }));

  // ขั้นที่ 3: จับคู่คำค้นหา + อ่านที่อยู่
  const results = [];
  let hiddenNoAddr = 0;
  for (const c of convs) {
    const msgs = msgsById.get(c.id);
    let matchedText = '';
    if (hasQuery) {
      const byName = nameHits.has(c.id);
      let hit = byName;
      if (!hit && textHit(c.snippet)) { hit = true; matchedText = c.snippet; }
      if (!hit && msgs) {
        const m = msgs.find(x => textHit(x.text));
        if (m) { hit = true; matchedText = m.text; }
      }
      if (!hit) continue;
    }
    const customerMsgs = (msgs || []).filter(m => m.fromId === c.psid);
    const info = customerMsgs.length ? extractAddressInfo(customerMsgs.map(m => ({ text: m.text, time: m.time }))) : null;
    if (onlyAddr && !info) { hiddenNoAddr++; continue; }
    let addressPreview = '';
    if (info) {
      const fx = smartThaiAddress(info.address, info.postcode);
      addressPreview = (fx.ok && fx.formatted) ? fx.formatted : info.address;
    }
    results.push({
      psid: c.psid, name: c.name, updatedTime: c.updated, snippet: c.snippet.slice(0, 120),
      matchedText: String(matchedText || '').slice(0, 160), hasAddress: !!info,
      recipientName: info?.recipientName || '', phone: info?.phone || '', addressPreview,
      messagesRead: !!msgs
    });
    if (results.length >= 500) break;
  }
  // ชื่อตรงขึ้นก่อน
  results.sort((a, b) => (textHit(b.name) ? 1 : 0) - (textHit(a.name) ? 1 : 0) || b.updatedTime - a.updatedTime);

  res.json({
    success: true, results,
    scanned: convs.length, listed, oldestSeen, endReason, hiddenNoAddr, nameHits: nameHits.size,
    readCount: msgsById.size, readLimited: readLimited || timeCut, deepScanned
  });
});

// 💬 แอดมินกดส่งเลขพัสดุให้ลูกค้า (เกิน 24 ชม. ใช้แท็ก HUMAN_AGENT ได้ภายใน 7 วัน)
app.post('/api/live/buyers/notify', checkAuth, async (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const bm = getBeemoveConfig(ctx.pageData);
  const ids = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String);
  let sent = 0, tagged = 0, skipped = 0;
  const errors = [];
  let convIndex = null;
  for (const id of ids) {
    const item = s.buyers.get(id);
    if (!item || !item.trackingNo) { skipped++; continue; }
    // ยังไม่รู้ว่าลูกค้าคือแชทไหน: หาจากรายการที่จับคู่ไว้ หรือจากชื่อในรายการแชทของเพจ
    if (!item.psid) {
      item.psid = getPsidMap(ctx.pageData).get(id) || (getInboxLog(ctx.pageData).has(id) ? id : '');
      if (!item.psid && item.fbName) {
        try {
          if (!convIndex) convIndex = await buildConversationIndex(ctx.pageData.config.pageId, ctx.pageData.config.pageAccessToken);
          item.psid = convIndex.get(normName(item.fbName)) || '';
        } catch (e) { convIndex = new Map(); }
      }
      if (!item.psid) {
        item.shipNote = 'ไม่พบแชทของลูกค้าคนนี้ ส่งเลขพัสดุทางแชทไม่ได้';
        errors.push((item.recipientName || item.fbName || id) + ': ไม่พบแชท');
        continue;
      }
    }
    try {
      const r = await sendMessengerText(ctx.pageData, item.psid, trackingText(bm, item), { humanAgent: true });
      item.notified = true;
      item.notifyPending = false;
      item.shipNote = '';
      sent++;
      if (r.tagged) tagged++;
    } catch (e) {
      item.shipNote = 'ส่งเลขพัสดุไม่สำเร็จ: ' + (e.response?.data?.error?.message || e.message);
      errors.push((item.recipientName || item.fbName || id) + ': ' + item.shipNote);
    }
    await sleep(300);
  }
  res.json({ success: true, sent, tagged, skipped, errors: errors.slice(0, 5) });
});

// 🗑️ ลบรายชื่อลูกค้าออกจากตาราง (ไม่ยกเลิกพัสดุใน Bee Move)
app.post('/api/live/buyers/delete', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (s.buyersJob && s.buyersJob.running) return res.json({ success: false, error: 'กำลังค้นหาที่อยู่อยู่ กรุณารอให้เสร็จก่อน' });
  if (s.shipJob && s.shipJob.running) return res.json({ success: false, error: 'กำลังสร้างพัสดุอยู่ กรุณารอให้เสร็จก่อน' });
  if (!s.buyersRemoved) s.buyersRemoved = new Set();
  const ids = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String);
  let removed = 0;
  for (const id of ids) {
    if (s.buyers.delete(id)) removed++;
    s.buyersRemoved.add(id); // กด "ดึงรายชื่อ" ใหม่จะไม่ดึงคนนี้กลับมา
  }
  res.json({ success: true, removed });
});

// ➕ เพิ่มคนที่เลือกจากผลค้นหาแชท เข้าตารางรายชื่อลูกค้าของ session แล้วค้นหาที่อยู่ให้ทันที
app.post('/api/live/buyers/add-from-chat', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (s.buyersJob && s.buyersJob.running) return res.json({ success: false, error: 'กำลังค้นหาที่อยู่อยู่ กรุณารอสักครู่' });
  if (!ctx.pageData.config.pageAccessToken) return res.json({ success: false, error: 'เพจนี้ยังไม่มี Page Access Token' });

  const people = (Array.isArray(req.body.people) ? req.body.people : [])
    .filter(p => p && p.psid).slice(0, 300);
  if (!people.length) return res.json({ success: false, error: 'กรุณาเลือกอย่างน้อย 1 คน' });
  if (!s.buyers) s.buyers = new Map();

  // ถ้าคนนี้เคยคอมเมนต์ใน session อยู่แล้ว ใช้รายการเดิม
  const entries = people.map(p => {
    const psid = String(p.psid);
    for (const [uid, c] of s.commenters.entries()) {
      if (c.psid === psid || uid === psid) return [uid, c];
    }
    for (const [uid, b] of s.buyers.entries()) {
      if (b.psid === psid) return [uid, { name: b.fbName, lastKeyword: b.keyword, matchedCount: b.matchedCount, lastMessage: b.lastMessage, psid, source: b.source }];
    }
    return [psid, { name: String(p.name || ''), lastKeyword: '', matchedCount: 0, lastMessage: '(เพิ่มจากแชท)', psid, source: 'chat' }];
  });

  if (s.buyersRemoved) entries.forEach(([uid]) => s.buyersRemoved.delete(uid)); // เพิ่มกลับเองได้
  s.buyersJob = { running: true, total: entries.length, done: 0, found: 0, message: 'กำลังค้นหาที่อยู่จากแชท...', warning: '', shouldStop: false };
  res.json({ success: true, total: entries.length });
  runBuyersJob(ctx.pageData, s, entries).catch(e => {
    s.buyersJob.running = false;
    s.buyersJob.message = 'เกิดข้อผิดพลาด: ' + e.message;
  });
});

app.get('/api/live/buyers', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (!s.buyers) s.buyers = new Map();

  const buyers = Array.from(s.buyers.values()).map(b => {
    const slipTotal = s.slips
      .filter(x => x.senderId === b.userId || (b.psid && x.senderId === b.psid))
      .reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
    const chk = checkAddressAgainstZip(b.address, b.postcode);
    return { ...b, slipTotal, addrCheck: chk.status, addrZip: chk.zip || '', addrOptions: chk.options, addrMatch: chk.matchIndex ?? -1, addrAltZip: !!chk.altZip };
  });
  const job = s.buyersJob
    ? { running: s.buyersJob.running, total: s.buyersJob.total, done: s.buyersJob.done, found: s.buyersJob.found, message: s.buyersJob.message, warning: s.buyersJob.warning }
    : null;
  const shipJob = s.shipJob
    ? { running: s.shipJob.running, total: s.shipJob.total, done: s.shipJob.done, created: s.shipJob.created, failed: s.shipJob.failed, message: s.shipJob.message }
    : null;
  res.json({ success: true, job, shipJob, buyers });
});

app.post('/api/live/buyers/update', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  const b = req.body || {};
  const item = s.buyers.get(String(b.userId));
  if (!item) return res.json({ success: false, error: 'ไม่พบลูกค้าคนนี้' });
  ['recipientName', 'address', 'phone', 'postcode'].forEach(k => {
    if (typeof b[k] === 'string') item[k] = b[k].slice(0, 1000);
  });
  if (item.addrGuess && checkAddressAgainstZip(item.address, item.postcode).status === 'ok' && b.confirmAddress) item.addrGuess = false;
  item.status = 'manual';
  res.json({ success: true });
});

// 🗺️ เลือก ตำบล/อำเภอ/จังหวัด ที่ถูกต้องจากรายการของรหัสไปรษณีย์
app.post('/api/live/buyers/set-location', checkAuth, async (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (!thaiAddrDb) await loadThaiAddressDb();
  const b = req.body || {};
  const item = s.buyers.get(String(b.userId));
  if (!item) return res.json({ success: false, error: 'ไม่พบลูกค้าคนนี้' });
  const rows = thaiAddrByZip.get(String(b.z)) || [];
  const loc = rows.find(r => r.d === b.d && r.a === b.a && r.p === b.p);
  if (!loc) return res.json({ success: false, error: 'ตัวเลือกไม่ถูกต้อง' });
  item.address = rebuildAddressWithLocation(item.address, loc);
  item.postcode = loc.z;
  item.addrGuess = false;
  item.status = 'manual';
  if (item.shipStatus === 'error') item.shipNote = '';
  res.json({ success: true, address: item.address });
});

app.get('/api/thai-address/zip', checkAuth, async (req, res) => {
  if (!thaiAddrDb) await loadThaiAddressDb();
  const rows = (thaiAddrByZip.get(String(req.query.zip || '').trim()) || []).map(r => ({ d: r.d, a: r.a, p: r.p, z: r.z }));
  res.json({ success: true, loaded: !!thaiAddrDb, rows });
});

// 🗺️ จัดรูปแบบที่อยู่ลูกค้าให้ถูกต้อง (เติม ต./อ./จ./รหัสไปรษณีย์)
// ✂️ แยกที่อยู่ 1 แถว: รวมข้อความในแถว -> แยกชื่อ/ที่อยู่/รหัสไปรษณีย์/เบอร์ -> จัดรูปแบบตามฐานข้อมูล
app.post('/api/live/buyers/split-address', checkAuth, async (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (!thaiAddrDb) await loadThaiAddressDb();
  const b = req.body || {};
  const item = s.buyers.get(String(b.userId));
  if (!item) return res.json({ success: false, error: 'ไม่พบลูกค้าคนนี้' });
  const str = (k) => String(b[k] ?? item[k] ?? '').slice(0, 1500).trim();
  const name0 = str('recipientName'), addr0 = str('address'), zip0 = str('postcode'), phone0 = str('phone');
  const text = [name0, addr0, zip0 && !addr0.includes(zip0) ? zip0 : '', phone0 && !addr0.replace(/\D/g, '').includes(phone0.replace(/\D/g, '')) ? phone0 : ''].filter(Boolean).join('\n');
  if (!text) return res.json({ success: false, error: 'ไม่มีข้อความให้แยก' });
  const p = parseAddressBlock([text], name0 || item.fbName || '');
  const recipientName = p.recipientName || name0;
  const phone = p.phone || phone0;
  let address = p.address || addr0, postcode = p.postcode || zip0;
  // ตัดชื่อผู้รับที่ติดมาในช่องที่อยู่ออก
  if (recipientName && address.startsWith(recipientName)) address = address.slice(recipientName.length).trim();
  const sm = thaiAddrDb ? smartThaiAddress(address, postcode) : null;
  let guess = !!item.addrGuess;
  if (sm && sm.ok && sm.formatted) { address = sm.formatted; postcode = sm.postal_code || postcode; guess = !!sm.guess; }
  Object.assign(item, { recipientName: recipientName.slice(0, 200), address: address.slice(0, 1000), postcode: String(postcode || '').slice(0, 10), phone: String(phone || '').slice(0, 30) });
  item.addrGuess = guess;
  item.status = 'manual';
  if (item.shipStatus === 'error') item.shipNote = '';
  const chk = thaiAddrDb ? checkAddressAgainstZip(item.address, item.postcode) : { status: 'nodb' };
  const missing = [];
  if (!item.recipientName) missing.push('ชื่อผู้รับ');
  if (!item.postcode) missing.push('รหัสไปรษณีย์');
  if (!item.phone) missing.push('เบอร์โทร');
  const message = '✂️ แยกที่อยู่แล้ว' + (chk.status === 'ok' && !guess ? ' · ตำบล/อำเภอถูกต้อง ✓' : ' · กรุณาเลือกตำบล/อำเภอให้ถูกต้อง') + (missing.length ? ' · ยังไม่มี' + missing.join('/') : '');
  res.json({ success: true, message, buyer: { recipientName: item.recipientName, address: item.address, postcode: item.postcode, phone: item.phone } });
});

app.post('/api/live/buyers/fix-address', checkAuth, async (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (!thaiAddrDb) await loadThaiAddressDb();
  const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(String) : [];
  let fixed = 0, failed = 0;
  for (const uid of ids) {
    const item = s.buyers.get(uid);
    if (!item || !item.address) continue;
    const r = smartThaiAddress(item.address, item.postcode);
    if (r.ok && r.formatted) {
      item.address = r.formatted;
      item.postcode = r.postal_code;
      item.addrGuess = !!r.guess;
      fixed++;
    } else {
      item.note = 'จัดรูปแบบที่อยู่ไม่ได้ ตรวจชื่อตำบล/อำเภอ/จังหวัด';
      failed++;
    }
  }
  res.json({ success: true, fixed, failed, dbLoaded: !!thaiAddrDb });
});

// -------------------------------------------------------------
// 5.7 🚚 Bee Move: ตั้งค่า / ทดสอบ / สร้างเลขพัสดุ / พิมพ์ใบแปะหน้า
// -------------------------------------------------------------
function maskKey(k) {
  const s = String(k || '');
  return s.length > 8 ? s.slice(0, 4) + '••••••' + s.slice(-4) : (s ? '••••' : '');
}

app.get('/api/beemove/config', checkAuth, (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const bm = getBeemoveConfig(pageData);
  const cached = beemoveTokenCache.get(beemoveCacheKey(bm));
  res.json({ success: true, config: {
    ...bm, apiKey: '', password: '',
    apiKeyMasked: maskKey(bm.apiKey), hasKey: !!bm.apiKey, hasPassword: !!bm.password,
    accounts: cached ? cached.accounts : [],
    webhookPath: '/beemove/webhook/' + bm.webhookKey,
    recentHooks: (pageData.beemoveHooks || []).slice(0, 5),
    defaultNotifyText: defaultBeemoveConfig.notifyText
  } });
});

app.post('/api/beemove/config', checkAuth, (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const bm = getBeemoveConfig(pageData);
  const b = req.body || {};
  for (const k of Object.keys(defaultBeemoveConfig)) {
    if (k === 'apiKey' || k === 'password' || k === 'webhookKey') continue;
    if (b[k] === undefined) continue;
    bm[k] = typeof defaultBeemoveConfig[k] === 'boolean' ? !!b[k] : String(b[k]);
  }
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) bm.apiKey = b.apiKey.trim();
  if (typeof b.password === 'string' && b.password) bm.password = b.password;
  if (b.clearKey) bm.apiKey = '';
  if (b.newWebhookKey) bm.webhookKey = crypto.randomBytes(16).toString('hex');
  res.json({ success: true });
});

// ทดสอบ API Key + ดึงรายชื่อขนส่งที่ใช้ได้ (เช็คราคาส่งจากที่อยู่ผู้ส่งไปที่อยู่ผู้ส่ง)
app.post('/api/beemove/test', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const bm = getBeemoveConfig(pageData);
  const out = { success: false, account: null, accounts: [], partners: [], warnings: [] };
  if (!bm.authMode || bm.authMode === 'login') {
    try {
      await beemoveLogin(bm, true);
      out.accounts = (beemoveTokenCache.get(beemoveCacheKey(bm)) || {}).accounts || [];
    } catch (e) {
      out.warnings.push(e.message);
      return res.json(out);
    }
  }
  try {
    const r = await beemoveRequest(bm, 'GET', '/client/v1/init');
    const d = unwrapData(r.data) || {};
    out.account = { name: d.name || '', telephone: d.telephone || '', wallet: d.wallet?.wallet_amount ?? null };
    out.success = true;
  } catch (e) {
    out.warnings.push('ตรวจบัญชีไม่สำเร็จ: ' + beemoveError(e));
  }
  let sender = null;
  try {
    sender = await beemoveResolveSender(bm);
    out.pickupPoints = sender.points.map(p => ({ id: p.id, name: p.name || p.responser, address: [p.address, p.district, p.city, p.province, p.postal_code].join(' ') }));
    if (!sender.points.length) out.warnings.push('ไม่พบ "ที่อยู่รับสินค้า" ในบัญชี Bee Move แนะนำให้เพิ่มที่ client.beemove.co.th → ตั้งค่า → ที่อยู่รับสินค้า');
  } catch (e) {
    out.warnings.push('ดึงที่อยู่รับสินค้าไม่สำเร็จ: ' + beemoveError(e));
  }
  const s = sender ? sender.from : beemoveSender(bm);
  if (s.district && s.city && s.province && s.postal_code) {
    try {
      const order = { from: s, to: { ...s }, parcel: beemoveParcel(bm) };
      if (sender && sender.pickupPointId) order.pickup_point_id = isNaN(Number(sender.pickupPointId)) ? sender.pickupPointId : Number(sender.pickupPointId);
      const est = await beemoveEstimateRaw(bm, order);
      const prices = est.prices;
      if (!prices.length) out.warnings.push('Bee Move ไม่ส่งราคาขนส่งกลับมา: ' + JSON.stringify(est.raw).slice(0, 250));
      out.partners = prices.filter(p => p.partner).map(p => ({
        id: p.partner.id, name: p.partner.partner_name, code: p.partner.partner_code || '',
        price: p.price?.sell_price ?? null, usable: !(p.errors && p.errors.length)
      }));
      out.success = true;
    } catch (e) {
      out.warnings.push('เช็คราคาขนส่งไม่สำเร็จ: ' + beemoveError(e));
    }
  } else {
    out.warnings.push('กรอกที่อยู่ผู้ส่งให้ครบ (ตำบล อำเภอ จังหวัด รหัสไปรษณีย์) เพื่อดึงรายชื่อขนส่ง');
  }
  if (!out.success && !out.warnings.length) out.warnings.push('เชื่อมต่อไม่สำเร็จ');
  res.json(out);
});

// 🛡️ ประวัติการสร้างพัสดุของเพจ (ทุก session) ใช้กันสร้างใบแปะหน้าซ้ำ แม้ลบแถวลูกค้าหรือดึงเข้า session ใหม่
const SHIP_DUP_DAYS = 1;
function shipPhoneKey(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }
function recordShipLog(pageData, s, item) {
  if (!pageData.shipLog) pageData.shipLog = [];
  pageData.shipLog.unshift({ uid: item.userId || '', psid: item.psid || '', phone: shipPhoneKey(item.phone), name: item.recipientName || item.fbName || '',
    trackingNo: item.trackingNo || '', orderId: item.beemoveOrderId || '', sid: s.id || '', sname: s.name || '', at: Date.now() });
  if (pageData.shipLog.length > 3000) pageData.shipLog.length = 3000;
}
function findShipDuplicate(pageData, s, uid, item) {
  const since = Date.now() - SHIP_DUP_DAYS * 86400000;
  const phone = shipPhoneKey(item.phone);
  return (pageData.shipLog || []).find(l => l.at >= since && !(l.sid === s.id && l.orderId && l.orderId === item.beemoveOrderId) &&
    (l.uid === uid || (item.psid && l.psid === item.psid) || (phone && l.phone === phone))) || null;
}

async function runShipJob(pageData, s, userIds, labelUserIds) {
  const job = s.shipJob;
  const bm = getBeemoveConfig(pageData);
  const token = pageData.config.pageAccessToken;
  const t0 = Date.now();

  const one = async (uid) => {
    const item = s.buyers.get(uid);
    if (!item) { job.done++; return; }
    // มีเลขพัสดุ / มีออเดอร์ Bee Move อยู่แล้ว (รอเลขจากขนส่ง) -> ไม่สร้างซ้ำ
    if (item.trackingNo || item.beemoveOrderId || item.shipBusy) { job.done++; job.skipped++; return; }
    item.shipBusy = true;
    job.message = 'กำลังสร้างพัสดุ: ' + (item.recipientName || item.fbName || uid);
    try {
      const remark = (item.fbName || '') + ' ' + (item.keyword || '') + 'x' + (item.matchedCount || 0);
      const r = await beemoveCreateShipment(bm, item, remark);
      item.beemoveOrderId = r.id;
      item.trackingNo = r.trackingNo;
      item.partnerName = r.partnerName;
      item.shipStatus = 'created';
      item.shipNote = r.trackingNo ? '' : 'สร้างแล้ว รอเลขพัสดุจากขนส่ง';
      recordShipLog(pageData, s, { ...item, userId: uid });
      job.created++;
      // ⚡ ส่งเลขพัสดุให้ลูกค้าทางแชทแบบเบื้องหลัง ไม่ต้องรอ
      if (token) runTask(() => autoNotifyTracking(pageData, bm, item), 'notify-tracking');
    } catch (e) {
      item.shipStatus = 'error';
      item.shipNote = e.response ? beemoveError(e) : e.message;
      job.failed++;
    }
    item.shipBusy = false;
    job.done++;
  };

  // ⚡ สร้างพร้อมกันครั้งละ 3 รายการ (เดิมทีละรายการ + หน่วง 0.4 วิ)
  let next = 0;
  const worker = async () => {
    while (!job.shouldStop && next < userIds.length) await one(userIds[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(3, userIds.length) }, worker));

  // ⚡ เริ่มดึงใบแปะหน้าล่วงหน้าทันที (หน้าเว็บขอเมื่อไหร่ได้ไฟล์เร็ว)
  const ids = (labelUserIds && labelUserIds.length ? labelUserIds : userIds)
    .map(uid => s.buyers.get(uid)).filter(b => b && b.beemoveOrderId).map(b => b.beemoveOrderId);
  if (ids.length) getBeemoveLabel(bm, ids, 'A6').catch(() => {}); // หน้าเว็บขอขนาด A6

  job.running = false;
  job.message = 'สร้างพัสดุเสร็จ: สำเร็จ ' + job.created + ' · ล้มเหลว ' + job.failed + (job.skipped ? ' · มีเลขอยู่แล้ว ' + job.skipped : '') + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' วิ)';
}

app.post('/api/live/beemove/create', checkAuth, (req, res) => {
  const ctx = getLiveContext(req, res);
  if (!ctx) return;
  const s = ctx.live;
  if (!s || !s.buyers) return res.json({ success: false, error: 'ไม่พบ session นี้' });
  if (s.shipJob && s.shipJob.running) return res.json({ success: false, error: 'กำลังสร้างพัสดุอยู่ กรุณารอสักครู่' });
  const bm = getBeemoveConfig(ctx.pageData);
  const loginMode = !bm.authMode || bm.authMode === 'login';
  if (loginMode && (!bm.username || !bm.password)) return res.json({ success: false, error: 'ยังไม่ได้ใส่เบอร์โทรและรหัสผ่าน Bee Move (เมนู 🚚 ขนส่ง Bee Move)' });
  if (!loginMode && !bm.apiKey) return res.json({ success: false, error: 'ยังไม่ได้ใส่ API Key ของ Bee Move (เมนู 🚚 ขนส่ง Bee Move)' });
  const userIds = Array.from(new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String))).filter(id => s.buyers.has(id));
  if (!userIds.length) return res.json({ success: false, error: 'กรุณาเลือกลูกค้าอย่างน้อย 1 คน' });
  // 🛡️ เคยสร้างพัสดุให้ลูกค้าคนนี้ (ชื่อเฟส / แชท / เบอร์โทรเดียวกัน) ภายใน 1 วัน -> ถามยืนยันก่อน
  if (!req.body.force) {
    const dups = [];
    for (const id of userIds) {
      const it = s.buyers.get(id);
      if (!it || it.trackingNo || it.beemoveOrderId) continue;
      const d = findShipDuplicate(ctx.pageData, s, id, it);
      if (d) dups.push({ userId: id, name: it.recipientName || it.fbName || id, trackingNo: d.trackingNo, session: d.sid === s.id ? 'session นี้' : (d.sname || 'session อื่น'), at: d.at });
    }
    if (dups.length) return res.json({ success: false, duplicates: dups, error: 'พบลูกค้าที่เคยสร้างพัสดุแล้ว' });
  }

  s.shipJob = { running: true, total: userIds.length, done: 0, created: 0, failed: 0, skipped: 0, message: 'กำลังเริ่มสร้างพัสดุ...', shouldStop: false };
  res.json({ success: true });
  const labelUserIds = (Array.isArray(req.body.labelUserIds) ? req.body.labelUserIds : []).map(String).filter(id => s.buyers.has(id));
  runShipJob(ctx.pageData, s, userIds, labelUserIds).catch(e => {
    s.shipJob.running = false;
    s.shipJob.message = 'เกิดข้อผิดพลาด: ' + e.message;
  });
});

// 📡 รับสถานะพัสดุจาก Bee Move (ตั้งค่าที่ client.beemove.co.th → การเชื่อมต่อ API → Webhook แบบ "กำหนดเอง")
app.post('/beemove/webhook/:key', async (req, res) => {
  res.status(200).json({ success: true });
  let pageData = null;
  for (const uid in usersDB) {
    for (const pid in usersDB[uid].pages) {
      const pd = usersDB[uid].pages[pid];
      if (pd.config.beemove && pd.config.beemove.webhookKey === req.params.key) { pageData = pd; break; }
    }
    if (pageData) break;
  }
  if (!pageData) { console.log('⚠️ [Bee Move Webhook] ไม่พบเพจของรหัสนี้'); return; }

  const bm = getBeemoveConfig(pageData);
  const body = req.body || {};
  if (!pageData.beemoveHooks) pageData.beemoveHooks = [];
  pageData.beemoveHooks.unshift({ time: Date.now(), body: JSON.stringify(body).slice(0, 3000) });
  pageData.beemoveHooks.length = Math.min(pageData.beemoveHooks.length, 20);
  console.log('📡 [Bee Move Webhook]', JSON.stringify(body).slice(0, 500));

  for (const ev of parseBeemoveWebhook(body)) {
    const item = findBuyerByShipment(pageData, ev.ids, ev.awb);
    if (!item) continue;
    if (ev.status) { item.bmStatus = ev.status; item.bmStatusAt = Date.now(); }
    const gotNewTracking = ev.awb && !item.trackingNo;
    if (gotNewTracking) { item.trackingNo = ev.awb; item.shipNote = ''; }

    try {
      if (gotNewTracking) await autoNotifyTracking(pageData, bm, item);
      if (bm.notifyStatus && !item.notifiedDelivered && item.psid && /สำเร็จ|delivered|success|complete/i.test(ev.status || '')) {
        await sendMessengerText(pageData, item.psid, '✅ พัสดุ ' + (item.trackingNo || '') + ' จัดส่งถึงแล้วค่ะ ขอบคุณที่อุดหนุนนะคะ 🙏');
        item.notifiedDelivered = true;
      }
    } catch (e) {
      console.error('❌ [Bee Move Webhook] แจ้งลูกค้าไม่สำเร็จ', e.response?.data || e.message);
    }
  }
});

// ดาวน์โหลดใบแปะหน้า PDF จาก Bee Move (ส่งต่อให้เบราว์เซอร์)
// ⚡ ใบแปะหน้า: ดึงล่วงหน้าทันทีที่สร้างพัสดุเสร็จ + จำไว้ 10 นาที + ลองใหม่ถ้า Bee Move ยังสร้างไฟล์ไม่เสร็จ
const beemoveLabelCache = new Map(); // key -> { promise, at }
function labelCacheKey(bm, ids, size) { return beemoveCacheKey(bm) + '|' + size + '|' + ids.slice().sort().join(','); }
async function fetchBeemoveLabelRaw(bm, ids, size) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await beemoveRequest(bm, 'GET', '/client/v1/label', {
        params: { ids: ids.join(','), id: ids.join(','), size, print_item: '0' },
        responseType: 'arraybuffer',
        timeout: 60000
      });
      const type = r.headers['content-type'] || 'application/pdf';
      if (/json/.test(type)) {
        lastErr = new Error('Bee Move ไม่ส่งไฟล์ใบแปะหน้า: ' + Buffer.from(r.data).toString('utf8').slice(0, 300));
      } else {
        return { type, buf: Buffer.from(r.data) };
      }
    } catch (e) {
      lastErr = e;
      const st = e.response?.status;
      if (st && st < 500 && st !== 404 && st !== 409 && st !== 425) break; // error ถาวร ไม่ต้องลองซ้ำ
    }
    await sleep(1500 * (attempt + 1)); // รอ Bee Move สร้างใบแปะหน้าของพัสดุที่เพิ่งสร้าง
  }
  throw lastErr;
}
function getBeemoveLabel(bm, ids, size) {
  const key = labelCacheKey(bm, ids, size);
  const c = beemoveLabelCache.get(key);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.promise;
  const promise = fetchBeemoveLabelRaw(bm, ids, size);
  beemoveLabelCache.set(key, { promise, at: Date.now() });
  promise.catch(() => beemoveLabelCache.delete(key));
  if (beemoveLabelCache.size > 30) beemoveLabelCache.delete(beemoveLabelCache.keys().next().value);
  return promise;
}

app.get('/api/beemove/label', checkAuth, async (req, res) => {
  const pageData = usersDB[req.userId]?.pages[req.query.pageId];
  if (!pageData) return res.status(404).json({ success: false, error: 'ไม่พบข้อมูลเพจนี้' });
  const bm = getBeemoveConfig(pageData);
  const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.status(400).json({ success: false, error: 'ไม่มีพัสดุที่เลือก' });
  try {
    const { type, buf } = await getBeemoveLabel(bm, ids, req.query.size || bm.labelSize || 'A6');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', 'inline; filename="beemove-label.pdf"');
    res.send(buf);
  } catch (e) {
    let msg = e.message;
    if (e.response?.data) {
      try { msg = '[' + e.response.status + '] ' + Buffer.from(e.response.data).toString('utf8').slice(0, 300); } catch (x) {}
    }
    res.status(502).json({ success: false, error: 'ดึงใบแปะหน้าไม่สำเร็จ: ' + msg });
  }
});

const PRIVATE_REPLY_MS = 7 * 24 * 3600 * 1000;

// targets: [{ uid, psid }] ส่งแบบแชทปกติ (ลูกค้าทักมาใน 24 ชม.) หรือ [{ uid, commentId }] ส่งแบบ Private Reply ผ่านคอมเมนต์
async function runLiveBroadcast(live, pageData, targets, message, delaySec, batchSize, pauseMin) {
  const st = live.broadcastStatus;
  const pageToken = pageData.config.pageAccessToken;
  let batchCount = 0;
  for (let i = 0; i < targets.length; i++) {
    if (st.shouldStop) break;
    const t = targets[i];
    st.current = i + 1;
    st.statusMessage = 'กำลังส่งหาผู้รับที่ ' + (i + 1) + '/' + targets.length + '...';
    const c = live.commenters.get(t.uid);
    try {
      const r = await axios.post('https://graph.facebook.com/v19.0/me/messages', {
        recipient: t.psid ? { id: t.psid } : { comment_id: t.commentId },
        messaging_type: 'RESPONSE',
        message: { text: message }
      }, { params: { access_token: pageToken }, timeout: 15000 });
      st.success++;
      if (t.commentId) {
        st.viaComment = (st.viaComment || 0) + 1;
        const psid = r.data?.recipient_id;
        if (psid) { getPsidMap(pageData).set(t.uid, String(psid)); if (c) c.psid = String(psid); }
      }
    } catch (err) {
      st.failed++;
      recordBroadcastError(st, err);
      if (err.response?.data?.error?.code === 190) { st.shouldStop = true; break; }
    }
    // คอมเมนต์นี้ใช้สิทธิ์ส่งส่วนตัวไปแล้ว (สำเร็จหรือไม่ก็ใช้ซ้ำไม่ได้)
    if (t.commentId && c && c.pendingComments) c.pendingComments = c.pendingComments.filter(x => x.id !== t.commentId);

    batchCount++;
    if (batchCount >= batchSize && (i + 1) < targets.length) {
      batchCount = 0;
      for (let m = pauseMin; m > 0; m--) {
        if (st.shouldStop) break;
        st.statusMessage = '⏳ พักระบบ ' + m + ' นาที...';
        for (let k = 0; k < 12 && !st.shouldStop; k++) await sleep(5000);
      }
    } else if ((i + 1) < targets.length) {
      await sleep(delaySec * 1000);
    }
  }
  st.isBroadcasting = false;
  const extra = st.skipped ? (' · ข้าม ' + st.skipped + ' คน (ยังไม่ทักแชท และไม่มีคอมเมนต์ที่ส่งส่วนตัวได้)') : '';
  st.statusMessage = (st.shouldStop ? '⏹️ หยุดบรอดแคสแล้ว' : '✅ บรอดแคสเสร็จสิ้น') + extra;
}

app.post('/api/live/broadcast/start', checkAuth, async (req, res) => {
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

  // คนที่ทักแชทมาภายใน 24 ชม. -> ส่งแชทปกติได้
  const { recipients: inWindow } = await collectBroadcastRecipients(ctx.pageData);
  const windowSet = new Set(inWindow);
  const psidMap = getPsidMap(ctx.pageData);
  const now = Date.now();
  const targets = [];
  const usedPsid = new Set();
  let skipped = 0;

  // 🏷️ กรองตามป้ายกำกับ: ส่งเฉพาะคนที่มีป้ายใดป้ายหนึ่งใน include และไม่มีป้ายใน exclude
  const includeLabels = (Array.isArray(req.body.includeLabels) ? req.body.includeLabels : []).map(String).filter(Boolean);
  const excludeLabels = (Array.isArray(req.body.excludeLabels) ? req.body.excludeLabels : []).map(String).filter(Boolean);
  let candidates = Array.from(s.commenters.entries()).filter(([, c]) => !onlyMatched || c.matchedCount > 0);
  let labelFiltered = 0;
  if (includeLabels.length || excludeLabels.length) {
    // ป้ายชื่อเดียวกันหลาย ID ให้นับเป็นป้ายเดียวกัน
    const expand = async (list) => Array.from(new Set((await Promise.all(list.map(id => sameNameLabelIds(ctx.pageData, id)))).flat()));
    const incAll = await expand(includeLabels);
    const excAll = await expand(excludeLabels);
    includeLabels.splice(0, includeLabels.length, ...incAll);
    excludeLabels.splice(0, excludeLabels.length, ...excAll);
    let labelErr = '';
    const checked = await Promise.all(candidates.map(([uid, c]) => {
      const psid = c.psid || psidMap.get(uid) || '';
      if (!psid) return Promise.resolve(!includeLabels.length); // ยังไม่มีแชท = ไม่มีป้ายใดๆ
      return fbLimit(ctx.pageData.config.pageId, () => getUserLabelIds(ctx.pageData, psid))
        .then(have => (!includeLabels.length || includeLabels.some(id => have.has(id))) && !excludeLabels.some(id => have.has(id)))
        .catch(e => { labelErr = graphErrorMessage(e); return false; });
    }));
    const before = candidates.length;
    candidates = candidates.filter((_, i) => checked[i]);
    labelFiltered = before - candidates.length;
    if (!candidates.length) {
      return res.json({ success: false, error: 'ไม่มีลูกค้าใน session นี้ที่ตรงเงื่อนไขป้ายกำกับ' + (labelErr ? ' (ตรวจป้ายไม่สำเร็จ: ' + labelErr + ')' : '') });
    }
  }

  for (const [uid, c] of candidates) {
    const psid = c.psid || psidMap.get(uid) || '';
    if (psid && windowSet.has(psid)) {
      if (!usedPsid.has(psid)) { usedPsid.add(psid); targets.push({ uid, psid }); }
      continue;
    }
    // ยังไม่ทักแชท -> ใช้ Private Reply ผ่านคอมเมนต์ล่าสุดที่ยังไม่เคยใช้สิทธิ์ (ภายใน 7 วัน)
    const pc = (c.pendingComments || []).filter(x => now - x.time < PRIVATE_REPLY_MS);
    if (pc.length) { targets.push({ uid, commentId: pc[pc.length - 1].id }); continue; }
    skipped++;
  }
  if (targets.length === 0) {
    return res.json({ success: false, error: 'ส่งไม่ได้: ' + skipped + ' คนนี้ยังไม่ได้ทักแชทภายใน 24 ชม. และคอมเมนต์ของเขาถูกใช้ส่งข้อความส่วนตัวไปแล้ว (Facebook อนุญาต 1 ครั้งต่อคอมเมนต์) — ให้ลูกค้าทักแชทเข้ามาก่อน หรือรอคอมเมนต์ใหม่' });
  }

  s.broadcastStatus = { isBroadcasting: true, total: targets.length, current: 0, success: 0, failed: 0, skipped, labelFiltered, viaComment: 0, errors: {}, statusMessage: 'กำลังเริ่มส่ง...', shouldStop: false };
  res.json({ success: true, total: targets.length, skipped, labelFiltered });
  runLiveBroadcast(s, ctx.pageData, targets, String(message), delaySec, batchSize, pauseMin).catch(e => {
    s.broadcastStatus.isBroadcasting = false;
    s.broadcastStatus.statusMessage = '❌ เกิดข้อผิดพลาด: ' + e.message;
  });
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

// 🧾 ตรวจสลิป 1 รูป (เรียกซ้ำได้ เมื่อธนาคารยังยืนยันไม่ได้)
async function processSlipImage(targetRecord, pageId, senderId, imageUrl, attempt = 0) {
  const pageData = targetRecord.pageData;
  const configStore = pageData.config;
  const usedSlips = pageData.usedSlips || (pageData.usedSlips = new Set());
  console.log(`🧾 [Page: ${pageId}] พบรูปภาพจากลูกค้า ID: ${senderId} กำลังตรวจสอบสลิป...` + (attempt ? ' (ลองใหม่ครั้งที่ ' + attempt + ')' : ''));
  // ตรวจสลิปกับผู้ให้บริการที่ตั้งไว้ (ZWIZ / EasySlip)
  const slipResult = await verifySlip(imageUrl, configStore, targetRecord.pageData);

  // ส่งข้อความตอบลูกค้า + บันทึกผลการส่งไว้ในประวัติตรวจสลิป (รายการล่าสุดของลูกค้าคนนี้)
  const sendSlipReply = async (text) => {
    const at = (pageData.slipAttempts || []).find(a => a.senderId === senderId && a.result !== 'noimage' && Date.now() - a.time < 5 * 60000);
    const mark = (st) => { if (at) at.replyStatus = st; };
    if (!configStore.pageAccessToken) { mark('❌ ไม่ได้ส่งข้อความ: เพจไม่มี Token'); return; }
    if (!String(text || '').trim()) { mark('⚠️ ไม่ได้ส่งข้อความ: ยังไม่ได้ตั้งข้อความตอบกลับของผลนี้ (หน้าตั้งค่าตรวจสลิป)'); return; }
    try {
      await fbPost('https://graph.facebook.com/v19.0/me/messages', {
        recipient: { id: senderId },
        messaging_type: 'RESPONSE',
        message: { text: String(text).slice(0, 2000) }
      }, { access_token: configStore.pageAccessToken }, 2);
      mark('💬 ส่งข้อความตอบลูกค้าแล้ว');
    } catch (sendErr) {
      if (isFbSpamBlock(sendErr)) setFbPause(pageData, 'inbox', sendErr);
      const em = graphErrorMessage(sendErr);
      mark('❌ ส่งข้อความตอบลูกค้าไม่สำเร็จ: ' + em);
      pageData.lastSlipError = { code: 'REPLY: ' + em.slice(0, 120), at: Date.now() };
      console.error('❌ [Send Slip Reply Error]', sendErr.response?.data || sendErr.message);
    }
  };

  const slip = slipResult.slip || null;
  const provider = configStore.slipProvider || 'zwiz';

  if (!slip) {
    const errCode = slipResult.errCode || '';
    console.log(`⚠️ [Page: ${pageId}] ตรวจสลิปไม่สำเร็จ (${provider})`, errCode);
    // อ่าน QR ได้แล้ว แต่ธนาคารยังยืนยันไม่ได้ (เช่น กรุงเทพ/ออมสิน ต้องรอสักครู่หลังโอน) -> เป็นสลิปจริงแน่ ลองใหม่อัตโนมัติ
    const RETRYABLE = ['VERIFY_FAILED', 'UNABLE_TO_VERIFY', 'SLIP_PENDING'];
    if (RETRYABLE.includes(errCode)) {
      const delays = [3, 8]; // นาที
      if (attempt < delays.length) {
        logSlipAttempt(pageData, { senderId, provider, result: 'retry', code: errCode, note: 'ธนาคารยังยืนยันไม่ได้ จะลองใหม่ใน ' + delays[attempt] + ' นาที' + (slipResult.detail ? ' · ' + slipResult.detail : '') });
        if (attempt === 0) await sendSlipReply('⏳ ได้รับสลิปแล้วค่ะ ระบบกำลังตรวจสอบกับธนาคาร (บางธนาคารใช้เวลาไม่กี่นาที) จะแจ้งผลให้อีกครั้งนะคะ 🙏');
        setTimeout(() => runTask(() => processSlipImage(targetRecord, pageId, senderId, imageUrl, attempt + 1), 'slip-retry'), delays[attempt] * 60 * 1000);
        return;
      }
      logSlipAttempt(pageData, { senderId, provider, result: 'unreadable', code: errCode, note: 'ลองใหม่ครบแล้ว ธนาคารยังยืนยันไม่ได้' + (slipResult.detail ? ' · ' + slipResult.detail : '') });
      labelSlipResult(pageData, senderId, 'unreadable');
      await sendSlipReply(configStore.msgSlipUnreadable);
      return;
    }
    // ปัญหาฝั่งระบบ (key / โควตา / เซิร์ฟเวอร์ EasySlip) ไม่ใช่ความผิดลูกค้า -> ไม่แจ้งลูกค้า
    const systemErr = ['MISSING_API_KEY', 'INVALID_API_KEY', 'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'IP_NOT_ALLOWED', 'BRANCH_INACTIVE', 'SERVICE_BANNED', 'SERVICE_DELETED', 'USER_BANNED', 'RATE_LIMIT_EXCEEDED', 'API_SERVER_ERROR', 'INTERNAL_SERVER_ERROR', 'INTERNAL_ERROR', 'IMAGE_DOWNLOAD_FAILED', 'NETWORK_ERROR', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504'].includes(errCode);
    if (systemErr) targetRecord.pageData.lastSlipError = { code: errCode, at: Date.now() };
    const mode = configStore.slipUnreadableMode || 'smart';
    const payCtx = isPaymentContext(targetRecord.pageData, senderId);
    const notify = !systemErr && (mode === 'always' || (mode === 'smart' && payCtx));
    logSlipAttempt(pageData, { senderId, provider, result: systemErr ? 'system' : 'unreadable', code: errCode || 'ไม่ทราบสาเหตุ', note: systemErr ? 'ปัญหาฝั่งระบบตรวจสลิป (ไม่แจ้งลูกค้า)' : (notify ? 'แจ้งลูกค้าให้ส่งใหม่' : 'ไม่ใช่สลิป/ไม่พบ QR · ไม่ตอบ') });
    if (notify) {
      labelSlipResult(targetRecord.pageData, senderId, 'unreadable');
      await sendSlipReply(configStore.msgSlipUnreadable);
    } else {
      console.log(`🖼️ [Page: ${pageId}] รูปจาก ${senderId} ไม่ใช่สลิป/อ่านไม่ได้ -> ไม่ตอบ (${systemErr ? 'ปัญหาระบบ ' + errCode : 'ลูกค้าไม่ได้อยู่ในช่วงจ่ายเงิน'})`);
    }
    return;
  }

  // สลิปใบเดิมจากลูกค้าคนเดิมภายใน 10 นาที (เช่น รูป + การ์ดสลิปของ Messenger มาคู่กัน) -> ข้ามเงียบ ๆ ไม่ตอบว่าซ้ำ
  if (usedSlips.has(slip.transRef) && (pageData.slipLog || []).some(x => x.transRef === slip.transRef && x.senderId === senderId && Date.now() - x.time < 10 * 60000)) {
    console.log(`🔁 [Page: ${pageId}] สลิปเดิมจาก ${senderId} ส่งเข้ามาซ้ำในไม่กี่นาที ข้าม`);
    return;
  }
  if (usedSlips.has(slip.transRef) || slip.isDuplicate) {
    console.log(`🔄 [Page: ${pageId}] สลิปซ้ำ ถูกใช้งานไปแล้ว`);
    logSlipAttempt(pageData, { senderId, provider, result: 'duplicate', code: slip.transRef, amount: slip.amount });
    labelSlipResult(targetRecord.pageData, senderId, 'duplicate');
    await sendSlipReply(configStore.msgSlipDuplicate);
    return;
  }

  // ZWIZ ตรวจบัญชีปลายทางให้แล้ว (matched / not_matched) ถ้าไม่ได้ตรวจ (skipped) ใช้การเทียบของระบบเอง
  const receiverOk = slip.matchResult === 'matched' ? true
    : slip.matchResult === 'not_matched' ? false
    : slip.receiverAccounts.length > 0
      ? accountMatches(configStore.merchantAccount, slip.receiverAccounts)
      : (!configStore.merchantAccount && !configStore.merchantName) || nameMatches(configStore.merchantName, slip.receiverNameTh);

  if (!receiverOk) {
    console.log(`❌ [Page: ${pageId}] เลขบัญชีผู้รับไม่ตรงกับร้านค้า`, slip.receiverAccounts, slip.receiverNameTh);
    logSlipAttempt(pageData, { senderId, provider, result: 'invalid', code: slip.matchResult || 'account', amount: slip.amount,
      note: 'ปลายทางในสลิป: ' + (slip.receiverBank ? 'ธนาคาร ' + bankNameFromCode(slip.receiverBank) + ' ' : '') + (slip.receiverAccounts.join(', ') || '-') + (slip.receiverNameTh ? ' (' + slip.receiverNameTh + ')' : '')
        + ' · ที่ตั้งไว้: ' + (configStore.merchantBank || '-') + ' ' + (configStore.merchantAccount || '-') });
    labelSlipResult(targetRecord.pageData, senderId, 'invalid');
    await sendSlipReply(configStore.msgSlipInvalid);
    return;
  }

  usedSlips.add(slip.transRef);
  logSlipAttempt(pageData, { senderId, provider, result: 'valid', code: slip.transRef, amount: slip.amount, note: attempt ? 'ผ่านหลังลองใหม่ ' + attempt + ' ครั้ง' : '' });
  labelSlipResult(targetRecord.pageData, senderId, 'valid');
  if (usedSlips.size > 50000) { let i = 0; for (const k of usedSlips) { usedSlips.delete(k); if (++i >= 5000) break; } }

  // บันทึกสลิปที่ผ่านการตรวจไว้ระดับเพจ (ใช้ดูสถานะ "โอนแล้ว" ของลูกค้า)
  if (!targetRecord.pageData.slipLog) targetRecord.pageData.slipLog = [];
  targetRecord.pageData.slipLog.push({ senderId, amount: Number(slip.amount) || 0, transRef: slip.transRef, time: Date.now() });
  if (targetRecord.pageData.slipLog.length > 5000) targetRecord.pageData.slipLog.splice(0, 1000);

  // บันทึกยอดโอนเข้า session ไลฟ์ของลูกค้าคนนี้
  const slipSession = findLiveSessionForSender(targetRecord.pageData, senderId);
  if (slipSession) {
    slipSession.slips.push({
      transRef: slip.transRef,
      amount: Number(slip.amount) || 0,
      senderId,
      senderName: findCommenterBySender(slipSession, senderId)?.name || '',
      time: Date.now()
    });
  }
  const replyText = (configStore.msgSlipSuccess || '')
    .replace('{amount}', slip.amount)
    .replace('{date}', slip.dateText);

  console.log(`✅ [Page: ${pageId}] สลิปถูกต้อง ส่งข้อความตอบกลับ`);
  await sendSlipReply(replyText);
}

// ประวัติการตรวจสลิปล่าสุด (แสดงในหน้าตั้งค่าสลิป ช่วยดูสาเหตุที่ไม่ผ่าน)
function logSlipAttempt(pageData, rec) {
  if (!pageData.slipAttempts) pageData.slipAttempts = [];
  const name = rec.name || (rec.senderId ? knownNameForPsid(pageData, rec.senderId) : '');
  pageData.slipAttempts.unshift({ time: Date.now(), ...rec, name, amount: rec.amount !== undefined ? Number(rec.amount) || 0 : undefined });
  if (pageData.slipAttempts.length > 50) pageData.slipAttempts.length = 50;
}
const BANK_CODE_NAMES = { '002': 'กรุงเทพ', '004': 'กสิกรไทย', '006': 'กรุงไทย', '011': 'ทีทีบี', '014': 'ไทยพาณิชย์', '022': 'ซีไอเอ็มบี', '024': 'ยูโอบี', '025': 'กรุงศรี', '030': 'ออมสิน', '033': 'อาคารสงเคราะห์', '034': 'ธ.ก.ส.', '067': 'ทิสโก้', '069': 'เกียรตินาคิน', '073': 'แลนด์แอนด์เฮ้าส์' };
function bankNameFromCode(c) { return BANK_CODE_NAMES[String(c)] || String(c); }

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
          // ข้ามข้อความที่เพจส่งเอง (echo)
          if (msgEvent.message && msgEvent.message.is_echo) continue;
          runTask(async () => {

          const senderId = msgEvent.sender?.id;
          if (senderId) {
            subscribers.add(senderId);
            const li = targetRecord.pageData.lastInbound || (targetRecord.pageData.lastInbound = new Map());
            li.delete(String(senderId));
            li.set(String(senderId), Date.now());
            if (li.size > 20000) { let i = 0; for (const k of li.keys()) { li.delete(k); if (++i >= 2000) break; } }
          }

          // 📦 เก็บข้อความตัวอักษรของลูกค้าไว้ ใช้ค้นหาชื่อที่อยู่สำหรับใบแปะหน้า
          if (senderId && msgEvent.message && msgEvent.message.text) {
            logInboxText(targetRecord.pageData, senderId, msgEvent.message.text);
            // ลูกค้าทักแชท: ถ้าเคยติดป้ายคำดักไม่สำเร็จ ลองใหม่ (ไลฟ์ที่เปิดอยู่)
            for (const ls of Object.values(targetRecord.pageData.liveSessions || {})) {
              if (ls.status !== 'active') continue;
              const cm = findCommenterBySender(ls, senderId);
              if (cm && cm.matchedCount > 0 && !cm.kwLabeled) labelKeywordCommenter(targetRecord.pageData, cm, String(senderId), ls.config);
            }
          }

          if (msgEvent.message && msgEvent.message.attachments && configStore.enableSlipVerify) {
            const types = msgEvent.message.attachments.map(a => a && a.type).join(',');
            const urls = slipImageUrlsFromMessage(msgEvent.message);
            if (types !== 'image') console.log(`📎 [Page: ${pageId}] ไฟล์แนบชนิด ${types} จาก ${senderId} · พบรูป ${urls.length}`);
            if (!urls.length) {
              const onlyStickers = msgEvent.message.attachments.every(a => a && a.type === 'image');
              // การ์ด template ที่ไม่มีข้อมูล (Messenger แปลงสลิปเป็นการ์ด "ตรวจสอบยืนยันสลิป") -> รูปสลิปตัวจริงมาเป็นอีกข้อความ ไม่ต้องบันทึก
              const emptyCards = msgEvent.message.attachments.every(a => a && a.type !== 'image' && (!a.payload || !Object.keys(a.payload).length));
              if (emptyCards && msgEvent.message.mid) {
                // บางครั้ง Facebook ส่งมาแค่การ์ดเปล่า ไม่ส่งรูปสลิปตามมา -> รอ 15 วิ ถ้ายังไม่มีรูปสลิปของลูกค้าคนนี้
                // ให้ถามรูปจาก Facebook ด้วย ID ข้อความ แล้วตรวจสลิปเอง
                const mid = msgEvent.message.mid, pd = targetRecord.pageData;
                setTimeout(() => runTask(() => fetchSlipFromCard(targetRecord, pageId, senderId, mid), 'slip-card'), 15000);
              }
              if (!onlyStickers && !emptyCards) {
                // บันทึกไว้ดูในประวัติตรวจสลิป เผื่อ Facebook ส่งสลิปมาในรูปแบบที่ยังไม่รองรับ
                let raw = ''; try { raw = JSON.stringify(msgEvent.message.attachments).slice(0, 300); } catch (e) {}
                logSlipAttempt(targetRecord.pageData, { senderId, provider: '-', result: 'noimage', code: types, note: 'ได้รับไฟล์แนบแต่ไม่พบรูปสลิป · ' + raw });
              }
            }
            for (const imageUrl of urls) await processSlipImage(targetRecord, pageId, senderId, imageUrl, 0);
          }
          }, 'messaging');
        }
      }

      // 2. ระบบบอตตอบคอมเมนต์อัตโนมัติ
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
            const comment = change.value;
            const senderId = comment.from?.id;
            // ข้ามคอมเมนต์ที่เพจตอบเอง (ไม่นับเป็นลูกค้า และกันบอตตอบวนซ้ำ)
            if (senderId && (senderId === pageId || senderId === configStore.pageId)) {
              // 🔔 เพจคอมเมนต์หัวใจในไลฟ์ที่เปิดโหมดประมูล = ปิดการประมูลรอบนี้
              if (isAuctionCloseSignal(comment.message) && !seenComment(targetRecord.pageData, comment.comment_id)) {
                const ls = findLiveSessionForComment(targetRecord.pageData, comment.post_id, comment.video_id);
                if (ls && ls.config.auctionMode) {
                  const at = comment.created_time ? Number(comment.created_time) * 1000 || Date.now() : Date.now();
                  if (!Array.isArray(ls.auctionCloses)) ls.auctionCloses = [];
                  ls.auctionCloses.push(at);
                  ls.auctionCloses.sort((x, y) => x - y);
                  if (ls.auctionCloses.length > 500) ls.auctionCloses.splice(0, 100);
                  console.log('🔔 [Auction] เพจส่งสัญญาณปิดประมูล');
                }
              }
              continue;
            }
            if (seenComment(targetRecord.pageData, comment.comment_id)) continue;
            // หมายเหตุ: ID คนคอมเมนต์ ไม่ใช่ ID แชท (PSID) จึงไม่เพิ่มเข้ารายชื่อบรอดแคส (ส่งไปก็ล้มเหลว)

            // หา session ไลฟ์ที่คอมเมนต์นี้สังกัด (ถ้ามี) แล้วใช้ค่าตั้งของ session แทนค่าหลักของเพจ
            const liveSession = findLiveSessionForComment(targetRecord.pageData, comment.post_id, comment.video_id);
            const cfg = liveSession ? { ...configStore, ...liveSession.config } : configStore;

            const commentText = comment.message || '';
            const auctionOn = !!(liveSession && liveSession.config.auctionMode);
            const bidAmount = auctionOn ? parseBid(commentText) : null;
            const commentAt = comment.created_time ? Number(comment.created_time) * 1000 || Date.now() : Date.now();
            // โหมดประมูล: คอมเมนต์ราคา (เช่น 100) ไม่ถือเป็นคำดัก แม้ตั้งแบบ "มีคำว่า 1"
            const matchedKw = bidAmount !== null ? '' : findMatchedKeyword(cfg, commentText);
            const isMatched = !!matchedKw;

            if (liveSession) {
              liveSession.stats.comments++;
              if (isMatched) liveSession.stats.matched++;
              if (senderId) {
                const prev = liveSession.commenters.get(senderId) ||
                  { name: '', count: 0, matchedCount: 0, lastMessage: '', lastKeyword: '', lastTime: 0, psid: '' };
                if (comment.from?.name) prev.name = comment.from.name;
                prev.count++;
                if (isMatched) { prev.matchedCount++; prev.lastKeyword = matchedKw; }
                prev.lastMessage = commentText.slice(0, 200);
                prev.lastTime = Date.now();
                if (bidAmount !== null) {
                  if (!Array.isArray(prev.bids)) prev.bids = [];
                  prev.bids.push({ amount: bidAmount, time: commentAt });
                  if (prev.bids.length > 30) prev.bids.shift();
                  prev.lastBid = bidAmount;
                  if (!Array.isArray(liveSession.bidLog)) liveSession.bidLog = [];
                  liveSession.bidLog.push({ uid: senderId, name: comment.from?.name || '', amount: bidAmount, time: commentAt });
                  if (liveSession.bidLog.length > 3000) liveSession.bidLog.splice(0, 500);
                }
                if (!prev.psid) prev.psid = getPsidMap(targetRecord.pageData).get(senderId) || '';
                // เก็บคอมเมนต์ที่ยังไม่เคยส่งข้อความส่วนตัว (Private Reply) ไว้ใช้บรอดแคสต์ภายหลัง (Facebook ให้ส่งได้ 1 ครั้ง/คอมเมนต์ ภายใน 7 วัน)
                if (!prev.pendingComments) prev.pendingComments = [];
                if (comment.comment_id) {
                  prev.pendingComments.push({ id: comment.comment_id, time: Date.now() });
                  if (prev.pendingComments.length > 5) prev.pendingComments.shift();
                }
                liveSession.commenters.set(senderId, prev);
              }
            }

            // ⏱️ ไม่ตอบซ้ำคนเดิมถี่ ๆ (ตั้งได้ในหน้า session: 0 = ตอบทุกครั้ง)
            const cooldownMs = Math.max(0, Number(cfg.replyCooldownMin) || 0) * 60000;
            const cRec = !senderId ? null : (liveSession ? liveSession.commenters.get(senderId) : (isMatched ? pageCommenterRec(targetRecord.pageData, senderId) : null));
            // โหมดประมูล: บิดราคาใหม่แล้วกด 1 = ชนะองค์ใหม่ ไม่ติดคูลดาวน์
            const hasNewBid = !!(auctionOn && cRec && Array.isArray(cRec.bids) && cRec.bids.some(b => b.time > (cRec.lastWinAt || 0)));
            const inCooldown = !!(isMatched && !hasNewBid && cooldownMs && cRec && cRec.lastRepliedAt && Date.now() - cRec.lastRepliedAt < cooldownMs);
            if (inCooldown) console.log('⏱️ [Comment] ข้าม ' + (comment.from?.name || senderId) + ' (เพิ่งตอบไปไม่ถึง ' + cfg.replyCooldownMin + ' นาที)');
            if (isMatched && cRec && !inCooldown) cRec.lastRepliedAt = Date.now();

            // สวิตช์หลักในเมนู "ตอบกลับคอมเมนต์" ปิดอยู่ -> ไม่ตอบคอมเมนต์ในโพสต์ทั่วไป (Live Session ใช้สวิตช์ของ session เอง)
            const botOff = !liveSession && configStore.enableCommentBot === false;
            if (isMatched && cfg.pageAccessToken && !inCooldown && !botOff) {
              const token = cfg.pageAccessToken;
              const commentId = comment.comment_id;
              const pageDataRef = targetRecord.pageData;
              const t0 = Date.now();
              const customerName = comment.from?.name || '';
              let inboxMsg = renderReplyText(cfg.inboxText, customerName);
              let replyMsg = renderReplyText(cfg.replyCommentText, customerName);
              // ⚡ ส่งเข้าแชท + ตอบคอมเมนต์ ใช้คิวหลัก (สำคัญ) · กดไลก์แยกคิวรอง ไม่แย่งช่องของงานสำคัญ
              runTask(async () => {
                if (auctionOn && senderId) {
                  // 🔨 รอ 3 วิ เผื่อคอมเมนต์ราคาที่พิมพ์ก่อนกด 1 ยังมาไม่ถึง แล้วหายอดจบประมูล
                  await sleep(3000);
                  const c = liveSession.commenters.get(senderId);
                  const win = auctionAmountFor(liveSession, senderId, commentAt);
                  // ข้อความส่งเข้าแชทไม่มี {amount} -> เติมบรรทัดยอดประมูลไว้บนสุดให้อัตโนมัติ
                  const aText = renderReplyText(typeof liveSession.config.auctionText === 'string' ? liveSession.config.auctionText : '🔨 ยอดประมูล {amount} บาท', customerName);
                  if (inboxMsg && aText.trim() && !/\{amount\}/i.test(inboxMsg)) inboxMsg = aText.trim() + '\n\n' + inboxMsg;
                  if (win) {
                    const amountText = Number(win.amount).toLocaleString('en-US');
                    inboxMsg = inboxMsg.replace(/\{amount\}/gi, amountText);
                    replyMsg = replyMsg.replace(/\{amount\}/gi, amountText);
                  } else {
                    // ไม่พบราคาที่บิด: แทน "{amount} บาท" ทั้งก้อนด้วยข้อความรอแอดมิน
                    const noBid = liveSession.config.auctionNoBidText || 'รอแอดมินแจ้งยอด';
                    inboxMsg = inboxMsg.replace(/\{amount\}\s*(?:บาท|฿)?/gi, noBid);
                    replyMsg = replyMsg.replace(/\{amount\}\s*(?:บาท|฿)?/gi, noBid);
                  }
                  if (c) {
                    if (!Array.isArray(c.wins)) c.wins = [];
                    c.wins.push({ amount: win ? win.amount : 0, time: commentAt, lot: win ? win.lot : 0, dup: !!(win && win.dupLot), warning: win ? win.warning : 'กด 1 แต่ไม่พบราคาที่บิด (ลงท้ายด้วย 0)', commentId });
                    if (c.wins.length > 30) c.wins.shift();
                    c.lastWinAt = commentAt;
                    if (win && win.lot) { if (!Array.isArray(c.wonLots)) c.wonLots = []; if (!c.wonLots.includes(win.lot)) c.wonLots.push(win.lot); if (c.wonLots.length > 100) c.wonLots.shift(); }
                    // 💰 บวกยอดประมูลเข้า "ยอดที่ต้องจ่าย" อัตโนมัติ (เช่น 380+1500)
                    if (win && win.amount > 0 && !win.dupLot) {
                      const prevDue = Number(c.dueAmount) || 0;
                      c.dueExpr = prevDue > 0 ? (c.dueExpr || String(prevDue)) + '+' + win.amount : '';
                      c.dueAmount = Math.round((prevDue + win.amount) * 100) / 100;
                      if (!c.dueExpr) delete c.dueExpr;
                    }
                  }
                  // กด 1 ซ้ำในรอบเดิม: ไม่ส่งข้อความซ้ำ
                  if (win && win.dupLot) { inboxMsg = ''; replyMsg = ''; }
                  console.log('🔨 [Auction] ' + customerName + ' กด 1 → ยอด ' + (win ? win.amount : '-') + (win && win.warning ? ' ⚠️ ' + win.warning : ''));
                } else {
                  inboxMsg = inboxMsg.replace(/\{amount\}/gi, '');
                  replyMsg = replyMsg.replace(/\{amount\}/gi, '');
                }
                return fbLimit(pageId, async () => {
                const jobs = [];
                if (cfg.enableInbox && inboxMsg && !fbPaused(pageDataRef, 'inbox')) {
                  jobs.push(fbPost('https://graph.facebook.com/v19.0/me/messages', {
                    recipient: { comment_id: commentId },
                    message: { text: inboxMsg }
                  }, { access_token: token }).then(inboxRes => {
                    // 📦 จับคู่ ID คนคอมเมนต์ กับ ID แชท (PSID) เพื่อใช้ค้นหาที่อยู่ในแชทภายหลัง
                    const psid = inboxRes.data?.recipient_id;
                    const c = senderId ? liveSession?.commenters.get(senderId) : null;
                    if (c && c.pendingComments) c.pendingComments = c.pendingComments.filter(x => x.id !== commentId);
                    if (psid && senderId) {
                      getPsidMap(pageDataRef).set(senderId, String(psid));
                      if (c) c.psid = String(psid);
                      if (c && liveSession) labelKeywordCommenter(pageDataRef, c, String(psid), liveSession.config);
                      else if (!liveSession) labelKeywordCommenter(pageDataRef, pageCommenterRec(pageDataRef, senderId), String(psid), cfg);
                    }
                    console.log('⚡ [Inbox] ' + commentId + ' ส่งเข้าแชทใน ' + (Date.now() - t0) + ' ms');
                  }).catch(inbErr => {
                    if (isFbSpamBlock(inbErr)) setFbPause(pageDataRef, 'inbox', inbErr);
                    console.error('❌ [Inbox Error]', inbErr.response?.data?.error?.message || inbErr.message);
                  }));
                }
                if (cfg.enableCommentReply && replyMsg && !fbPaused(pageDataRef, 'reply')) {
                  jobs.push(fbPost('https://graph.facebook.com/v19.0/' + commentId + '/comments', {
                    message: replyMsg
                  }, { access_token: token }, 1)
                    .catch(repErr => {
                      if (isFbSpamBlock(repErr)) setFbPause(pageDataRef, 'reply', repErr);
                      console.error('❌ [Comment Reply Error]', repErr.response?.data?.error?.message || repErr.message);
                    }));
                }
                await Promise.all(jobs);
                // ยังไม่ได้ติดป้าย (เช่น ปิดส่งเข้าแชท) แต่รู้ ID แชทของคนนี้อยู่แล้ว -> ติดป้ายเลย
                if (liveSession && senderId) {
                  const c2 = liveSession.commenters.get(senderId);
                  const known = c2 && (c2.psid || getPsidMap(pageDataRef).get(senderId));
                  if (c2 && known) labelKeywordCommenter(pageDataRef, c2, String(known), liveSession.config);
                } else if (senderId) {
                  const known = getPsidMap(pageDataRef).get(senderId);
                  if (known) labelKeywordCommenter(pageDataRef, pageCommenterRec(pageDataRef, senderId), String(known), cfg);
                }
              });
              }, 'comment');
              if (cfg.enableAutoLike && !botOff) {
                runTask(() => fbLimit(pageId + ':like', () => axios.post('https://graph.facebook.com/v19.0/' + commentId + '/likes', {}, {
                  params: { access_token: token }, timeout: 15000
                }).catch(() => {})), 'like');
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

// 💾 สถานะฐานข้อมูล
app.get('/api/db/status', checkAuth, (req, res) => {
  res.json({ success: true, enabled: dbState.enabled, loaded: dbState.loaded, lastSave: dbState.lastSave, keys: dbState.keys, lastError: dbState.lastError, lastErrorAt: dbState.lastErrorAt });
});

// ⚡ จุดเช็กสถานะเบา ๆ (ตัวปลุกเซิร์ฟเวอร์ใช้ตัวนี้ แทนการโหลดหน้าเว็บ 350KB)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// 🛡️ กันเซิร์ฟเวอร์ล่ม: error ที่หลุดจากงานเบื้องหลังจะถูกบันทึกไว้ ไม่ทำให้ข้อมูลในหน่วยความจำหายทั้งหมด
process.on('unhandledRejection', (e) => console.error('⚠️ [Unhandled Rejection]', e?.response?.data || e?.message || e));
process.on('uncaughtException', (e) => console.error('⚠️ [Uncaught Exception]', e?.stack || e));

let server = null;
const dbBoot = Promise.race([initDb(), sleep(45000)]).catch(() => {});
dbBoot.then(() => {
server = app.listen(PORT, () => {
  console.log('Server is running on port ' + PORT);
  if (DB_ENABLED) setInterval(() => saveDb(false), 15 * 1000);
  loadThaiAddressDb();
  setInterval(() => { if (!thaiAddrDb) loadThaiAddressDb(); }, 10 * 60 * 1000);
  setInterval(async () => {
    try { await axios.get(serverUrl + '/healthz', { timeout: 5000 }); } catch (e) {}
  }, 10 * 60 * 1000);
});
// ⚡ ให้การเชื่อมต่อจาก Load Balancer ของ Render อยู่นานกว่า (ลด error 502 เป็นครั้งคราว)
if (server) {
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;
}
});

// 💾 Render ส่งสัญญาณ SIGTERM ก่อนรีสตาร์ท/Deploy ใหม่ -> บันทึกข้อมูลล่าสุดก่อนปิด
let shuttingDown = false;
async function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('💾 [DB] ได้รับ ' + sig + ' กำลังบันทึกข้อมูลก่อนปิด...');
  try {
    if (DB_ENABLED && dbState.loaded) {
      for (let i = 0; i < 20 && dbState.saving; i++) await sleep(250);
      await Promise.race([saveDb(true), sleep(20000)]);
      console.log('💾 [DB] บันทึกเรียบร้อย');
    }
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));