/**
 * OpenDate - Native IndexedDB Storage Layer
 * Zero external dependencies. Provides persistent local storage for
 * credentials, candidate profiles, transparent likes, and chat threads.
 */

const DB_NAME = 'OpenDate_DB';
const DB_VERSION = 1;

let dbInstance = null;

const OpenDateDB = {
  /**
   * Initializes the IndexedDB database and schema.
   * @returns {Promise<IDBDatabase>}
   */
  async init() {
    if (dbInstance) return dbInstance;

    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported, falling back to in-memory store.');
        return resolve(null);
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Key-Value Store for app settings, keys, flags
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }

        // Cached Dating Profiles
        if (!db.objectStoreNames.contains('profiles')) {
          const profileStore = db.createObjectStore('profiles', { keyPath: 'pubkey' });
          profileStore.createIndex('geohash', 'geohash', { unique: false });
          profileStore.createIndex('updated_at', 'updated_at', { unique: false });
        }

        // Transparent Likes & Intro Notes
        if (!db.objectStoreNames.contains('likes')) {
          const likesStore = db.createObjectStore('likes', { keyPath: 'id' });
          likesStore.createIndex('senderPubkey', 'senderPubkey', { unique: false });
          likesStore.createIndex('created_at', 'created_at', { unique: false });
        }

        // Decrypted Post-Match Chat Messages
        if (!db.objectStoreNames.contains('messages')) {
          const messageStore = db.createObjectStore('messages', { keyPath: 'id' });
          messageStore.createIndex('conversationPubkey', 'conversationPubkey', { unique: false });
          messageStore.createIndex('created_at', 'created_at', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        resolve(null); // Do not crash the app if IDB is blocked by browser privacy modes
      };
    });
  },

  /**
   * Sets a value in the key-value store.
   * @param {string} key
   * @param {any} value
   */
  async set(key, value) {
    const db = await this.init();
    if (!db) {
      try { localStorage.setItem('od_' + key, JSON.stringify(value)); } catch (e) {}
      return true;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.put({ key, value });
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (err) {
        resolve(false);
      }
    });
  },

  /**
   * Gets a value from the key-value store.
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    const db = await this.init();
    if (!db) {
      try {
        const item = localStorage.getItem('od_' + key);
        return item ? JSON.parse(item) : null;
      } catch (e) { return null; }
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  },

  /**
   * Deletes a key from the key-value store.
   * @param {string} key
   */
  async del(key) {
    const db = await this.init();
    if (!db) {
      try { localStorage.removeItem('od_' + key); } catch (e) {}
      return true;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /**
   * Saves or updates a dating profile.
   * @param {object} profile
   */
  async saveProfile(profile) {
    const db = await this.init();
    if (!db) return true;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('profiles', 'readwrite');
        const store = tx.objectStore('profiles');
        const req = store.put(profile);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /**
   * Retrieves all cached profiles.
   * @returns {Promise<Array>}
   */
  async getAllProfiles() {
    const db = await this.init();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('profiles', 'readonly');
        const store = tx.objectStore('profiles');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  },

  /**
   * Saves an incoming transparent like.
   * @param {object} likeItem
   */
  async saveLike(likeItem) {
    const db = await this.init();
    if (!db) {
      try {
        const existing = JSON.parse(localStorage.getItem('od_likes') || '[]');
        existing.push(likeItem);
        localStorage.setItem('od_likes', JSON.stringify(existing));
      } catch (e) {}
      return true;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('likes', 'readwrite');
        const store = tx.objectStore('likes');
        const req = store.put(likeItem);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /**
   * Retrieves all incoming likes.
   * @returns {Promise<Array>}
   */
  async getAllLikes() {
    const db = await this.init();
    if (!db) {
      try {
        return JSON.parse(localStorage.getItem('od_likes') || '[]');
      } catch (e) { return []; }
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('likes', 'readonly');
        const store = tx.objectStore('likes');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  },

  /**
   * Deletes a like (when matched or passed).
   * @param {string} id
   */
  async deleteLike(id) {
    const db = await this.init();
    if (!db) {
      try {
        const existing = JSON.parse(localStorage.getItem('od_likes') || '[]');
        const filtered = existing.filter(l => l.id !== id);
        localStorage.setItem('od_likes', JSON.stringify(filtered));
      } catch (e) {}
      return true;
    }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('likes', 'readwrite');
        const store = tx.objectStore('likes');
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /**
   * Saves a chat message.
   * @param {object} msg
   */
  async saveMessage(msg) {
    const db = await this.init();
    if (!db) return true;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const req = store.put(msg);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /**
   * Gets messages for a specific conversation pubkey.
   * @param {string} conversationPubkey
   * @returns {Promise<Array>}
   */
  async getMessages(conversationPubkey) {
    const db = await this.init();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const index = store.index('conversationPubkey');
        const req = index.getAll(conversationPubkey);
        req.onsuccess = () => {
          const msgs = req.result || [];
          msgs.sort((a, b) => a.created_at - b.created_at);
          resolve(msgs);
        };
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  },

  /**
   * Deletes all messages for a specific conversation pubkey.
   * @param {string} conversationPubkey
   * @returns {Promise<boolean>}
   */
  async deleteConversation(conversationPubkey) {
    const db = await this.init();
    if (!db) return true;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const index = store.index('conversationPubkey');
        const req = index.getAllKeys(conversationPubkey);
        req.onsuccess = () => {
          const keys = req.result || [];
          keys.forEach(k => store.delete(k));
          tx.oncomplete = () => resolve(true);
        };
        req.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /**
   * Retrieves all messages across all conversations.
   * @returns {Promise<Array>}
   */
  async getAllMessages() {
    const db = await this.init();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  },

  /**
   * Retrieves all key-value entries.
   * @returns {Promise<Array>}
   */
  async getAllKV() {
    const db = await this.init();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  },

  /**
   * Bulk restores database items from an exported backup.
   * @param {object} payload
   */
  async bulkRestore(payload) {
    if (!payload) return;
    const db = await this.init();
    if (!db) return;

    const restoreStore = (storeName, items) => {
      if (!Array.isArray(items) || !items.length) return Promise.resolve();
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          items.forEach(item => {
            try { store.put(item); } catch (err) {}
          });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (e) { resolve(false); }
      });
    };

    if (payload.kv) await restoreStore('kv', payload.kv);
    if (payload.profiles) await restoreStore('profiles', payload.profiles);
    if (payload.likes) await restoreStore('likes', payload.likes);
    if (payload.messages) await restoreStore('messages', payload.messages);
  }
};

window.OpenDateDB = OpenDateDB;
window.DB = OpenDateDB;
