import { afterEach, vi } from "vitest";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

afterEach(() => {
  vi.restoreAllMocks();
});
