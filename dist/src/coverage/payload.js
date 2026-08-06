// The coverage wire contract: every shape that crosses from the server to the
// browser, and nothing else.
//
// It lives in its own module because the client bundle must stay host-free --
// the modules that *produce* these shapes all reach for `node:fs`, `node:path`
// or `child_process`, so the client cannot import from them even for types
// without dragging Node's typings into a config that deliberately has none.
// Declaring the contract once here, and having both sides import it, keeps the
// two ends from drifting apart the way a hand-copied mirror would.
export {};
