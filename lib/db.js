// JSON ファイルベースの簡易データストア
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
fs.mkdirSync(SNAP_DIR, { recursive: true });

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.societies ||= []; db.items ||= []; db.runs ||= []; db.settings ||= {};
    return db;
  } catch {
    return { societies: [], items: [], runs: [], settings: {} };
  }
}

const db = load();
let timer = null;

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  if (!timer) timer = setTimeout(flush, 300);
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function snapFile(societyId) {
  return path.join(SNAP_DIR, societyId.replace(/[^\w-]/g, '_') + '.json');
}
function getSnapshot(societyId) {
  try { return JSON.parse(fs.readFileSync(snapFile(societyId), 'utf8')); } catch { return null; }
}
function setSnapshot(societyId, snap) {
  fs.writeFileSync(snapFile(societyId), JSON.stringify(snap));
}
function deleteSnapshot(societyId) {
  try { fs.unlinkSync(snapFile(societyId)); } catch { /* none */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { flush(); } finally { process.exit(0); } });
}
process.on('exit', () => { try { if (timer) flush(); } catch { /* ignore */ } });

module.exports = { db, save, flush, newId, getSnapshot, setSnapshot, deleteSnapshot, DATA_DIR };
