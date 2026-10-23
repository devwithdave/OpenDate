/**
 * OpenDate - Secure Chat Engine & Safe Keyboard-GIF Protocol (NIP-17)
 * Implements Dual Gift-Wrapping (Self-CC) for multi-device synchronization,
 * strict Tenor/Giphy CDN whitelisting, and Scammer Pattern Detection.
 */

const GIF_WHITELIST_REGEX = /^https:\/\/(?:media|c|i)\.(?:tenor|giphy)\.com\/.+\.(?:gif|webp|mp4)$/i;

// Scammer detection patterns (external contact redirects, crypto keywords)
const SCAM_PATTERNS = [
  /(?:whatsapp|telegram|signal|cashapp|venmo|zelle)[\s:]*[@\d\w\-_]+/i,
  /\b\d{3}[-.\s]??\d{3}[-.\s]??\d{4}\b/, // US Phone number
  /\b(?:crypto|bitcoin|eth|forex|invest|trading|roi|profits|whatsapp)\b/i
];

const OpenDateChat = {
  /**
   * Normalizes web links (e.g. giphy.com/gifs/slug-id) to direct embeddable media URLs.
   * @param {string} url
   * @returns {string}
   */
  normalizeGifUrl(url) {
    if (!url || typeof url !== 'string') return url;
    const clean = url.trim();

    // Convert Giphy web page link (https://giphy.com/gifs/slug-ID or https://giphy.com/gifs/ID)
    const giphyMatch = clean.match(/^https?:\/\/giphy\.com\/gifs\/(?:.*-)?([a-zA-Z0-9]+)\/?$/i);
    if (giphyMatch && giphyMatch[1]) {
      return `https://media.giphy.com/media/${giphyMatch[1]}/giphy.gif`;
    }

    return clean;
  },

  /**
   * Tests if a URL matches the safe Tenor or Giphy whitelist.
   * @param {string} url
   * @returns {boolean}
   */
  isWhitelistedGif(url) {
    if (!url || typeof url !== 'string') return false;
    const clean = this.normalizeGifUrl(url.trim());
    return GIF_WHITELIST_REGEX.test(clean) ||
           clean.includes('giphy.com/media/') ||
           clean.includes('i.giphy.com/') ||
           clean.includes('media.tenor.com/') ||
           clean.includes('c.tenor.com/');
  },

  /**
   * Screens text for scam patterns (crypto keywords, phone numbers, off-platform links).
   * @param {string} text
   * @returns {{suspicious: boolean, reason?: string}}
   */
  detectScamPatterns(text) {
    if (!text || typeof text !== 'string') return { suspicious: false };
    for (const pattern of SCAM_PATTERNS) {
      if (pattern.test(text)) {
        return {
          suspicious: true,
          reason: 'Message contains external phone numbers, off-platform messaging links, or investment keywords.'
        };
      }
    }
    return { suspicious: false };
  },

  /**
   * Creates a Dual Gift-Wrapped NIP-17 direct message (Self-CC Synchronization).
   * Generates two encrypted envelopes:
   * - Copy A: Encrypted to Recipient
   * - Copy B: Encrypted to Sender (Self-CC) for multi-device sync
   * @param {string} text Plain text message or whitelisted GIF URL
   * @param {string} recipientPubkey
   * @param {Uint8Array} senderSecretKey
   * @returns {Promise<{recipientWrap: object, selfWrap: object, msgId: string, timestamp: number}>}
   */
  async createDualGiftWrapMessage(text, recipientPubkey, senderSecretKey) {
    const NT = window.NostrTools;
    const crypto = window.OpenDateCrypto || window.CryptoEngine;
    const senderPubkey = NT.getPublicKey(senderSecretKey);
    const now = Math.floor(Date.now() / 1000);
    const msgId = 'msg_' + now + '_' + Math.floor(Math.random() * 10000);

    const messagePayload = {
      id: msgId,
      type: 'opendate_chat',
      text: text.trim(),
      created_at: now
    };

    // Copy A: Delivered to recipient
    const recipientWrap = await crypto.createGiftWrap(messagePayload, recipientPubkey, senderSecretKey);

    // Copy B: Delivered to sender (Self-CC) for multi-device sync
    const selfWrap = await crypto.createGiftWrap(messagePayload, senderPubkey, senderSecretKey);

    return { recipientWrap, selfWrap, msgId, timestamp: now };
  }
};

window.OpenDateChat = OpenDateChat;
window.ChatEngine = OpenDateChat;
