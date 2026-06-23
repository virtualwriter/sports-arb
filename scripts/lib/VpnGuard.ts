/**
 * VPN Guard — ensures all traffic routes through the Netherlands.
 *
 * Two layers of protection:
 *   1. Geo-IP check at startup and periodically during operation
 *   2. Application-level SOCKS5 proxy (patches Node.js global agent)
 *
 * If the VPN drops and the IP is no longer in NL, the kill callback fires
 * which should cancel all orders and halt trading.
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import https from "https";
import http from "http";

const ALLOWED_COUNTRIES = new Set(["CH", "DE", "AT", "PT", "SG", "JP", "KR", "HK", "AE", "IE"]);
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  Austria: "AT",
  Germany: "DE",
  Ireland: "IE",
  Japan: "JP",
  Portugal: "PT",
  Singapore: "SG",
  "South Korea": "KR",
  Korea: "KR",
  "Hong Kong": "HK",
  "United Arab Emirates": "AE",
  Switzerland: "CH",
};
const GEO_CHECK_URLS = [
  "https://ipapi.co/json",
  "https://ipwho.is/",
  "https://ipinfo.io/json",
  "https://ifconfig.co/json",
];
const GEO_CHECK_INTERVAL_MS = 60_000;

export interface VpnGuardOptions {
  /** SOCKS5 proxy URL, e.g. socks5://user:pass@nl.socks.nordvpn.com:1080 */
  socksProxy?: string;
  /** Callback when VPN check fails — should trigger kill switch */
  onVpnDrop: (reason: string) => void;
  /** How often to re-check IP (ms). Default 60s. */
  checkIntervalMs?: number;
  /** Skip checks (for local testing). Default false. */
  skipChecks?: boolean;
}

interface GeoResult {
  ip: string;
  country: string;
  city: string;
}

export class VpnGuard {
  private socksProxy?: string;
  private onVpnDrop: (reason: string) => void;
  private checkIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private _verified = false;
  private _proxyActive = false;
  private skipChecks: boolean;

  constructor(options: VpnGuardOptions) {
    this.socksProxy = options.socksProxy;
    this.onVpnDrop = options.onVpnDrop;
    this.checkIntervalMs = options.checkIntervalMs ?? GEO_CHECK_INTERVAL_MS;
    this.skipChecks = options.skipChecks ?? false;
  }

  get isVerified(): boolean {
    return this._verified;
  }

  get isProxyActive(): boolean {
    return this._proxyActive;
  }

  /**
   * Activate the SOCKS5 proxy at the Node.js global agent level.
   * All outgoing HTTP/HTTPS from this process will route through it.
   */
  activateProxy(): void {
    if (!this.socksProxy) {
      console.log(`[VPN] No SOCKS proxy configured — relying on system-wide VPN`);
      return;
    }

    const agent = new SocksProxyAgent(this.socksProxy);

    // Patch global agents so ALL requests (including @polymarket/clob-client's
    // internal axios) route through the SOCKS proxy.
    http.globalAgent = agent as any;
    https.globalAgent = agent as any;

    this._proxyActive = true;
    console.log(`[VPN] SOCKS5 proxy activated: ${this.socksProxy.replace(/\/\/.*@/, "//***@")}`);
  }

  /**
   * Verify current public IP is in the Netherlands.
   * Throws if not in NL.
   */
  async verifyLocation(): Promise<GeoResult> {
    if (this.skipChecks) {
      console.log(`[VPN] Skipping geo check (skipChecks=true)`);
      this._verified = true;
      return { ip: "skip", country: "NL", city: "skip" };
    }

    try {
      const geo = await this.fetchGeo();

      if (!ALLOWED_COUNTRIES.has(geo.country)) {
        const msg = `IP ${geo.ip} is in ${geo.country} — not in allowed list (${[...ALLOWED_COUNTRIES].join(", ")})!`;
        this._verified = false;
        throw new Error(msg);
      }

      this._verified = true;
      console.log(`[VPN] ✓ IP ${geo.ip} — ${geo.city}, ${geo.country}`);
      return geo;
    } catch (err: any) {
      if (err.message?.includes("not NL")) throw err;
      const msg = `Geo-IP check failed: ${err.message}`;
      this._verified = false;
      throw new Error(msg);
    }
  }

  /**
   * Start periodic VPN verification. If it ever fails, fires onVpnDrop.
   */
  startMonitoring(): void {
    if (this.skipChecks) return;

    this.timer = setInterval(async () => {
      try {
        await this.verifyLocation();
      } catch (err: any) {
        console.error(`[VPN] *** VPN CHECK FAILED *** ${err.message}`);
        this.onVpnDrop(err.message);
        this.stopMonitoring();
      }
    }, this.checkIntervalMs);

    console.log(`[VPN] Monitoring active — checking every ${this.checkIntervalMs / 1000}s`);
  }

  stopMonitoring(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async fetchGeo(): Promise<GeoResult> {
    for (const url of GEO_CHECK_URLS) {
      try {
        const result = await this.httpGet(url);
        const json = JSON.parse(result);
        // ipinfo.io uses "country" as ISO, ifconfig.co may return either
        // "country_iso" or a human-readable "country" such as "Japan".
        const rawCountry = json.country_iso ?? json.country_code ?? json.country;
        const country = this.normalizeCountry(rawCountry);
        const ip = json.ip;
        const city = json.city ?? json.region ?? "unknown";
        if (country && ip) return { ip, country, city };
      } catch {
        continue; // try next URL
      }
    }
    throw new Error("All geo-IP services failed");
  }

  private normalizeCountry(country: unknown): string {
    const value = String(country ?? "").trim();
    if (!value) return "";
    const upper = value.toUpperCase();
    if (upper.length === 2) return upper;
    return COUNTRY_NAME_TO_CODE[value] ?? COUNTRY_NAME_TO_CODE[value.replace(/\s+/g, " ")] ?? value;
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 10_000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
  }
}
