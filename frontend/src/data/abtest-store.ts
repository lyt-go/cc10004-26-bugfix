import { SEED_AB_PLANS, SEED_EXPERIMENT_HITS, SEED_LIFECYCLE_MODELS } from './abtest-seed'
import type { AbPlan, ExperimentHit, LifecycleModel } from './abtest-types'

// 实验域独立持久化键，与通用 CRUD 的 data-product-ops:entries 互不影响。
const STORAGE_KEY = 'data-product-ops:abtest-domain:v1'

export type ExperimentDomain = {
  plans: AbPlan[]
  lifecycles: LifecycleModel[]
  hits: ExperimentHit[]
  /** 命中记录自增主键。 */
  hitSeq: number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function seedDomain(): ExperimentDomain {
  return {
    plans: clone(SEED_AB_PLANS),
    lifecycles: clone(SEED_LIFECYCLE_MODELS),
    hits: clone(SEED_EXPERIMENT_HITS),
    hitSeq: 0,
  }
}

function readStorage(): ExperimentDomain {
  const fallback = seedDomain()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ExperimentDomain>
    // 与种子做一次合并，避免老缓存缺字段时跑出 undefined。
    return {
      plans: parsed.plans ?? fallback.plans,
      lifecycles: parsed.lifecycles ?? fallback.lifecycles,
      hits: parsed.hits ?? fallback.hits,
      hitSeq: typeof parsed.hitSeq === 'number' ? parsed.hitSeq : fallback.hitSeq,
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: ExperimentDomain | null = null

export function domainState(): ExperimentDomain {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 整块写入：状态推进、下线联动、阶段推进与分组退出都在同一次提交里落盘。 */
export function saveDomain(next: ExperimentDomain): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetDomain(): ExperimentDomain {
  const fresh = seedDomain()
  saveDomain(fresh)
  return fresh
}

export function domainStorageKey(): string {
  return STORAGE_KEY
}
