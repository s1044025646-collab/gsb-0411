export interface Token {
  id: number;
  form: string;
  lemma: string;
  upos: string;
  xpos: string;
  feats: string;
  head: number;
  deprel: string;
  deps: string;
  misc: string;
  raw: string;
}

export interface Sentence {
  index: number;
  comments: string[];
  tokens: Token[];
  raw: string;
}

export type ErrorCode =
  | "FIELD_COUNT"
  | "MULTIWORD_ID"
  | "EMPTY_NODE_ID"
  | "BAD_ID"
  | "NON_CONTIGUOUS_IDS"
  | "BAD_HEAD"
  | "HEAD_OUT_OF_RANGE"
  | "ROOT_COUNT"
  | "ROOT_RELATION"
  | "SELF_LOOP"
  | "CYCLE"
  | "DISCONNECTED"
  | "EMPTY_SENTENCE"
  | "TOO_MANY_SENTENCES"
  | "TOO_MANY_TOKENS"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "INVALID_SENTENCE";

export class ConlluError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ConlluError";
  }
}

export interface Diagnostic {
  code: ErrorCode;
  message: string;
  sentence: number;
  tokenId?: number;
  chain?: number[];
}

export type SentenceStatus = "invalid" | "projective" | "nonprojective";

export interface SubtreeViolation {
  nodeId: number;
  min: number;
  max: number;
  descendants: number[];
  gaps: number[];
  parentChain: number[];
}

export interface ProjectivityReport {
  projective: boolean;
  violations: SubtreeViolation[];
}
