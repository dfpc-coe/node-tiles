# CHANGELOG

## Emoji Cheatsheet
- :pencil2: doc updates
- :bug: when fixing a bug
- :white_check_mark: when adding tests
- :arrow_up: when upgrading dependencies
- :tada: when adding new features

## Version History

### Pending

### v1.2.1 - 2026-11-08

- :rocket: Configure node-tiles

### v1.2.0 - 2026-11-08

- :bug: Reset versioning

### v1.1.0 - 2026-11-08

- :tada: Introduce Hillshade rendering for terrain tiles with customizable light direction and intensity

### v1.0.0 - 2026-11-06

- :tada: `Tile` - Web Mercator tile addressing, hierarchy, neighbours, bounds and pixel/tile-space projection
- :tada: `Raster` - channel-interleaved pixel buffer with crop, RGBA expansion and pixel access
- :tada: `Terrain` - DEM tile decoded from `terrarium` or `mapbox` encoded rasters with Horn slope, bilinear overzoom and a source walk that falls back to parent tiles
- :tada: `Vector` - Mapbox Vector Tile encoder and decoder with GeoJSON export
- :tada: `Slope` - slope angle class parsing, legends and shaded RGBA rendering
- :tada: `@tak-ps/node-tiles/node` - sharp backed image decode, PNG/WebP encode and an image backed `TerrainSource`
