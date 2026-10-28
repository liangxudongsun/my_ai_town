import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../town-manager.mjs'
import { worldQuery } from '../towns/hosts.mjs'
import { APPEARANCE_SET } from '../mapgen/budget.mjs'

test('one world commits dynamic book geometry and removals together across restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-space-runtime-'))
  let m
  try {
    const started = await startTown(root, [
      { kind: 'library', count: 1, size: 'large' },
      { kind: 'home', count: 2, size: 'small' },
    ])
    m = started.m
    let town = started.town
    const query = (command, type) => worldQuery(town.endpoint, command, (m) => m.type === type)
    const content = (id, locale) =>
      query(
        {
          type: 'content',
          request_id: id,
          world_id: town.worldId,
          command: {
            operation: 'create',
            id,
            locale,
            title: '空间中的书',
            author: '验收',
            text: '这段文字由读者自行决定记住什么。',
          },
        },
        'prop_result'
      )
    const created = await content('user:spatial-book', 'library_1')
    assert.ok(created.ok, JSON.stringify(created))
    let catalog = (await query({ type: 'get_props' }, 'props')).catalog
    const spatial = catalog.spatial,
      placed = spatial.overrides.find((v) => v.prop.id === 'user:spatial-book')
    assert.ok(placed)
    assert.ok(catalog.instances.some((p) => p.id === 'user:spatial-book'))
    assert.equal(placed.route.to, 'node_user:spatial-book')
    assert.ok(placed.route.length > 0)
    assert.equal((await content('user:invalid', 'missing-place')).ok, false)
    catalog = (await query({ type: 'get_props' }, 'props')).catalog
    assert.equal(catalog.spatial.overrides.length, 1)
    assert.ok(!catalog.instances.some((p) => p.id === 'user:invalid'))
    await m.hosts.close(town.id)
    town = await m.hosts.open(town.id)
    assert.deepEqual((await query({ type: 'get_props' }, 'props')).catalog.spatial, spatial)
    const removed = await query(
      {
        type: 'remove_prop',
        request_id: 'remove',
        world_id: town.worldId,
        id: 'user:spatial-book',
      },
      'prop_result'
    )
    assert.ok(removed.ok, JSON.stringify(removed))
    const after = (await query({ type: 'get_props' }, 'props')).catalog
    assert.ok(!after.instances.some((p) => p.id === 'user:spatial-book'))
    assert.ok(after.spatial.removed.includes('user:spatial-book'))
    assert.ok(after.spatial.revision > spatial.revision)
    await m.hosts.close(town.id)
    town = await m.hosts.open(town.id)
    assert.deepEqual((await query({ type: 'get_props' }, 'props')).catalog.spatial, after.spatial)
    assert.ok(
      !(await query({ type: 'get_props' }, 'props')).catalog.instances.some(
        (p) => p.id === 'user:spatial-book'
      )
    )
    await query({ type: 'reset_world', request_id: 'reset-world' }, 'world_reset')
    const reset = (await query({ type: 'get_props' }, 'props')).catalog
    assert.deepEqual(reset.spatial.overrides, [])
    assert.deepEqual(reset.spatial.removed, [])
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

/** 起管理服务，用生成器建一座海边小镇并打开，设好世界观 */
async function startTown(root, places) {
  const m = await createManager({ root, port: 0, mockLlm: true })
  const api = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${m.server.address().port}/api/towns${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-town-client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const v = await r.json()
    assert.ok(r.ok, JSON.stringify(v))
    return v
  }
  const spec = {
    schema_version: 2,
    name: '空间持久化',
    seed: 42,
    appearance_set: APPEARANCE_SET,
    environment: { preset: 'coastal-village', vegetation: 'medium' },
    places,
    resources: 'normal-life',
    constraints: [],
  }
  const draft = await api('/preview', { spec }),
    saved = await api('/save', {
      draft_id: draft.id,
      expected_version: draft.version,
      request_id: 'space-save',
    })
  const town = await api(`/${saved.id}/open`, {})
  const query = (command, type) => worldQuery(town.endpoint, command, (m) => m.type === type)
  const state = (await query({ type: 'get_world_settings' }, 'world_settings')).state
  assert.ok(
    (
      await query(
        {
          type: 'set_worldview',
          request_id: 'setup',
          world_id: state.world_id,
          expected_revision: state.revision,
          text: '一处供居民生活和阅读的海岸村落。',
        },
        'world_settings_saved'
      )
    ).ok
  )
  return { m, town, map: path.join(root, 'towns', saved.id, 'map.json') }
}

test('placing a prop where the player clicked puts it beside that spot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-space-near-'))
  let m
  try {
    const started = await startTown(root, [{ kind: 'plaza', count: 1, size: 'large' }])
    m = started.m
    const { town } = started
    const query = (command, type) => worldQuery(town.endpoint, command, (m) => m.type === type)
    // 先点右头再点左头，两件各自更靠近自己点的那头。
    // 不看点的位置时放置器从区域一角按行扫，先放的在左、后放的在右，正好相反
    const map = JSON.parse(await fs.readFile(started.map, 'utf8'))
    const { bounds } = map.spatial.floors.find((f) => f.id === 'plaza_1')
    const ends = [
      [bounds.x + bounds.w - 1, bounds.y + bounds.h / 2],
      [bounds.x + 1, bounds.y + bounds.h / 2],
    ]
    for (const [i, near] of ends.entries()) {
      const placed = await query(
        {
          type: 'place_prop',
          request_id: `near-${i}`,
          world_id: town.worldId,
          instance: { id: `user:near-${i}`, definition: 'core:workbench@1', locale: 'plaza_1' },
          near: { space: 'town_outdoor', position: near },
        },
        'prop_result'
      )
      assert.ok(placed.ok, JSON.stringify(placed))
    }
    // 道具列表带上放好的位置，地图才画得出来
    const { instances } = (await query({ type: 'get_props' }, 'props')).catalog
    const away = (i, end) => {
      const [x, , z] = instances.find((p) => p.id === `user:near-${i}`).position
      return Math.hypot(x - ends[end][0], z - ends[end][1])
    }
    assert.ok(away(0, 0) < away(1, 0) && away(1, 1) < away(0, 1))
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
