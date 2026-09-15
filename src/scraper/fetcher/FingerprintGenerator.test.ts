import { HeaderGenerator, type HeaderGeneratorOptions } from "header-generator";
import { describe, expect, it, vi } from "vitest";
import { FingerprintGenerator } from "./FingerprintGenerator";

vi.mock("header-generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("header-generator")>();
  return {
    ...actual,
    // A `function` (not an arrow) so `new` works on the spy.
    HeaderGenerator: vi.fn(function (
      this: unknown,
      options?: Partial<HeaderGeneratorOptions>,
    ) {
      return new actual.HeaderGenerator(options);
    }),
  };
});

const MOBILE_UA = /Mobile|Android|iPhone|iPad|iPod/i;

describe("FingerprintGenerator", () => {
  it("should be instantiated without options", () => {
    const generator = new FingerprintGenerator();
    expect(generator).toBeInstanceOf(FingerprintGenerator);
  });

  it("should be instantiated with options", () => {
    const options: Partial<HeaderGeneratorOptions> = {
      browsers: ["firefox"],
    };
    const generator = new FingerprintGenerator(options);
    expect(generator).toBeInstanceOf(FingerprintGenerator);
  });

  it("should generate headers", () => {
    const generator = new FingerprintGenerator();
    const headers = generator.generateHeaders();
    expect(headers).toBeDefined();
    expect(typeof headers).toBe("object");
    expect(Object.keys(headers).length).toBeGreaterThan(0);
    expect(headers["user-agent"]).toBeDefined();
    expect(headers.accept).toBeDefined();
    expect(headers["accept-language"]).toBeDefined();
  });

  describe("desktop-only defaults (2026-09-15)", () => {
    // A randomly drawn mobile fingerprint made Salesforce Experience Cloud
    // serve a `formFactor: SMALL` bootstrap that never rendered in headless
    // desktop Chromium, so the raw shell became the captured note (evidence
    // note "DOM settle step 0 trace"). The constructor constraints are the
    // deterministic contract; the sampled user agents are the behavioral one.
    it("constrains HeaderGenerator to desktop devices and desktop operating systems", () => {
      vi.mocked(HeaderGenerator).mockClear();
      new FingerprintGenerator();
      const [options] = vi.mocked(HeaderGenerator).mock.calls[0];
      expect(options?.devices).toEqual(["desktop"]);
      expect(options?.operatingSystems).toEqual(
        expect.arrayContaining(["windows", "linux", "macos"]),
      );
      expect(options?.operatingSystems).not.toContain("android");
      expect(options?.operatingSystems).not.toContain("ios");
    });

    it("keeps explicit caller overrides", () => {
      vi.mocked(HeaderGenerator).mockClear();
      new FingerprintGenerator({ devices: ["mobile"], operatingSystems: ["android"] });
      const [options] = vi.mocked(HeaderGenerator).mock.calls[0];
      expect(options?.devices).toEqual(["mobile"]);
      expect(options?.operatingSystems).toEqual(["android"]);
    });

    it("never draws a mobile user agent by default", () => {
      const generator = new FingerprintGenerator();
      for (let i = 0; i < 100; i += 1) {
        expect(generator.generateHeaders()["user-agent"]).not.toMatch(MOBILE_UA);
      }
    });

    it("negative control: a mobile override does draw mobile user agents", () => {
      const generator = new FingerprintGenerator({
        devices: ["mobile"],
        operatingSystems: ["android", "ios"],
      });
      const agents = Array.from(
        { length: 20 },
        () => generator.generateHeaders()["user-agent"],
      );
      expect(agents.some((ua) => MOBILE_UA.test(ua))).toBe(true);
    });
  });
});
