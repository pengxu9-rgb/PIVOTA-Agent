from __future__ import annotations

import numpy as np

from .label_map import (
    CLASS_TO_ID,
    IGNORE_INDEX,
    NON_SKIN_CLASS_NAME,
    SKIN_BINARY_CLASSES,
    SKIN_CLASS_NAME,
    remap_celebamask_parts,
    remap_fasseg,
    remap_lapa,
    skinmask_schema,
    to_binary_skin_mask,
)


def test_remap_lapa_basic_classes():
    raw = np.array(
        [
            [0, 1, 17],
            [4, 10, 11],
        ],
        dtype=np.uint8,
    )
    mapped = remap_lapa(raw)
    assert mapped[0, 0] == CLASS_TO_ID["background"]
    assert mapped[0, 1] == CLASS_TO_ID["skin"]
    assert mapped[0, 2] == CLASS_TO_ID["hair"]
    assert mapped[1, 0] == CLASS_TO_ID["eyes"]
    assert mapped[1, 1] == CLASS_TO_ID["nose"]
    assert mapped[1, 2] == CLASS_TO_ID["mouth"]


def test_remap_fasseg_basic_classes():
    raw = np.array(
        [
            [0, 1, 2, 3],
        ],
        dtype=np.uint8,
    )
    mapped = remap_fasseg(raw)
    assert mapped[0, 0] == CLASS_TO_ID["background"]
    assert mapped[0, 1] == CLASS_TO_ID["skin"]
    assert mapped[0, 2] == CLASS_TO_ID["hair"]
    assert mapped[0, 3] == IGNORE_INDEX


def test_remap_celebamask_unknown_parts_to_ignore():
    shape = (2, 2)
    part_masks = {
        "skin": np.array([[1, 0], [0, 0]], dtype=np.uint8),
        "nose": np.array([[0, 1], [0, 0]], dtype=np.uint8),
        "mystery_part": np.array([[0, 0], [1, 0]], dtype=np.uint8),
    }
    mapped = remap_celebamask_parts(part_masks, shape)
    assert mapped[0, 0] == CLASS_TO_ID["skin"]
    assert mapped[0, 1] == CLASS_TO_ID["nose"]
    assert mapped[1, 0] == IGNORE_INDEX


def test_to_binary_skin_mask_preserves_ignore():
    unified = np.array([[CLASS_TO_ID["background"], CLASS_TO_ID["skin"], IGNORE_INDEX]], dtype=np.uint8)
    binary = to_binary_skin_mask(unified, preserve_ignore_index=True)
    assert binary[0, 0] == 0
    assert binary[0, 1] == 1
    assert binary[0, 2] == IGNORE_INDEX


def test_skinmask_schema_sigmoid_binary_defaults():
    schema = skinmask_schema(size=(320, 256))
    assert schema["output"]["type"] == "sigmoid"
    assert schema["output"]["classes"] == list(SKIN_BINARY_CLASSES)
    assert schema["output"]["skin_class"] == SKIN_CLASS_NAME
    assert schema["output"]["skin_class_id"] == 1
    assert schema["output"]["classes"][0] == NON_SKIN_CLASS_NAME
