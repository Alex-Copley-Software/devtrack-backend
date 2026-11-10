# Bone chains for the parts that bend (wings, capes, hair), before the FBX is made (export.py).
# The body stays R6 and welded; only these meshes are skinned. Each rig in the plan:
#   { part, mesh: its final name, kind, bones: per chain, smooth: 0.05..1,
#     chains: [{ root: [x, y, z], tip: [x, y, z] }] in the viewer's (glTF) space,
#     names: the bone names, chain by chain: "<mesh> A1".."A<n>", "<mesh> B1"... }
#
# An armature "<mesh> Rig" gets a straight chain of bones from each root to its tip, and the mesh is
# weighted to them by weights_for() below. The Models page works out the same weights with the same
# steps (rigWeights() in models/index.html), so its preview is what Studio gets; change one, change both.
import bpy
from mathutils import Matrix, Vector

TO_GLTF = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
FROM_GLTF = TO_GLTF.inverted()
MAX_INFLUENCES = 4


def weights_for(p, chains, bones, smooth):
    """[(chain, bone, weight)] for a point p, all in the same space; up to 4, adding up to 1.

    Along a chain, a point belongs to the bone it's beside, blending into the next one around the joint
    (smooth: 1 blends the whole way between bone middles, small values give hard steps). Across chains,
    a point leans to the nearest chain (inverse square of its distance to the chain's line)."""
    per = []
    for c, (root, tip) in enumerate(chains):
        d = tip - root
        l2 = max(d.length_squared, 1e-12)
        t = min(1.0, max(0.0, (p - root).dot(d) / l2))
        dist = (p - (root + d * t)).length
        per.append((c, t, dist, l2 ** 0.5))
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
    top = sorted(out.items(), key=lambda kv: -kv[1])[:MAX_INFLUENCES]
    total = sum(w for _, w in top) or 1.0
    return [(c, k, w / total) for (c, k), w in top]


def _add(rig):
    o = bpy.data.objects.get(rig['mesh']) or bpy.data.objects.get(rig['part'])
    if not o or o.type != 'MESH':
        raise SystemExit(f"Bending part {rig['mesh']}: no such mesh")
    if any(m.type == 'ARMATURE' for m in o.modifiers):
        raise SystemExit(f"{o.name} already has an armature in the .blend; take it off there, or rig it there instead")
    chains = [(FROM_GLTF @ Vector(ch['root']), FROM_GLTF @ Vector(ch['tip'])) for ch in rig['chains']]
    n = rig['bones']
    names = rig['names']

    data = bpy.data.armatures.new(f"{o.name} Rig")
    arm = bpy.data.objects.new(f"{o.name} Rig", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for c, (root, tip) in enumerate(chains):
        prev = None
        for k in range(n):
            b = data.edit_bones.new(names[c * n + k])
            b.head = root + (tip - root) * (k / n)
            b.tail = root + (tip - root) * ((k + 1) / n)
            if prev:
                b.parent = prev
                b.use_connect = True
            prev = b
    bpy.ops.object.mode_set(mode='OBJECT')

    groups = [o.vertex_groups.get(nm) or o.vertex_groups.new(name=nm) for nm in names]
    mw = o.matrix_world
    for v in o.data.vertices:
        for c, k, w in weights_for(mw @ v.co, chains, n, rig['smooth']):
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
