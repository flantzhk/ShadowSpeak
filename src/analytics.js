import { Capacitor } from '@capacitor/core';

let _analyticsClient = null;
const APP_VERSION = "3.9.5";

/**
 * Set an analytics client (e.g. PostHog) for production use.
 * Call setAnalyticsClient(posthog) after PostHog is initialized.
 */
export function setAnalyticsClient(client) {
  _analyticsClient = client;
}

/**
 * Track an analytics event.
 * In dev: console.log. In prod with client set: forwards to PostHog.
 * Auto-attaches uid, language, isPremium, appVersion, platform.
 */
export function trackEvent(eventName, props = {}) {
  const uid = window._ssUser?.uid || null;
  const lang = localStorage.getItem('shadowspeak-lang') || null;
  const isPremium = window._ssIsPremium || false;
  const platform = Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web';

  const fullProps = {
    ...props,
    uid,
    language: lang,
    isPremium,
    appVersion: APP_VERSION,
    platform,
  };

  // Development: console log
  console.log(`[Analytics] ${eventName}`, fullProps);

  // Production: forward to analytics client
  if (_analyticsClient?.capture) {
    _analyticsClient.capture(eventName, fullProps);
  }
}
