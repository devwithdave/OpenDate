# OpenDate

A sovereign, decentralized, zero-backend dating application built on Nostr. Zero developer infrastructure, zero subscriptions, zero algorithmic paywalls, and zero centralized tracking.

OpenDate runs entirely client-side as a Progressive Web App (PWA) hosted on static storage (such as GitHub Pages). Identity, discovery, matching, and direct messaging happen peer-to-peer over public Nostr relays and decentralized Blossom media servers.

---

## Core Philosophy

- **Zero Backend Required**: No private servers, no centralized user databases, and no cloud hosting bills.
- **Cryptographic Sovereignty**: Your identity is a standard Nostr cryptographic keypair (secp256k1). You own your data, your matches, and your encryption keys.
- **No Paywalls or Blurring**: 100% free forever. All incoming likes, intros, and chats are fully transparent and accessible without micro-transactions or paid tiers.
- **Privacy by Default**: Coarse 25-mile regional geohashes prevent exact coordinate leakage. Photos are scrubbed of EXIF and GPS metadata client-side before upload.
- **Anti-Bot & Anti-Spam Defenses**: Tiered Proof-of-Work (PoW / NIP-13), ephemeral discovery presentation tokens, and regional proximity gating protect the network without paid bonds.

---

## Key Features

### 1. Discovery Deck
- **Multi-Photo Carousel**: Browse candidates with Instagram/Tinder-style segmented progress bars, side tap zones, chevron arrows, and touch-swipe gestures on mobile devices.
- **Dual Location Decoupling**: Set your profile's home location (where your profile is discovered) independently from your active Discover search region (where you are currently looking for matches).
- **Clean Attribute Lists**: Basic profile info and lifestyle habits render in a clean, legible list under photos. Attributes marked "Prefer not to say" are automatically hidden.
- **Mutual Compatibility**: Client-side dealbreaker engine filters candidates according to age ranges, intents, lifestyle, and shared interests.

### 2. Transparent Likes & Intros
- Anyone can send a transparent like and an optional intro note tied to a profile prompt.
- Incoming likes appear in your Likes inbox with complete profile details and notes visible upfront with zero blurred paywalls.

### 3. End-to-End Encrypted Chat (NIP-17 / NIP-59)
- Direct messaging uses Nostr Gift Wrap (NIP-59) with dual wrap transmission (NIP-17).
- Relays see only ephemeral sender wrappers and randomized timestamps, concealing communication metadata and message content.

### 4. Client-Side Live Camera Verification
- Awarded through real-time camera capture directly in the browser to deter catfishing and stolen profile pictures.
- Verification status is cryptographically signed and published to candidate cards.

### 5. Multi-Device Sync & Backups
- **QR Code Mobile Login**: Generate a QR deep link on desktop to scan with your phone camera, instantly importing keys and syncing profile data from relays.
- **Full JSON Backup**: One-click export and import of private recovery keys, profile metadata, saved matches, and encrypted chat histories.

### 6. Decentralized Moderation & Web-of-Trust (WoT)
- **Silent Unmatch**: Disconnect from conversations and purge local thread history cleanly without alerting the other party.
- **Tiered Proof-of-Work**: 20-bit PoW for mutual match reports; 22-bit PoW for Discover candidate reports calculated silently in a background Web Worker.
- **Proximity & Presentation Gating**: Discover reports require coarse geohash proximity and a signed presentation token proving the candidate appeared organically in a real deck.
- **Asymmetric WoT Suppression**: Verified established accounts hold higher moderation weight than burner accounts, requiring consensus before network-wide suppression.

---

## Technical Stack

- **Architecture**: Zero-framework Vanilla ES6 (no Node build step, no Webpack/Vite bundlers).
- **Network Protocol**: Nostr (NIP-01, NIP-13, NIP-17, NIP-51, NIP-59).
- **Libraries**:
  - `nostr.bundle.js`: Pre-compiled browser build of `nostr-tools`.
  - `qrcode.min.js`: Client-side QR code generator.
- **Media Storage**: Blossom servers (SHA-256 content addressing with NIP-98 authorization).
- **Local Storage**: IndexedDB for offline persistence of credentials, cached candidate decks, transparent likes, and chat logs.
- **PWA**: Service Worker caching (`sw.js`) enabling instant boot and offline resilience.

---

## Nostr Event Architecture

| Event Kind | Purpose | Specification |
| :--- | :--- | :--- |
| **30078** | Parameterized Replaceable Dating Profile (`opendate-v1-profile`) | NIP-78 |
| **1059** | Gift Wrap encrypted container for Likes and Messages | NIP-59 |
| **10000** | Mute List for blocked and silenced profiles | NIP-51 |
| **1984** | Decentralized Moderation and Abuse Reports | NIP-56 / NIP-13 |

---

## Getting Started

### Option 1: Live Deployment (GitHub Pages)
OpenDate runs out of the box on GitHub Pages:
1. Fork or clone this repository.
2. In your repository settings, navigate to **Pages**.
3. Under **Build and deployment**, set Source to **Deploy from a branch** and select `main` / `/ (root)`.
4. Your dating application is live at `https://<username>.github.io/<repo>/`.

### Option 2: Local Development
Because OpenDate requires no backend runtime, you can serve the directory using any static web server:

```powershell
# Using Python
python -m http.server 3000

# Using Node.js npx
npx serve .

# Or using the included local server script
node server.js
```

Open `http://localhost:3000` in your browser.

---

## Relay Pool Defaults

OpenDate connects out of the box to public, reliable Nostr relays:
- `wss://nos.lol`
- `wss://relay.primal.net`
- `wss://nostr.mom`

You can add or modify relay endpoints directly in `js/relay.js`.

---

## License

MIT License. Open-source, decentralized, and sovereign software for human connection.
