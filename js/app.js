/**
 * OpenDate - Production Application Controller & State Engine
 * Clean, production-ready zero-framework ES6 orchestrator coordinating
 * local IndexedDB, cryptographic sovereignty, Safe Media, Blossom uploads,
 * real Nostr relay subscriptions, and Minimalist Mono UI without demo data.
 */

class OpenDateApp {
  constructor() {
    this.identity = null;
    this.options = window.OPENDATE_OPTIONS || {};
    this.currentGeohash = 'dqb8';
    this.locationLabel = 'Charlottesville, VA';
    this.activeTab = 'discover';
    this.candidateQueue = [];
    this.allCandidates = [];
    this.currentCandidatePhotoIndex = 0;
    this.discoverFilters = this.getDefaultFilters();
    this.activeLikeCandidate = null;
    this.activeLikeTarget = 'Profile';
    this.activeChatPartner = null;
    this.activeCameraStream = null;
    this.myProfile = null;
    this.toastTimeout = null;
    this.isQrVisible = false;
    this.activeReportTarget = null;
    this.discoveryTokens = new Map();
    this.regionalRelaySubscription = null;
    this.userPreferences = {
      dealbreakerSmoking: false,
      dealbreakerDrugs: false
    };
  }

  async init() {
    // 1. Immediately bind DOM events
    this.bindEvents();

    // 2. Set immediate location badge
    this.updateLocationBadge();

    // 3. Load dynamic taxonomies from options.json so edits apply immediately
    try {
      const optRes = await fetch('options.json?_t=' + Date.now(), { cache: 'no-store' });
      if (optRes.ok) {
        const dynamicOptions = await optRes.json();
        if (dynamicOptions && dynamicOptions.genders) {
          this.options = dynamicOptions;
          window.OPENDATE_OPTIONS = dynamicOptions;
        }
      }
    } catch (e) {
      // Running offline or via file:// protocol where fetch is restricted
    }

    if (!this.options || !this.options.genders) {
      this.options = window.OPENDATE_OPTIONS || {};
    }

    // 4. Initialize local database
    const db = window.OpenDateDB || window.DB;
    if (db) {
      await db.init();
      const savedGeo = await db.get('user_geohash');
      const savedLabel = await db.get('user_location_label');
      if (savedGeo && savedLabel) {
        this.currentGeohash = savedGeo;
        this.locationLabel = savedLabel;
        this.updateLocationBadge();
      }

      const savedFilters = await db.get('discover_filters');
      if (savedFilters) {
        this.discoverFilters = Object.assign(this.getDefaultFilters(), savedFilters);
      } else {
        this.discoverFilters = this.getDefaultFilters();
      }

      this.myProfile = await db.get('my_profile');
      if (!this.myProfile) {
        this.myProfile = this.createDefaultProfile();
        await db.set('my_profile', this.myProfile);
      }

      const prefs = await db.get('user_dealbreaker_prefs');
      if (prefs) this.userPreferences = prefs;
    } else {
      this.myProfile = this.createDefaultProfile();
    }

    // 5. Initialize Sovereign Cryptographic Identity
    const crypto = window.OpenDateCrypto || window.CryptoEngine;
    if (crypto && window.NostrTools) {
      try {
        this.identity = await crypto.getOrCreateIdentity();
      } catch (err) {
        console.warn('Identity initialization warning:', err);
      }
    }

    // Check for mobile QR login hash (#login=nsec...)
    await this.checkLoginHash();

    // 6. Load real candidates & incoming likes
    await this.loadCandidates();
    await this.updateLikesCount();
    this.syncOwnProfileFromRelays();

    // 7. Render initial active view
    this.render();

    // 8. Check first-time visitor landing modal
    await this.checkLandingModal();

    // 9. Non-blocking background IP geolocation
    this.fetchBackgroundIpLocation();

    // 10. Listen for incoming gift wraps from Nostr relays (Likes & DMs)
    this.initRelaySubscriptions();
  }

  createDefaultProfile() {
    return {
      name: '',
      age: 26,
      locationLabel: this.locationLabel || 'Charlottesville, VA',
      geohash: this.currentGeohash || 'dqb8',
      ageMin: 21,
      ageMax: 36,
      gender: 'Woman',
      interestedIn: ['Everyone'],
      sexuality: 'Prefer not to say',
      intents: [],
      height: '',
      ethnicity: ['Prefer not to say'],
      religion: ['Prefer not to say'],
      children: ["Don't have children, open / undecided"],
      pets: [],
      smoking: 'No',
      marijuana: 'No',
      drugs: 'No',
      alcohol: 'Sometimes',
      drive: 'Yes, and have a car',
      jobTitle: '',
      interests: [],
      bio: '',
      prompts: [],
      photos: [],
      verifiedSelfie: false,
      paused: false
    };
  }

  async fetchBackgroundIpLocation() {
    const db = window.OpenDateDB || window.DB;
    const savedGeo = db ? await db.get('user_geohash') : null;
    if (savedGeo) return;

    const geo = window.OpenDateGeo || window.Geo;
    if (geo && geo.getIpLocation) {
      try {
        const ipLoc = await geo.getIpLocation();
        if (ipLoc) {
          this.currentGeohash = ipLoc.geohash;
          this.locationLabel = ipLoc.label;
          this.updateLocationBadge();
          if (db) {
            await db.set('user_geohash', this.currentGeohash);
            await db.set('user_location_label', this.locationLabel);
          }
          if (this.myProfile && !this.myProfile.locationLabel) {
            this.myProfile.locationLabel = ipLoc.label;
            this.myProfile.geohash = ipLoc.geohash;
            if (db) await db.set('my_profile', this.myProfile);
          }
          await this.loadCandidates();
          if (this.activeTab === 'discover') this.renderDiscoverView();
        }
      } catch (e) {}
    }
  }

  initRelaySubscriptions() {
    const relay = window.OpenDateRelay || window.RelayEngine;
    const crypto = window.OpenDateCrypto || window.CryptoEngine;
    const moderation = window.OpenDateModeration || window.ModerationEngine;
    const db = window.OpenDateDB || window.DB;

    if (!relay || !crypto || !this.identity || !this.identity.pubkey) return;

    relay.subscribeIncomingGiftWraps(this.identity.pubkey, async (wrapEvent) => {
      const unwrapped = await crypto.unwrapGiftWrap(wrapEvent, this.identity.secretKey);
      if (!unwrapped || !unwrapped.rumor) return;

      // Drop if sender is blocked
      if (moderation && await moderation.isBlocked(unwrapped.senderPubkey)) {
        return;
      }

      const data = unwrapped.rumor;

      // Inbound Transparent Like & Note
      if (data.type === 'opendate_like') {
        if (db) {
          await db.saveLike({
            id: wrapEvent.id,
            senderPubkey: unwrapped.senderPubkey,
            senderProfile: data.senderProfile || {},
            targetItem: data.targetItem || 'Profile',
            note: data.note || '',
            created_at: wrapEvent.created_at
          });
        }
        this.showToast('You received a new transparent like.');
        await this.updateLikesCount();
        if (this.activeTab === 'likes') this.renderLikesView();
      }

      // Inbound Direct Message
      if (data.type === 'opendate_chat') {
        if (db) {
          await db.saveMessage({
            id: data.id || wrapEvent.id,
            conversationPubkey: unwrapped.senderPubkey,
            senderPubkey: unwrapped.senderPubkey,
            text: data.text || '',
            created_at: data.created_at || wrapEvent.created_at
          });
        }
        this.showToast('New message received.');
        if (this.activeTab === 'chats') {
          if (this.activeChatPartner && this.activeChatPartner.pubkey === unwrapped.senderPubkey) {
            this.renderThreadView(this.activeChatPartner);
          } else {
            this.renderChatsView();
          }
        }
      }
    });
  }

  updateLocationBadge() {
    const el = document.getElementById('locationLabel');
    if (el) el.textContent = `Search: ${this.locationLabel}`;
  }

  async checkLandingModal() {
    const db = window.OpenDateDB || window.DB;
    const visited = db ? await db.get('visited_landing') : false;
    const modal = document.getElementById('landingModal');
    if (!visited && modal) modal.classList.remove('hidden');
  }

