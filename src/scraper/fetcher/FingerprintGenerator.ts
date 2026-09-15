import { HeaderGenerator, type HeaderGeneratorOptions } from "header-generator";

/**
 * Generates realistic browser-like HTTP headers to help avoid bot detection.
 * Uses the `header-generator` library for header generation.
 */
export class FingerprintGenerator {
  private headerGenerator: HeaderGenerator;

  /**
   * Creates an instance of FingerprintGenerator.
   * @param options Optional configuration for the header generator.
   */
  constructor(options?: Partial<HeaderGeneratorOptions>) {
    // Default options for a broad range of realistic *desktop* headers.
    // Fork change (2026-09-15): mobile devices and OSes are no longer in the
    // pool. Both HttpFetcher and BrowserFetcher draw from this generator, and
    // a randomly drawn mobile user agent made Salesforce Experience Cloud
    // serve a mobile (`formFactor: SMALL`) bootstrap that never rendered in
    // headless desktop Chromium, so the raw shell became the captured page.
    // Callers can still opt into mobile explicitly via `options`.
    const defaultOptions: Partial<HeaderGeneratorOptions> = {
      browsers: [{ name: "chrome", minVersion: 100 }, "firefox", "safari"],
      devices: ["desktop"],
      operatingSystems: ["windows", "linux", "macos"],
      locales: ["en-US", "en"],
      httpVersion: "2",
    };

    // `devices` and `operatingSystems` are a coupled pair in header-generator:
    // `{ devices: ["mobile"] }` combined with the desktop OS default (or an
    // Android/iOS override combined with the desktop device default) has no
    // matching headers and throws. When a caller overrides only one half,
    // widen the paired half back to the full upstream pool so every
    // previously supported single-field override keeps working.
    const merged: Partial<HeaderGeneratorOptions> = { ...defaultOptions, ...options };
    if (options?.devices !== undefined && options.operatingSystems === undefined) {
      merged.operatingSystems = ["windows", "linux", "macos", "android", "ios"];
    }
    if (options?.operatingSystems !== undefined && options.devices === undefined) {
      merged.devices = ["desktop", "mobile"];
    }

    this.headerGenerator = new HeaderGenerator(merged);
  }

  /**
   * Generates a set of realistic HTTP headers.
   * @returns A set of realistic HTTP headers.
   */
  generateHeaders(): Record<string, string> {
    return this.headerGenerator.getHeaders();
  }
}
