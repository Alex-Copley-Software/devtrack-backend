# Shared by inspect.py and export.py. Blender adds this folder to sys.path
# because the script that imports it lives here.
import bpy


def show_everything():
    """Make every object in the scene count: hidden objects and switched-off
    collections are part of the model too. Only this run's copy changes; the
    .blend file is never saved."""
    def walk(layer_collection):
        layer_collection.exclude = False
        layer_collection.hide_viewport = False
        layer_collection.collection.hide_viewport = False
        layer_collection.collection.hide_render = False
        for child in layer_collection.children:
            walk(child)
    walk(bpy.context.view_layer.layer_collection)
    for o in bpy.context.scene.objects:
        o.hide_viewport = False
        o.hide_render = False
        try:
            o.hide_set(False)
        except RuntimeError:
            pass


def parts():
    """The parts of the model: every mesh object, in Outliner (A to Z) order."""
    return sorted((o for o in bpy.context.scene.objects if o.type == 'MESH'), key=lambda o: o.name.lower())
