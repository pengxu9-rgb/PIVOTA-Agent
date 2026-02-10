from __future__ import annotations

import numpy as np

from .label_map import CLASS_TO_ID, IGNORE_INDEX, remap_celebamask_parts, remap_fasseg, remap_lapa


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
