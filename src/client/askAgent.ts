// Posts a row reference to the host, which composes the message and sends it
// into the agent session. The page never sends prompt text -- see src/ask.ts.
import { bridge } from "@bridge";

// `index` is the row's position in the payload the host pushed, which survives
// filtering and sorting; `name` lets the host reject a click that raced a
// refresh.
export function askAgent(index: number, name: string): Promise<boolean> {
  return bridge.ask(index, name);
}
