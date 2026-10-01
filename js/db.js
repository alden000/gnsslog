// IndexedDB storage.
//   sessions : one record per test case (meta + events), keyPath 'id'
//   samples  : 5 Hz rows, keyPath ['sid', 'seq']
//   sync     : upload progress per session, keyPath 'sid' (kept apart from 'sessions' so
//              the recorder and the uploader never overwrite each other's fields)

const DB_NAME = 'gnsslog';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function openDB() {
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('sessions')) {
      const s = db.createObjectStore('sessions', { keyPath: 'id' });
      s.createIndex('createdAt', 'createdAt');
    }
    if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: ['sid', 'seq'] });
    if (!db.objectStoreNames.contains('sync')) db.createObjectStore('sync', { keyPath: 'sid' });
  };
  return new Store(await req(open));
}

class Store {
  constructor(db) {
    this.db = db;
  }

  async putSession(session) {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(session);
    await done(tx);
  }

  /** Atomically append samples and update the session row that counts them. */
  async appendSamples(session, samples) {
    const tx = this.db.transaction(['sessions', 'samples'], 'readwrite');
    const st = tx.objectStore('samples');
    for (const s of samples) st.put(s);
    tx.objectStore('sessions').put(session);
    await done(tx);
  }

  getSession(id) {
    return req(this.db.transaction('sessions').objectStore('sessions').get(id));
  }

  async listSessions() {
    const all = await req(this.db.transaction('sessions').objectStore('sessions').getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Samples with from <= seq <= to (inclusive), at most `limit`. */
  getSamples(sid, from = 0, to = Number.MAX_SAFE_INTEGER, limit) {
    const range = IDBKeyRange.bound([sid, from], [sid, to]);
    return req(this.db.transaction('samples').objectStore('samples').getAll(range, limit));
  }

  async deleteSession(sid) {
    const tx = this.db.transaction(['sessions', 'samples', 'sync'], 'readwrite');
    tx.objectStore('sessions').delete(sid);
    tx.objectStore('samples').delete(IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]));
    tx.objectStore('sync').delete(sid);
    await done(tx);
  }

  getSync(sid) {
    return req(this.db.transaction('sync').objectStore('sync').get(sid));
  }

  async listSync() {
    const all = await req(this.db.transaction('sync').objectStore('sync').getAll());
    return new Map(all.map((s) => [s.sid, s]));
  }

  async putSync(state) {
    const tx = this.db.transaction('sync', 'readwrite');
    tx.objectStore('sync').put(state);
    await done(tx);
  }
}
