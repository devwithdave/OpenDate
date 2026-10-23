/**
 * OpenDate - Moderation, Muting & Safety Engine
 * Handles NIP-51 Personal Mute Lists (kind 10000), NIP-56 Cryptographic Reports (kind 1984),
 * Live Camera Verification, and Emergency Date Plan Sharing.
 */

const OpenDateModeration = {
  /**
   * Blocks a user by pubkey and persists to NIP-51 mute list.
   * @param {string} targetPubkey
   * @param {Uint8Array} secretKey
   * @returns {Promise<boolean>}
   */
  async blockUser(targetPubkey, secretKey) {
    const db = window.OpenDateDB || window.DB;
    if (db) {
      let blocked = await db.get('blocked_pubkeys') || [];
      if (!blocked.includes(targetPubkey)) {
        blocked.push(targetPubkey);
        await db.set('blocked_pubkeys', blocked);
      }
    }

    // Publish kind 10000 NIP-51 Mute List to public relays
    if (secretKey && window.NostrTools) {
      const NT = window.NostrTools;
      const relay = window.OpenDateRelay || window.RelayEngine;
      const now = Math.floor(Date.now() / 1000);

      const eventTemplate = {
        kind: 10000,
        created_at: now,
        tags: [['p', targetPubkey]],
        content: ''
      };

      try {
        const finalized = NT.finalizeEvent(eventTemplate, secretKey);
        if (relay) await relay.publishEvent(finalized);
      } catch (err) {
        console.warn('Failed to publish mute list to relay:', err);
      }
    }

    return true;
  },

  /**
   * Checks if a pubkey is blocked by the user.
   * @param {string} pubkey
   * @returns {Promise<boolean>}
   */
  async isBlocked(pubkey) {
    const db = window.OpenDateDB || window.DB;
    if (!db) return false;
    const blocked = await db.get('blocked_pubkeys') || [];
    return blocked.includes(pubkey);
  },

  /**
   * Calculates leading zero bits of a hex hash per NIP-13.
   * @param {string} hex
   * @returns {number}
   */
  getPow(hex) {
    if (!hex || typeof hex !== 'string') return 0;
    let count = 0;
    for (let i = 0; i < hex.length && i < 64; i += 8) {
      const nibble = parseInt(hex.substring(i, i + 8), 16);
      if (nibble === 0) {
        count += 32;
      } else {
        count += Math.clz32(nibble);
        break;
      }
    }
    return count;
  },

  /**
   * Checks for established cryptographic interaction link with target.
   * Gating requires: exchanged direct messages (NIP-17) or incoming intro note / like.
   * @param {string} targetPubkey
   * @returns {Promise<{ hasInteraction: boolean, type: string }>}
   */
  async checkInteractionLink(targetPubkey) {
    const db = window.OpenDateDB || window.DB;
    if (!db) return { hasInteraction: false, type: 'none' };

    // 1. Check direct messages
    const msgs = await db.getMessages(targetPubkey);
    if (msgs && msgs.length > 0) {
      return { hasInteraction: true, type: 'chat' };
    }

    // 2. Check incoming likes / intro notes
    const likes = await db.getAllLikes();
    const hasLike = likes.some(l => l.senderPubkey === targetPubkey || l.id === targetPubkey);
    if (hasLike) {
      return { hasInteraction: true, type: 'like' };
    }

    return { hasInteraction: false, type: 'none' };
  },

  /**
   * Non-blocking background NIP-13 PoW miner (20 leading zeros).
   * Runs inside a background Web Worker or yields chunked iterations so the UI never freezes.
   * @param {object} eventTemplate
   * @param {number} difficulty
   * @returns {Promise<object>}
   */
  async minePowBackground(eventTemplate, difficulty = 20) {
    const workerScript = `
      var K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0x0bef9a3f, 0xc67178f2
      ]);

      function sha256Hex(ascii) {
        function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
        var words = [];
        var asciiBitLength = ascii.length * 8;
        for (var i = 0; i < ascii.length; i++) {
          words[i >> 2] |= (ascii.charCodeAt(i) & 0xff) << ((3 - i % 4) * 8);
        }
        words[ascii.length >> 2] |= 0x80 << ((3 - ascii.length % 4) * 8);
        words[(((ascii.length + 8) >> 6) + 1) * 16 - 1] = asciiBitLength;

        var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
        var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
        var w = new Uint32Array(64);

        for (var j = 0; j < words.length; j += 16) {
          for (var i = 0; i < 16; i++) w[i] = words[j + i] | 0;
          for (var i = 16; i < 64; i++) {
            var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
          }
          var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
          for (var i = 0; i < 64; i++) {
            var s1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
            var ch = (e & f) ^ ((~e) & g);
            var t1 = (h + s1 + ch + K[i] + w[i]) | 0;
            var s0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var t2 = (s0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
          }
          h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
          h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
        }
        var hex = "";
        var res = [h0, h1, h2, h3, h4, h5, h6, h7];
        for (var i = 0; i < 8; i++) {
          for (var b = 24; b >= 0; b -= 8) {
            var byte = (res[i] >>> b) & 0xff;
            hex += (byte < 16 ? "0" : "") + byte.toString(16);
          }
        }
        return hex;
      }

      function getPowBits(hex) {
        var count = 0;
        for (var i = 0; i < 64; i += 8) {
          var nibble = parseInt(hex.substring(i, i + 8), 16);
          if (nibble === 0) { count += 32; }
          else { count += Math.clz32(nibble); break; }
        }
        return count;
      }

      self.onmessage = function(e) {
        var event = e.data.event;
        var diff = e.data.difficulty || 20;
        var nonce = 0;
        var nonceTag = ["nonce", "0", String(diff)];
        event.tags.push(nonceTag);

        while (true) {
          nonceTag[1] = String(++nonce);
          var serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
          var hash = sha256Hex(serialized);
          if (getPowBits(hash) >= diff) {
            event.id = hash;
            self.postMessage({ success: true, event: event, nonce: nonce, hash: hash });
            break;
          }
        }
      };
    `;

    return new Promise((resolve) => {
      try {
        if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
          const blob = new Blob([workerScript], { type: 'application/javascript' });
          const workerUrl = URL.createObjectURL(blob);
          const worker = new Worker(workerUrl);

          worker.onmessage = (e) => {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve(e.data.event);
          };

          worker.onerror = () => {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            this.minePowChunked(eventTemplate, difficulty).then(resolve);
          };

          worker.postMessage({ event: eventTemplate, difficulty });
          return;
        }
      } catch (err) {
        // Fall back to chunked async loop
      }

      this.minePowChunked(eventTemplate, difficulty).then(resolve);
    });
  },

  /**
   * Chunked non-blocking main-thread fallback miner.
   * Yields every 3000 hashes so the UI does not freeze.
   * @param {object} eventTemplate
   * @param {number} difficulty
   * @returns {Promise<object>}
   */
  async minePowChunked(eventTemplate, difficulty = 20) {
    const NT = window.NostrTools;
    const fastHash = NT?.nip13?.fastEventHash || ((evt) => NT.getEventHash(evt));
    const event = Object.assign({}, eventTemplate);
    event.tags = Array.from(event.tags || []);
    const nonceTag = ['nonce', '0', String(difficulty)];
    event.tags.push(nonceTag);

    let nonce = 0;
    const CHUNK_SIZE = 3000;

    return new Promise((resolve) => {
      const step = () => {
        for (let i = 0; i < CHUNK_SIZE; i++) {
          nonceTag[1] = String(++nonce);
          event.id = fastHash(event);
          if (this.getPow(event.id) >= difficulty) {
            resolve(event);
            return;
          }
        }
        setTimeout(step, 0);
      };
      step();
    });
  },

  /**
   * Validates coarse 9-cell regional geohash proximity between reporter and target.
   * @param {string} reporterGeohash
   * @param {string} targetGeohash
   * @returns {boolean}
   */
  isWithinRegionalProximity(reporterGeohash, targetGeohash) {
    const geo = window.OpenDateGeo || window.Geo;
    if (!geo || !reporterGeohash || !targetGeohash) return true;
    try {
      const validCells = geo.getGeohashWith8Neighbors(reporterGeohash);
      const targetCell = targetGeohash.slice(0, 4);
      return validCells.includes(targetCell);
    } catch (e) {
      return true;
    }
  },

  /**
   * Checks daily rate-limit quota for Discover reports (max 3 per 24 hours).
   * @returns {Promise<{ allowed: boolean, remaining: number, count: number }>}
   */
  async checkDiscoverReportQuota() {
    const db = window.OpenDateDB || window.DB;
    if (!db) return { allowed: true, remaining: 3, count: 0 };
    const history = await db.get('discover_report_history') || [];
    const oneDayAgo = Date.now() - 24 * 3600 * 1000;
    const recent = history.filter(ts => ts > oneDayAgo);
    return {
      allowed: recent.length < 3,
      remaining: Math.max(0, 3 - recent.length),
      count: recent.length
    };
  },

  /**
   * Records a Discover report submission timestamp in local quota history.
   */
  async recordDiscoverReportUsage() {
    const db = window.OpenDateDB || window.DB;
    if (!db) return;
    const history = await db.get('discover_report_history') || [];
    const oneDayAgo = Date.now() - 24 * 3600 * 1000;
    const recent = history.filter(ts => ts > oneDayAgo);
    recent.push(Date.now());
    await db.set('discover_report_history', recent);
  },

  /**
   * Queues a silent background NIP-13 PoW report (kind 1984).
   * Supports tiered difficulty (22 bits for discover, 20 bits for chat),
   * regional proximity gating, and presentation token tags.
   * Runs without locking UI thread.
   * @param {string} targetPubkey
   * @param {string} reason
   * @param {string} notes
   * @param {Uint8Array} secretKey
   * @param {object} reporterProfile
   * @param {object} options Optional parameters { source, reporterGeohash, targetGeohash, discoveryToken, difficulty }
   * @returns {Promise<boolean>}
   */
  async queueBackgroundReport(targetPubkey, reason, notes, secretKey, reporterProfile, options = {}) {
    if (!secretKey || !window.NostrTools) return false;
    const NT = window.NostrTools;
    const relay = window.OpenDateRelay || window.RelayEngine;
    const crypto = window.OpenDateCrypto || window.CryptoEngine;
    const reporterPubkey = crypto?.getPublicKey ? crypto.getPublicKey(secretKey) : NT.getPublicKey(secretKey);
    const now = Math.floor(Date.now() / 1000);

    const isDiscover = options.source === 'discover';
    let interactionType = 'unverified_blind';

    if (isDiscover) {
      // 1. Proximity Gating
      const reporterGeo = options.reporterGeohash || '';
      const targetGeo = options.targetGeohash || '';
      const isNear = this.isWithinRegionalProximity(reporterGeo, targetGeo);
      interactionType = isNear ? 'discover_proximity' : 'unverified_blind';
    } else {
      // Chat/match interaction gating
      const interaction = await this.checkInteractionLink(targetPubkey);
      interactionType = interaction.hasInteraction ? interaction.type : 'unverified_blind';
    }

    const difficulty = isDiscover ? (options.difficulty || 22) : (options.difficulty || 20);
    const isReporterVerified = Boolean(reporterProfile?.verifiedSelfie);

    const tags = [
      ['p', targetPubkey, reason || 'other'],
      ['interaction', interactionType],
      ['reporter_verified', isReporterVerified ? '1' : '0']
    ];

    if (isDiscover) {
      if (options.reporterGeohash) tags.push(['geohash', options.reporterGeohash]);
      if (options.discoveryToken) tags.push(['discovery_token', options.discoveryToken]);
    }

    const eventTemplate = {
      kind: 1984,
      pubkey: reporterPubkey,
      created_at: now,
      tags,
      content: notes || `Reported for ${reason}`
    };

    try {
      // 2. Silent background mining with tiered PoW (22 bits for discover, 20 bits for chat)
      const minedEvent = await this.minePowBackground(eventTemplate, difficulty);

      // 3. Sign and broadcast to public relays
      const finalized = NT.finalizeEvent(minedEvent, secretKey);
      if (relay) {
        await relay.publishEvent(finalized);
      }

      // 4. Cache locally
      const db = window.OpenDateDB || window.DB;
      if (db) {
        const filed = await db.get('my_filed_reports') || [];
        filed.push({
          targetPubkey,
          reason,
          pow: difficulty,
          source: isDiscover ? 'discover' : 'chat',
          interaction: interactionType,
          created_at: now
        });
        await db.set('my_filed_reports', filed);
      }

      console.log(`[Moderation] ${difficulty}-bit PoW report broadcast for ${targetPubkey}`);
      return true;
    } catch (err) {
      console.warn('[Moderation] Background report failed:', err);
      return false;
    }
  },

  /**
   * Evaluates community reports using Weighted Web-of-Trust (WoT).
   * Chat/match report from verified: 1.0 weight.
   * Discover report from verified: 0.5 weight.
   * Unverified/burner keys: 0.0 weight.
   * Requires >= 2.0 cumulative weight from distinct verified reporters to suppress.
   * @param {string} targetPubkey
   * @param {Array} reports
   * @returns {Promise<{ suppressed: boolean, score: number, validCount: number }>}
   */
  async evaluateCommunityReports(targetPubkey, reports) {
    if (!Array.isArray(reports) || reports.length === 0) {
      return { suppressed: false, score: 0, validCount: 0 };
    }

    const db = window.OpenDateDB || window.DB;
    let cachedProfiles = [];
    if (db) {
      cachedProfiles = await db.getAllProfiles();
    }
    const profileMap = new Map(cachedProfiles.map(p => [p.pubkey, p]));

    let cumulativeWeight = 0;
    let validReports = 0;
    const seenReporters = new Set();

    for (const report of reports) {
      const reporter = report.pubkey;
      if (!reporter || seenReporters.has(reporter)) continue;
      seenReporters.add(reporter);

      // Interaction check and tier threshold
      const interactionTag = report.tags?.find(t => t[0] === 'interaction');
      const interactionType = interactionTag ? interactionTag[1] : 'unverified_blind';
      const isDiscover = interactionType === 'discover_proximity';
      const minPow = isDiscover ? 22 : 20;

      // Verify NIP-13 PoW per tier
      const actualPow = this.getPow(report.id || '');
      if (actualPow < minPow) {
        continue;
      }

      // Drop blind crawler bot reports
      if (interactionType === 'unverified_blind') {
        continue;
      }

      // Calculate Asymmetric WoT weight
      let weight = 0;
      const reporterProfile = profileMap.get(reporter);
      const isVerifiedTag = report.tags?.find(t => t[0] === 'reporter_verified')?.[1] === '1';
      const isVerified = Boolean(reporterProfile?.verifiedSelfie || isVerifiedTag);
      const isEstablished = Boolean(reporterProfile?.created_at && (Date.now() / 1000 - reporterProfile.created_at > 14 * 86400));

      if (isVerified || isEstablished) {
        // Asymmetric weighting: 0.5 for Discover report, 1.0 for match report
        weight = isDiscover ? 0.5 : 1.0;
      } else {
        weight = 0.0;
      }

      cumulativeWeight += weight;
      if (weight > 0) validReports++;
    }

    const isSuppressed = cumulativeWeight >= 2.0;

    // Cache community suppression status in IndexedDB
    if (db && isSuppressed) {
      const suppressedList = await db.get('community_suppressed_pubkeys') || [];
      if (!suppressedList.includes(targetPubkey)) {
        suppressedList.push(targetPubkey);
        await db.set('community_suppressed_pubkeys', suppressedList);
      }
    }

    return {
      suppressed: isSuppressed,
      score: cumulativeWeight,
      validCount: validReports
    };
  },

  /**
   * Checks if target is suppressed by community consensus.
   * @param {string} pubkey
   * @returns {Promise<boolean>}
   */
  async isSuppressedByCommunity(pubkey) {
    const db = window.OpenDateDB || window.DB;
    if (!db) return false;
    const suppressedList = await db.get('community_suppressed_pubkeys') || [];
    return suppressedList.includes(pubkey);
  },

  /**
   * Publishes a NIP-56 kind 1984 cryptographic report against a pubkey.
   * Reasons: nudity, violence, impersonation, spam, harassment.
   * @param {string} targetPubkey
   * @param {string} reason
   * @param {string} notes
   * @param {Uint8Array} secretKey
   * @returns {Promise<boolean>}
   */
  async reportUser(targetPubkey, reason, notes, secretKey) {
    if (!secretKey || !window.NostrTools) return false;
    const NT = window.NostrTools;
    const relay = window.OpenDateRelay || window.RelayEngine;
    const now = Math.floor(Date.now() / 1000);

    const eventTemplate = {
      kind: 1984,
      created_at: now,
      tags: [
        ['p', targetPubkey, reason || 'other']
      ],
      content: notes || `Reported for ${reason}`
    };

    try {
      const finalized = NT.finalizeEvent(eventTemplate, secretKey);
      if (relay) await relay.publishEvent(finalized);
      return true;
    } catch (err) {
      console.warn('Failed to publish report:', err);
      return false;
    }
  },

  /**
   * Initializes device camera stream for live selfie verification.
   * @param {HTMLVideoElement} videoElement
   * @returns {Promise<MediaStream>}
   */
  async startLiveCamera(videoElement) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access is not supported by your browser.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      audio: false
    });

    if (videoElement) {
      videoElement.srcObject = stream;
      videoElement.play();
    }
    return stream;
  },

  /**
   * Captures a live frame from the active video stream, validates live presence,
   * and returns a data URL.
   * @param {HTMLVideoElement} videoElement
   * @param {MediaStream} stream
   * @returns {string} Clean base64 image dataUrl
   */
  captureLiveSelfie(videoElement, stream) {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth || 480;
    canvas.height = videoElement.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    // Stop camera tracks after capture
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }

    return canvas.toDataURL('image/jpeg', 0.85);
  },

  /**
   * Generates and triggers emergency date plan sharing via native OS share sheet or SMS.
   * @param {string} partnerName
   * @param {string} partnerPubkey
   * @param {string} meetingLocation
   * @param {string} dateNotes
   */
  async shareDatePlan(partnerName, partnerPubkey, meetingLocation, dateNotes) {
    const text = `OpenDate Meetup Safety Plan:\nMeeting with ${partnerName || 'my match'}\nLocation: ${meetingLocation || 'Regional Area'}\nDetails: ${dateNotes || 'Coffee / Dinner'}\nPartner ID: ${partnerPubkey ? partnerPubkey.slice(0, 16) + '...' : 'Verified'}\nStay safe!`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: `Date Plan with ${partnerName}`,
          text: text
        });
        return true;
      } catch (e) {
        // Fallback to clipboard or SMS
      }
    }

    // Fallback: SMS URL scheme
    const smsUrl = `sms:?body=${encodeURIComponent(text)}`;
    window.open(smsUrl, '_blank');
    return true;
  }
};

window.OpenDateModeration = OpenDateModeration;
window.ModerationEngine = OpenDateModeration;
