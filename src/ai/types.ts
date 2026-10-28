export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Ephemeral provider replay only; never written to channel history. */
  reasoning_content?: string;
  /** Ephemeral visual input only; never persisted in channel history. */
  images?: string[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Model {
  id: string;
  name: string;
  kind: 'chat' | 'image';
  contextLength: number;
  locked: boolean;
  /** True only when the current provider catalog explicitly confirms vision. */
  vision?: boolean;
}

export interface Completion {
  text: string;
  model: string;
  inputTokens: number;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
}

/** Deliberately value-safe: never include an upstream body, prompt, or key. */
export class AIError extends Error {
  override name = 'AIError';
}

export function bedtime(error: unknown): string {
  const reason =
    error instanceof AIError ? error.message : 'AI service unavailable';
  return `I'm tired and went to bed. I can't reply right now.\n-# ${reason}`;
}
