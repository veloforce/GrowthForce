# Image template backgrounds

Generate the PNG files described in `docs/spec/image-template-prompts.md` and place them in this directory.

The renderer always exports the following standard dimensions:

- `xhs_*.png`: 1080 × 1440 (9 backgrounds, reused by `xhs_cover` and `xhs_content`)
- `wechat_*.png`: 1476 × 628
- `article_*.png`: 1536 × 1024

Source backgrounds may use a different pixel size. They are scaled proportionally and center-cropped to the standard output ratio; they are never stretched.

Backgrounds must contain no text, letters, numbers, logos, or watermarks.
