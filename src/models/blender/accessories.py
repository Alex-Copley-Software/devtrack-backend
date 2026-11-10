# Adds a unit's weapons and other accessories to it before the FBX is made
# (export.py). Each accessory in the plan:
#   { prefix: "A1", path: the accessory's .blend or .fbx, format: "blend" | "fbx",
#     meshes: [its mesh objects to keep, by name],
#     matrix: 16 numbers, column-major: where the page put it, in the viewer's
#             (glTF) space,
#     handle: [x, y, z]: where the hand grips, in the same space }
#
# Its meshes come in named "A1 <name>" and placed exactly as they were on the
# page, and a small cube "A1 Handle" marks the grip. In Studio the Mac turns
# those into the accessory's Model, its Handle part and the welds.
import bpy
from mathutils import Matrix, Vector

# The viewer shows Blender's world in glTF space: x stays, z goes up, -y goes forward.
TO_GLTF = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
FROM_GLTF = TO_GLTF.inverted()


def _bring_in(acc):
    """The accessory's objects, added to this scene. Returns the new objects."""
    before = set(bpy.data.objects)
    if acc['format'] == 'fbx':
        bpy.ops.import_scene.fbx(filepath=acc['path'])
        return [o for o in bpy.data.objects if o not in before]
    with bpy.data.libraries.load(acc['path'], link=False) as (src, dst):
        dst.scenes = src.scenes[:1]
    loaded = dst.scenes[0]
    new = list(loaded.objects)
    for o in new:
        if o.name not in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.link(o)
    bpy.data.scenes.remove(loaded)
    return new


def _add(acc, unit_height):
    new = _bring_in(acc)
    keep = set(acc['meshes'])
    meshes = [o for o in new if o.type == 'MESH' and o.name in keep]
    missing = keep - {o.name for o in meshes}
    if missing:
        raise SystemExit(f"Accessory {acc['prefix']}: could not find {', '.join(sorted(missing))}")
    # Free the meshes from their parents (keeping where they are), then drop everything else that came in.
    where = {o: o.matrix_world.copy() for o in meshes}
    for o in meshes:
        o.parent = None
        o.matrix_world = where[o]
        o.hide_viewport = False
        o.hide_render = False
        try:
            o.hide_set(False)
        except RuntimeError:
            pass
    for o in new:
        if o not in meshes:
            bpy.data.objects.remove(o, do_unlink=True)

    m = acc['matrix']
    placed = Matrix([[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]])
    move = FROM_GLTF @ placed @ TO_GLTF
    for o in meshes:
        o.matrix_world = move @ where[o]
        o.name = f"{acc['prefix']} {o.name}"
        if o.data and o.data.users == 1:
            o.data.name = o.name

    h = FROM_GLTF @ Vector((*acc['handle'], 1))
    bpy.ops.mesh.primitive_cube_add(size=max(unit_height * 0.03, 1e-4), location=(h.x, h.y, h.z))
    marker = bpy.context.active_object
    marker.name = f"{acc['prefix']} Handle"
    marker.data.name = marker.name


def add_accessories(accessories):
    # The unit's own objects step aside while files come in, so nothing gets renamed "Head.001".
    unit = [(o, o.name) for o in bpy.data.objects]
    for i, (o, _) in enumerate(unit):
        o.name = f'__dt_unit_{i}'
    corners = [o.matrix_world @ Vector(c) for o, _ in unit if o.type == 'MESH' for c in o.bound_box]
    height = (max(c.z for c in corners) - min(c.z for c in corners)) if corners else 1.0
    for acc in accessories:
        _add(acc, height)
    for o, name in unit:
        o.name = name
