/**
 * OpenDate - Cryptographic Engine & Sovereign Identity
 * Handles key generation, password manager synchronization,
 * NIP-13 Proof of Work, NIP-44 v2 encryption, and NIP-59 Gift Wrapping.
 */

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Ensure hex utility availability on window.NostrTools
if (typeof window !== 'undefined' && window.NostrTools) {
  if (!window.NostrTools.bytesToHex) window.NostrTools.bytesToHex = bytesToHex;
  if (!window.NostrTools.hexToBytes) window.NostrTools.hexToBytes = hexToBytes;
}

const OpenDateCrypto = {
  bytesToHex,
  hexToBytes,

  /**
   * Retrieves the current user's keypair or generates a new one silently.
   * @returns {Promise<{secretKey: Uint8Array, pubkey: string, nsec: string, npub: string}>}
   */
  async getOrCreateIdentity() {
    const NT = window.NostrTools;
    if (!NT) {
      throw new Error('NostrTools bundle is not loaded.');
    }

    const db = window.OpenDateDB || window.DB;
    let storedHex = db ? await db.get('user_secret_key') : null;
    let secretKey;

    if (storedHex) {
      try {
        secretKey = hexToBytes(storedHex);
      } catch (e) {
        storedHex = null;
      }
    }

    if (!storedHex || !secretKey || secretKey.length !== 32) {
      // Invisible sovereign key generation on first run
      secretKey = NT.generateSecretKey();
      if (db) await db.set('user_secret_key', bytesToHex(secretKey));
    }

    const pubkey = NT.getPublicKey(secretKey);
    const nsec = NT.nip19.nsecEncode(secretKey);
    const npub = NT.nip19.npubEncode(pubkey);

    // Sync to hidden password manager fields for iCloud Keychain / Google Password Manager
    this.syncToPasswordManager(npub, nsec);

    return { secretKey, pubkey, nsec, npub };
  },

  /**
   * Imports an existing identity from an nsec or 64-char hex string.
   * @param {string} keyString
   */
  async importIdentity(keyString) {
    const NT = window.NostrTools;
    const clean = keyString.trim();
    let secretKey;

    if (clean.startsWith('nsec1')) {
      const decoded = NT.nip19.decode(clean);
      if (decoded.type !== 'nsec') {
        throw new Error('Invalid nsec key format.');
      }
      secretKey = decoded.data;
    } else if (clean.length === 64) {
      secretKey = hexToBytes(clean);
    } else {
      throw new Error('Invalid key: must be an nsec1... or 64-character hex string.');
    }

    const pubkey = NT.getPublicKey(secretKey);
    const nsec = NT.nip19.nsecEncode(secretKey);
    const npub = NT.nip19.npubEncode(pubkey);

    const db = window.OpenDateDB || window.DB;
    if (db) await db.set('user_secret_key', bytesToHex(secretKey));
    this.syncToPasswordManager(npub, nsec);

    return { secretKey, pubkey, nsec, npub };
  },

  /**
   * Populates hidden form fields with user credentials to trigger
   * native OS password manager backup (Face ID / Touch ID / Keychain).
   * @param {string} username
   * @param {string} password
   */
  syncToPasswordManager(username, password) {
    const userField = document.getElementById('hidden-pm-username');
    const passField = document.getElementById('hidden-pm-password');
    if (userField && passField) {
      userField.value = username;
      passField.value = password;
    }
  },

  /**
   * Mines a NIP-13 Proof-of-Work nonce meeting target bit difficulty.
   * Runs non-blocking to prevent UI freezing.
   * @param {object} eventTemplate
   * @param {number} targetDifficulty Bits of difficulty (12-bit default ~4096 hashes)
   * @returns {Promise<object>}
   */
  async minePoW(eventTemplate, targetDifficulty = 12) {
    const NT = window.NostrTools;
    const event = { ...eventTemplate, tags: [...(eventTemplate.tags || [])] };
    let nonce = 0;

    // Filter out previous nonce tags if present
    event.tags = event.tags.filter(t => t[0] !== 'nonce');

    return new Promise((resolve) => {
      function mineBatch() {
        const batchSize = 1500;
        for (let i = 0; i < batchSize; i++) {
          nonce++;
          const candidateTags = [...event.tags, ['nonce', nonce.toString(), targetDifficulty.toString()]];
          const testEvent = { ...event, tags: candidateTags };
          const hexId = NT.getEventHash(testEvent);
          const idBytes = hexToBytes(hexId);

          let leadingZeros = 0;
          for (let b = 0; b < idBytes.length; b++) {
            const byte = idBytes[b];
            if (byte === 0) {
              leadingZeros += 8;
            } else {
              leadingZeros += Math.clz32(byte) - 24;
              break;
            }
          }

          if (leadingZeros >= targetDifficulty) {
            testEvent.tags = candidateTags;
            testEvent.id = hexId;
            return resolve(testEvent);
          }
        }
        setTimeout(mineBatch, 0);
      }
      mineBatch();
    });
  },

  /**
   * Encapsulates a payload into a NIP-59 3-layer Gift Wrap:
   * Rumor (kind 14 unsigned) -> Seal (kind 13 signed) -> Gift Wrap (kind 1059 disposable)
   * @param {object} rumorData Payload object
   * @param {string} recipientPubkey Hex pubkey of recipient
   * @param {Uint8Array} senderSecretKey Sender's secret key
   * @returns {Promise<object>} Gift wrap event ready for relay broadcast
   */
  async createGiftWrap(rumorData, recipientPubkey, senderSecretKey) {
    const NT = window.NostrTools;
    const senderPubkey = NT.getPublicKey(senderSecretKey);

    // 1. Rumor (Unsigned Kind 14)
    const rumor = {
      kind: 14,
      pubkey: senderPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: typeof rumorData === 'string' ? rumorData : JSON.stringify(rumorData)
    };

    // 2. Seal (Kind 13 signed by sender)
    const sealConversationKey = NT.nip44.v2.utils.getConversationKey(senderSecretKey, recipientPubkey);
    const encryptedRumor = NT.nip44.v2.encrypt(JSON.stringify(rumor), sealConversationKey);

    const sealTemplate = {
      kind: 13,
      created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 60),
      tags: [],
      content: encryptedRumor
    };
    const seal = NT.finalizeEvent(sealTemplate, senderSecretKey);

    // 3. Gift Wrap (Kind 1059 signed by a disposable burner key)
    const disposableSecretKey = NT.generateSecretKey();
    const wrapConversationKey = NT.nip44.v2.utils.getConversationKey(disposableSecretKey, recipientPubkey);
    const encryptedSeal = NT.nip44.v2.encrypt(JSON.stringify(seal), wrapConversationKey);

    const randomizedTimestamp = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800);

    const wrapTemplate = {
      kind: 1059,
      created_at: randomizedTimestamp,
      tags: [['p', recipientPubkey]],
      content: encryptedSeal
    };

    return NT.finalizeEvent(wrapTemplate, disposableSecretKey);
  },

  /**
   * Unwraps a received NIP-59 Gift Wrap event.
   * @param {object} giftWrapEvent
   * @param {Uint8Array} recipientSecretKey
   * @returns {Promise<{rumor: object, senderPubkey: string}|null>}
   */
  async unwrapGiftWrap(giftWrapEvent, recipientSecretKey) {
    const NT = window.NostrTools;
    try {
      const wrapConversationKey = NT.nip44.v2.utils.getConversationKey(recipientSecretKey, giftWrapEvent.pubkey);
      const decryptedSealStr = NT.nip44.v2.decrypt(giftWrapEvent.content, wrapConversationKey);
      const seal = JSON.parse(decryptedSealStr);

      if (seal.kind !== 13) return null;

      const sealConversationKey = NT.nip44.v2.utils.getConversationKey(recipientSecretKey, seal.pubkey);
      const decryptedRumorStr = NT.nip44.v2.decrypt(seal.content, sealConversationKey);
      const rumor = JSON.parse(decryptedRumorStr);

      return { rumor, senderPubkey: seal.pubkey };
    } catch (err) {
      console.warn('Failed to unwrap gift wrap event:', err);
      return null;
    }
  }
};

window.OpenDateCrypto = OpenDateCrypto;
window.CryptoEngine = OpenDateCrypto;
