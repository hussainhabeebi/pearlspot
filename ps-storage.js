/**
 * ps-storage.js — Pearl Spot Tours CRM
 * Centralised localStorage persistence layer
 *
 * All data lives under the 'ps:' namespace to avoid collisions.
 *
 * Storage keys:
 *   ps:kanban    →  KanbanCard[]
 *   ps:notes     →  { [cardId]: Note[] }
 *   ps:calllogs  →  { [cardId]: CallLog[] }
 *   ps:users     →  User[]
 *   ps:meta      →  { lastSync, lastWrite, version }
 *
 * IMMUTABILITY RULE
 * -----------------
 * The Kanban board is the SOLE SOURCE OF TRUTH for all card data.
 * Google Sheet (or any external) sync is APPEND-ONLY:
 *   • New rows not present locally → create card at stage = 'New'
 *   • Rows already on the board   → NEVER overwrite (stage, amounts, anything)
 *
 * Card schema  (KanbanCard)
 * -------------------------
 * {
 *   id:           string   – unique (SL NO from sheet, or 'k'+timestamp for manual)
 *   name:         string
 *   phone:        string
 *   checkin:      string   – YYYY-MM-DD
 *   checkout:     string
 *   service:      string   – e.g. 'Deluxe Premium'
 *   dayType:      string   – 'Day Trip' | 'Overnight' | 'Night Stay' | 'Sharing Overnight'
 *   adults:       string
 *   rooms:        string
 *   quotedAmount: string   – numeric string
 *   paidAmount:   string
 *   stage:        string   – 'New'|'Quoted'|'Confirmed'|'Paid'|'Checked-In'|'Completed'|'Cancelled'
 *   source:       string
 *   boat:         string
 *   occasion:     string
 *   priority:     'high'|'normal'|'low'
 *   fromSheet:    boolean  – true if imported from Google Sheet
 *   confirmationSent: boolean
 *   reviewSent:   boolean
 *   createdAt:    number   – Date.now()
 *   importedAt:   string   – ISO date string (sheet imports only)
 * }
 *
 * Note schema
 * -----------
 * { text: string, by: string, ts: string }
 *
 * CallLog schema
 * --------------
 * { note: string, outcome: string, by: string, ts: string }
 *
 * User schema
 * -----------
 * { id: string, name: string, email: string, pwd: string, role: 'admin'|'agent'|'viewer', active: boolean }
 */

'use strict';

