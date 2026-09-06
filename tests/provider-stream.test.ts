import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureRegisteredProviderStreams,
  createBridgeStreamFn,
  createProviderFetch,
} from "../src/om/provider-stream.js";

const dispatcherSymbol = Symbol.for("undici.globalDispatcher.2");
const originalDispatcher = (globalThis as any)[dispatcherSymbol];

describe("custom provider stream bridge", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-blackhole:provider-streams")];
    vi.unstubAllGlobals();
    if (originalDispatcher === undefined) {
      delete (globalThis as any)[dispatcherSymbol];
    } else {
      (globalThis as any)[dispatcherSymbol] = originalDispatcher;
    }
  });

  it("discovers custom streams through the public model registry API", () => {
    const customStream = vi.fn();
    const registry = {
      getRegisteredProviderIds: () => ["custom-provider"],
      getRegisteredProviderConfig: (providerId: string) =>
        providerId === "custom-provider"
          ? { api: "custom-api", streamSimple: customStream }
          : undefined,
    };
    const providerStreams = new Map<string, Function>();

    captureRegisteredProviderStreams(registry as any, providerStreams);

    expect(providerStreams.get("custom-api")).toBe(customStream);
  });

  it("uses the discovered stream for a custom API", () => {
    const fallbackStream = vi.fn();
    const customStream = vi.fn(() => "custom-result");
    const key = Symbol.for("pi-blackhole:provider-streams");
    (globalThis as any)[key] = new Map([["custom-api", customStream]]);
    const bridge = createBridgeStreamFn(fallbackStream);

    expect(bridge({ api: "custom-api" }, "context", {})).toBe("custom-result");
    expect(customStream).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("returns undefined when no timeout is configured (inherit pi default)", async () => {
    const fetchFn = createProviderFetch();
    expect(fetchFn).toBeUndefined();
  });

  it("returns undefined for timeout 0 (explicitly disabled)", async () => {
    const fetchFn = createProviderFetch(0);
    expect(fetchFn).toBeUndefined();
  });

  it("wraps fetch with an explicit positive timeout", async () => {
    const dispatch = vi.fn(() => true);
    (globalThis as any)[dispatcherSymbol] = { dispatch };
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal("fetch", fetchMock);

    const wrapped = createProviderFetch(120_000)!;
    await wrapped("https://example.com");
    const requestDispatcher = fetchMock.mock.calls[0]?.[1]?.dispatcher;
    requestDispatcher.dispatch({ path: "/explicit" }, "handler");

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      { path: "/explicit", bodyTimeout: 120_000 },
      "handler",
    );
    expect((globalThis as any)[dispatcherSymbol]).toEqual({ dispatch });
  });

  it("chains through a caller-provided dispatcher instead of overwriting it", async () => {
    const outerDispatch = vi.fn(() => true);
    const innerDispatch = vi.fn(() => true);
    const callerDispatcher = { dispatch: outerDispatch };
    (globalThis as any)[dispatcherSymbol] = { dispatch: innerDispatch };
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal("fetch", fetchMock);

    const wrapped = createProviderFetch(120_000)!;
    await wrapped("https://example.com", { dispatcher: callerDispatcher });
    const requestDispatcher = fetchMock.mock.calls[0]?.[1]?.dispatcher;
    requestDispatcher.dispatch({ path: "/chained" }, "handler");

    // Caller's dispatcher is used; our timeout is injected into its options.
    expect(outerDispatch).toHaveBeenCalledOnce();
    expect(outerDispatch).toHaveBeenNthCalledWith(
      1,
      { path: "/chained", bodyTimeout: 120_000 },
      "handler",
    );
    expect(innerDispatch).not.toHaveBeenCalled();
  });
});
