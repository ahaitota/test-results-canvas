// Posts a row reference to the extension, which composes the message and sends
// it into the agent session. The page never sends prompt text -- see src/ask.ts.
// Same channel, and the same token, for the shell actions in revealReport().
const ASK_TOKEN = (window as unknown as { __ASK_TOKEN__?: string }).__ASK_TOKEN__ || "";

// `index` is the row's position in the payload the server broadcast, which
// survives filtering and sorting; `name` lets the server reject a click that
// raced a refresh.
export async function askAgent(index: number, name: string): Promise<boolean> {
  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ASK_TOKEN}` },
      body: JSON.stringify({ index, name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The coverage equivalent. The page names a scope -- and, for "file", a path
// that must already appear in the server's own report -- and the server
// composes the prompt from its own data. Same token, same rule as above.
export type CoverageAskScope = "file" | "patch" | "enable";

export async function askAgentCoverage(scope: CoverageAskScope, path?: string): Promise<boolean> {
  try {
    const res = await fetch("/ask-coverage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ASK_TOKEN}` },
      body: JSON.stringify(path ? { scope, path } : { scope }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Diff mode: "which tests does this change affect?". The page sends no
// argument at all -- the server has the diff -- so this is the narrowest of
// the three.
export async function askAgentImpact(): Promise<boolean> {
  try {
    const res = await fetch("/ask-impact", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ASK_TOKEN}` },
      body: "{}",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Hands the run to the desktop shell. The page names only the action; the server
// acts on the files it already holds. Resolves to null on success, or to the
// reason to show the user -- a launch that fails must not look like one that
// worked.
export type RevealMode = "reveal" | "open";

export async function revealReport(mode: RevealMode): Promise<string | null> {
  try {
    const res = await fetch("/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ASK_TOKEN}` },
      body: JSON.stringify({ mode }),
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : "could not open the report";
  } catch {
    return "could not reach the panel";
  }
}
