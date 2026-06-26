import { app, type Session } from "electron";

export const browserFingerprintPolicyVersion = 1;

export interface BrowserFingerprintIdentity {
  userAgent: string;
  acceptLanguage: string;
  navigatorLanguages: string[];
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>;
    fullVersionList: Array<{ brand: string; version: string }>;
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
}

interface BrowserFingerprintOptions {
  chromeVersion?: string;
  locale?: string;
  preferredLanguages?: string[];
  platform?: NodeJS.Platform;
  arch?: string;
}

export function createBrowserFingerprintIdentity(options: BrowserFingerprintOptions = {}): BrowserFingerprintIdentity {
  const chromeVersion = normalizeChromeVersion(options.chromeVersion ?? process.versions.chrome);
  const chromeMajor = chromeVersion.split(".")[0];
  const locale = normalizeLocale(options.locale ?? app?.getLocale?.() ?? "en-US");
  const preferredLanguages = options.preferredLanguages ?? app?.getPreferredSystemLanguages?.() ?? [];
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformIdentity = resolvePlatformIdentity(platform, arch);
  const brands = [
    { brand: "Not_A Brand", version: "99" },
    { brand: "Chromium", version: chromeMajor }
  ];
  const fullVersionList = [
    { brand: "Not_A Brand", version: "99.0.0.0" },
    { brand: "Chromium", version: chromeVersion }
  ];
  const navigatorLanguages = buildNavigatorLanguages(locale, preferredLanguages);

  return {
    userAgent: `Mozilla/5.0 (${platformIdentity.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    acceptLanguage: buildAcceptLanguage(navigatorLanguages),
    navigatorLanguages,
    userAgentMetadata: {
      brands,
      fullVersionList,
      fullVersion: chromeVersion,
      platform: platformIdentity.clientHintPlatform,
      platformVersion: platformIdentity.platformVersion,
      architecture: platformIdentity.architecture,
      model: "",
      mobile: false,
      bitness: platformIdentity.bitness,
      wow64: false
    }
  };
}

export function configureBrowserSessionFingerprint(session: Session, identity = createBrowserFingerprintIdentity()): BrowserFingerprintIdentity {
  session.setUserAgent(identity.userAgent, identity.acceptLanguage);
  return identity;
}

function normalizeChromeVersion(value: string | undefined): string {
  const match = String(value ?? "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) throw new Error(`Unable to resolve Chromium version from ${JSON.stringify(value)}`);
  return [match[1], match[2] ?? "0", match[3] ?? "0", match[4] ?? "0"].join(".");
}

function normalizeLocale(value: string): string {
  const locale = value.trim().replace("_", "-");
  return locale || "en-US";
}

function buildNavigatorLanguages(locale: string, preferredLanguages: string[]): string[] {
  const values = [locale, ...preferredLanguages.map(normalizeLocale)];
  const base = locale.split("-")[0];
  if (base && base !== locale) values.push(base);
  if (!values.some((value) => value.toLowerCase() === "en-us")) values.push("en-US");
  if (!values.some((value) => value.toLowerCase() === "en")) values.push("en");
  return values.filter((value, index) => values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
}

function buildAcceptLanguage(languages: string[]): string {
  return languages.join(",");
}

function resolvePlatformIdentity(platform: NodeJS.Platform, arch: string): {
  uaPlatform: string;
  clientHintPlatform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
} {
  const architecture = arch === "arm64" ? "arm" : "x86";
  const bitness = arch === "ia32" || arch === "arm" ? "32" : "64";
  if (platform === "darwin") {
    return {
      uaPlatform: "Macintosh; Intel Mac OS X 10_15_7",
      clientHintPlatform: "macOS",
      platformVersion: "10.15.7",
      architecture,
      bitness
    };
  }
  if (platform === "win32") {
    return {
      uaPlatform: "Windows NT 10.0; Win64; x64",
      clientHintPlatform: "Windows",
      platformVersion: "10.0.0",
      architecture,
      bitness
    };
  }
  return {
    uaPlatform: "X11; Linux x86_64",
    clientHintPlatform: "Linux",
    platformVersion: "",
    architecture,
    bitness
  };
}
