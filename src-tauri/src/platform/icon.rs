//! Platform-independent pixel work for native icons (tested on every OS):
//! BGRA → RGBA, alpha recovered from the AND mask for icons without an alpha
//! channel, and scaling to the requested size.

#![cfg_attr(not(windows), allow(dead_code))]

/// Convert a top-down 32-bit BGRA buffer (as GetDIBits returns it) to RGBA.
///
/// Icons without an alpha channel (older 24-bit and 16-colour icons) come back
/// with alpha = 0 everywhere and would render fully transparent; for them the
/// alpha is taken from the AND mask (`mask_bgra`, same size: black = opaque,
/// white = transparent).
pub fn bgra_to_rgba(mut px: Vec<u8>, mask_bgra: Option<&[u8]>) -> Vec<u8> {
    let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
    for (i, p) in px.chunks_exact_mut(4).enumerate() {
        p.swap(0, 2); // B <-> R
        if !has_alpha {
            let transparent = mask_bgra
                .and_then(|m| m.get(i * 4))
                .is_some_and(|&v| v != 0);
            p[3] = if transparent { 0 } else { 255 };
        }
    }
    px
}

/// Scale an RGBA image to `size`×`size` when the system returned another size
/// (e.g. 20×20 or 24×24 for a "small" icon on a high-DPI display). Reading it
/// with the requested width, as before, produced a skewed or clipped icon.
pub fn fit(rgba: Vec<u8>, w: u32, h: u32, size: u32) -> Option<image::RgbaImage> {
    let img = image::RgbaImage::from_raw(w, h, rgba)?;
    if w == size && h == size {
        return Some(img);
    }
    Some(image::imageops::resize(&img, size, size, image::imageops::FilterType::Triangle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_channels_and_keeps_real_alpha() {
        let out = bgra_to_rgba(vec![1, 2, 3, 200, 4, 5, 6, 0], None);
        assert_eq!(out, vec![3, 2, 1, 200, 6, 5, 4, 0]);
    }

    #[test]
    fn alpha_comes_from_the_mask_when_missing() {
        let mask = [0, 0, 0, 0, 255, 255, 255, 0];
        let out = bgra_to_rgba(vec![10, 20, 30, 0, 40, 50, 60, 0], Some(&mask));
        assert_eq!(out, vec![30, 20, 10, 255, 60, 50, 40, 0]);
    }

    #[test]
    fn scales_to_the_requested_size() {
        let img = fit(vec![255; 24 * 24 * 4], 24, 24, 16).unwrap();
        assert_eq!(img.dimensions(), (16, 16));
        assert!(fit(vec![0; 10], 24, 24, 16).is_none(), "short buffer is rejected");
    }
}
