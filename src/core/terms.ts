// 固定标识清单：对应规格 §15.2（概念）与 §15.3（动作）。名字一经定下永不改变。

export const CONCEPT_IDS = [
  'tavern', 'host', 'character', 'card', 'user', 'profile', 'world', 'house_rules',
  'core_memory', 'recap', 'transcript', 'narrator', 'extra', 'scenario', 'show', 'scene',
] as const

export const ACTION_IDS = ['init', 'import', 'wrap'] as const

export type ConceptId = (typeof CONCEPT_IDS)[number]
export type ActionId = (typeof ACTION_IDS)[number]
