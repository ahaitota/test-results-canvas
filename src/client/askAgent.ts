// Posts a row reference to the extension, which composes the message and sends
// it into the agent session. The page never sends prompt text -- see src/ask.ts.
const ASK_TOKEN = (window as unknown as { __ASK_TOKEN__?: string }).__ASK_TOKEN__ || "";

// `index` is the row's position in the payload the server broadcast, which
// survives filtering and sorting; `name` lets the server reject a click that
// raced a refresh.
export async function askAgent(index: number, name: string): Promise<boolean> {
  try {
    const res = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ASK_TOKEN, index, name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
