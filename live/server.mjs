// Chánh Điện Tịnh Tâm — live server
// Runs on the streaming PC. Serves the overlay + control panel, listens to a TikTok LIVE room,
// keeps the list of seated viewers, generates Vietnamese voice lines with Edge TTS and pushes
// everything to the overlay over WebSocket.
//
//   cd live && npm install && node server.mjs        → http://localhost:3000/live/control.html
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // repo root: serves /assets, /live
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
const PORT = +process.env.PORT || 3000;

/* ------------------------------------------------------------------ state */
const settings = {
  title: 'Chánh Điện Tịnh Tâm',
  subtitle: 'Nam Mô A Di Đà Phật',
  voice: 'vi-VN-NamMinhNeural',      // or vi-VN-HoaiMyNeural
  pitch: -18,                        // Hz
  rate: -20,                         // %
  music: true, mo: true, moBpm: 52,
  track: 'auto',                     // 'auto' = shuffle every file in assets/music, or one file name to loop
  musicVol: 50,                      // background music volume, 0-100
  autoChant: true, chantEveryMin: 3,
  seatMode: 'auto',                  // auto | 24 | 36 | 64 | 100
  joinOnEnter: false,                // also seat viewers who only enter the room
  requireKeyword: true,              // a viewer must comment the keyword below to walk into the hall
  joinKeyword: 'nam mô a di đà phật, a di đà phật, nam mô',   // comma separated; accents / case / punctuation are ignored
  welcomeVoice: true,                // read out the names of newcomers in batches
  ctaVoice: true, ctaEveryMin: 5,    // periodically invite the audience to type the keyword / commands
  gifts: { readAll: true, minDiamonds: 1 },
};
const stats = { lay: 0, niem: 0 };   // collective bows / chants since the server started
const viewers = new Map();           // id -> { id, name, skin, avatar, coins, joinedAt, lastAt, lastText, lastTextAt, demo }
const startedAt = Date.now();
let tiktok = null, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const log = [];
function addLog(s){ const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`; log.push(line); if (log.length > 300) log.shift(); broadcast({ t:'log', line }, 'control'); console.log(line); }

const CAPS = [24, 36, 64, 100];
function capacity(){ if (settings.seatMode !== 'auto') return +settings.seatMode; const n = viewers.size; return CAPS.find(c => n <= c) || 100; }

/* skins: sprites that exist in /assets. Walking strips exist for man / woman / granny. */
// A comment changes the outfit only when it IS the keyword (≤ 3 words), so "Nam mô A Di Đà Phật" never reads as "nam".
const SKIN_WORDS = [
  ['master', ['cao tăng','cao tang']], ['monk', ['sư','su','sư thầy','su thay','thầy','thay']], ['nun', ['ni','ni cô','ni co','sư cô','su co']],
  ['child', ['tiểu','tieu','chú tiểu','chu tieu','bé','be']], ['granny', ['bà','ba','áo nâu','ao nau','cụ','cu']],
  ['woman', ['nữ','nu','chị','chi','gái','gai']], ['man', ['nam','anh','trai']],
];
function skinFromText(t){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3) return null;
  for (const [skin, words] of SKIN_WORDS) if (words.some(k => w === k || w.startsWith(k + ' '))) return skin;
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'woman', 'man', 'granny'];

function pub(v){ return { id:v.id, name:v.name, skin:v.skin, avatar:v.avatar||'', coins:v.coins, lay:v.lay||0, niem:v.niem||0, demo:!!v.demo }; }
/* background music: every audio file dropped into assets/music shows up in the panel (use the rescan button, no restart) */
const MUSIC_DIR = path.join(ROOT, 'assets', 'music');
const MUSIC_EXT = /\.(mp3|ogg|wav|m4a|aac|flac|opus)$/i;
function listTracks(){ try { return fs.readdirSync(MUSIC_DIR).filter(f => MUSIC_EXT.test(f) && !f.startsWith('.')).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true })); } catch { return []; } }
let tracks = listTracks();
function snapshot(){ return { t:'state', tracks, settings, viewers:[...viewers.values()].map(pub), cap: capacity(), startedAt, tiktok: tiktokState, stats }; }

/* ------------------------------------------------- keyword + action commands */
// fold(): lower-case, strip Vietnamese accents and punctuation → "Nam mô A Di Đà Phật!" == "nam mo a di da phat"
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function keywords(){ const k = String(settings.joinKeyword || '').split(/[,|\n]/).map(fold).filter(Boolean); return k.length ? k : ['nam mo a di da phat']; }
function hasKeyword(text){ const w = ' ' + fold(text) + ' '; return keywords().some(k => w.includes(' ' + k + ' ')); }
// Commands a seated viewer can type. Short and easy to type on a phone: the digits are the main path.
const ACTIONS = {
  lay:   { words: ['1', 'lay', 'lay phat', 'cui lay', 'le phat', 'bai phat', '3 lay'],                 ms: 8000,  bows: 3, label: 'Lạy Phật' },
  huong: { words: ['2', 'thap huong', 'dang huong', 'huong', 'dot huong'],                            ms: 32000, bows: 3, label: 'Thắp hương' },
  dao:   { words: ['3', 'kinh hanh', 'di dao', 'di bo', 'dao', 'di'],                                 ms: 24000, bows: 0, label: 'Kinh hành' },
  chap:  { words: ['4', 'chap tay', 'cau nguyen', 'nguyen', 'cau an', 'cau binh an'],                 ms: 4000,  bows: 1, label: 'Chắp tay cầu nguyện' },
};
function actionFromText(t){
  const w = fold(t); if (!w || w.split(' ').length > 5) return null;
  for (const [act, a] of Object.entries(ACTIONS)) if (a.words.some(k => w === k || (k.length > 2 && w.startsWith(k + ' ')))) return act;
  return null;
}
const crossed = (before, now, step) => Math.floor(now / step) > Math.floor(before / step);
function milestone(kind, total){
  const line = kind === 'lay' ? `Cả chánh điện đã cùng nhau lễ ${total} lạy. Nam mô A Di Đà Phật.` : `Cả chánh điện đã cùng niệm Phật ${total} lần. Nam mô A Di Đà Phật.`;
  broadcast({ t:'milestone', kind, total }); addLog('🏮 ' + line); say(line, { tag:'milestone' });
}
function doAction(v, act){
  const now = Date.now(), a = ACTIONS[act];
  if (act !== 'niem' && now < (v.busyUntil || 0)) return false;          // still doing the previous one: ignore the spam
  if (act === 'niem'){
    const before = stats.niem; v.niem = (v.niem || 0) + 1; stats.niem++;
    broadcast({ t:'act', id: v.id, name: v.name, act, lay: v.lay || 0, niem: v.niem, stats });
    if (crossed(before, stats.niem, 108)) milestone('niem', Math.floor(stats.niem / 108) * 108);
    return true;
  }
  v.busyUntil = now + a.ms;
  const before = stats.lay; v.lay = (v.lay || 0) + a.bows; stats.lay += a.bows;
  broadcast({ t:'act', id: v.id, name: v.name, act, label: a.label, lay: v.lay, niem: v.niem || 0, stats });
  if (a.bows && crossed(before, stats.lay, 108)) milestone('lay', Math.floor(stats.lay / 108) * 108);
  return true;
}
let lastHint = 0;
function hint(name){ if (Date.now() - lastHint < 4000) return; lastHint = Date.now(); broadcast({ t:'hint', name: String(name).slice(0, 18), key: String(settings.joinKeyword).split(',')[0].trim() }); }

/* welcome: names of newcomers are read out in small batches, never one TTS per person */
let welcomeQ = [];
setInterval(() => {
  if (!settings.welcomeVoice || !welcomeQ.length || ttsQueue.length > 3) return;
  const names = welcomeQ.splice(0).map(spoken), shown = names.slice(0, 3);
  const who = shown.length === 1 ? shown[0] : shown.slice(0, -1).join(', ') + ' và ' + shown.at(-1);
  say(`Nam mô A Di Đà Phật. Chào mừng Phật tử ${who}${names.length > 3 ? ' cùng ' + (names.length - 3) + ' vị khác' : ''} vào chánh điện.`, { tag:'welcome' });
}, 20_000);
/* call to action: tells newcomers what to type (the single biggest driver of comments on a live) */
let ctaTimer = null;
function cta(){
  const key = String(settings.joinKeyword).split(',')[0].trim();
  broadcast({ t:'cta' });
  say(`Mời quý vị bình luận ${key}, để bước vào chánh điện. Khi đã vào, gõ số 1 để lạy Phật, số 2 để thắp hương, số 3 để kinh hành, số 4 để chắp tay cầu nguyện.`, { tag:'cta' });
}
function scheduleCta(){ clearInterval(ctaTimer); if (settings.ctaVoice) ctaTimer = setInterval(cta, Math.max(1, settings.ctaEveryMin) * 60_000); }

function seat(id, name, opts = {}){
  let v = viewers.get(id);
  if (v){ v.lastAt = Date.now(); if (opts.avatar) v.avatar = opts.avatar; return { v, isNew:false }; }
  if (viewers.size >= 100){                     // full: the longest-quiet non-donor stands up
    const quiet = [...viewers.values()].filter(x => x.coins === 0).sort((a,b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v:null, isNew:false };
    viewers.delete(quiet.id); broadcast({ t:'leave', id: quiet.id });
  }
  v = { id, name: (name||id).slice(0, 18), skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
        avatar: opts.avatar || '', coins: 0, joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo };
  viewers.set(id, v);
  if (!v.demo && !String(id).startsWith('bot_')) welcomeQ.push(v.name);
  broadcast({ t:'join', v: pub(v), cap: capacity() });
  return { v, isNew:true };
}

/* ------------------------------------------------------------- events in */
function onChat(id, name, text, avatar){
  text = String(text || '').slice(0, 120);
  let v = viewers.get(id);
  if (!v){
    // not in the hall yet: only the keyword opens the door
    if (settings.requireKeyword && !hasKeyword(text)){ hint(name || id); return; }
    ({ v } = seat(id, name, { avatar }));
    if (!v) return;
    v.lastText = text; v.lastTextAt = Date.now();
    broadcast({ t:'chat', id, name: v.name, text });
    return;
  }
  v.lastAt = Date.now(); if (avatar) v.avatar = avatar;
  const act = actionFromText(text);
  if (act){ doAction(v, act); return; }                  // 1 / 2 / 3 / 4 and their word forms
  const want = skinFromText(text);
  if (want && want !== v.skin){ v.skin = want; broadcast({ t:'skin', id, skin: want }); }
  if (hasKeyword(text)){ doAction(v, 'niem'); return; }  // typing the keyword again = one more recitation
  v.lastText = text; v.lastTextAt = Date.now();
  broadcast({ t:'chat', id, name: v.name, text });
}

function onGift(id, name, giftName, count, diamonds, avatar){
  giftName = String(giftName || 'quà').slice(0, 30); count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar });
  if (!v) return;
  const coins = Math.max(1, (diamonds || 1) * (count || 1));
  v.coins += coins;
  const prayer = (v.lastText && Date.now() - v.lastTextAt < 90_000 && v.lastText.length > 6) ? v.lastText : pickPrayer();
  const tier = coins >= 99 ? 3 : coins >= 10 ? 2 : 1;
  const line = `Nam mô A Di Đà Phật. Phật tử ${spoken(v.name)} thành tâm dâng ${giftName}${count > 1 ? ', ' + count + ' lần' : ''}. ${prayer}.`;
  broadcast({ t:'gift', id, name: v.name, giftName, count, coins, total: v.coins, tier, prayer });
  if (settings.gifts.readAll || coins >= settings.gifts.minDiamonds) say(line, { tag:'gift', id });
}

function pickPrayer(){
  const P = ['Nguyện cầu gia đạo bình an, vạn sự cát tường', 'Nguyện cầu cha mẹ mạnh khỏe, sống lâu', 'Nguyện hồi hướng công đức cho khắp pháp giới chúng sinh',
             'Nguyện cầu thân tâm an lạc, phiền não tiêu trừ', 'Nguyện cầu công việc hanh thông, gia đình hạnh phúc'];
  return P[Math.floor(Math.random() * P.length)];
}
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'ẩn danh';

/* ------------------------------------------------------------------ TTS */
const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){ if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; } ttsQueue.push({ text: String(text).slice(0, 500), meta }); pumpTTS(); }
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return; ttsBusy = true;
  const { text, meta } = ttsQueue.shift();
  try {
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
    try { tts.close(); } catch {}
    fs.writeFileSync(path.join(TTS_DIR, file), Buffer.concat(chunks));
    broadcast({ t:'tts', url: `/live/tts/${file}`, text, ...meta });
    const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
  } catch (e) {
    addLog('TTS lỗi: ' + (e?.message || e));
    if (/SELF_SIGNED_CERT|UNABLE_TO_VERIFY|CERT_/.test(String(e?.code || e?.message || ''))) addLog('→ Mạng đang chen chứng chỉ HTTPS (VPN / proxy công ty / diệt virus). Dừng server rồi chạy: npm run start:syscert (Node 22.15 trở lên), hoặc tắt VPN / dịch vụ quét HTTPS của diệt virus.');
  }
  ttsBusy = false; setTimeout(pumpTTS, 50);
}

const CHANTS = [
  'Nam mô Bổn Sư Thích Ca Mâu Ni Phật. Nguyện đem công đức này, hướng về khắp tất cả, đệ tử và chúng sinh, đều trọn thành Phật đạo.',
  'Nam mô A Di Đà Phật. Nguyện sanh Tây Phương Tịnh Độ trung, cửu phẩm liên hoa vi phụ mẫu.',
  'Nam mô Đại Bi Quán Thế Âm Bồ Tát. Nguyện cho tất cả chúng sinh thân tâm an lạc, tai qua nạn khỏi.',
  'Quán Tự Tại Bồ Tát hành thâm Bát Nhã Ba La Mật Đa thời, chiếu kiến ngũ uẩn giai không, độ nhất thiết khổ ách.',
];
let chantIdx = 0, chantTimer = null;
function chant(){ const text = CHANTS[chantIdx++ % CHANTS.length]; broadcast({ t:'chant', text }); say(text, { tag:'chant' }); }
function scheduleChant(){ clearInterval(chantTimer); if (settings.autoChant) chantTimer = setInterval(chant, Math.max(1, settings.chantEveryMin) * 60_000); }
scheduleChant();
scheduleCta();

/* --------------------------------------------------------------- TikTok */
let TikTokLib = null;
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  await disconnectTikTok();
  tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
  try {
    TikTokLib ||= await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = TikTokLib;
    const conn = new TikTokLiveConnection(uniqueId, { enableExtendedGiftInfo: true, processInitialData: false });
    const av = u => u?.profilePicture?.url?.[0] || u?.profilePicture?.urlList?.[0] || u?.avatarThumb?.urlList?.[0] || u?.avatarThumb?.url?.[0] || '';
    const nm = u => u?.nickname || u?.uniqueId || 'ẩn danh';
    conn.on(WebcastEvent.CHAT, d => onChat(d.user?.uniqueId || d.user?.userId, nm(d.user), d.comment, av(d.user)));
    conn.on(WebcastEvent.GIFT, d => {
      const type = d.giftDetails?.giftType ?? d.extendedGiftInfo?.type;
      if (type === 1 && !d.repeatEnd) return;                       // streak still running
      const gname = d.giftDetails?.giftName || d.extendedGiftInfo?.name || 'quà';
      const dia = d.giftDetails?.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 1;
      onGift(d.user?.uniqueId || d.user?.userId, nm(d.user), gname, d.repeatCount || 1, dia, av(d.user));
      addLog(`🎁 ${nm(d.user)} tặng ${gname} x${d.repeatCount || 1}`);
    });
    conn.on(WebcastEvent.MEMBER, d => { if (settings.joinOnEnter) seat(d.user?.uniqueId, nm(d.user), { avatar: av(d.user) }); });
    conn.on(WebcastEvent.LIKE, d => broadcast({ t:'like', id: d.user?.uniqueId, n: d.likeCount || 1 }));
    conn.on(ControlEvent.DISCONNECTED, () => { tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState }); addLog('TikTok: mất kết nối'); });
    conn.on(ControlEvent.ERROR, e => addLog('TikTok lỗi: ' + (e?.info || e?.message || e)));
    const st = await conn.connect();
    tiktok = conn;
    tiktokState = { status: 'connected', uniqueId, error: '', roomId: st?.roomId || '' };
    addLog(`✅ Đã kết nối live @${uniqueId}`);
  } catch (e) {
    tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
    addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
  }
  broadcast({ t:'tiktok', ...tiktokState });
}
async function disconnectTikTok(){ if (tiktok){ try { await tiktok.disconnect(); } catch {} tiktok = null; } tiktokState = { status:'idle', uniqueId:'', error:'' }; broadcast({ t:'tiktok', ...tiktokState }); }

/* ------------------------------------------------------------- test data */
// Test names: pháp danh (Diệu Hạnh) and lay names (Ngọc Lan) built from word lists, shuffled once per run.
// Names are handed out so that no two people in the hall ever share a name, for any mix of demo viewers and bots.
const DANH_A = ['Diệu','Minh','Thiện','Huệ','Tịnh','Quảng','Chơn','Pháp','Nguyên','Tâm','Trí','Phước','Hạnh','Như','Bảo','Thanh','Từ','An','Giác','Tuệ','Liên','Hồng','Ngọc','Kim','Đức','Hải','Vạn','Tín'];
const DANH_B = ['Hạnh','Tâm','Đức','An','Nhã','Trí','Như','Hỷ','Thanh','Đăng','Liên','Hải','Lộc','Nguyện','Ý','Châu','Lương','Hoa','Minh','Hương','Linh','Quang','Lạc','Giác','Nghiêm','Từ','Thiện','Phúc','Nhân','Duyên'];
const LAY_A = ['Thu','Ngọc','Mai','Phương','Bảo','Hoàng','Thanh','Minh','Quốc','Anh','Gia','Hải','Khánh','Kim','Đức','Tuấn'];
const LAY_B = ['Hà','Lan','Anh','Thảo','Ngọc','Trang','Huy','Kiên','Linh','Vy','Phúc','Long','Nam','Hiếu','Dung','Yến'];
const NAME_POOL = (() => {
  const s = new Set();
  for (const a of DANH_A) for (const b of DANH_B) if (a !== b) s.add(a + ' ' + b);
  for (const a of LAY_A) for (const b of LAY_B) if (a !== b) s.add(a + ' ' + b);
  const arr = [...s];
  for (let i = arr.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
})();
// First name nobody in the hall is using. Demo viewers take from the front of the pool, bots from the back.
function freeDemoName(fromEnd){
  const used = new Set([...viewers.values()].map(v => v.name.toLowerCase()));
  for (let k = 0; k < NAME_POOL.length; k++){
    const nm = NAME_POOL[fromEnd ? NAME_POOL.length - 1 - k : k];
    if (!used.has(nm.toLowerCase())) return nm;
  }
  return 'Phật tử ' + (viewers.size + 1);
}
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 100; i++){
    if (viewers.has('demo_' + i)) continue;
    seat('demo_' + i, freeDemoName(false), { demo: true, skin: ['man','woman','woman','man','granny','monk','nun','child'][i % 8] });
  }
}
function clearSeats(){ viewers.clear(); broadcast(snapshot()); addLog('Đã làm trống bồ đoàn'); }

/* ------------------------------------------------------------- control */
// a name typed in the panel that matches someone already in the hall means that person (not a new made-up viewer)
const byName = n => { const k = String(n || '').trim().toLowerCase(); return k ? [...viewers.values()].find(v => v.name.toLowerCase() === k) : undefined; };
function onControl(m){
  switch (m.cmd){
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    // m.id = a person picked from the "Trong sân chùa" list: act as that real viewer instead of a made-up "sim_" one
    case 'chat': { const who = viewers.get(String(m.id || '')) || byName(m.name); if (who){ onChat(who.id, who.name, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120), who.avatar); break; } const n = String(m.name || 'Khách').slice(0, 18); onChat('sim_' + n, n, String(m.text || 'Nam mô A Di Đà Phật').slice(0, 120)); break; }
    case 'gift': { const who = viewers.get(String(m.id || '')) || byName(m.name); if (who){ onGift(who.id, who.name, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000), who.avatar); break; } const n = String(m.name || 'Khách').slice(0, 18); onGift('sim_' + n, n, String(m.gift || 'Hoa hồng').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000)); break; }
    case 'fill': fillDemo(clamp(m.n, 1, 100)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'bell': broadcast({ t:'bell' }); break;
    case 'mo': broadcast({ t:'mo1' }); break;
    case 'chant': chant(); break;
    case 'nexttrack': broadcast({ t:'nexttrack' }, 'overlay'); break;
    case 'rescan': tracks = listTracks(); if (settings.track !== 'auto' && !tracks.includes(settings.track)) settings.track = 'auto'; broadcast({ t:'tracks', tracks, settings }); addLog('🎵 Tìm thấy ' + tracks.length + ' bài nhạc trong assets/music'); break;
    case 'cta': cta(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'settings':
      applySettings(m.settings || {});
      scheduleChant(); scheduleCta(); broadcast({ t:'settings', settings, cap: capacity() }); break;
    case 'bots': setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

// Only known keys, right types, sane ranges: the panel is local, but nothing from the socket is trusted blindly.
const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), moBpm: v => clamp(v, 20, 120), chantEveryMin: v => clamp(v, 1, 60),
  music: Boolean, mo: Boolean, musicVol: v => clamp(v, 0, 100), track: v => (String(v) === 'auto' || tracks.includes(String(v))) ? String(v) : 'auto', autoChant: Boolean, joinOnEnter: Boolean,
  requireKeyword: Boolean, welcomeVoice: Boolean, ctaVoice: Boolean, ctaEveryMin: v => clamp(v, 1, 60),
  joinKeyword: v => String(v).slice(0, 120).trim() || settings.joinKeyword,
  seatMode: v => ['auto', '24', '36', '64', '100'].includes(String(v)) ? String(v) : 'auto',
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){ for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]); }

/* ----------------------------------------------------------------- bots */
let botTimer = null;
const BOT_LINES = ['Nam mô A Di Đà Phật', 'Nam mô Bổn Sư Thích Ca Mâu Ni Phật', 'Cầu cho gia đình bình an', 'Con xin thành tâm sám hối', 'nữ', 'nam', 'bà',
  'Nguyện cầu cha mẹ mạnh khỏe', 'Mô Phật, an lạc quá', 'Chúc mọi người một ngày bình an', 'sư', 'Cầu công việc hanh thông',
  '1', '1', '2', '3', '4', 'lạy', 'thắp hương', 'kinh hành', 'chắp tay'];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on){
    n = clamp(n, 1, 100);
    for (let i = 0; i < n; i++) if (!viewers.has('bot_' + i)) seat('bot_' + i, freeDemoName(true), { demo: true });
    const every = { slow: 4000, mid: 1800, fast: 700 }[pace] || 1800;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .62) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .9) broadcast({ t:'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .985) onGift(id, v.name, 'Hoa hồng', 1 + Math.floor(Math.random() * 3), 1);
      else onGift(id, v.name, 'Đèn hoa sen', 1, 99);
    }, every);
    addLog(`🤖 Bật ${n} bot, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

/* -------------------------------------------------------------- server */
// Security notes (this file is meant to be shared publicly):
//  • listens on 127.0.0.1 only; nothing is reachable from the LAN or internet unless HOST is changed on purpose
//  • Host header must be localhost/127.0.0.1 (blocks DNS-rebinding pages from talking to the server)
//  • WebSocket only accepts pages served by this server (Origin check), so other sites open in the
//    same browser cannot send control commands
//  • static files: only /assets and /live, no dot-files, no node_modules, no server source, no path escapes
//  • no TikTok password, cookie or session is ever used or stored; only public room events are read
const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac', '.flac':'audio/flac', '.opus':'audio/ogg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (!/^\/(assets|live)\//.test(p) && p !== '/index.html') return null;       // /index.html = the hall (overlay) page
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;      // never serve server code / package files
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (p === '/favicon.ico') { res.writeHead(204).end(); return; }       // browsers always ask: answer quietly instead of logging a 404
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;                                   // OBS / non-browser clients send no Origin
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t:'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;                          // overlays only listen
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => addLog(`Server chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Giao diện (overlay): http://localhost:${PORT}/index.html`));
