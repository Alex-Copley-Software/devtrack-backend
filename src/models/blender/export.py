# Renames the parts and exports an FBX:
#   blender -b -Y --factory-startup model.blend --python export.py -- plan.json out.fbx
# plan.json  { "rename": { "Cube.012": "Head", ... }, "drop": ["Cube.003", ...],
#              "embed": true, "scale": 0.01, "accessories": [...] }
# embed  Path Mode Copy with Embed Textures ticked (false: Path Mode Auto, not embedded)
# scale  the export dialog's Scale (0.01 or 1.0)
# accessories  see accessories.py
# Parts not named in the plan keep their Blender name. The .blend is never saved.
import bpy, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import show_everything, parts

plan_path, fbx = sys.argv[sys.argv.index('--') + 1:][:2]
with open(plan_path, encoding='utf-8') as f:
    plan = json.load(f)
rename = plan.get('rename', {})
drop = set(plan.get('drop', []))
embed = bool(plan.get('embed', True))
scale = float(plan.get('scale', 0.01))

show_everything()
by_name = {o.name: o for o in parts()}

for name in drop:
    o = by_name.pop(name, None)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)

# Two passes, so "Head" can move from one part to another without Blender
# turning the second into "Head.001".
moving = [(by_name[old], new) for old, new in rename.items() if old in by_name and new]
for i, (o, _) in enumerate(moving):
    o.name = f'__dt_{i}'
taken = {o.name for o in bpy.data.objects}
for o, new in moving:
    if new in taken:  # a part or other object that keeps its name already has it
        other = bpy.data.objects[new]
        other.name = f'{new} (old)'
    o.name = new
    taken.add(new)
    if o.data and o.data.users == 1:
        o.data.name = new

missing = [o for o, new in moving if o.name != new]
if missing:
    raise SystemExit('Could not rename: ' + ', '.join(o.name for o in missing))

# Weapons and other accessories, each where it was put on the page (accessories.py).
if plan.get('accessories'):
    from accessories import add_accessories
    add_accessories(plan['accessories'])

bpy.ops.export_scene.fbx(
    filepath=fbx, use_selection=False, use_visible=False,
    object_types={'MESH', 'ARMATURE', 'EMPTY'},
    global_scale=scale, apply_unit_scale=True, axis_forward='-Z', axis_up='Y',
    use_mesh_modifiers=True, mesh_smooth_type='FACE',
    add_leaf_bones=False, bake_anim=False,
    path_mode='COPY' if embed else 'AUTO', embed_textures=embed,
)
print('DT_EXPORTED', json.dumps(sorted(o.name for o in parts())))
