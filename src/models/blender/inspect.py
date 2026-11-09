# Opens a .blend and writes what the model viewer needs:
#   blender -b -Y --factory-startup model.blend --python inspect.py -- out.glb out.json
# out.glb   the model for the browser; each part carries its Blender object
#           name in its extras (three.js: userData.dt_part)
# out.json  { blender, parts: [{ name, hidden, verts, faces, materials, parent, collection, center }] }
import bpy, json, os, sys
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import show_everything, parts

glb, meta = sys.argv[sys.argv.index('--') + 1:][:2]

hidden = {o.name for o in bpy.context.scene.objects if o.hide_get() or o.hide_viewport or not o.visible_get()}
show_everything()

out = []
for o in parts():
    o['dt_part'] = o.name
    box = [o.matrix_world @ Vector(c) for c in o.bound_box]
    center = [sum(c[i] for c in box) / 8 for i in range(3)]
    out.append({
        'name': o.name,
        'hidden': o.name in hidden,
        'verts': len(o.data.vertices),
        'faces': len(o.data.polygons),
        'materials': [s.material.name for s in o.material_slots if s.material],
        'parent': o.parent.name if o.parent else None,
        'collection': o.users_collection[0].name if o.users_collection else None,
        'center': [round(c, 4) for c in center],
    })

bpy.ops.export_scene.gltf(
    filepath=glb, export_format='GLB', use_selection=False, use_visible=False,
    export_extras=True, export_apply=True, export_animations=False,
    export_cameras=False, export_lights=False, export_yup=True,
)

with open(meta, 'w', encoding='utf-8') as f:
    json.dump({'blender': bpy.app.version_string, 'parts': out}, f)
