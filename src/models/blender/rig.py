# Bone chains for the parts that bend (wings, capes, hair), before the FBX is made (export.py).
# The body stays R6 and welded; only these meshes are skinned. Each rig in the plan:
#   { part, mesh: its final name, kind, bones: per chain, smooth: 0.05..1,
#     chains: [{ root: [x, y, z], tip: [x, y, z], mid: the joints between, if moved }] in the viewer's (glTF) space,
#     paint: [{ p: [x, y, z], r, to: 0 anchor | 1 normal | 2 loosen, s: strength }], brush dabs, same space,
#     names: the bone names, chain by chain: "<mesh> A1".."A<n>", "<mesh> B1"..., then "<mesh> Base" if painted }
#
# An armature "<mesh> Rig" gets a chain of bones from each root to its tip, joint to joint (evenly spaced on a
# straight line unless the joints were moved on the page to curve it, a tail say), and the mesh is
# weighted to them by weights_for() below. The Models page works out the same weights with the same
# steps (rigWeights() in models/index.html), so its preview is what Studio gets; change one, change both.
import bpy
from mathutils import Matrix, Vector

TO_GLTF = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
FROM_GLTF = TO_GLTF.inverted()
MAX_INFLUENCES = 4


def chain_points(ch, bones):
    """The chain's joints, root to tip (bones + 1 of them), in the viewer's space."""
    root, tip = Vector(ch['root']), Vector(ch['tip'])
    mid = ch.get('mid')
    if mid and len(mid) == bones - 1:
        return [root, *(Vector(m) for m in mid), tip]
    return [root + (tip - root) * (k / bones) for k in range(bones + 1)]


def give_at(p, paint):
    """How freely a point moves, from the paint: 1 unless painted, toward 0 where anchored, toward 2 where loosened.
    The dabs apply in order, each pulling the give toward its own 'to', most at its centre."""
    g = 1.0
    for d in paint:
        q = (p - d['p']).length_squared / (d['r'] * d['r'])
        if q < 1.0:
            g += (d['to'] - g) * d['s'] * (1.0 - q) * (1.0 - q)
    return g


def weights_for(p, chains, bones, smooth, give=1.0):
    """[(chain, bone, weight)] for a point p, all in the same space; up to 4, adding up to 1.
    chains: each chain's joints, root to tip (chain_points). give (give_at): below 1, that much of the point
    goes to the Base bone instead (chain len(chains), bone 0), which no animation moves; above 1, the point is
    weighted as if it were further down the chain, up to a bone further, so it swings more.

    Along a chain, a point belongs to the bone it's beside (the nearest one), blending into the next one
    around the joint (smooth: 1 blends the whole way between bone middles, small values give hard steps).
    Across chains, a point leans to the nearest chain (inverse square of its distance to the chain)."""
    per = []
    for c, pts in enumerate(chains):
        best, length = None, 0.0
        for k in range(bones):
            a, d = pts[k], pts[k + 1] - pts[k]
            l2 = max(d.length_squared, 1e-12)
            length += l2 ** 0.5
            t = min(1.0, max(0.0, (p - a).dot(d) / l2))
            dist = (p - (a + d * t)).length
            if best is None or dist < best[1]:
                best = (k + t, dist)
        t = best[0] / bones
        if give > 1.0:
            t = min(1.0, t + (give - 1.0) / bones)
        per.append((c, t, best[1], length))
    avg_len = sum(q[3] for q in per) / len(per)
    eps = (0.05 * avg_len) ** 2 + 1e-12
    across = [1.0 / (q[2] * q[2] + eps) for q in per]
    total = sum(across)
    across = [a / total for a in across]
    s = max(0.05, smooth)
    out = {}
    for (c, t, _d, _l), wc in zip(per, across):
        x = t * bones - 0.5
        k0 = int(x // 1)
        f = x - k0
        f2 = min(1.0, max(0.0, (f - 0.5) / s + 0.5))
        for k, w in ((k0, 1.0 - f2), (k0 + 1, f2)):
            k = min(bones - 1, max(0, k))
            if w > 0:
                out[(c, k)] = out.get((c, k), 0.0) + wc * w
    if give < 1.0:
        out = {key: w * max(0.0, give) for key, w in out.items()}
        out[(len(chains), 0)] = 1.0 - max(0.0, give)
    top = sorted(out.items(), key=lambda kv: -kv[1])[:MAX_INFLUENCES]
    total = sum(w for _, w in top) or 1.0
    return [(c, k, w / total) for (c, k), w in top]


def _add(rig):
    o = bpy.data.objects.get(rig['mesh']) or bpy.data.objects.get(rig['part'])
    if not o or o.type != 'MESH':
        raise SystemExit(f"Bending part {rig['mesh']}: no such mesh")
    if any(m.type == 'ARMATURE' for m in o.modifiers):
        raise SystemExit(f"{o.name} already has an armature in the .blend; take it off there, or rig it there instead")
    n = rig['bones']
    chains = [[FROM_GLTF @ q for q in chain_points(ch, n)] for ch in rig['chains']]
    names = rig['names']
    paint = [dict(d, p=FROM_GLTF @ Vector(d['p'])) for d in rig.get('paint') or []]

    data = bpy.data.armatures.new(f"{o.name} Rig")
    arm = bpy.data.objects.new(f"{o.name} Rig", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    base = None
    if paint:
        # The bone that holds what was anchored: at the chains' roots, as the parent of each chain, never animated.
        head = sum((pts[0] for pts in chains), Vector()) / len(chains)
        along = sum(((pts[1] - pts[0]) for pts in chains), Vector())
        if along.length < 1e-6:  # chains pointing opposite ways: follow the first
            along = chains[0][1] - chains[0][0]
        size = sum((pts[1] - pts[0]).length for pts in chains) / len(chains)
        base = data.edit_bones.new(names[len(chains) * n])
        base.head = head
        base.tail = head + along.normalized() * max(size * 0.25, 1e-3)
    for c, pts in enumerate(chains):
        prev = base
        for k in range(n):
            b = data.edit_bones.new(names[c * n + k])
            b.head = pts[k]
            b.tail = pts[k + 1]
            if prev:
                b.parent = prev
                b.use_connect = prev is not base
            prev = b
    bpy.ops.object.mode_set(mode='OBJECT')

    groups = [o.vertex_groups.get(nm) or o.vertex_groups.new(name=nm) for nm in names]
    mw = o.matrix_world
    for v in o.data.vertices:
        p = mw @ v.co
        for c, k, w in weights_for(p, chains, n, rig['smooth'], give_at(p, paint) if paint else 1.0):
            groups[c * n + k].add([v.index], w, 'REPLACE')

    mod = o.modifiers.new('Rig', 'ARMATURE')
    mod.object = arm
    where = o.matrix_world.copy()
    o.parent = arm
    o.matrix_world = where
    return o.name


def add_rigs(rigs):
    for rig in rigs:
        _add(rig)
