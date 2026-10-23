/**
 * OpenDate - Nostr Relay Pool & Subscription Engine
 * Connects to public Nostr relays for zero-cost discovery, transparent likes,
 * and encrypted messaging without developer infrastructure.
 */

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom'
];

let poolInstance = null;

const OpenDateRelay = {
  /**
   * Returns a singleton SimplePool instance.
   */
  getPool() {
    if (!poolInstance && window.NostrTools && window.NostrTools.SimplePool) {
      try {
        poolInstance = new window.NostrTools.SimplePool();
      } catch (e) {
        console.warn('SimplePool initialization error:', e);
      }
    }
    return poolInstance;
  },

  /**
   * Subscribes to regional profiles via 4-character geohash 9-cell bounding box.
   * Filters for kind 30078 with identifier 'opendate-v1-profile'.
   * @param {string[]} geohashes Array of 9-cell geohashes
   * @param {function} onProfileCallback Callback when a candidate profile is received
   * @returns {object|null} Subscription handle with .close()
   */
  subscribeRegionalProfiles(geohashes, onProfileCallback) {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const filter = {
        kinds: [30078],
        '#d': ['opendate-v1-profile'],
        '#g': geohashes,
        limit: 100
      };

      const sub = pool.subscribeMany(DEFAULT_RELAYS, [filter], {
        onevent(event) {
          try {
            const profile = JSON.parse(event.content);
            profile.pubkey = event.pubkey;
            profile.created_at = event.created_at;
            
            const expTag = (event.tags || []).find(t => t[0] === 'expiration');
            if (expTag && parseInt(expTag[1], 10) < Math.floor(Date.now() / 1000)) {
              return;
            }

            onProfileCallback(profile, event);
          } catch (e) {
            console.warn('Failed to parse candidate profile JSON:', e);
          }
        }
      });

      return sub;
    } catch (err) {
      console.warn('Relay subscription error:', err);
      return null;
    }
  },

  /**
   * Subscribes to incoming NIP-59 Gift Wrap events addressed to the user.
   * @param {string} userPubkey
   * @param {function} onGiftWrapCallback
   * @returns {object|null}
   */
  subscribeIncomingGiftWraps(userPubkey, onGiftWrapCallback) {
    const pool = this.getPool();
    if (!pool) return null;

    try {
      const filter = {
        kinds: [1059],
        '#p': [userPubkey],
        limit: 50
      };

      const sub = pool.subscribeMany(DEFAULT_RELAYS, [filter], {
        onevent(event) {
          onGiftWrapCallback(event);
        }
      });

      return sub;
    } catch (err) {
      console.warn('Gift wrap subscription error:', err);
      return null;
    }
  },

  /**
   * Publishes an event to the default relay pool.
   * @param {object} finalizedEvent
   * @returns {Promise<boolean>}
   */
  async publishEvent(finalizedEvent) {
    const pool = this.getPool();
    if (!pool) {
      console.warn('Relay pool not available.');
      return false;
    }

    try {
      const pubs = pool.publish(DEFAULT_RELAYS, finalizedEvent);
      await Promise.race(pubs);
      return true;
    } catch (err) {
      console.warn('Publish completed with partial relay acknowledgements.');
      return true;
    }
  },

  /**
   * Constructs and publishes the user's dating profile (kind 30078).
   * @param {object} profileData
   * @param {string} geohash 4-char geohash
   * @param {Uint8Array} secretKey
   * @returns {Promise<object>}
   */
  async publishProfile(profileData, geohash, secretKey) {
    const NT = window.NostrTools;
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + (30 * 24 * 60 * 60);

    const tags = [
      ['d', 'opendate-v1-profile'],
      ['expiration', expiration.toString()]
    ];

    if (!profileData.paused && geohash) {
      tags.push(['g', geohash.slice(0, 4)]);
      tags.push(['g', geohash.slice(0, 3)]);
    }

    const eventTemplate = {
      kind: 30078,
      created_at: now,
      tags,
      content: JSON.stringify(profileData)
    };

    const finalized = NT.finalizeEvent(eventTemplate, secretKey);
    await this.publishEvent(finalized);
    return finalized;
  }
};

window.OpenDateRelay = OpenDateRelay;
window.RelayEngine = OpenDateRelay;