  bindEvents() {
    // Navigation Tabs
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        this.activeTab = btn.dataset.tab;
        this.activeChatPartner = null;
        this.render();
      });
    });

    // Location Dialog
    const locBtn = document.getElementById('locationBtn');
    const locModal = document.getElementById('locationModal');
    const closeLocBtn = document.getElementById('closeLocModal');
    const saveLocBtn = document.getElementById('saveLocBtn');
    const gpsBtn = document.getElementById('gpsBtn');

    if (locBtn && locModal) {
      locBtn.addEventListener('click', () => {
        locModal.classList.remove('hidden');
        document.getElementById('locInput')?.focus();
      });
    }
    if (closeLocBtn && locModal) {
      closeLocBtn.addEventListener('click', () => locModal.classList.add('hidden'));
    }

    if (saveLocBtn) {
      saveLocBtn.addEventListener('click', async () => {
        const input = document.getElementById('locInput');
        const query = input ? input.value.trim() : '';
        if (!query) {
          this.showToast('Please enter a City, State or 5-digit US ZIP.');
          return;
        }

        const geo = window.OpenDateGeo || window.Geo;
        if (geo) {
          const result = await geo.searchLocation(query);
          if (result) {
            this.currentGeohash = result.geohash;
            this.locationLabel = result.label;
            const db = window.OpenDateDB || window.DB;
            if (db) {
              await db.set('user_geohash', this.currentGeohash);
              await db.set('user_location_label', this.locationLabel);
            }
            this.updateLocationBadge();
            if (locModal) locModal.classList.add('hidden');
            this.showToast(`Updated search region to ${result.label}`);
            await this.loadCandidates();
            if (this.activeTab === 'discover') this.renderDiscoverView();
          } else {
            this.showToast('Region not found. Try a valid US ZIP or City, State.');
          }
        }
      });
    }

    if (gpsBtn) {
      gpsBtn.addEventListener('click', async () => {
        const geo = window.OpenDateGeo || window.Geo;
        if (!navigator.geolocation) {
          this.showToast('GPS is not supported on this device. Please type your city or ZIP below.');
          return;
        }

        try {
          this.showToast('Reading device coordinates...');
          const result = await geo.getDeviceLocation();
          this.currentGeohash = result.geohash;
          this.locationLabel = result.label;
          const db = window.OpenDateDB || window.DB;
          if (db) {
            await db.set('user_geohash', this.currentGeohash);
            await db.set('user_location_label', this.locationLabel);
          }
          this.updateLocationBadge();
          if (locModal) locModal.classList.add('hidden');
          this.showToast('Updated search region from device coordinates.');
          await this.loadCandidates();
          if (this.activeTab === 'discover') this.renderDiscoverView();
        } catch (err) {
          this.showToast('GPS unavailable on this desktop. Please enter your City or ZIP code.');
        }
      });
    }

    // Landing Dialog
    const closeLandingBtn = document.getElementById('closeLandingBtn');
    const startBrowsingBtn = document.getElementById('startBrowsingBtn');
    const openSyncFromLandingBtn = document.getElementById('openSyncFromLandingBtn');

    const dismissLanding = async () => {
      const db = window.OpenDateDB || window.DB;
      if (db) await db.set('visited_landing', true);
      document.getElementById('landingModal')?.classList.add('hidden');
    };

    if (closeLandingBtn) closeLandingBtn.addEventListener('click', dismissLanding);
    if (startBrowsingBtn) startBrowsingBtn.addEventListener('click', dismissLanding);
    if (openSyncFromLandingBtn) {
      openSyncFromLandingBtn.addEventListener('click', async () => {
        await dismissLanding();
        this.switchTab('safety');
      });
    }

    // Header Action Buttons
    document.getElementById('howItWorksBtn')?.addEventListener('click', () => {
      this.openHowItWorksModal();
    });

    const closeHowItWorksBtn = document.getElementById('closeHowItWorksBtn');
    const dismissHowItWorksBtn = document.getElementById('dismissHowItWorksBtn');
    const dismissHowItWorks = () => {
      document.getElementById('howItWorksModal')?.classList.add('hidden');
    };
    if (closeHowItWorksBtn) closeHowItWorksBtn.addEventListener('click', dismissHowItWorks);
    if (dismissHowItWorksBtn) dismissHowItWorksBtn.addEventListener('click', dismissHowItWorks);

    document.getElementById('syncBtn')?.addEventListener('click', () => {
      this.switchTab('safety');
    });

    // Discover Filters Modal Actions
    document.getElementById('closeFilterModalBtn')?.addEventListener('click', () => {
      document.getElementById('filterModal')?.classList.add('hidden');
    });

    // Like Modal Actions
    const closeLikeModal = document.getElementById('closeLikeModal');
    const cancelLikeBtn = document.getElementById('cancelLikeBtn');
    const confirmLikeBtn = document.getElementById('confirmLikeBtn');

    const dismissLikeModal = () => {
      document.getElementById('likeNoteModal')?.classList.add('hidden');
      this.activeLikeCandidate = null;
      this.activeLikeTarget = 'Profile';
    };

    if (closeLikeModal) closeLikeModal.addEventListener('click', dismissLikeModal);
    if (cancelLikeBtn) cancelLikeBtn.addEventListener('click', dismissLikeModal);

    if (confirmLikeBtn) {
      confirmLikeBtn.addEventListener('click', async () => {
        const noteInput = document.getElementById('likeNoteInput');
        const note = noteInput ? noteInput.value.trim() : '';
        await this.sendLikeToCandidate(this.activeLikeCandidate, note, this.activeLikeTarget);
        dismissLikeModal();
      });
    }

    // Share Date Plan Modal Actions
    const closeSharePlanBtn = document.getElementById('closeSharePlanBtn');
    const cancelSharePlanBtn = document.getElementById('cancelSharePlanBtn');
    const confirmSharePlanBtn = document.getElementById('confirmSharePlanBtn');

    const dismissSharePlanModal = () => {
      document.getElementById('sharePlanModal')?.classList.add('hidden');
    };

    if (closeSharePlanBtn) closeSharePlanBtn.addEventListener('click', dismissSharePlanModal);
    if (cancelSharePlanBtn) cancelSharePlanBtn.addEventListener('click', dismissSharePlanModal);

    if (confirmSharePlanBtn) {
      confirmSharePlanBtn.addEventListener('click', async () => {
        const loc = document.getElementById('planLocation')?.value.trim() || 'Local Area';
        const notes = document.getElementById('planNotes')?.value.trim() || 'Meetup';
        const moderation = window.OpenDateModeration || window.ModerationEngine;
        if (moderation && this.activeChatPartner) {
          await moderation.shareDatePlan(this.activeChatPartner.name, this.activeChatPartner.pubkey, loc, notes);
          this.showToast('Date plan dispatched.');
        }
        dismissSharePlanModal();
      });
    }

    // Report & Unmatch Modal Actions
    const closeReportBtn = document.getElementById('closeReportBtn');
    const cancelReportBtn = document.getElementById('cancelReportBtn');
    const unmatchOnlyBtn = document.getElementById('unmatchOnlyBtn');
    const confirmReportBtn = document.getElementById('confirmReportBtn');

    const dismissReportModal = () => {
      document.getElementById('reportModal')?.classList.add('hidden');
    };

    if (closeReportBtn) closeReportBtn.addEventListener('click', dismissReportModal);
    if (cancelReportBtn) cancelReportBtn.addEventListener('click', dismissReportModal);

    if (unmatchOnlyBtn) {
      unmatchOnlyBtn.addEventListener('click', async () => {
        if (!this.activeChatPartner) {
          dismissReportModal();
          return;
        }
        const partnerName = this.activeChatPartner.name || 'User';
        const partnerPubkey = this.activeChatPartner.pubkey;
        const db = window.OpenDateDB || window.DB;
        if (db) {
          await db.deleteConversation(partnerPubkey);
          await db.deleteLike(partnerPubkey);
          const allLikes = await db.getAllLikes();
          for (const l of allLikes) {
            if (l.senderPubkey === partnerPubkey || l.id === partnerPubkey) {
              await db.deleteLike(l.id);
            }
          }
          await db.set('unmatched_' + partnerPubkey, true);
        }
        this.showToast(`Silently unmatched with ${partnerName}.`);
        this.activeChatPartner = null;
        dismissReportModal();
        await this.updateLikesCount();
        this.renderChatsView();
      });
    }

    if (confirmReportBtn) {
      confirmReportBtn.addEventListener('click', async () => {
        const reason = document.getElementById('reportReasonSelect')?.value || 'other';
        const notes = document.getElementById('reportNotesInput')?.value.trim() || '';
        const moderation = window.OpenDateModeration || window.ModerationEngine;

        const target = this.activeReportTarget || (this.activeChatPartner ? {
          pubkey: this.activeChatPartner.pubkey,
          name: this.activeChatPartner.name,
          source: 'chat'
        } : null);

        if (!target || !moderation) {
          dismissReportModal();
          return;
        }

        const targetPubkey = target.pubkey;
        const targetName = target.name || 'User';
        const secretKey = this.identity?.secretKey;
        const reporterProfile = this.myProfile;
        const isDiscover = target.source === 'discover';

        // 1. Instant local relief: mute, unmatch, clean DB and purge from view
        const db = window.OpenDateDB || window.DB;
        if (db) {
          await db.deleteConversation(targetPubkey);
          await db.deleteLike(targetPubkey);
          await db.set('unmatched_' + targetPubkey, true);
        }
        await moderation.blockUser(targetPubkey, secretKey);

        if (isDiscover) {
          this.candidateQueue = this.candidateQueue.filter(x => x.pubkey !== targetPubkey);
          if (this.allCandidates) {
            this.allCandidates = this.allCandidates.filter(x => x.pubkey !== targetPubkey);
          }
          this.renderDiscoverView();
        } else {
          this.activeChatPartner = null;
          await this.updateLikesCount();
          this.renderChatsView();
        }

        dismissReportModal();
        this.activeReportTarget = null;

        // 2. Discover rate-limiting quota check (max 3 per 24 hours)
        if (isDiscover) {
          const quota = await moderation.checkDiscoverReportQuota();
          if (!quota.allowed) {
            this.showToast(`Daily Discover report limit reached (3/24h). ${targetName} blocked locally.`);
            return;
          }
          await moderation.recordDiscoverReportUsage();
        }

        this.showToast(`Blocked ${targetName}. Mining ${isDiscover ? '22-bit' : '20-bit'} PoW report in background...`);

        // 3. Silent background action: tiered PoW + proximity/interaction gating + relay broadcast
        const options = {
          source: isDiscover ? 'discover' : 'chat',
          targetGeohash: target.geohash || this.currentGeohash,
          reporterGeohash: this.currentGeohash,
          difficulty: isDiscover ? 22 : 20,
          discoveryToken: isDiscover ? this.getDiscoveryToken(targetPubkey) : null
        };

        moderation.queueBackgroundReport(targetPubkey, reason, notes, secretKey, reporterProfile, options).then((ok) => {
          if (ok) {
            console.log(`[Moderation] ${isDiscover ? 'Discover (22-bit)' : 'Chat (20-bit)'} PoW report broadcast for ${targetPubkey}`);
          }
        }).catch(err => {
          console.warn('[Moderation] Background report error:', err);
        });
      });
    }

    // Live Camera Verification Modal Actions
    const closeCameraBtn = document.getElementById('closeCameraBtn');
    const cancelCameraIntroBtn = document.getElementById('cancelCameraIntroBtn');
    const cancelCameraStreamBtn = document.getElementById('cancelCameraStreamBtn');
    const dismissCameraErrorBtn = document.getElementById('dismissCameraErrorBtn');
    const startCameraBtn = document.getElementById('startCameraBtn');
    const retryCameraBtn = document.getElementById('retryCameraBtn');
    const captureCameraBtn = document.getElementById('captureCameraBtn');

    const stopCamera = () => {
      if (this.activeCameraStream) {
        this.activeCameraStream.getTracks().forEach(t => t.stop());
        this.activeCameraStream = null;
      }
      document.getElementById('cameraModal')?.classList.add('hidden');
    };

    if (closeCameraBtn) closeCameraBtn.addEventListener('click', stopCamera);
    if (cancelCameraIntroBtn) cancelCameraIntroBtn.addEventListener('click', stopCamera);
    if (cancelCameraStreamBtn) cancelCameraStreamBtn.addEventListener('click', stopCamera);
    if (dismissCameraErrorBtn) dismissCameraErrorBtn.addEventListener('click', stopCamera);

    const showCameraError = (title, desc) => {
      document.getElementById('cameraIntroStep')?.classList.add('hidden');
      document.getElementById('cameraStreamStep')?.classList.add('hidden');
      const errStep = document.getElementById('cameraErrorStep');
      const titleEl = document.getElementById('cameraErrorTitle');
      const descEl = document.getElementById('cameraErrorDesc');
      if (titleEl) titleEl.textContent = title;
      if (descEl) descEl.textContent = desc;
      if (errStep) errStep.classList.remove('hidden');
    };

    const initiateCameraStream = async () => {
      const video = document.getElementById('liveCameraVideo');
      const moderation = window.OpenDateModeration || window.ModerationEngine;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showCameraError(
          'Camera Not Supported',
          'Your browser does not support media device streaming. You can verify your profile from a smartphone browser.'
        );
        return;
      }

      try {
        const stream = await moderation.startLiveCamera(video);
        this.activeCameraStream = stream;
        document.getElementById('cameraIntroStep')?.classList.add('hidden');
        document.getElementById('cameraErrorStep')?.classList.add('hidden');
        document.getElementById('cameraStreamStep')?.classList.remove('hidden');
      } catch (err) {
        let title = 'No Camera Detected';
        let desc = 'We could not detect an available webcam or selfie camera on this computer. You can continue exploring OpenDate and verify your profile later on a phone or device with a camera.';

        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          title = 'Camera Permission Needed';
          desc = 'Camera access was blocked by your browser. Please allow camera permissions in your browser URL bar or settings, then tap Try Again.';
        }

        showCameraError(title, desc);
      }
    };

    if (startCameraBtn) startCameraBtn.addEventListener('click', initiateCameraStream);
    if (retryCameraBtn) retryCameraBtn.addEventListener('click', initiateCameraStream);

    if (captureCameraBtn) {
      captureCameraBtn.addEventListener('click', async () => {
        const video = document.getElementById('liveCameraVideo');
        const moderation = window.OpenDateModeration || window.ModerationEngine;
        if (video && moderation && this.activeCameraStream) {
          const selfieDataUrl = moderation.captureLiveSelfie(video, this.activeCameraStream);
          this.activeCameraStream = null;

          this.myProfile.verifiedSelfie = true;
          if (!this.myProfile.photos) this.myProfile.photos = [];
          if (this.myProfile.photos.length === 0) {
            this.myProfile.photos.push(selfieDataUrl);
          }

          const db = window.OpenDateDB || window.DB;
          if (db) await db.set('my_profile', this.myProfile);

          const relay = window.OpenDateRelay || window.RelayEngine;
          if (relay && this.identity?.secretKey) {
            await relay.publishProfile(this.myProfile, this.myProfile.geohash || this.currentGeohash, this.identity.secretKey);
          }

          document.getElementById('cameraModal')?.classList.add('hidden');
          this.showToast('Live Camera Verification successful! Badge awarded.');
          this.render();
        }
      });
    }
  }

  switchTab(tabKey) {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(b => {
      const isMatch = b.dataset.tab === tabKey;
      b.classList.toggle('active', isMatch);
      b.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
    this.activeTab = tabKey;
    this.activeChatPartner = null;
    this.render();
    if (tabKey === 'profile') {
      this.syncOwnProfileFromRelays();
    }
  }

  async syncOwnProfileFromRelays() {
    if (!this.identity?.pubkey) return;
    const relay = window.OpenDateRelay || window.RelayEngine;
    if (!relay || !relay.fetchProfileByPubkey) return;

    try {
      const remoteProfile = await relay.fetchProfileByPubkey(this.identity.pubkey);
      if (remoteProfile) {
        const localUpdated = this.myProfile?.updated_at || 0;
        const remoteUpdated = remoteProfile.updated_at || remoteProfile.created_at || 0;
        if (!this.myProfile?.name || remoteUpdated >= localUpdated) {
          this.myProfile = Object.assign({}, this.myProfile, remoteProfile);
          this.myProfile.updated_at = remoteUpdated;
          const db = window.OpenDateDB || window.DB;
          if (db) await db.set('my_profile', this.myProfile);
          if (this.activeTab === 'profile') this.renderProfileView();
        }
      }
    } catch (e) {
      console.warn('Own profile sync error:', e);
    }
  }

  async updateLikesCount() {
    const db = window.OpenDateDB || window.DB;
    const likes = db ? await db.getAllLikes() : [];
    const countEl = document.getElementById('likesCount');
    if (countEl) countEl.textContent = likes.length.toString();
  }

  /**
   * Real production candidate loading:
   * 1. Loads cached profiles from local IndexedDB.
   * 2. Subscribes to live Nostr relays for the 9-cell geohash perimeter.
   * 3. Discards candidate if it matches the current user's own pubkey or blocked list.
   * 4. Filters candidates using the mutual dealbreaker engine.
   */
  async loadCandidates() {
    const db = window.OpenDateDB || window.DB;
    const geo = window.OpenDateGeo || window.Geo;
    const relay = window.OpenDateRelay || window.RelayEngine;
    const moderation = window.OpenDateModeration || window.ModerationEngine;
    const dealbreakers = window.OpenDateDealbreakers || window.DealbreakerEngine;

    let candidateList = [];

    // 1. Read locally cached profiles from IndexedDB
    if (db) {
      const cached = await db.getAllProfiles();
      candidateList = cached || [];
    }

    // 2. Query live public Nostr relays for the 9-cell geohash bounding box
    if (relay && geo && this.currentGeohash) {
      const boundingCells = geo.getGeohashWith8Neighbors(this.currentGeohash);

      if (this.regionalRelaySubscription) {
        try { this.regionalRelaySubscription.close(); } catch (e) {}
      }

      this.regionalRelaySubscription = relay.subscribeRegionalProfiles(boundingCells, async (profile) => {
        // Exclude own profile
        if (this.identity && profile.pubkey === this.identity.pubkey) return;

        // Exclude blocked or community-suppressed profiles
        if (moderation && (await moderation.isBlocked(profile.pubkey) || await moderation.isSuppressedByCommunity(profile.pubkey))) return;

        // Cache in local IndexedDB
        if (db) await db.saveProfile(profile);

        if (!this.allCandidates) this.allCandidates = [];
        const existingIdx = this.allCandidates.findIndex(c => c.pubkey === profile.pubkey);
        if (existingIdx === -1) {
          this.allCandidates.push(profile);
          if (this.candidateMatchesFilters(profile)) {
            this.candidateQueue.push(profile);
            if (this.activeTab === 'discover') this.renderDiscoverView();
          }
        } else {
          const existing = this.allCandidates[existingIdx];
          const incomingTime = profile.updated_at || profile.created_at || 0;
          const existingTime = existing.updated_at || existing.created_at || 0;
          if (incomingTime >= existingTime) {
            this.allCandidates[existingIdx] = profile;
            const qIdx = this.candidateQueue.findIndex(c => c.pubkey === profile.pubkey);
            const matches = this.candidateMatchesFilters(profile);
            if (qIdx !== -1) {
              if (matches) {
                this.candidateQueue[qIdx] = profile;
              } else {
                this.candidateQueue.splice(qIdx, 1);
              }
              if (this.activeTab === 'discover') this.renderDiscoverView();
            } else if (matches) {
              this.candidateQueue.push(profile);
              if (this.activeTab === 'discover') this.renderDiscoverView();
            }
          }
        }
      });
    }

    // 3. Filter candidates
    const myPubkey = this.identity?.pubkey;
    const unblocked = [];
    for (const c of candidateList) {
      if (myPubkey && c.pubkey === myPubkey) continue;
      if (moderation && await moderation.isBlocked(c.pubkey)) continue;
      if (moderation && await moderation.isSuppressedByCommunity(c.pubkey)) continue;
      unblocked.push(c);
    }

    this.allCandidates = unblocked;
    this.applyFiltersToQueue();
  }

  render() {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));

    const currentPanel = document.getElementById(`view-${this.activeTab}`);
    if (currentPanel) currentPanel.classList.remove('hidden');

    switch (this.activeTab) {
      case 'discover':
        this.renderDiscoverView();
        break;
      case 'likes':
        this.renderLikesView();
        break;
      case 'chats':
        if (this.activeChatPartner) {
          this.renderThreadView(this.activeChatPartner);
        } else {
          this.renderChatsView();
        }
        break;
      case 'profile':
        this.renderProfileView();
        break;
      case 'safety':
        this.renderSafetyView();
        break;
    }
  }

  renderDiscoverView() {
    const container = document.getElementById('discoverContainer');
    if (!container) return;

    const activeFilterCount = this.getActiveFilterCount();
    const toolbarHtml = `
      <div class="discover-toolbar">
        <div style="display: flex; align-items: baseline; gap: 8px;">
          <h2 style="font-size: 16px; font-weight: 700; margin: 0;">Discover</h2>
          <span class="discover-candidate-count">${this.candidateQueue.length} nearby</span>
        </div>
        <button type="button" class="filter-trigger-btn ${activeFilterCount > 0 ? 'has-active' : ''}" onclick="window.app.openFilterModal()" aria-label="Filter candidates">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
          </svg>
          <span>Filter</span>
          ${activeFilterCount > 0 ? `<span class="filter-count-badge">${activeFilterCount}</span>` : ''}
        </button>
      </div>
    `;

    if (this.candidateQueue.length === 0) {
      container.innerHTML = `
        ${toolbarHtml}
        <div class="state-box">
          <div class="state-title">No Profiles Match Your Filters</div>
          <div class="state-desc">
            ${activeFilterCount > 0
              ? `You have ${activeFilterCount} active filter${activeFilterCount > 1 ? 's' : ''} applied near ${this.locationLabel}. Try broadening your criteria to see more candidates.`
              : `OpenDate connects directly to public relays with zero central server barriers. There are no profiles published in this 25-mile box right now. Try broadening your region or publishing your profile to be the first in your area.`}
          </div>
          <div style="display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap;">
            ${activeFilterCount > 0 ? `
              <button type="button" class="btn btn-primary" onclick="window.app.openFilterModal()">
                Adjust Filters
              </button>
              <button type="button" class="btn btn-secondary" onclick="window.app.resetDiscoverFilters()">
                Reset Filters
              </button>
            ` : `
              <button type="button" class="btn btn-secondary" onclick="window.app.loadCandidates().then(() => window.app.renderDiscoverView())">
                Refresh Region
              </button>
              <button type="button" class="btn btn-primary" onclick="window.app.switchTab('profile')">
                Edit My Profile
              </button>
            `}
          </div>
        </div>
      `;
      return;
    }

    const c = this.candidateQueue[0];
    const dealbreakers = window.OpenDateDealbreakers || window.DealbreakerEngine;
    const compat = dealbreakers ? dealbreakers.evaluateMutualCompatibility(this.myProfile, c, this.userPreferences) : { sharedInterests: [] };
    const sharedSet = new Set(compat.sharedInterests || []);
    const validPhotos = (c.photos || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    const photoCount = validPhotos.length;
    if (this.currentCandidatePhotoIndex >= photoCount) {
      this.currentCandidatePhotoIndex = 0;
    }
    const currentPhotoIdx = this.currentCandidatePhotoIndex;
    const heroPhoto = photoCount > 0 ? validPhotos[currentPhotoIdx] : null;

    this.cacheDiscoveryToken(c.pubkey);

    container.innerHTML = `
      ${toolbarHtml}
      <article class="profile-card">
        <div class="profile-card-header">
          <div>
            <div class="card-title">${c.name || 'Anonymous'}, ${c.age || '25'}</div>
            <div class="card-subtitle">Near ${c.locationLabel || this.locationLabel}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${c.verifiedSelfie ? `<span class="verified-badge">Live Verified</span>` : ''}
            <button type="button" class="icon-btn" style="width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;" onclick="window.app.openDiscoverReportModal()" title="Report or Block Candidate" aria-label="Report or Block Candidate">
              <img src="icons/block.svg" width="15" height="15" alt="" style="display: block; filter: brightness(0) invert(0.85);" />
            </button>
          </div>
        </div>

        <div class="photo-slot" id="candidatePhotoSlot" onclick="window.app.handlePhotoSlotClick(event)">
          ${heroPhoto ? `
            <img id="discoverCandidateImg" src="${heroPhoto}" alt="${c.name || 'Candidate'}" />
            ${photoCount > 1 ? `
              <div class="photo-progress-bars">
                ${validPhotos.map((_, i) => `
                  <div class="photo-bar-segment ${i === currentPhotoIdx ? 'active' : ''}"></div>
                `).join('')}
              </div>
              <button type="button" class="photo-nav-btn photo-nav-prev" onclick="window.app.prevPhoto(event)" aria-label="Previous photo">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
              </button>
              <button type="button" class="photo-nav-btn photo-nav-next" onclick="window.app.nextPhoto(event)" aria-label="Next photo">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
              </button>
              <span class="photo-counter-badge" id="photoCounterBadge">${currentPhotoIdx + 1}/${photoCount}</span>
            ` : ''}
          ` : `
            <div class="photo-placeholder">
              <span style="font-size: 26px;">📷</span>
              <span>No Photo Uploaded</span>
            </div>
          `}
        </div>

        <div class="bio-paragraph">${c.bio || 'No written bio provided.'}</div>

        <div class="attributes-grid">
          ${c.jobTitle ? `<div class="attribute-item"><div class="attribute-label">Work</div><div class="attribute-value">${c.jobTitle}</div></div>` : ''}
          ${c.height ? `<div class="attribute-item"><div class="attribute-label">Height</div><div class="attribute-value">${c.height}</div></div>` : ''}
          ${c.religion ? `<div class="attribute-item"><div class="attribute-label">Faith</div><div class="attribute-value">${c.religion}</div></div>` : ''}
          ${c.children ? `<div class="attribute-item"><div class="attribute-label">Kids</div><div class="attribute-value">${c.children}</div></div>` : ''}
          ${c.drive ? `<div class="attribute-item"><div class="attribute-label">Transit</div><div class="attribute-value">${c.drive}</div></div>` : ''}
        </div>

        <div class="tags-cluster">
          ${(c.intents || []).map(i => `<span class="pill-tag">${i}</span>`).join('')}
          ${(c.interests || []).map(i => {
            const isShared = sharedSet.has(i);
            return `<span class="pill-tag ${isShared ? 'shared-interest' : ''}">${isShared ? '⭐ ' : ''}${i}</span>`;
          }).join('')}
        </div>

        ${(c.prompts || []).map((prompt) => `
          <div class="icebreaker-card" style="cursor: pointer;" onclick="window.app.openLikeModalForTarget(window.app.candidateQueue[0], 'Prompt: ${prompt.q.replace(/'/g, "\\'")}')">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div class="icebreaker-q">${prompt.q}</div>
              <span style="font-size: 11px; color: var(--ink-secondary);">Tap to reply</span>
            </div>
            <div class="icebreaker-a">"${prompt.a}"</div>
          </div>
        `).join('')}

        <div class="card-actions">
          <button type="button" class="btn btn-secondary" id="passBtn">
            Pass
          </button>
          <button type="button" class="btn btn-primary" id="likeBtn">
            Like &amp; Reply
          </button>
        </div>
      </article>
    `;

    const slotEl = document.getElementById('candidatePhotoSlot');
    if (slotEl) {
      this.attachPhotoTouchHandlers(slotEl);
    }

    document.getElementById('passBtn')?.addEventListener('click', () => {
      this.currentCandidatePhotoIndex = 0;
      const passed = this.candidateQueue.shift();
      if (passed && this.allCandidates) {
        this.allCandidates = this.allCandidates.filter(x => x.pubkey !== passed.pubkey);
      }
      this.renderDiscoverView();
    });

    document.getElementById('likeBtn')?.addEventListener('click', () => {
      this.openLikeModalForTarget(c, 'Profile');
    });
  }

  nextPhoto(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const c = this.candidateQueue[0];
    if (!c) return;
    const validPhotos = (c.photos || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPhotos.length <= 1) return;
    this.currentCandidatePhotoIndex = (this.currentCandidatePhotoIndex + 1) % validPhotos.length;
    this.updateDiscoverPhoto(validPhotos);
  }

  prevPhoto(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const c = this.candidateQueue[0];
    if (!c) return;
    const validPhotos = (c.photos || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPhotos.length <= 1) return;
    this.currentCandidatePhotoIndex = (this.currentCandidatePhotoIndex - 1 + validPhotos.length) % validPhotos.length;
    this.updateDiscoverPhoto(validPhotos);
  }

  updateDiscoverPhoto(validPhotos) {
    const c = this.candidateQueue[0];
    if (!c) return;
    const photos = validPhotos || (c.photos || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (photos.length === 0) return;
    const idx = Math.min(this.currentCandidatePhotoIndex, photos.length - 1);
    const img = document.getElementById('discoverCandidateImg');
    if (img) img.src = photos[idx];

    const bars = document.querySelectorAll('.photo-bar-segment');
    bars.forEach((bar, i) => {
      bar.classList.toggle('active', i === idx);
    });

    const badge = document.getElementById('photoCounterBadge');
    if (badge) badge.textContent = `${idx + 1}/${photos.length}`;
  }

  handlePhotoSlotClick(e) {
    if (e.target.closest('.photo-nav-btn')) return;
    const c = this.candidateQueue[0];
    if (!c) return;
    const validPhotos = (c.photos || []).filter(p => typeof p === 'string' && p.trim().length > 0);
    if (validPhotos.length <= 1) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    if (clickX < rect.width * 0.4) {
      this.prevPhoto(e);
    } else {
      this.nextPhoto(e);
    }
  }

  attachPhotoTouchHandlers(slotEl) {
    if (!slotEl) return;
    let startX = 0;
    let startY = 0;
    slotEl.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    }, { passive: true });

    slotEl.addEventListener('touchend', (e) => {
      if (!e.changedTouches || e.changedTouches.length === 0) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      if (Math.abs(deltaX) > 30 && Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX < 0) {
          this.nextPhoto();
        } else {
          this.prevPhoto();
        }
      }
    }, { passive: true });
  }

  getDefaultFilters() {
    return {
      ageMin: 18,
      ageMax: 65,
      genders: [],
      intents: [],
      verifiedOnly: false,
      smoking: 'Any',
      marijuana: 'Any',
      drugs: 'Any',
      alcohol: 'Any',
      children: 'Any',
      drive: 'Any',
      requireSharedInterests: false,
      interests: []
    };
  }

  getActiveFilterCount() {
    let count = 0;
    const f = this.discoverFilters;
    if (!f) return 0;
    if (f.ageMin > 18 || f.ageMax < 65) count++;
    if (f.genders && f.genders.length > 0) count++;
    if (f.intents && f.intents.length > 0) count++;
    if (f.verifiedOnly) count++;
    if (f.smoking && f.smoking !== 'Any') count++;
    if (f.marijuana && f.marijuana !== 'Any') count++;
    if (f.drugs && f.drugs !== 'Any') count++;
    if (f.alcohol && f.alcohol !== 'Any') count++;
    if (f.children && f.children !== 'Any') count++;
    if (f.drive && f.drive !== 'Any') count++;
    if (f.requireSharedInterests) count++;
    if (f.interests && f.interests.length > 0) count++;
    return count;
  }

  candidateMatchesFilters(c) {
    if (!c) return false;
    const f = this.discoverFilters;
    if (!f) return true;

    // 1. Age Range
    const age = c.age || 25;
    if (f.ageMin && age < f.ageMin) return false;
    if (f.ageMax && age > f.ageMax) return false;

    // 2. Gender
    if (f.genders && f.genders.length > 0) {
      if (!c.gender || !f.genders.includes(c.gender)) return false;
    }

    // 3. Relationship Intent
    if (f.intents && f.intents.length > 0) {
      const candIntents = c.intents || [];
      const hasMatch = candIntents.some(i => f.intents.includes(i));
      if (!hasMatch) return false;
    }

    // 4. Live Camera Verified
    if (f.verifiedOnly && !c.verifiedSelfie) return false;

    // 5. Habits & Lifestyle
    if (f.smoking === 'No' && c.smoking !== 'No') return false;
    if (f.smoking === 'Yes' && c.smoking === 'No') return false;

    if (f.marijuana === 'No' && c.marijuana !== 'No') return false;
    if (f.marijuana === 'Yes' && c.marijuana === 'No') return false;

    if (f.drugs === 'No' && c.drugs !== 'No') return false;
    if (f.drugs === 'Yes' && c.drugs === 'No') return false;

    if (f.alcohol === 'No' && c.alcohol !== 'No') return false;
    if (f.alcohol === 'Yes' && c.alcohol === 'No') return false;

    if (f.children === 'No kids' && c.children && !c.children.includes("Don't have children")) return false;
    if (f.children === 'Want kids' && c.children && !c.children.includes('want')) return false;

    if (f.drive === 'Has car' && (!c.drive || !c.drive.includes('have a car'))) return false;

    // 6. Interests
    if (f.requireSharedInterests && this.myProfile) {
      const myInterests = new Set(this.myProfile.interests || []);
      const candInterests = c.interests || [];
      const shares = candInterests.some(i => myInterests.has(i));
      if (!shares) return false;
    }

    if (f.interests && f.interests.length > 0) {
      const candInterests = c.interests || [];
      const matchesRequired = f.interests.some(i => candInterests.includes(i));
      if (!matchesRequired) return false;
    }

    return true;
  }

  applyFiltersToQueue() {
    const pool = this.allCandidates || [];
    this.candidateQueue = pool.filter(c => this.candidateMatchesFilters(c));
  }

  openFilterModal() {
    const modal = document.getElementById('filterModal');
    if (!modal) return;
    this.renderFilterModalContent();
    modal.classList.remove('hidden');
  }

  renderFilterModalContent() {
    const container = document.getElementById('filterModalBody');
    if (!container) return;

    const f = this.discoverFilters || this.getDefaultFilters();
    const opts = this.options || {};
    const genders = opts.genders || ['Woman', 'Man', 'Non-binary', 'Transfeminine', 'Transmasculine', 'Agender', 'Genderfluid', 'Prefer to self-describe'];
    const intents = opts.intents || ['Long-term partner', 'Life partner / Marriage', 'Short-term / Casual dating', 'New friends', 'Activity / Hobby partner'];
    const allInterests = opts.interestsTaxonomy
      ? Object.values(opts.interestsTaxonomy).flat()
      : ['Hiking', 'Coffee & Pour-overs', 'Craft Beer & Breweries', 'Board Games', 'Camping', 'Cycling', 'Cooking From Scratch', 'Live Concerts', 'Tacos', 'Reading Fiction', 'Yoga', 'Photography'];
    const sampleInterests = allInterests.slice(0, 24);

    container.innerHTML = `
      <div class="filter-section">
        <div class="filter-section-title">Age Range</div>
        <div class="filter-section-subtitle">Show candidates within this age bracket</div>
        <div class="filter-age-row">
          <div>
            <label for="filterAgeMin" style="font-size: 11px; color: var(--ink-secondary); display: block; margin-bottom: 2px;">Min Age</label>
            <input type="number" id="filterAgeMin" class="filter-age-input" min="18" max="99" value="${f.ageMin || 18}" />
          </div>
          <span style="color: var(--ink-secondary); font-size: 13px; margin-top: 14px;">to</span>
          <div>
            <label for="filterAgeMax" style="font-size: 11px; color: var(--ink-secondary); display: block; margin-bottom: 2px;">Max Age</label>
            <input type="number" id="filterAgeMax" class="filter-age-input" min="18" max="99" value="${f.ageMax || 65}" />
          </div>
        </div>
      </div>

      <div class="filter-section">
        <div class="filter-section-title">Gender (${(f.genders && f.genders.length) ? f.genders.length + ' selected' : 'Any'})</div>
        <div class="filter-section-subtitle">Leave unselected to discover all genders</div>
        <div class="filter-chips-grid">
          ${genders.map(g => `
            <button type="button" class="filter-chip ${(f.genders || []).includes(g) ? 'selected' : ''}" onclick="window.app.toggleFilterGender('${g.replace(/'/g, "\\'")}')">
              ${g}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="filter-section">
        <div class="filter-section-title">Relationship Intent (${(f.intents && f.intents.length) ? f.intents.length + ' selected' : 'Any'})</div>
        <div class="filter-section-subtitle">Select dating goals you are open to</div>
        <div class="filter-chips-grid">
          ${intents.map(i => `
            <button type="button" class="filter-chip ${(f.intents || []).includes(i) ? 'selected' : ''}" onclick="window.app.toggleFilterIntent('${i.replace(/'/g, "\\'")}')">
              ${i}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="filter-section">
        <div class="filter-section-title">Identity &amp; Presence</div>
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin-top: 4px;">
          <input type="checkbox" id="filterVerifiedOnly" ${f.verifiedOnly ? 'checked' : ''} />
          Only show profiles with a Live Camera Verified badge
        </label>
      </div>

      <div class="filter-section">
        <div class="filter-section-title">Lifestyle &amp; Habits</div>
        <div class="filter-section-subtitle">Filter by substance use, family plans, and transportation</div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 6px;">
          <div>
            <label for="filterSmoking" class="form-label" style="font-size: 11.5px;">Tobacco Smoking</label>
            <select id="filterSmoking" class="filter-select">
              <option value="Any" ${f.smoking === 'Any' ? 'selected' : ''}>Any</option>
              <option value="No" ${f.smoking === 'No' ? 'selected' : ''}>Non-smoker only</option>
              <option value="Yes" ${f.smoking === 'Yes' ? 'selected' : ''}>Smoker</option>
            </select>
          </div>

          <div>
            <label for="filterDrugs" class="form-label" style="font-size: 11.5px;">Recreational Drugs</label>
            <select id="filterDrugs" class="filter-select">
              <option value="Any" ${f.drugs === 'Any' ? 'selected' : ''}>Any</option>
              <option value="No" ${f.drugs === 'No' ? 'selected' : ''}>Non-user only</option>
            </select>
          </div>

          <div>
            <label for="filterMarijuana" class="form-label" style="font-size: 11.5px;">Cannabis / Weed</label>
            <select id="filterMarijuana" class="filter-select">
              <option value="Any" ${f.marijuana === 'Any' ? 'selected' : ''}>Any</option>
              <option value="No" ${f.marijuana === 'No' ? 'selected' : ''}>Non-user only</option>
              <option value="Yes" ${f.marijuana === 'Yes' ? 'selected' : ''}>User (Sometimes/Yes)</option>
            </select>
          </div>

          <div>
            <label for="filterAlcohol" class="form-label" style="font-size: 11.5px;">Alcohol</label>
            <select id="filterAlcohol" class="filter-select">
              <option value="Any" ${f.alcohol === 'Any' ? 'selected' : ''}>Any</option>
              <option value="No" ${f.alcohol === 'No' ? 'selected' : ''}>Non-drinker only</option>
              <option value="Yes" ${f.alcohol === 'Yes' ? 'selected' : ''}>Social drinker</option>
            </select>
          </div>

          <div>
            <label for="filterChildren" class="form-label" style="font-size: 11.5px;">Children</label>
            <select id="filterChildren" class="filter-select">
              <option value="Any" ${f.children === 'Any' ? 'selected' : ''}>Any</option>
              <option value="No kids" ${f.children === 'No kids' ? 'selected' : ''}>No children</option>
              <option value="Want kids" ${f.children === 'Want kids' ? 'selected' : ''}>Wants kids someday</option>
            </select>
          </div>

          <div>
            <label for="filterDrive" class="form-label" style="font-size: 11.5px;">Transportation</label>
            <select id="filterDrive" class="filter-select">
              <option value="Any" ${f.drive === 'Any' ? 'selected' : ''}>Any</option>
              <option value="Has car" ${f.drive === 'Has car' ? 'selected' : ''}>Has a car</option>
            </select>
          </div>
        </div>
      </div>

      <div class="filter-section">
        <div class="filter-section-title">Interests &amp; Shared Passions</div>
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin-top: 4px; margin-bottom: 8px;">
          <input type="checkbox" id="filterRequireShared" ${f.requireSharedInterests ? 'checked' : ''} />
          Must share at least 1 interest with my profile
        </label>

        <div class="filter-section-subtitle" style="margin-top: 8px;">Require specific shared interests (${(f.interests || []).length} selected):</div>
        <div class="filter-chips-grid">
          ${sampleInterests.map(item => `
            <button type="button" class="filter-chip ${(f.interests || []).includes(item) ? 'selected' : ''}" onclick="window.app.toggleFilterInterest('${item.replace(/'/g, "\\'")}')">
              ${item}
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  toggleFilterGender(gender) {
    if (!this.discoverFilters.genders) this.discoverFilters.genders = [];
    const idx = this.discoverFilters.genders.indexOf(gender);
    if (idx >= 0) {
      this.discoverFilters.genders.splice(idx, 1);
    } else {
      this.discoverFilters.genders.push(gender);
    }
    this.renderFilterModalContent();
  }

  toggleFilterIntent(intent) {
    if (!this.discoverFilters.intents) this.discoverFilters.intents = [];
    const idx = this.discoverFilters.intents.indexOf(intent);
    if (idx >= 0) {
      this.discoverFilters.intents.splice(idx, 1);
    } else {
      this.discoverFilters.intents.push(intent);
    }
    this.renderFilterModalContent();
  }

  toggleFilterInterest(interest) {
    if (!this.discoverFilters.interests) this.discoverFilters.interests = [];
    const idx = this.discoverFilters.interests.indexOf(interest);
    if (idx >= 0) {
      this.discoverFilters.interests.splice(idx, 1);
    } else {
      this.discoverFilters.interests.push(interest);
    }
    this.renderFilterModalContent();
  }

  async applyDiscoverFiltersFromModal() {
    const minEl = document.getElementById('filterAgeMin');
    const maxEl = document.getElementById('filterAgeMax');
    const verifiedEl = document.getElementById('filterVerifiedOnly');
    const smokingEl = document.getElementById('filterSmoking');
    const drugsEl = document.getElementById('filterDrugs');
    const marijuanaEl = document.getElementById('filterMarijuana');
    const alcoholEl = document.getElementById('filterAlcohol');
    const childrenEl = document.getElementById('filterChildren');
    const driveEl = document.getElementById('filterDrive');
    const sharedEl = document.getElementById('filterRequireShared');

    if (minEl) this.discoverFilters.ageMin = parseInt(minEl.value, 10) || 18;
    if (maxEl) this.discoverFilters.ageMax = parseInt(maxEl.value, 10) || 65;
    if (verifiedEl) this.discoverFilters.verifiedOnly = verifiedEl.checked;
    if (smokingEl) this.discoverFilters.smoking = smokingEl.value;
    if (drugsEl) this.discoverFilters.drugs = drugsEl.value;
    if (marijuanaEl) this.discoverFilters.marijuana = marijuanaEl.value;
    if (alcoholEl) this.discoverFilters.alcohol = alcoholEl.value;
    if (childrenEl) this.discoverFilters.children = childrenEl.value;
    if (driveEl) this.discoverFilters.drive = driveEl.value;
    if (sharedEl) this.discoverFilters.requireSharedInterests = sharedEl.checked;

    const db = window.OpenDateDB || window.DB;
    if (db) await db.set('discover_filters', this.discoverFilters);

    document.getElementById('filterModal')?.classList.add('hidden');
    this.applyFiltersToQueue();
    this.renderDiscoverView();
    this.showToast('Discover filters applied.');
  }

  async resetDiscoverFilters() {
    this.discoverFilters = this.getDefaultFilters();
    const db = window.OpenDateDB || window.DB;
    if (db) await db.set('discover_filters', this.discoverFilters);
    this.renderFilterModalContent();
    this.applyFiltersToQueue();
    this.renderDiscoverView();
    this.showToast('Filters reset to defaults.');
  }

  openLikeModalForTarget(candidate, targetItem = 'Profile') {
    this.activeLikeCandidate = candidate;
    this.activeLikeTarget = targetItem;
    const modal = document.getElementById('likeNoteModal');
    const desc = document.getElementById('likeTargetDesc');
    const input = document.getElementById('likeNoteInput');

    if (desc) {
      desc.textContent = targetItem === 'Profile'
        ? `Liking ${candidate.name}'s profile. You can optionally include an intro note:`
        : `Replying directly to ${candidate.name}'s ${targetItem}:`;
    }
    if (input) input.value = '';
    if (modal) modal.classList.remove('hidden');
  }

  async sendLikeToCandidate(candidate, note, targetItem = 'Profile') {
    if (!candidate) return;

    this.showToast('Sending like...');

    const crypto = window.OpenDateCrypto || window.CryptoEngine;
    const relay = window.OpenDateRelay || window.RelayEngine;

    const rumorPayload = {
      type: 'opendate_like',
      targetItem: targetItem,
      note: note || '',
      senderProfile: this.myProfile
    };

    try {
      if (crypto && relay && candidate.pubkey) {
        const giftWrap = await crypto.createGiftWrap(rumorPayload, candidate.pubkey, this.identity.secretKey);
        await relay.publishEvent(giftWrap);
      }

      this.showToast(`Sent like and intro note to ${candidate.name}.`);
      this.currentCandidatePhotoIndex = 0;
      this.candidateQueue.shift();
      this.renderDiscoverView();
    } catch (err) {
      console.warn('Like transmission warning:', err);
      this.currentCandidatePhotoIndex = 0;
      this.candidateQueue.shift();
      this.renderDiscoverView();
    }
  }

  async renderLikesView() {
    const container = document.getElementById('likesContainer');
    if (!container) return;

    const db = window.OpenDateDB || window.DB;
    const likes = db ? await db.getAllLikes() : [];

    if (likes.length === 0) {
      container.innerHTML = `
        <div class="state-box">
          <div class="state-title">No Incoming Likes Right Now</div>
          <div class="state-desc">
            When someone likes your profile, their full profile and intro note will appear here immediately with zero blurred paywalls.
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="font-size: 13px; color: var(--ink-secondary); margin-bottom: 8px;">
        Transparent Likes: All incoming likes and notes are 100% visible and free to match with.
      </div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${likes.map(like => {
          const p = like.senderProfile || {};
          return `
            <article class="likes-inbox-item" id="like-${like.id}">
              <div class="profile-card-header">
                <div>
                  <div class="card-title">${p.name || 'Anonymous'}, ${p.age || '25'}</div>
                  <div class="card-subtitle">Near ${p.locationLabel || this.locationLabel}</div>
                </div>
                ${p.verifiedSelfie ? `<span class="verified-badge">Live Verified</span>` : ''}
              </div>

              ${like.note ? `
                <div class="intro-note-bubble">
                  <div style="font-size: 11px; text-transform: uppercase; color: var(--ink-secondary); margin-bottom: 2px;">
                    Target: ${like.targetItem || 'Profile'}
                  </div>
                  <strong>Intro Note:</strong> "${like.note}"
                </div>
              ` : ''}

              <div class="bio-paragraph">${p.bio || 'No bio provided.'}</div>

              <div class="tags-cluster">
                ${(p.interests || []).map(i => `<span class="pill-tag">${i}</span>`).join('')}
              </div>

              <div class="card-actions">
                <button type="button" class="btn btn-secondary" onclick="window.app.dismissLike('${like.id}')">
                  Pass
                </button>
                <button type="button" class="btn btn-primary" onclick="window.app.acceptMatch('${like.id}', '${like.senderPubkey}', '${p.name || 'Anonymous'}', ${p.verifiedSelfie ? 'true' : 'false'})">
                  Match &amp; Chat
                </button>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `;
  }

  async dismissLike(id) {
    const db = window.OpenDateDB || window.DB;
    if (db) await db.deleteLike(id);
    await this.updateLikesCount();
    this.renderLikesView();
    this.showToast('Passed like.');
  }

  async acceptMatch(likeId, partnerPubkey, partnerName, partnerVerified = false) {
    const db = window.OpenDateDB || window.DB;
    if (db) {
      await db.deleteLike(likeId);
      await db.saveMessage({
        id: 'msg_' + Date.now(),
        conversationPubkey: partnerPubkey,
        senderPubkey: partnerPubkey,
        text: 'Hey! Excited to connect on OpenDate.',
        created_at: Math.floor(Date.now() / 1000)
      });
    }
    await this.updateLikesCount();
    this.showToast(`Matched with ${partnerName}!`);
    this.activeChatPartner = { pubkey: partnerPubkey, name: partnerName, verified: partnerVerified };
    this.switchTab('chats');
  }

  async renderChatsView() {
    const container = document.getElementById('chatsContainer');
    if (!container) return;

    const db = window.OpenDateDB || window.DB;
    const moderation = window.OpenDateModeration || window.ModerationEngine;

    let conversations = [];
    if (db) {
      const allProfiles = await db.getAllProfiles();
      const profileMap = new Map(allProfiles.map(p => [p.pubkey, p]));

      // Query database for all unique conversation messages
      try {
        const rawDb = await db.init();
        if (rawDb && rawDb.objectStoreNames.contains('messages')) {
          const tx = rawDb.transaction('messages', 'readonly');
          const store = tx.objectStore('messages');
          const allMsgs = await new Promise(res => {
            const req = store.getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => res([]);
          });

          const groups = new Map();
          for (const m of allMsgs) {
            const pk = m.conversationPubkey;
            if (!pk) continue;
            if (moderation && await moderation.isBlocked(pk)) continue;
            if (await db.get('unmatched_' + pk)) continue;
            if (!groups.has(pk)) groups.set(pk, []);
            groups.get(pk).push(m);
          }

          groups.forEach((msgs, pk) => {
            msgs.sort((a, b) => a.created_at - b.created_at);
            const lastMsg = msgs[msgs.length - 1];
            const partnerProfile = profileMap.get(pk) || {};
            conversations.push({
              partnerPubkey: pk,
              partnerName: partnerProfile.name || (pk.slice(0, 8) + '...'),
              partnerVerified: !!partnerProfile.verifiedSelfie,
              lastMessage: lastMsg.text,
              timestamp: lastMsg.created_at
            });
          });
        }
      } catch (e) {
        console.warn('Conversation query error:', e);
      }
    }

    if (conversations.length === 0) {
      container.innerHTML = `
        <div class="state-box">
          <div class="state-title">No Active Matches Yet</div>
          <div class="state-desc">
            When you match with someone from the Discover feed or accept a like in your inbox, your private encrypted conversation will appear here.
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="font-size: 13px; color: var(--ink-secondary); margin-bottom: 8px;">
        Direct Messages: End-to-end encrypted. Camera roll uploads are disabled to keep chats respectful and safe; text and reaction GIFs are supported.
      </div>

      <div class="chat-list">
        ${conversations.map(item => `
          <article class="chat-item" onclick="window.app.openChatThread('${item.partnerPubkey}', '${item.partnerName}', ${item.partnerVerified})">
            <div class="chat-item-main">
              <div class="chat-avatar">${item.partnerName.slice(0, 1)}</div>
              <div>
                <div class="chat-info-name">
                  <span>${item.partnerName}</span>
                  ${item.partnerVerified ? `<span class="verified-badge" style="font-size: 9px; padding: 1px 5px;">Verified</span>` : ''}
                </div>
                <div class="chat-info-preview">${item.lastMessage}</div>
              </div>
            </div>
            <div style="font-size: 11px; color: var(--ink-secondary);">
              Active
            </div>
          </article>
        `).join('')}
      </div>
    `;
  }

  openChatThread(partnerPubkey, partnerName, partnerVerified = false) {
    this.activeChatPartner = { pubkey: partnerPubkey, name: partnerName, verified: partnerVerified };
    this.renderThreadView(this.activeChatPartner);
  }

  async renderThreadView(partner) {
    const container = document.getElementById('chatsContainer');
    if (!container || !partner) return;

    const db = window.OpenDateDB || window.DB;
    const chatEngine = window.OpenDateChat || window.ChatEngine;
    const msgs = db ? await db.getMessages(partner.pubkey) : [];

    const hasScamPattern = msgs.some(m => m.senderPubkey === partner.pubkey && chatEngine?.detectScamPatterns(m.text).suspicious);

    container.innerHTML = `
      <div class="thread-container">
        <!-- Thread Header -->
        <div class="thread-header">
          <div class="thread-header-left">
            <button type="button" class="back-to-chats-btn" onclick="window.app.backToChatsList()" aria-label="Back to match list">&larr;</button>
            <div>
              <div style="font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                <span>${partner.name}</span>
                ${partner.verified ? `<span class="verified-badge" style="font-size: 9px; padding: 1px 5px;">Verified</span>` : ''}
              </div>
              <div style="font-size: 11px; color: var(--ink-secondary);">End-to-End Encrypted</div>
            </div>
          </div>

          <div style="display: flex; gap: 6px;">
            <button type="button" class="icon-btn" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;" onclick="window.app.openSharePlanModal()" title="Share Date Plan with Trusted Contact" aria-label="Share Date Plan">
              <img src="icons/share.svg" width="16" height="16" alt="" style="display: block; filter: brightness(0) invert(0.85);" />
            </button>
            <button type="button" class="icon-btn" style="width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;" onclick="window.app.openReportModal()" title="Unmatch, Report or Block User" aria-label="Unmatch, Report or Block User">
              <img src="icons/block.svg" width="16" height="16" alt="" style="display: block; filter: brightness(0) invert(0.85);" />
            </button>
          </div>
        </div>

        <!-- Scammer Pattern Alert -->
        ${hasScamPattern ? `
          <div class="scam-warning-box">
            <span>⚠️</span>
            <span>
              <strong>Safety Warning:</strong> A message in this thread mentions off-platform contact details or financial keywords. Never send money, gift cards, or crypto to anyone you meet online.
            </span>
          </div>
        ` : ''}

        <!-- Message Thread -->
        <div class="thread-messages-area" id="threadScrollArea">
          ${msgs.map(m => {
            const isMine = (m.senderPubkey === this.identity?.pubkey || m.isMine);
            const isGif = chatEngine && chatEngine.isWhitelistedGif(m.text);
            const gifUrl = isGif && chatEngine ? chatEngine.normalizeGifUrl(m.text) : m.text;
            const timeStr = new Date(m.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            return `
              <div class="message-row ${isMine ? 'mine' : 'theirs'}">
                ${isGif ? `
                  <div class="message-gif">
                    <img src="${gifUrl}" alt="Reaction GIF" />
                  </div>
                ` : `
                  <div class="message-bubble">${m.text}</div>
                `}
                <div class="message-time">${timeStr}</div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Thread Input Bar -->
        <div class="thread-input-bar">
          <input type="text" id="chatInput" class="thread-text-input" placeholder="Type a message or paste a Tenor / Giphy link..." autocomplete="off" />
          <button type="button" class="btn btn-primary" style="min-height: 44px; padding: 0 16px;" onclick="window.app.sendChatMessage()">
            Send
          </button>
        </div>
      </div>
    `;

    const scrollEl = document.getElementById('threadScrollArea');
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;

    document.getElementById('chatInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.sendChatMessage();
      }
    });
  }

  backToChatsList() {
    this.activeChatPartner = null;
    this.renderChatsView();
  }

  async sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input ? input.value.trim() : '';
    if (!text) return;

    input.value = '';
    await this.dispatchMessage(text);
  }

  async dispatchMessage(text) {
    if (!this.activeChatPartner) return;

    const chatEngine = window.OpenDateChat || window.ChatEngine;
    const relay = window.OpenDateRelay || window.RelayEngine;
    const db = window.OpenDateDB || window.DB;

    const cleanText = chatEngine && chatEngine.normalizeGifUrl ? chatEngine.normalizeGifUrl(text.trim()) : text.trim();
    const now = Math.floor(Date.now() / 1000);
    const msgObj = {
      id: 'msg_' + Date.now(),
      conversationPubkey: this.activeChatPartner.pubkey,
      senderPubkey: this.identity?.pubkey || 'me',
      isMine: true,
      text: cleanText,
      created_at: now
    };

    if (db) await db.saveMessage(msgObj);

    try {
      if (chatEngine && relay && this.identity?.secretKey) {
        const { recipientWrap, selfWrap } = await chatEngine.createDualGiftWrapMessage(
          text,
          this.activeChatPartner.pubkey,
          this.identity.secretKey
        );
        await relay.publishEvent(recipientWrap);
        await relay.publishEvent(selfWrap);
      }
    } catch (err) {
      console.warn('Relay transmission warning:', err);
    }

    this.renderThreadView(this.activeChatPartner);
  }

  openSharePlanModal() {
    const modal = document.getElementById('sharePlanModal');
    if (modal) modal.classList.remove('hidden');
  }

  cacheDiscoveryToken(pubkey) {
    if (!pubkey) return '';
    if (!this.discoveryTokens) this.discoveryTokens = new Map();
    const hourBucket = Math.floor(Date.now() / 3600000);
    const token = 'dt_' + pubkey.slice(0, 10) + '_' + hourBucket;
    this.discoveryTokens.set(pubkey, token);
    return token;
  }

  getDiscoveryToken(pubkey) {
    if (!pubkey) return '';
    if (!this.discoveryTokens) this.discoveryTokens = new Map();
    return this.discoveryTokens.get(pubkey) || this.cacheDiscoveryToken(pubkey);
  }

  openDiscoverReportModal() {
    if (!this.candidateQueue || this.candidateQueue.length === 0) return;
    const c = this.candidateQueue[0];
    this.activeReportTarget = {
      pubkey: c.pubkey,
      name: c.name || 'Candidate',
      geohash: c.geohash || this.currentGeohash,
      source: 'discover'
    };

    this.cacheDiscoveryToken(c.pubkey);

    const titleEl = document.getElementById('reportModalTitle');
    if (titleEl) titleEl.textContent = 'Report or Block Candidate';

    const descEl = document.getElementById('reportModalDesc');
    if (descEl) descEl.textContent = 'Block this candidate from your Discover deck. Submitting computes a 22-bit PoW community report with regional proximity proof in background.';

    document.getElementById('silentUnmatchSection')?.classList.add('hidden');
    document.getElementById('silentUnmatchDivider')?.classList.add('hidden');

    const modal = document.getElementById('reportModal');
    if (modal) modal.classList.remove('hidden');
  }

  openReportModal() {
    if (!this.activeChatPartner) return;
    this.activeReportTarget = {
      pubkey: this.activeChatPartner.pubkey,
      name: this.activeChatPartner.name,
      source: 'chat'
    };

    const titleEl = document.getElementById('reportModalTitle');
    if (titleEl) titleEl.textContent = 'Unmatch or Report Account';

    const descEl = document.getElementById('reportModalDesc');
    if (descEl) descEl.textContent = 'Block this user permanently and submit a community safety flag to protect others.';

    document.getElementById('silentUnmatchSection')?.classList.remove('hidden');
    document.getElementById('silentUnmatchDivider')?.classList.remove('hidden');

    const modal = document.getElementById('reportModal');
    if (modal) modal.classList.remove('hidden');
  }

  openHowItWorksModal() {
    const modal = document.getElementById('howItWorksModal');
    if (modal) modal.classList.remove('hidden');
  }

  openLiveCameraModal() {
    const modal = document.getElementById('cameraModal');
    if (!modal) return;

    document.getElementById('cameraIntroStep')?.classList.remove('hidden');
    document.getElementById('cameraStreamStep')?.classList.add('hidden');
    document.getElementById('cameraErrorStep')?.classList.add('hidden');

    modal.classList.remove('hidden');
  }

  renderProfileView() {
    const container = document.getElementById('profileContainer');
    if (!container) return;

    const p = this.myProfile || {};
    const opts = this.options || {};
    const genders = opts.genders || ['Woman', 'Man', 'Non-binary', 'Transfeminine', 'Transmasculine', 'Agender', 'Genderfluid', 'Prefer to self-describe'];
    const sexualities = opts.sexualities || ['Straight / Heterosexual', 'Gay', 'Lesbian', 'Bisexual', 'Pansexual', 'Queer', 'Asexual', 'Prefer not to say'];
    const intentsList = opts.intents || ['Long-term partner', 'Life partner / Marriage', 'Short-term / Casual dating', 'New friends', 'Activity / Hobby partner'];
    const religions = opts.religions || ['Agnostic', 'Atheist', 'Buddhist', 'Catholic', 'Christian (Protestant / Non-denom)', 'Spiritual (not religious)', 'Prefer not to say'];
    const childrenList = opts.childrenOptions || ["Don't have children, open / undecided", "Don't have children, want them someday", "Have children, want more"];
    const driveList = opts.driveOptions || ['Yes, and have a car', 'Yes, but don\'t own a car', 'No (use public transit / bike / walk)'];
    const yesNo = opts.yesNoSometimes || ['No', 'Sometimes', 'Yes'];

    const userIntents = new Set(p.intents || []);
    const userInterestedIn = new Set(p.interestedIn || ['Everyone']);
    const userInterests = new Set(p.interests || []);
    const photos = p.photos || [];

    container.innerHTML = `
      <form id="profileForm" class="form-section">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h2 style="font-size: 17px; font-weight: 700;">Edit Dating Profile</h2>
          ${p.verifiedSelfie ? `
            <span class="verified-badge">Live Verified</span>
          ` : `
            <button type="button" class="btn btn-secondary" style="font-size: 11px; min-height: 32px; padding: 0 8px;" onclick="window.app.openLiveCameraModal()">
              Get Live Verified
            </button>
          `}
        </div>

        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Profiles automatically pause after 30 days of inactivity to keep your local dating pool active.
        </p>

        <!-- PHOTO UPLOADER & POLICY WARNING -->
        <div class="profile-subgroup">
          <div class="profile-subgroup-title">Profile Photos (6 Slots)</div>
          
          <div class="policy-banner">
            <div class="policy-banner-title">
              <span>⚠️ STRICT PHOTO POLICY: ZERO TOLERANCE</span>
            </div>
            <div class="policy-banner-text">
              Nudity, sexually explicit content, violence, gore, hate symbols, and stolen photos are strictly prohibited. Images are client-side EXIF/GPS scrubbed and scaled before upload.
            </div>
          </div>

          <div class="photo-grid-container" id="photoGrid">
            ${[0, 1, 2, 3, 4, 5].map(idx => {
              const photoUrl = photos[idx];
              const isPrimary = (idx === 0);
              return `
                <div class="photo-grid-slot ${isPrimary ? 'primary-slot' : ''}" onclick="window.app.triggerPhotoUpload(${idx})">
                  ${photoUrl ? `
                    <img src="${photoUrl}" alt="Slot ${idx + 1}" />
                    <button type="button" class="photo-slot-delete" onclick="event.stopPropagation(); window.app.deletePhoto(${idx});" title="Remove Photo">&times;</button>
                  ` : `
                    <div style="font-size: ${isPrimary ? '28px' : '20px'}; opacity: 0.6;">+</div>
                    <span style="font-size: 11px; color: var(--ink-secondary); margin-top: 2px;">
                      ${isPrimary ? 'Cover Photo' : `Slot ${idx + 1}`}
                    </span>
                  `}
                  <span class="photo-slot-label">${isPrimary ? 'Cover' : `#${idx + 1}`}</span>
                </div>
              `;
            }).join('')}
          </div>
          <input type="file" id="photoFileInput" class="hidden" accept="image/*" />
        </div>

        <!-- BASIC ATTRIBUTES -->
        <div class="profile-subgroup">
          <div class="profile-subgroup-title">Basic Information</div>

          <div class="form-group">
            <label for="profName" class="form-label">First Name</label>
            <input type="text" id="profName" class="form-input" value="${p.name || ''}" placeholder="Your first name" required />
          </div>

          <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
              <label for="profLocation" class="form-label" style="margin: 0;">Profile Home Location</label>
              <button type="button" class="btn btn-secondary" style="font-size: 11px; min-height: 24px; padding: 2px 8px;" onclick="window.app.detectProfileLocation()">
                Use Device GPS
              </button>
            </div>
            <input type="text" id="profLocation" class="form-input" value="${p.locationLabel || ''}" placeholder="e.g. Richmond, VA or 23220" />
            <span style="font-size: 11.5px; color: var(--ink-secondary); display: block; margin-top: 4px;">
              Where your profile lives. Independent of your Discover search region.
            </span>
          </div>

          <div style="display: flex; gap: 10px;">
            <div class="form-group" style="flex: 1;">
              <label for="profAge" class="form-label">Your Age</label>
              <input type="number" id="profAge" class="form-input" value="${p.age || 26}" min="18" max="99" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label for="profAgeMin" class="form-label">Match Age Min</label>
              <input type="number" id="profAgeMin" class="form-input" value="${p.ageMin || 21}" min="18" max="99" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label for="profAgeMax" class="form-label">Match Age Max</label>
              <input type="number" id="profAgeMax" class="form-input" value="${p.ageMax || 36}" min="18" max="99" />
            </div>
          </div>

          <div style="display: flex; gap: 10px;">
            <div class="form-group" style="flex: 1;">
              <label for="profGender" class="form-label">Gender</label>
              <select id="profGender" class="form-select">
                ${genders.map(g => `<option value="${g}" ${p.gender === g ? 'selected' : ''}>${g}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="flex: 1;">
              <label for="profSexuality" class="form-label">Sexuality</label>
              <select id="profSexuality" class="form-select">
                ${sexualities.map(s => `<option value="${s}" ${p.sexuality === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Interested In (Who should see you)</label>
            <div class="chip-cluster">
              ${['Women', 'Men', 'Non-binary', 'Everyone'].map(g => `
                <button type="button" class="chip-btn ${userInterestedIn.has(g) ? 'selected' : ''}" onclick="window.app.toggleInterestedIn('${g}')">
                  ${g}
                </button>
              `).join('')}
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Relationship Intent</label>
            <div class="chip-cluster">
              ${intentsList.map(it => `
                <button type="button" class="chip-btn ${userIntents.has(it) ? 'selected' : ''}" onclick="window.app.toggleIntent('${it}')">
                  ${it}
                </button>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- DETAILS & LIFESTYLE HABITS -->
        <div class="profile-subgroup">
          <div class="profile-subgroup-title">Lifestyle &amp; Habits</div>

          <div style="display: flex; gap: 10px;">
            <div class="form-group" style="flex: 1;">
              <label for="profHeight" class="form-label">Height</label>
              <input type="text" id="profHeight" class="form-input" value="${p.height || ''}" placeholder="e.g. 5'9 (175 cm)" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label for="profReligion" class="form-label">Faith / Spirituality</label>
              <select id="profReligion" class="form-select">
                ${religions.map(r => `<option value="${r}" ${p.religion === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
            </div>
          </div>

          <div style="display: flex; gap: 10px;">
            <div class="form-group" style="flex: 1;">
              <label for="profChildren" class="form-label">Children</label>
              <select id="profChildren" class="form-select">
                ${childrenList.map(c => `<option value="${c}" ${p.children === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="flex: 1;">
              <label for="profDrive" class="form-label">Transportation</label>
              <select id="profDrive" class="form-select">
                ${driveList.map(d => `<option value="${d}" ${p.drive === d ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
            <div class="form-group">
              <label for="profSmoking" class="form-label">Tobacco</label>
              <select id="profSmoking" class="form-select">
                ${yesNo.map(yn => `<option value="${yn}" ${p.smoking === yn ? 'selected' : ''}>${yn}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label for="profMarijuana" class="form-label">Cannabis</label>
              <select id="profMarijuana" class="form-select">
                ${yesNo.map(yn => `<option value="${yn}" ${p.marijuana === yn ? 'selected' : ''}>${yn}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label for="profAlcohol" class="form-label">Alcohol</label>
              <select id="profAlcohol" class="form-select">
                ${yesNo.map(yn => `<option value="${yn}" ${p.alcohol === yn ? 'selected' : ''}>${yn}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label for="profDrugs" class="form-label">Drugs</label>
              <select id="profDrugs" class="form-select">
                ${yesNo.map(yn => `<option value="${yn}" ${p.drugs === yn ? 'selected' : ''}>${yn}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label for="profJob" class="form-label">Occupation / Work</label>
            <input type="text" id="profJob" class="form-input" value="${p.jobTitle || ''}" placeholder="e.g. Architect, Teacher" />
          </div>

          <div class="form-group">
            <label for="profBio" class="form-label">Bio (About You)</label>
            <textarea id="profBio" class="form-textarea" rows="3" placeholder="Write a few honest sentences about yourself...">${p.bio || ''}</textarea>
          </div>
        </div>

        <!-- 60+ CATEGORIZED INTERESTS SELECTOR -->
        <div class="profile-subgroup">
          <div class="profile-subgroup-title">Interests &amp; Hobbies (${userInterests.size} selected)</div>
          <div style="font-size: 12px; color: var(--ink-secondary);">
            Shared interests with candidates will be highlighted automatically when discovering singles.
          </div>

          ${Object.entries(opts.interestsTaxonomy || {}).map(([category, items]) => `
            <div class="interest-category-group">
              <div class="interest-category-title">${category}</div>
              <div class="chip-cluster">
                ${items.map(item => `
                  <button type="button" class="chip-btn ${userInterests.has(item) ? 'selected' : ''}" onclick="window.app.toggleInterest('${item.replace(/'/g, "\\'")}')">
                    ${item}
                  </button>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>

        <!-- ICEBREAKER PROMPTS -->
        <div class="profile-subgroup">
          <div class="profile-subgroup-title">Icebreaker Prompts (Answer up to 2)</div>
          <div style="font-size: 12px; color: var(--ink-secondary);">
            Candidates can reply directly to these questions with an intro note.
          </div>

          ${[0, 1].map(idx => {
            const current = (p.prompts && p.prompts[idx]) || { q: opts.icebreakerPrompts?.[idx] || '', a: '' };
            return `
              <div class="form-group" style="margin-top: 8px;">
                <label for="promptQ_${idx}" class="form-label">Prompt Question #${idx + 1}</label>
                <select id="promptQ_${idx}" class="form-select">
                  ${(opts.icebreakerPrompts || []).map(q => `<option value="${q}" ${current.q === q ? 'selected' : ''}>${q}</option>`).join('')}
                </select>
                <textarea id="promptA_${idx}" class="form-textarea" rows="2" placeholder="Your thoughtful answer..." style="margin-top: 4px;">${current.a || ''}</textarea>
              </div>
            `;
          }).join('')}
        </div>

        <!-- PAUSE MODE -->
        <div class="form-group">
          <label class="form-label">Profile Pause Mode</label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" id="profPaused" ${p.paused ? 'checked' : ''} />
            Pause discovery (hide my profile from new people while keeping active chats)
          </label>
        </div>

        <button type="submit" class="btn btn-primary" style="margin-top: 10px; width: 100%;">
          Save &amp; Publish Profile
        </button>
      </form>
    `;

    document.getElementById('profileForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.saveProfileFromForm();
    });
  }

  async saveProfileFromForm() {
    const p = this.myProfile;
    p.name = document.getElementById('profName').value.trim();
    p.age = parseInt(document.getElementById('profAge').value, 10);
    p.ageMin = parseInt(document.getElementById('profAgeMin').value, 10);
    p.ageMax = parseInt(document.getElementById('profAgeMax').value, 10);
    p.gender = document.getElementById('profGender').value;
    p.sexuality = document.getElementById('profSexuality').value;
    p.height = document.getElementById('profHeight').value.trim();
    p.religion = document.getElementById('profReligion').value;
    p.children = document.getElementById('profChildren').value;
    p.drive = document.getElementById('profDrive').value;
    p.smoking = document.getElementById('profSmoking').value;
    p.marijuana = document.getElementById('profMarijuana').value;
    p.alcohol = document.getElementById('profAlcohol').value;
    p.drugs = document.getElementById('profDrugs').value;
    p.jobTitle = document.getElementById('profJob').value.trim();
    p.bio = document.getElementById('profBio').value.trim();
    p.paused = document.getElementById('profPaused').checked;

    p.prompts = [];
    for (let idx = 0; idx < 2; idx++) {
      const qEl = document.getElementById(`promptQ_${idx}`);
      const aEl = document.getElementById(`promptA_${idx}`);
      if (qEl && aEl && aEl.value.trim()) {
        p.prompts.push({ q: qEl.value, a: aEl.value.trim() });
      }
    }

    const locInput = document.getElementById('profLocation');
    if (locInput) {
      const enteredLoc = locInput.value.trim();
      if (enteredLoc && enteredLoc !== p.locationLabel) {
        const geo = window.OpenDateGeo || window.Geo;
        if (geo) {
          const res = await geo.searchLocation(enteredLoc);
          if (res) {
            p.locationLabel = res.label;
            p.geohash = res.geohash;
          } else {
            p.locationLabel = enteredLoc;
          }
        } else {
          p.locationLabel = enteredLoc;
        }
      } else if (!p.geohash) {
        p.geohash = this.currentGeohash || 'dqb8';
        p.locationLabel = p.locationLabel || this.locationLabel || 'Charlottesville, VA';
      }
    }

    p.updated_at = Math.floor(Date.now() / 1000);

    const db = window.OpenDateDB || window.DB;
    if (db) await db.set('my_profile', this.myProfile);

    const relay = window.OpenDateRelay || window.RelayEngine;
    if (relay && this.identity && this.identity.secretKey) {
      await relay.publishProfile(this.myProfile, p.geohash || this.currentGeohash, this.identity.secretKey);
    }

    this.showToast('Profile saved & published to relays.');
  }

  async detectProfileLocation() {
    const geo = window.OpenDateGeo || window.Geo;
    if (!geo) return;
    const input = document.getElementById('profLocation');
    this.showToast('Detecting location...');
    try {
      let loc = null;
      if (navigator.geolocation) {
        loc = await geo.getDeviceLocation();
      }
      if (!loc && geo.getIpLocation) {
        loc = await geo.getIpLocation();
      }
      if (loc) {
        if (input) input.value = loc.label;
        if (this.myProfile) {
          this.myProfile.locationLabel = loc.label;
          this.myProfile.geohash = loc.geohash;
        }
        this.showToast(`Set home location to ${loc.label}`);
      }
    } catch (e) {
      this.showToast('Could not detect device location. Please enter city or ZIP.');
    }
  }

  triggerPhotoUpload(slotIndex) {
    const fileInput = document.getElementById('photoFileInput');
    if (!fileInput) return;

    fileInput.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      this.showToast('Scrubbing EXIF metadata & scaling image...');

      const media = window.OpenDateMedia || window.MediaEngine;
      if (!media) return;

      try {
        const { blob, dataUrl, sha256Hex } = await media.scrubExifAndCompress(file, 1080, 0.82);

        const finalUrl = await media.uploadToBlossom(
          blob,
          sha256Hex,
          this.identity?.secretKey,
          dataUrl
        );

        if (!this.myProfile.photos) this.myProfile.photos = [];
        this.myProfile.photos[slotIndex] = finalUrl;

        const db = window.OpenDateDB || window.DB;
        if (db) await db.set('my_profile', this.myProfile);

        this.showToast(`Photo ${slotIndex + 1} added.`);
        this.renderProfileView();
      } catch (err) {
        console.error('Photo processing error:', err);
        this.showToast('Error uploading photo: ' + err.message);
      }
    };

    fileInput.click();
  }

  deletePhoto(slotIndex) {
    if (this.myProfile && this.myProfile.photos) {
      this.myProfile.photos.splice(slotIndex, 1);
      const db = window.OpenDateDB || window.DB;
      if (db) db.set('my_profile', this.myProfile);
      this.showToast('Photo removed.');
      this.renderProfileView();
    }
  }

  toggleInterestedIn(gender) {
    if (!this.myProfile.interestedIn) this.myProfile.interestedIn = [];
    const idx = this.myProfile.interestedIn.indexOf(gender);
    if (idx >= 0) {
      this.myProfile.interestedIn.splice(idx, 1);
    } else {
      this.myProfile.interestedIn.push(gender);
    }
    this.renderProfileView();
  }

  toggleIntent(intent) {
    if (!this.myProfile.intents) this.myProfile.intents = [];
    const idx = this.myProfile.intents.indexOf(intent);
    if (idx >= 0) {
      this.myProfile.intents.splice(idx, 1);
    } else {
      this.myProfile.intents.push(intent);
    }
    this.renderProfileView();
  }

  toggleInterest(interest) {
    if (!this.myProfile.interests) this.myProfile.interests = [];
    const idx = this.myProfile.interests.indexOf(interest);
    if (idx >= 0) {
      this.myProfile.interests.splice(idx, 1);
    } else {
      this.myProfile.interests.push(interest);
    }
    this.renderProfileView();
  }

  async renderSafetyView() {
    const container = document.getElementById('safetyContainer');
    if (!container) return;

    if (!this.identity) {
      const crypto = window.OpenDateCrypto || window.CryptoEngine;
      if (crypto && window.NostrTools) {
        try {
          this.identity = await crypto.getOrCreateIdentity();
        } catch (e) {
          console.warn('Identity derivation error:', e);
        }
      }
    }

    const npub = this.identity?.npub || '';
    const nsec = this.identity?.nsec || '';

    container.innerHTML = `
      <div class="form-section">
        <h2 style="font-size: 16px; font-weight: 700;">Account Security &amp; Backup</h2>
        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Your account is stored safely on your device and backed up to your browser password manager (iCloud Keychain or Google Password Manager).
        </p>

        <div class="form-group">
          <label class="form-label">Public Account ID</label>
          <input type="text" class="form-input" value="${npub}" readonly />
        </div>

        <div class="form-group">
          <label class="form-label">Private Recovery Key</label>
          <input type="password" id="nsecDisplay" class="form-input" value="${nsec}" readonly />
          <button type="button" class="btn btn-secondary" style="margin-top: 4px; font-size: 12px; min-height: 36px;" onclick="window.app.toggleNsecVisibility()">
            Reveal / Hide Recovery Key
          </button>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border-default); margin: 8px 0;" />

        <h3 style="font-size: 14px; font-weight: 700;">Mobile Login &amp; QR Sync</h3>
        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Scan this QR code with your phone camera to log in and sync your account on mobile.
        </p>
        <div style="margin-top: 6px;">
          <button type="button" class="btn btn-secondary" id="toggleQrBtn" style="font-size: 12px; min-height: 36px;" onclick="window.app.toggleMobileLoginQr()">
            ${this.isQrVisible ? 'Hide Login QR Code' : 'Show Login QR Code'}
          </button>
          <div id="mobileQrWrapper" class="${this.isQrVisible ? '' : 'hidden'}" style="margin-top: 12px; text-align: center;">
            <div style="display: inline-block; background: #ffffff; padding: 14px; border-radius: 8px; border: 1px solid var(--border-default);">
              <div id="mobileLoginQrCode"></div>
            </div>
            <div style="margin-top: 8px; display: flex; gap: 8px; justify-content: center;">
              <button type="button" class="btn btn-secondary" style="font-size: 12px; min-height: 34px;" onclick="window.app.copyMobileLoginLink()">
                Copy Mobile Sync Link
              </button>
            </div>
            <p style="font-size: 11.5px; color: var(--ink-secondary); margin-top: 6px;">
              Keep this QR code private. Anyone who scans it gains full access to your account.
            </p>
          </div>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border-default); margin: 8px 0;" />

        <h3 style="font-size: 14px; font-weight: 700;">Data Backup &amp; Portability</h3>
        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Export all profile info, keys, matches, likes, chat messages, and filters to a single JSON backup file. Protects against browser cache resets.
        </p>
        <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
          <button type="button" class="btn btn-primary" style="flex: 1; min-width: 140px; font-size: 12.5px;" onclick="window.app.exportDataBackup()">
            Export Backup (.json)
          </button>
          <button type="button" class="btn btn-secondary" style="flex: 1; min-width: 140px; font-size: 12.5px;" onclick="document.getElementById('backupFileInput').click()">
            Import Backup (.json)
          </button>
          <input type="file" id="backupFileInput" accept=".json,application/json" class="hidden" onchange="window.app.handleBackupImport(event)" />
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border-default); margin: 8px 0;" />

        <h3 style="font-size: 14px; font-weight: 700;">Live Camera Verification</h3>
        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Verify your physical presence using your device camera to earn the verified badge.
        </p>

        <div style="margin-top: 6px;">
          ${this.myProfile?.verifiedSelfie ? `
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="verified-badge">Live Camera Verified</span>
              <span style="font-size: 12px; color: var(--status-verified-text);">Active on your profile</span>
            </div>
          ` : `
            <button type="button" class="btn btn-secondary" onclick="window.app.openLiveCameraModal()">
              Take Live Verification Selfie
            </button>
          `}
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border-default); margin: 8px 0;" />

        <h3 style="font-size: 14px; font-weight: 700;">Restore Existing Account</h3>
        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Switching devices or browsers? Paste your private recovery key below to restore your matches and profile.
        </p>
        <div class="form-group">
          <input type="text" id="importKeyInput" class="form-input" placeholder="Paste your private recovery key here" />
          <button type="button" class="btn btn-secondary" style="margin-top: 6px;" onclick="window.app.handleKeyImport()">
            Import &amp; Restore Account
          </button>
        </div>

        <hr style="border: 0; border-top: 1px solid var(--border-default); margin: 8px 0;" />

        <h3 style="font-size: 14px; font-weight: 700;">Technical Specifications</h3>
        <p style="font-size: 12.5px; color: var(--ink-secondary);">
          Curious about the decentralized protocols powering OpenDate?
        </p>
        <button type="button" class="btn btn-secondary" style="margin-top: 6px; width: 100%;" onclick="window.app.openHowItWorksModal()">
          How OpenDate Works (Architecture Guide)
        </button>
      </div>
    `;

    if (this.isQrVisible) {
      setTimeout(() => this.renderMobileLoginQr(), 40);
    }
  }

  toggleNsecVisibility() {
    const input = document.getElementById('nsecDisplay');
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  }

  async handleKeyImport() {
    const input = document.getElementById('importKeyInput');
    if (!input || !input.value.trim()) return;
    try {
      const crypto = window.OpenDateCrypto || window.CryptoEngine;
      if (crypto) {
        this.identity = await crypto.importIdentity(input.value.trim());
        this.showToast('Account successfully imported.');
        this.renderSafetyView();
      }
    } catch (err) {
      this.showToast('Import error: ' + err.message);
    }
  }

  async checkLoginHash() {
    if (!window.location.hash) return;
    const match = window.location.hash.match(/[#&]login=([^&]+)/);
    if (!match || !match[1]) return;

    const rawKey = decodeURIComponent(match[1]).trim();
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } else {
        window.location.hash = '';
      }
    } catch (e) {
      window.location.hash = '';
    }

    if (rawKey) {
      const crypto = window.OpenDateCrypto || window.CryptoEngine;
      if (crypto) {
        try {
          this.identity = await crypto.importIdentity(rawKey);
          this.showToast('Account successfully restored via mobile login!');
          const db = window.OpenDateDB || window.DB;
          if (db) {
            const savedProfile = await db.get('my_profile');
            if (savedProfile) this.myProfile = savedProfile;
          }
          await this.syncOwnProfileFromRelays();
        } catch (err) {
          this.showToast('Login import failed: ' + err.message);
        }
      }
    }
  }

  toggleMobileLoginQr() {
    this.isQrVisible = !this.isQrVisible;
    const wrapper = document.getElementById('mobileQrWrapper');
    const btn = document.getElementById('toggleQrBtn');
    if (!wrapper || !btn) return;

    if (this.isQrVisible) {
      wrapper.classList.remove('hidden');
      btn.textContent = 'Hide Login QR Code';
      this.renderMobileLoginQr();
    } else {
      wrapper.classList.add('hidden');
      btn.textContent = 'Show Login QR Code';
    }
  }

  renderMobileLoginQr() {
    const container = document.getElementById('mobileLoginQrCode');
    if (!container) return;
    container.innerHTML = '';

    const nsec = this.identity?.nsec || '';
    if (!nsec) {
      container.innerHTML = '<span style="color: #666; font-size: 12px;">No active key found</span>';
      return;
    }

    const originUrl = window.location.href.split('#')[0];
    const loginUrl = `${originUrl}#login=${encodeURIComponent(nsec)}`;

    if (typeof QRCode !== 'undefined') {
      try {
        new QRCode(container, {
          text: loginUrl,
          width: 180,
          height: 180,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (err) {
        console.warn('QRCode error:', err);
        container.innerHTML = '<span style="color: #666; font-size: 12px;">Failed to render QR</span>';
      }
    } else {
      container.innerHTML = '<span style="color: #666; font-size: 12px;">QR library loading...</span>';
    }
  }

  copyMobileLoginLink() {
    const nsec = this.identity?.nsec || '';
    if (!nsec) {
      this.showToast('No active recovery key to export.');
      return;
    }
    const originUrl = window.location.href.split('#')[0];
    const loginUrl = `${originUrl}#login=${encodeURIComponent(nsec)}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(loginUrl).then(() => {
        this.showToast('Mobile sync link copied to clipboard.');
      }).catch(() => {
        prompt('Copy mobile sync link:', loginUrl);
      });
    } else {
      prompt('Copy mobile sync link:', loginUrl);
    }
  }

  async exportDataBackup() {
    try {
      const db = window.OpenDateDB || window.DB;
      let likes = [];
      let profiles = [];
      let messages = [];
      let kv = [];

      if (db) {
        likes = await db.getAllLikes();
        profiles = await db.getAllProfiles();
        messages = await db.getAllMessages();
        kv = await db.getAllKV();
      }

      const backup = {
        app: 'OpenDate',
        version: 1,
        exportedAt: new Date().toISOString(),
        identity: {
          pubkey: this.identity?.pubkey || '',
          privkey: this.identity?.privkey || '',
          npub: this.identity?.npub || '',
          nsec: this.identity?.nsec || ''
        },
        profile: this.myProfile || {},
        preferences: {
          discoverFilters: this.discoverFilters || {},
          userPreferences: this.userPreferences || {}
        },
        location: {
          geohash: this.currentGeohash || '',
          label: this.locationLabel || '',
          coords: this.currentCoords || null
        },
        database: {
          likes,
          profiles,
          messages,
          kv
        }
      };

      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `opendate-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showToast('Backup successfully exported.');
    } catch (err) {
      console.error('Backup export error:', err);
      this.showToast('Export failed: ' + err.message);
    }
  }

  async handleBackupImport(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data || (!data.identity && !data.profile)) {
        throw new Error('Invalid OpenDate backup file format');
      }

      const db = window.OpenDateDB || window.DB;
      const crypto = window.OpenDateCrypto || window.CryptoEngine;

      // 1. Restore identity
      const keyToImport = data.identity?.nsec || data.identity?.privkey;
      if (keyToImport && crypto) {
        this.identity = await crypto.importIdentity(keyToImport);
      }

      // 2. Restore profile
      if (data.profile) {
        this.myProfile = Object.assign(this.createDefaultProfile(), data.profile);
        if (db) await db.set('my_profile', this.myProfile);
      }

      // 3. Restore preferences & filters
      if (data.preferences?.discoverFilters) {
        this.discoverFilters = Object.assign(this.getDefaultFilters(), data.preferences.discoverFilters);
        if (db) await db.set('discover_filters', this.discoverFilters);
      }
      if (data.preferences?.userPreferences) {
        this.userPreferences = data.preferences.userPreferences;
        if (db) await db.set('user_dealbreaker_prefs', this.userPreferences);
      }

      // 4. Restore location
      if (data.location?.geohash && data.location?.label) {
        this.currentGeohash = data.location.geohash;
        this.locationLabel = data.location.label;
        this.currentCoords = data.location.coords || null;
        if (db) {
          await db.set('user_geohash', this.currentGeohash);
          await db.set('user_location_label', this.locationLabel);
        }
        this.updateLocationBadge();
      }

      // 5. Restore database stores (likes, profiles, messages, kv)
      if (db && data.database) {
        await db.bulkRestore(data.database);
      }

      event.target.value = '';

      // Re-hydrate state and views
      await this.loadCandidates();
      await this.updateLikesCount();
      this.render();
      this.showToast('Backup successfully imported! All profile data, matches, and chats restored.');
    } catch (err) {
      console.error('Backup import error:', err);
      this.showToast('Import failed: ' + err.message);
      if (event.target) event.target.value = '';
    }
  }

  showToast(message) {
    const toast = document.getElementById('appToast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.display = 'block';
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.style.display = 'none';
    }, 2800);
  }
}

// Global initialization
window.app = new OpenDateApp();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.app.init());
} else {
  window.app.init();
}