const PS_Store = (() => {
  const NS = 'ps:';

  /** Read a key, returning fallback if missing or corrupt */
  function read(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('[PS_Store] read failed for key:', key, e);
      return fallback;
    }
  }

  /** Write a value, updates meta timestamp */
  function write(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
      _updateMeta(key);
      return true;
    } catch (e) {
      console.error('[PS_Store] write failed for key:', key, e);
      if (e.name === 'QuotaExceededError') {
        console.error('[PS_Store] localStorage quota exceeded!');
      }
      return false;
    }
  }

  /** Delete a key */
  function clear(key) {
    localStorage.removeItem(NS + key);
    _updateMeta(key + '_cleared');
  }

  /** Update meta entry (never throws) */
  function _updateMeta(key) {
    try {
      const meta = read('meta', {});
      meta[key + '_saved'] = new Date().toISOString();
      meta.lastWrite = new Date().toISOString();
      meta.version = meta.version || 2;
      localStorage.setItem(NS + 'meta', JSON.stringify(meta));
    } catch (_) {}
  }

  /** Export all ps: keys as a plain object (for JSON backup download) */
  function exportAll() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) {
        try { out[k] = JSON.parse(localStorage.getItem(k)); }
        catch (e) { out[k] = localStorage.getItem(k); }
      }
    }
    out['_backup_meta'] = {
      exportedAt: new Date().toISOString(),
      namespace: NS,
      version: 2,
    };
    return out;
  }

  /** Import a backup blob (overwrites matching keys) */
  function importAll(blob) {
    let count = 0;
    Object.entries(blob).forEach(([k, v]) => {
      if (k.startsWith(NS)) {
        try {
          localStorage.setItem(k, JSON.stringify(v));
          count++;
        } catch (e) {
          console.warn('[PS_Store] importAll failed for key:', k, e);
        }
      }
    });
    return count;
  }

  /** Return storage usage statistics */
  function usage() {
    let bytes = 0;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS)) {
        const v = localStorage.getItem(k) || '';
        bytes += (k.length + v.length) * 2; // UTF-16
        keys.push({ key: k.replace(NS, ''), size: Math.round(v.length * 2 / 1024 * 10) / 10 });
      }
    }
    return {
      bytes,
      kb: Math.round(bytes / 1024 * 10) / 10,
      mb: Math.round(bytes / 1048576 * 100) / 100,
      keys,
      // localStorage typically allows 5–10 MB
      percentUsed: Math.round(bytes / (5 * 1048576) * 100),
    };
  }

  /** Trigger a JSON file download of the full backup */
  function downloadBackup(filename) {
    const blob = exportAll();
    const json = JSON.stringify(blob, null, 2);
    const url  = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename || `pearlspot-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return { read, write, clear, exportAll, importAll, usage, downloadBackup };
})();

// ─── KanbanStore — thin wrapper specific to the pipeline board ───────────────
const KanbanStore = {
  /** Load cards from localStorage */
  load() {
    return PS_Store.read('kanban', []);
  },

  /** Persist the current cards array */
  save(cards) {
    return PS_Store.write('kanban', cards);
  },

  /**
   * Append-only import from Google Sheet rows.
   * Matches by id (exact) OR phone (normalised digits).
   * NEVER modifies cards that are already present.
   * Returns count of newly added cards.
   */
  importFromSheet(rows, cards) {
    let newCount = 0;
    rows.forEach(row => {
      const id    = String(row.id || row['SL NO'] || '');
      const phone = (row.phone || row['Phone'] || '').replace(/\D/g, '');
      const exists = cards.find(c =>
        (id    && c.id === id) ||
        (phone && c.phone && c.phone.replace(/\D/g, '') === phone)
      );
      if (exists) return; // existing card — NEVER touch
      cards.push({
        id,
        name:          row.name         || row['Name']           || '',
        phone:         row.phone        || row['Phone']          || '',
        checkin:       row.checkin      || row['check-in date']  || '',
        checkout:      row.checkout     || row['check-out date'] || '',
        service:       row.service      || row['Service']        || '',
        dayType:       row.dayType      || row['Day Type']       || '',
        adults:        row.adults       || row['Adults']         || '',
        rooms:         row.rooms        || row['Rooms']          || '',
        quotedAmount:  row.quotedAmount || row['Quoted_Amount']  || '',
        paidAmount:    row.paidAmount   || row['Paid_Amount']    || '',
        stage:        'New',            // always start at New — user decides
        source:        row.source       || row['Source']         || '',
        boat:          row.boatAssigned || row['Boat_Assigned']  || '',
        occasion:      row.occasion     || row['Occasion']       || '',
        priority:     'normal',
        fromSheet:    true,
        confirmationSent: false,
        reviewSent:       false,
        createdAt:    Date.now(),
        importedAt:   new Date().toISOString(),
      });
      newCount++;
    });
    if (newCount > 0) this.save(cards);
    return newCount;
  },

  /** Move a card to a new stage (persists immediately) */
  moveCard(cards, cardId, newStage) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return false;
    card.stage = newStage;
    this.save(cards);
    return true;
  },

  /** Update arbitrary fields on a card (persists immediately) */
  updateCard(cards, cardId, fields) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return false;
    Object.assign(card, fields);
    this.save(cards);
    return true;
  },

  /** Delete a card by id */
  deleteCard(cards, cardId) {
    const idx = cards.findIndex(c => c.id === cardId);
    if (idx === -1) return false;
    cards.splice(idx, 1);
    this.save(cards);
    return true;
  },
};

// ─── NotesStore ──────────────────────────────────────────────────────────────
const NotesStore = {
  load()       { return PS_Store.read('notes', {}); },
  save(notes)  { PS_Store.write('notes', notes); },
  add(notes, cardId, text, byName) {
    if (!notes[cardId]) notes[cardId] = [];
    notes[cardId].push({ text, by: byName, ts: new Date().toLocaleString() });
    this.save(notes);
  },
  delete(notes, cardId, index) {
    if (!notes[cardId]) return;
    notes[cardId].splice(index, 1);
    this.save(notes);
  },
};

// ─── CallLogStore ─────────────────────────────────────────────────────────────
const CallLogStore = {
  load()          { return PS_Store.read('calllogs', {}); },
  save(logs)      { PS_Store.write('calllogs', logs); },
  add(logs, cardId, note, outcome, byName) {
    if (!logs[cardId]) logs[cardId] = [];
    logs[cardId].push({ note, outcome, by: byName, ts: new Date().toLocaleString() });
    this.save(logs);
  },
};

// ─── UserStore ────────────────────────────────────────────────────────────────
const UserStore = {
  DEFAULT: [
    { id:'u1', name:'Baiju',     email:'baiju@pearlspottours.com',    pwd:'Pearl@Baiju26', role:'admin', active:true },
    { id:'u2', name:'Admin',     email:'admin@pearlspottours.com',     pwd:'Pearl@Admin26', role:'admin', active:true },
    { id:'u3', name:'Hussain',   email:'hussain@aiingo.com',           pwd:'Aiingo@2026',   role:'admin', active:true },
    { id:'u4', name:'Reception', email:'reception@pearlspottours.com', pwd:'Pearl@Recep26', role:'agent', active:true },
  ],
  load() {
    const stored = PS_Store.read('users', null);
    if (!stored) { this.save(this.DEFAULT); return [...this.DEFAULT]; }
    return stored;
  },
  save(users) { PS_Store.write('users', users); },
  authenticate(email, password) {
    const users = this.load();
    return users.find(u => u.email === email && u.pwd === password && u.active) || null;
  },
};

// Export for module environments (ignored in plain <script> context)
if (typeof module !== 'undefined') {
  module.exports = { PS_Store, KanbanStore, NotesStore, CallLogStore, UserStore };
}
