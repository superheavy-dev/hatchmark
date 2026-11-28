export interface Profile {
  name: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
  cpuThrottle: number;
  network: { latencyMs: number; downloadKbps: number; uploadKbps: number } | null;
}

export const PROFILES: Record<string, Profile> = {
  phone: {
    name: "phone",
    viewport: { width: 412, height: 2400 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    cpuThrottle: 4,
    network: { latencyMs: 150, downloadKbps: 1638.4, uploadKbps: 750 },
  },
  desktop: {
    name: "desktop",
    viewport: { width: 1440, height: 2400 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    cpuThrottle: 1,
    network: null,
  },
};
