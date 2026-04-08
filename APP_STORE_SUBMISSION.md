# ShadowSpeak — App Store Submission Guide

## App Identity

| Field | Value |
|-------|-------|
| Name | ShadowSpeak |
| Subtitle | Learn Cantonese and Mandarin |
| Bundle ID | com.shadowspeak.languages |
| SKU | SHADOWSPEAK-001 |
| Primary category | Education |
| Secondary category | Utilities |
| Age rating | 4+ |
| Price | Free (with in-app purchases) |

## Short Description (30 chars)
Learn languages by speaking.

## Long Description

ShadowSpeak teaches you to speak Cantonese and Mandarin the way languages are actually learned — by listening to native speakers and speaking along.

Most apps teach you to recognise words. ShadowSpeak teaches you to produce them. The difference shows up the moment you try to have a real conversation.

Six-phase lessons take you from first listen to confident speaking in under 30 minutes. Shadow mode puts native audio and your voice side by side. Real phrases from real Hong Kong and Mandarin-speaking life.

Free to start. Three units completely free. Unlock the full curriculum with ShadowSpeak Premium.

## Keywords (100 chars max)
cantonese,mandarin,shadowing,speak,hong kong,language,pronunciation,fluency,tones,shadow

## URLs

| Field | URL |
|-------|-----|
| Support URL | https://faithlantz.com/shadowspeak-support |
| Privacy Policy URL | https://faithlantz.com/shadowspeak-privacy |
| Marketing URL (optional) | https://flantzhk.github.io/ShadowSpeak/ |

## In-App Purchases (Register in App Store Connect)

| Product ID | Display Name | Price |
|------------|-------------|-------|
| shadowspeak.premium.monthly | ShadowSpeak Premium Monthly | HKD 98 |
| shadowspeak.premium.annual | ShadowSpeak Premium Annual | HKD 598 |
| shadowspeak.premium.lifetime | ShadowSpeak Premium Lifetime | HKD 1,280 |

Note: These are registered in App Store Connect but payment processing is not yet wired (RevenueCat integration is post-launch). The app currently shows pricing UI with "Coming soon" messaging.

## Required Screenshots

Capture these moments at the required sizes:

### Scenes to capture:
1. **Home screen** — Unit grid showing Cantonese or Mandarin lessons
2. **Active lesson** — Shadow mode with Chinese characters, romanisation, audio controls
3. **Pronunciation scoring** — Feedback screen with character-level scoring
4. **Badge unlock** — Celebration animation after earning a badge
5. **Premium gate** — Pricing tiers screen

### Required sizes:
| Device | Size (pixels) | Required? |
|--------|--------------|-----------|
| iPhone 6.7" (15 Pro Max) | 1290 x 2796 | Yes |
| iPhone 6.5" (11 Pro Max) | 1242 x 2688 | Yes |
| iPad Pro 12.9" | 2048 x 2732 | If iPad supported |

## Build Commands

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Add iOS platform (requires Xcode)
npx cap add ios

# Sync web build to iOS
npx cap sync

# Open in Xcode
npx cap open ios
```

## Xcode Configuration

After running `npx cap open ios`:

1. **Minimum deployment target:** iOS 16
2. **Supported orientations:** Portrait only
3. **Background modes:** Enable "Audio, AirPlay, and Picture in Picture" (for TTS when screen dims)
4. **Status bar style:** Dark content
5. **Signing:** Select your Apple Developer team

## Pre-Submission Checklist

- [ ] Apple Developer Program enrolled ($99/year)
- [ ] Small Business Program enrolled (15% commission rate)
- [ ] Firebase on Blaze plan
- [ ] Privacy policy published at support URL
- [ ] Support page published at support URL
- [ ] `npm run build` produces clean dist/ with no errors
- [ ] `npx cap run ios` builds and runs without errors
- [ ] Background audio plays correctly in WKWebView on first tap
- [ ] All touch targets are minimum 44x44px
- [ ] Language picker works in-app (no URL parameters)
- [ ] Referral codes captured at signup
- [ ] Promo codes stored in Firestore and working end-to-end
- [ ] Freemium gate shows correctly on premium units
- [ ] Admin dashboard accessible and showing real user data
- [ ] All analytics events logging to console
- [ ] App icon (1024x1024) created for App Store

## Firestore Setup Required

Before launch, create these documents in Firestore:

### `/config/promoCodes`
```json
{
  "codes": [
    { "code": "LAUNCH50", "active": true, "description": "Launch offer" },
    { "code": "INFLUENCER", "active": true, "description": "Influencer access" },
    { "code": "FAITH2025", "active": true, "description": "Admin access" }
  ]
}
```

### `/config/admin`
```json
{
  "password": "your-secure-admin-password"
}
```

## Post-Launch Priorities

1. Wire RevenueCat for real payment processing
2. Android / Google Play build
3. PostHog analytics integration (replace console.log)
4. Server-side premium verification
5. Push notifications
6. New language packs (Japanese, Korean, Thai)
