// Public facade for the React SSR implementation.
//
// Re-exports `renderPortalSSR` from server-impl so callers can `await import("./server")`
// without dragging the .tsx implementation through tsc's JSX resolver in non-JSX files.
// This file stays a plain .ts so it's safe to import from anywhere in the worker.
export { renderPortalSSR } from "./server-impl";
