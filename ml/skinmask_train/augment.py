from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Tuple

import numpy as np
from PIL import Image, ImageEnhance, ImageOps


def _resize_pair(image: Image.Image, mask: np.ndarray, width: int, height: int) -> tuple[Image.Image, np.ndarray]:
    resized_image = image.resize((width, height), Image.BILINEAR)
    resized_mask = Image.fromarray(mask.astype(np.uint8), mode="L").resize((width, height), Image.NEAREST)
    return resized_image, np.asarray(resized_mask, dtype=np.uint8)


def _random_crop_pair(image: Image.Image, mask: np.ndarray, width: int, height: int) -> tuple[Image.Image, np.ndarray]:
    src_w, src_h = image.size
    if src_w == width and src_h == height:
        return image, mask
    if src_w < width or src_h < height:
        pad_left = max(0, (width - src_w) // 2)
        pad_top = max(0, (height - src_h) // 2)
        pad_right = max(0, width - src_w - pad_left)
        pad_bottom = max(0, height - src_h - pad_top)
        image = ImageOps.expand(image, border=(pad_left, pad_top, pad_right, pad_bottom), fill=0)
        mask_img = Image.fromarray(mask.astype(np.uint8), mode="L")
        mask_img = ImageOps.expand(mask_img, border=(pad_left, pad_top, pad_right, pad_bottom), fill=255)
        mask = np.asarray(mask_img, dtype=np.uint8)
        src_w, src_h = image.size
    x0 = random.randint(0, max(0, src_w - width))
    y0 = random.randint(0, max(0, src_h - height))
    return image.crop((x0, y0, x0 + width, y0 + height)), mask[y0 : y0 + height, x0 : x0 + width]


def _light_color_jitter(image: Image.Image) -> Image.Image:
    brightness = random.uniform(0.95, 1.05)
    contrast = random.uniform(0.95, 1.05)
    saturation = random.uniform(0.97, 1.04)
    image = ImageEnhance.Brightness(image).enhance(brightness)
    image = ImageEnhance.Contrast(image).enhance(contrast)
    image = ImageEnhance.Color(image).enhance(saturation)
    return image


@dataclass
class SegTrainAugment:
    image_size: int = 512
    scale_min: float = 0.85
    scale_max: float = 1.15
    hflip_prob: float = 0.5
    color_jitter_prob: float = 0.35

    def __call__(self, image: Image.Image, mask: np.ndarray) -> tuple[Image.Image, np.ndarray]:
        target_size = int(self.image_size)
        if target_size < 64:
            raise ValueError("image_size_too_small")

        src_w, src_h = image.size
        base = max(src_w, src_h)
        scale = random.uniform(self.scale_min, self.scale_max)
        resized_edge = max(target_size, int(round(base * scale)))
        if base > 0:
            ratio = resized_edge / float(base)
        else:
            ratio = 1.0
        new_w = max(1, int(round(src_w * ratio)))
        new_h = max(1, int(round(src_h * ratio)))
        image, mask = _resize_pair(image, mask, new_w, new_h)

        if random.random() < self.hflip_prob:
            image = ImageOps.mirror(image)
            mask = np.ascontiguousarray(np.fliplr(mask))

        image, mask = _random_crop_pair(image, mask, target_size, target_size)

        if random.random() < self.color_jitter_prob:
            image = _light_color_jitter(image)
        return image, mask


@dataclass
class SegEvalTransform:
    image_size: int = 512

    def __call__(self, image: Image.Image, mask: np.ndarray) -> tuple[Image.Image, np.ndarray]:
        target_size = int(self.image_size)
        return _resize_pair(image, mask, target_size, target_size)


def build_train_augment(image_size: int = 512) -> SegTrainAugment:
    return SegTrainAugment(image_size=image_size)


def build_eval_transform(image_size: int = 512) -> SegEvalTransform:
    return SegEvalTransform(image_size=image_size)

