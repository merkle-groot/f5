/**
 * Load-shedding middleware: an in-flight concurrency ceiling and a per-IP rate
 * limit. Both are pure functions over Express-shaped req/res, so they are tested
 * with hand-built mocks (no supertest), matching the handler specs in this suite.
 */
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { inFlightLimit, rateLimitPerIp } from "../../src/middlewares/throttle.js";

/** A minimal Express `Response` mock that records status/json and fires lifecycle events. */
function mockRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); return this; },
    emit(event: string) { (listeners[event] ?? []).forEach((cb) => cb()); },
  };
  return res as unknown as Response & { emit(e: string): void; statusCode?: number; body: unknown; headers: Record<string, string> };
}

describe("inFlightLimit", () => {
  it("admits up to the cap and rejects the overflow with 503", () => {
    const mw = inFlightLimit(2);
    const next = vi.fn() as unknown as NextFunction;

    const r1 = mockRes(); mw({} as Request, r1, next);
    const r2 = mockRes(); mw({} as Request, r2, next);
    const r3 = mockRes(); mw({} as Request, r3, next);

    expect(next).toHaveBeenCalledTimes(2); // r1, r2 admitted
    expect(r3.statusCode).toBe(503);
    expect(r3.headers["Retry-After"]).toBe("1");
  });

  it("frees a slot when a request finishes", () => {
    const mw = inFlightLimit(1);
    const next = vi.fn() as unknown as NextFunction;

    const r1 = mockRes(); mw({} as Request, r1, next);
    const r2 = mockRes(); mw({} as Request, r2, next);
    expect(r2.statusCode).toBe(503); // full

    r1.emit("finish"); // r1 done
    const r3 = mockRes(); mw({} as Request, r3, next);
    expect(r3.statusCode).toBeUndefined(); // admitted now
    expect(next).toHaveBeenCalledTimes(2); // r1, then r3
  });

  it("releases a slot only once even if finish and close both fire", () => {
    const mw = inFlightLimit(1);
    const next = vi.fn() as unknown as NextFunction;

    const r1 = mockRes(); mw({} as Request, r1, next);
    r1.emit("finish");
    r1.emit("close"); // must NOT double-decrement below zero

    const r2 = mockRes(); mw({} as Request, r2, next);
    const r3 = mockRes(); mw({} as Request, r3, next);
    expect(r2.statusCode).toBeUndefined(); // one free slot
    expect(r3.statusCode).toBe(503);       // and only one
  });
});

describe("rateLimitPerIp", () => {
  it("allows up to max per window then 429s the same IP", () => {
    const mw = rateLimitPerIp(60_000, 2);
    const next = vi.fn() as unknown as NextFunction;
    const req = { ip: "1.2.3.4" } as Request;

    const a = mockRes(); mw(req, a, next);
    const b = mockRes(); mw(req, b, next);
    const c = mockRes(); mw(req, c, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(c.statusCode).toBe(429);
    expect(c.headers["Retry-After"]).toBeDefined();
  });

  it("keeps separate budgets per IP", () => {
    const mw = rateLimitPerIp(60_000, 1);
    const next = vi.fn() as unknown as NextFunction;

    const a = mockRes(); mw({ ip: "1.1.1.1" } as Request, a, next);
    const b = mockRes(); mw({ ip: "2.2.2.2" } as Request, b, next);
    expect(a.statusCode).toBeUndefined();
    expect(b.statusCode).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("resets the budget after the window elapses", () => {
    vi.useFakeTimers();
    try {
      const mw = rateLimitPerIp(1_000, 1);
      const next = vi.fn() as unknown as NextFunction;
      const req = { ip: "9.9.9.9" } as Request;

      const a = mockRes(); mw(req, a, next);
      const b = mockRes(); mw(req, b, next);
      expect(b.statusCode).toBe(429);

      vi.advanceTimersByTime(1_001);
      const c = mockRes(); mw(req, c, next);
      expect(c.statusCode).toBeUndefined(); // new window
    } finally {
      vi.useRealTimers();
    }
  });
});
