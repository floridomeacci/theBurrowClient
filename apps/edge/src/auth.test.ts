import { describe, expect, it } from "vitest";
import {
  SITE_SESSION_COOKIE,
  createSitePasswordHash,
  issueSiteSession,
  readCookie,
  verifySitePassword,
  verifySiteSession
} from "./auth";

describe("site access authentication", () => {
  it("verifies only the configured password", async () => {
    const hash = await createSitePasswordHash("correct-horse-battery", undefined, new Uint8Array(16).fill(7));
    expect(hash).toMatch(/^v1\$100000\$/);
    await expect(verifySitePassword("correct-horse-battery", hash)).resolves.toBe(true);
    await expect(verifySitePassword("incorrect-password", hash)).resolves.toBe(false);
    await expect(verifySitePassword("correct-horse-battery", "invalid")).resolves.toBe(false);
  });

  it("issues signed sessions and rejects tampering or expiration", async () => {
    const secret = "test-session-secret-with-at-least-32-characters";
    const issuedAt = Date.UTC(2026, 7, 13);
    const token = await issueSiteSession(secret, issuedAt, 60);
    await expect(verifySiteSession(token, secret, issuedAt + 30_000)).resolves.not.toBeNull();
    await expect(verifySiteSession(`${token}x`, secret, issuedAt + 30_000)).resolves.toBeNull();
    await expect(verifySiteSession(token, secret, issuedAt + 61_000)).resolves.toBeNull();
  });

  it("reads the host-only session cookie", () => {
    const request = new Request("https://example.test", {
      headers: { cookie: `theme=dark; ${SITE_SESSION_COOKIE}=signed-value; other=1` }
    });
    expect(readCookie(request, SITE_SESSION_COOKIE)).toBe("signed-value");
  });
});
