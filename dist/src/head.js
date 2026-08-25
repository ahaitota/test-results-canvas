// Sizing up a file only needs its opening. A scan looks at every candidate in a
// folder, and both results files and coverage reports run to tens of megabytes,
// so this reads through a descriptor rather than pulling in and decoding the
// whole file to look at the first few lines of it.
import { openSync, readSync, closeSync } from "node:fs";
export const HEAD_BYTES = 8192;
export function readHead(abs) {
    const fd = openSync(abs, "r");
    try {
        const buf = Buffer.allocUnsafe(HEAD_BYTES);
        const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
        return buf.subarray(0, n).toString("utf8");
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=head.js.map