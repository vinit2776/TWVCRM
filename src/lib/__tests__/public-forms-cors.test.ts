import { describe, it, expect } from "vitest";
import { allowedOrigin, withCors } from "@/lib/public-forms/cors";

describe("public enquiry CORS", () => {
  it("allows the website origins and nothing else", () => {
    expect(allowedOrigin("https://www.theworkvilla.com")).toBe("https://www.theworkvilla.com");
    expect(allowedOrigin("https://theworkvilla.com")).toBe("https://theworkvilla.com");
    expect(allowedOrigin("https://theworkvilla.vercel.app")).toBe("https://theworkvilla.vercel.app");
    expect(allowedOrigin("https://evil.example")).toBeNull();
    expect(allowedOrigin("https://www.theworkvilla.com.evil.example")).toBeNull();
    expect(allowedOrigin(null)).toBeNull();
  });

  it("sets the full header set for an allowed origin", () => {
    const res = withCors(new Response(null, { status: 204 }), "https://www.theworkvilla.com");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.theworkvilla.com");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("sends no Allow-Origin to other origins but still varies on Origin", () => {
    const res = withCors(new Response(null), "https://evil.example");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
  });
});
