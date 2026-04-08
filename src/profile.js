import { fbDb } from './firebase.js';

/**
 * Ensure user profile exists in Firestore.
 * Creates on first sign-in, updates lastActiveAt on subsequent visits.
 */
export async function ensureUserProfile(user) {
  if (!user) return null;

  const profileRef = fbDb.collection('users').doc(user.uid);

  try {
    const doc = await profileRef.get();

    if (doc.exists) {
      // Returning user — update lastActiveAt
      await profileRef.update({
        lastActiveAt: new Date(),
        // Keep these in sync in case they changed
        email: user.email || null,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
      });
      return doc.data();
    } else {
      // New user — create full profile
      const referralCode = sessionStorage.getItem('shadowspeak_referral_code') || null;
      const selectedLanguage = localStorage.getItem('shadowspeak-lang') || null;

      const profile = {
        uid: user.uid,
        email: user.email || null,
        displayName: user.displayName || null,
        photoURL: user.photoURL || null,
        createdAt: new Date(),
        lastActiveAt: new Date(),
        selectedLanguage: selectedLanguage,
        isPremium: false,
        premiumSince: null,
        premiumTier: null,
        promoCodeUsed: null,
        referredBy: referralCode,
      };

      await profileRef.set(profile);

      // Clear the referral code from session after writing
      if (referralCode) {
        sessionStorage.removeItem('shadowspeak_referral_code');
      }

      return profile;
    }
  } catch (e) {
    console.warn('Profile sync failed:', e);
    return null;
  }
}

/**
 * Capture ?ref= URL parameter into sessionStorage.
 * Call this on app load, before auth.
 */
export function captureReferralCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const ref = urlParams.get('ref');
  if (ref) {
    sessionStorage.setItem('shadowspeak_referral_code', ref);
    console.log('[Analytics] referral_link_opened', { ref });
    // Clean the URL
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('ref');
    window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  }
}
