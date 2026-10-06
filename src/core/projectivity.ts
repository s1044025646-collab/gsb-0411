import { parentChain } from "./conllu";
import { ProjectivityReport, SubtreeViolation, Token } from "./types";

/** 返回每个节点的后代集合（含自身），键为 token ID。 */
export function descendantsMap(tokens: Token[]): Map<number, Set<number>> {
  const children = new Map<number, number[]>();
  for (const t of tokens) {
    if (t.head !== 0) {
      const list = children.get(t.head) ?? [];
      list.push(t.id);
      children.set(t.head, list);
    }
  }
  const result = new Map<number, Set<number>>();
  const collect = (id: number, acc: Set<number>) => {
    acc.add(id);
    for (const c of children.get(id) ?? []) collect(c, acc);
  };
  for (const t of tokens) {
    const acc = new Set<number>();
    collect(t.id, acc);
    result.set(t.id, acc);
  }
  return result;
}

/**
 * 投射性核验（仅在结构合法的树上调用）。
 * 位置按 token ID 决定；对每个节点检查其子树位置集合是否构成连续区间。
 */
export function checkProjectivity(tokens: Token[]): ProjectivityReport {
  const desc = descendantsMap(tokens);
  const violations: SubtreeViolation[] = [];
  for (const t of tokens) {
    const set = desc.get(t.id)!;
    const positions = [...set].sort((a, b) => a - b);
    const min = positions[0];
    const max = positions[positions.length - 1];
    if (max - min + 1 === set.size) continue; // 连续区间
    const gaps: number[] = [];
    for (let p = min; p <= max; p++) {
      if (!set.has(p)) gaps.push(p);
    }
    violations.push({
      nodeId: t.id,
      min,
      max,
      descendants: positions,
      gaps,
      parentChain: parentChain(tokens, t.id),
    });
  }
  violations.sort((a, b) => a.nodeId - b.nodeId);
  return { projective: violations.length === 0, violations };
}

/** 子树解释：后代、区间、缺口、父链。 */
export function explainSubtree(tokens: Token[], nodeId: number) {
  const desc = descendantsMap(tokens);
  const set = desc.get(nodeId);
  if (!set) return null;
  const positions = [...set].sort((a, b) => a - b);
  const min = positions[0];
  const max = positions[positions.length - 1];
  const gaps: number[] = [];
  for (let p = min; p <= max; p++) if (!set.has(p)) gaps.push(p);
  return {
    nodeId,
    min,
    max,
    descendants: positions,
    contiguous: gaps.length === 0,
    gaps,
    parentChain: parentChain(tokens, nodeId),
  };
}
