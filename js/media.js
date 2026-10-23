/**
 * OpenDate - Client-Side Safe Media & Blossom Protocol Engine
 * Strips camera EXIF/GPS metadata, scales images to 1080px, compresses to JPEG (0.82),
 * and uploads to Blossom BUD-01 servers signed with kind 24242 Nostr authorization.
 */

const BLOSSOM_SERVERS = [
  'https://blossom.primal.net',
  'https://nostr.build'
];

const OpenDateMedia = {
  /**
   * Loads a user-selected File, draws to HTML5 Canvas, resizes to max 1080px,
   * and exports a clean JPEG (0.82 quality) with all camera/GPS EXIF stripped.
   * @param {File} file
   * @param {number} maxDimension
   * @param {number} quality
   * @returns {Promise<{blob: Blob, dataUrl: string, sha256Hex: string}>}
   */
  async scrubExifAndCompress(file, maxDimension = 1080, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Failed to load image format.'));
        img.onload = () => {
          // Calculate proportional scale
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');

          // Draw image to canvas to strip all EXIF metadata tags
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            async (blob) => {
              if (!blob) {
                return reject(new Error('Canvas export to blob failed.'));
              }

              // Compute SHA-256 hash of the cleaned binary data
              const arrayBuffer = await blob.arrayBuffer();
              const NT = window.NostrTools;
              let sha256Hex = '';

              if (NT && NT.sha256) {
                const hashBytes = NT.sha256(new Uint8Array(arrayBuffer));
                sha256Hex = NT.bytesToHex(hashBytes);
              } else if (crypto && crypto.subtle) {
                const hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer);
                const hashArr = Array.from(new Uint8Array(hashBuf));
                sha256Hex = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
              }

              const dataUrl = canvas.toDataURL('image/jpeg', quality);
              resolve({ blob, dataUrl, sha256Hex });
            },
            'image/jpeg',
            quality
          );
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  },

  /**
   * Signs a kind: 24242 Blossom BUD-01 upload authorization event.
   * @param {string} sha256Hex
   * @param {number} sizeBytes
   * @param {Uint8Array} secretKey
   * @returns {object} Finalized Nostr authorization event
   */
  createBlossomAuthEvent(sha256Hex, sizeBytes, secretKey) {
    const NT = window.NostrTools;
    const now = Math.floor(Date.now() / 1000);
    const expiration = now + 3600; // 1 hour valid

    const eventTemplate = {
      kind: 24242,
      created_at: now,
      tags: [
        ['t', 'upload'],
        ['x', sha256Hex],
        ['size', sizeBytes.toString()],
        ['expiration', expiration.toString()]
      ],
      content: 'Upload authorization for OpenDate profile photo'
    };

    return NT.finalizeEvent(eventTemplate, secretKey);
  },

  /**
   * Uploads the scrubbed image blob to Blossom protocol server.
   * Falls back to local dataUrl if servers are unreachable or offline.
   * @param {Blob} blob
   * @param {string} sha256Hex
   * @param {Uint8Array} secretKey
   * @param {string} fallbackDataUrl
   * @returns {Promise<string>} Public image URL or local dataUrl
   */
  async uploadToBlossom(blob, sha256Hex, secretKey, fallbackDataUrl) {
    if (!secretKey || !window.NostrTools) {
      return fallbackDataUrl;
    }

    try {
      const authEvent = this.createBlossomAuthEvent(sha256Hex, blob.size, secretKey);
      const authHeader = 'Nostr ' + btoa(JSON.stringify(authEvent));

      for (const server of BLOSSOM_SERVERS) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);

          const res = await fetch(`${server}/upload`, {
            method: 'PUT',
            headers: {
              'Authorization': authHeader,
              'Content-Type': 'image/jpeg'
            },
            body: blob,
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (res.ok) {
            const data = await res.json();
            if (data && data.url) {
              return data.url;
            }
            return `${server}/${sha256Hex}.jpg`;
          }
        } catch (e) {
          console.warn(`Blossom upload failed for ${server}:`, e.message);
        }
      }
    } catch (err) {
      console.warn('Blossom authorization error:', err);
    }

    // Graceful offline/local fallback
    return fallbackDataUrl;
  }
};

window.OpenDateMedia = OpenDateMedia;
window.MediaEngine = OpenDateMedia;
