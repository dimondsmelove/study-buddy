# Welcome annotations and extension icon

These eight self-contained SVGs supply the numbered red markers, circles, arrows, and the selected StudyBuddy toolbar icon. Each SVG embeds its source raster as a data URI; the welcome page loads no annotation art from `/tmp` or a CDN.

- `step-number-1.svg`, `step-number-2.svg`, `step-number-3.svg`: source [hand-drawn number set](https://img.magnific.com/premium-vector/hand-drawn-numbers-set-lettering-font_439591-2531.jpg?semt=ais_hybrid&w=740&q=80), 740×493. Crops use viewBoxes `(30,60,130,160)`, `(170,60,145,160)`, and `(330,60,110,160)` respectively.
- `ring-number-1-pin.svg`, `ring-number-2-extension.svg`, `ring-number-3-puzzle.svg`: source [scribble-number-circle sheet](https://www.shutterstock.com/image-vector/scribble-numbers-circle-hand-drawn-260nw-2691241917.jpg), 690×280. Crops use viewBoxes `(122,16,112,112)`, `(343,16,112,112)`, and `(122,135,112,112)` respectively.
- `curved-red-arrow.svg`: source [red brush arrow](https://freepngimg.com/thumb/red_arrow/83467-red-arrow.png), 797×798; its original pixels are recolored with an SVG alpha mask.
- `study-buddy-hat-tile.svg`: source [Flaticon AI technology icon](https://cdn-icons-png.flaticon.com/512/17030/17030743.png), 512×512. The original white silhouette is placed on a sampled blue rounded tile, uniformly scaled to 400px and inset by 56px.

The displayed icon-size placements and marker geometry are in `welcome/index.html`; originals remain embedded and unedited.
