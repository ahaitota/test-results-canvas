// The coverage wire contract: every shape that crosses from the server to the
// browser. It is separate because the modules that produce these shapes import
// node:fs and node:path, which the client bundle must not pull in even for types.
export {};
//# sourceMappingURL=payload.js.map