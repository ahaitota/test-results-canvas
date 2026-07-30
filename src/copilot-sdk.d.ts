// Ambient types for the Copilot extension SDK. The real module is provided by
// the Copilot app host at runtime (it is not an installed dependency), so we
// declare just the surface this extension uses. Kept intentionally loose.

declare module "@github/copilot-sdk/extension" {
  export interface CanvasContext<Input = any> {
    instanceId: string;
    input?: Input;
  }

  export interface CanvasActionResult {
    [key: string]: unknown;
  }

  export interface CanvasAction {
    name: string;
    description?: string;
    inputSchema?: unknown;
    handler: (ctx: CanvasContext) => unknown | Promise<unknown>;
  }

  export interface CanvasConfig {
    id: string;
    displayName?: string;
    description?: string;
    inputSchema?: unknown;
    actions?: CanvasAction[];
    open?: (ctx: CanvasContext) => unknown | Promise<unknown>;
    onClose?: (ctx: CanvasContext) => unknown | Promise<unknown>;
  }

  export interface Canvas {
    readonly id: string;
  }

  export function createCanvas(config: CanvasConfig): Canvas;

  export interface ToolHookInput {
    toolArgs?: unknown;
    workingDirectory?: string;
    [key: string]: unknown;
  }

  export interface SessionConfig {
    canvases?: Canvas[];
    hooks?: {
      onPostToolUse?: (input: ToolHookInput) => unknown | Promise<unknown>;
      onPostToolUseFailure?: (input: ToolHookInput) => unknown | Promise<unknown>;
    };
  }

  export function joinSession(config: SessionConfig): Promise<unknown>;
}
