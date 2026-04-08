import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.shadowspeak.languages',
  appName: 'ShadowSpeak',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
