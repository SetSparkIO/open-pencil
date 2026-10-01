import {
  cloneInstanceOverrideState,
  hasInstanceOverride,
  INSTANCE_SYNC_FIELDS,
  setInstanceOverride,
  type SceneNode
} from '@open-pencil/scene-graph'

import { applyOverridePatch } from '../patches'
import { resolveOverrideTarget } from '../resolve'
import type { OverrideContext } from '../types'
import { patchFromSymbolOverride } from './patches'

/**
 * Strips fields from a stored-override patch that were since live-edited
 * (recordInstanceOverride) — reapplying the stale stored value on every
 * lazy-population pass would otherwise silently discard the edit.
 */
function dropLiveOverriddenFields(
  ctx: OverrideContext,
  targetId: string,
  patch: ReturnType<typeof patchFromSymbolOverride>
): void {
  if (!patch?.props) return
  const kept = Object.fromEntries(
    Object.entries(patch.props).filter(
      ([field]) => !hasInstanceOverride(ctx.graph, targetId, field)
    )
  )
  patch.props = Object.keys(kept).length > 0 ? (kept as typeof patch.props) : undefined
}

function isActiveInstance(ctx: OverrideContext, nodeId: string | undefined): nodeId is string {
  return nodeId !== undefined && (!ctx.activeNodeIds || ctx.activeNodeIds.has(nodeId))
}

function preserveInstanceRootBounds(
  hasRootSize: boolean,
  instanceId: string,
  targetId: string,
  patch: ReturnType<typeof patchFromSymbolOverride>
): void {
  if (!hasRootSize || targetId !== instanceId || !patch?.props) return
  // Root bounds belong to the instance NodeChange. Figma may repeat the
  // source component size in a root symbol override, but that must not resize
  // the placed instance.
  delete patch.props.width
  delete patch.props.height
}

/**
 * Apply symbolOverrides from kiwi data.
 *
 * Handles instance swaps (overriddenSymbolID) and property overrides
 * (fills, text, visibility, etc.). Returns the set of directly
 * overridden node IDs (used as seeds for transitive sync).
 */
export function applySymbolOverrides(ctx: OverrideContext, propertiesOnly = false): Set<string> {
  const overriddenNodes = new Set<string>()
  ctx.componentIdRoot.clear()

  for (const [ncId, nc] of ctx.changeMap) {
    if (nc.type !== 'INSTANCE') continue
    const overrides = nc.symbolData?.symbolOverrides
    if (!overrides?.length) continue

    const nodeId = ctx.guidToNodeId.get(ncId)
    if (!isActiveInstance(ctx, nodeId)) continue

    for (const ov of overrides) {
      const guids = ov.guidPath?.guids
      if (!guids?.length) continue

      const targetId = resolveOverrideTarget(ctx, nodeId, guids)
      if (!targetId) continue

      if (targetId === nodeId && ctx.kiwiPropertyNodes.has(nodeId)) continue

      const patch = patchFromSymbolOverride(ctx, targetId, ov)
      if (!patch) continue
      dropLiveOverriddenFields(ctx, targetId, patch)
      preserveInstanceRootBounds(nc.size !== undefined, nodeId, targetId, patch)
      if (propertiesOnly) patch.swapComponentId = undefined
      if (!patch.swapComponentId && !patch.props) continue
      overriddenNodes.add(targetId)
      applyOverridePatch(ctx, patch)
      rememberAppliedFields(ctx, targetId, patch)
    }
  }
  return overriddenNodes
}

const SYNC_FIELDS: ReadonlySet<string> = new Set(INSTANCE_SYNC_FIELDS)

function rememberAppliedFields(
  ctx: OverrideContext,
  targetId: string,
  patch: NonNullable<ReturnType<typeof patchFromSymbolOverride>>
): void {
  if (!patch.props) return
  const fields = Object.keys(patch.props).filter((field) => SYNC_FIELDS.has(field))
  if (fields.length === 0) return
  let applied = ctx.appliedOverrideFields.get(targetId)
  if (!applied) {
    applied = new Set()
    ctx.appliedOverrideFields.set(targetId, applied)
  }
  for (const field of fields) applied.add(field)
}

function nearestInstance(ctx: OverrideContext, nodeId: string): SceneNode | undefined {
  let current = ctx.graph.getNode(nodeId)
  while (current) {
    if (current.type === 'INSTANCE') return current
    current = current.parentId ? ctx.graph.getNode(current.parentId) : undefined
  }
  return undefined
}

/**
 * Records every field a stored symbol override set as an instance override,
 * the same way a live edit does (recordInstanceOverride: keyed on the nearest
 * INSTANCE ancestor). Without this, the first component sync in a live editor
 * treats imported override values as inherited and copies the main
 * component's values over them. Runs once, after the last override pass, so
 * dropLiveOverriddenFields still lets this pass's replay re-apply values.
 */
export function recordAppliedSymbolOverrides(ctx: OverrideContext): void {
  const pending = new Map<SceneNode, [string, Set<string>][]>()
  for (const [targetId, fields] of ctx.appliedOverrideFields) {
    const instance = nearestInstance(ctx, targetId)
    if (!instance) continue
    const entries = pending.get(instance) ?? []
    entries.push([targetId, fields])
    pending.set(instance, entries)
  }

  for (const [instance, entries] of pending) {
    // A fresh state object, so population deltas see the change.
    const instanceOverrides = cloneInstanceOverrideState(instance.instanceOverrides)
    let changed = false
    for (const [targetId, fields] of entries) {
      for (const field of fields) {
        if (hasInstanceOverride(ctx.graph, targetId, field)) continue
        setInstanceOverride(instanceOverrides, instance.id, targetId, field)
        changed = true
      }
    }
    if (!changed) continue
    ctx.graph.preserveSourceMetadataDuring(() =>
      ctx.graph.updateNode(instance.id, { instanceOverrides })
    )
  }
  ctx.appliedOverrideFields.clear()
}
