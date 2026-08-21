// The wire contract: every shape that travels from the server to the browser.
//
// It is a file of its own because the modules that build these shapes import
// node:fs and node:path, and the client bundle must not pull those in — not
// even for types.
export {};
//# sourceMappingURL=payload.js.map