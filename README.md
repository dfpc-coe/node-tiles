<h1 align=center>node-tiles</h1>

<p align=center>Tile, Raster, Terrain and Vector tile primitives with DEM utilities</p>

## Installation

```sh
npm add @tak-ps/node-tiles
```

The root export is pure TypeScript with no native dependencies, so it runs in
Node, workers and browsers alike. Image decoding and encoding live behind the
`@tak-ps/node-tiles/node` entry, which depends on [sharp](https://sharp.pixelplumbing.com/).

## Usage

### Tile

A Web Mercator XYZ tile address with hierarchy, neighbour and projection helpers.

```ts
import { Tile } from '@tak-ps/node-tiles';

const tile = Tile.fromKey('10/212/388');

tile.bounds();                  // [west, south, east, north]
tile.parent();                  // Tile 9/106/194
tile.children();                // four Tiles at zoom 11
tile.ancestor(3);               // Tile 7/26/48
tile.contains(Tile.fromKey('12/850/1552'));
tile.neighbor(-1, 0);           // wraps around the antimeridian; null above or below the grid

tile.latitude(row, 256);        // latitude at a pixel row centre
tile.resolution(row, 256);      // metres per pixel at that row
tile.project(lng, lat, 4096);   // [x, y] in tile space
tile.unproject(x, y, 4096);     // [lng, lat]

Tile.fromLngLat(-105.3, 39.8, 10);
```

### Raster

An 8-bit pixel buffer with 1 to 4 interleaved channels.

```ts
import { Raster } from '@tak-ps/node-tiles';

const raster = Raster.alloc(256, 256, 4);
raster.set(10, 20, [255, 0, 0, 255]);
raster.get(10, 20);             // [255, 0, 0, 255]
raster.toRGBA();                // expands grey/RGB rasters
raster.crop(0, 0, 128, 128);
```

### Terrain

A square elevation grid decoded from a `terrarium` or `mapbox` encoded raster-dem tile.

```ts
import { Tile, Terrain } from '@tak-ps/node-tiles';

const terrain = Terrain.decode(tile, raster, 'terrarium');

terrain.at(x, y);               // metres, clamped to the grid edge
terrain.range();                // [min, max]
terrain.slope();                // Float32Array of degrees (Horn's method)
terrain.overzoom(childTile);    // bilinear resample covering a descendant tile
terrain.encode('mapbox');       // back to an RGB raster
```

`Terrain.fetch` reads a tile from a `TerrainSource`, walking up to parent tiles
and overzooming when the source has nothing at the requested zoom:

```ts
const source: TerrainSource = {
    encoding: 'terrarium',
    minzoom: 0,
    maxzoom: 12,
    tile: async (tile) => await loadRaster(tile),   // Raster | null
};

const terrain = await Terrain.fetch(Tile.fromKey('14/3392/6208'), source, { maxOverzoom: 4 });
```

### Vector

A Mapbox Vector Tile built from features in tile space, encoded with
[@maplibre/vt-pbf](https://github.com/maplibre/vt-pbf) and decoded with
[@mapbox/vector-tile](https://github.com/mapbox/vector-tile-js).

```ts
import { Vector } from '@tak-ps/node-tiles';

const vector = new Vector();

vector.layer('contours').add({
    id: 1,
    type: 'LineString',
    geometry: [[[0, 100], [4096, 120]]],
    properties: { ele: 1200 },
});

const pbf = vector.encode();            // Uint8Array
const decoded = Vector.decode(pbf);
decoded.toGeoJSON(tile);                // FeatureCollection in geographic coordinates
```

Coordinates are rounded to the integer tile grid on encode. Polygon rings are
closed on `add` and should follow the MVT winding rule (exterior clockwise,
holes counter-clockwise in tile space). Readers drop layers without features.

### Slope

Slope angle shading, the first terrain utility.

```ts
import { Slope } from '@tak-ps/node-tiles';

const classes = Slope.parse(['27:30:ffeb3bc8', '30:35:ff9800']);  // lower:upper:RRGGBB[AA]
Slope.serialize(classes);               // normalised strings for a tile URL
Slope.legend(classes);                  // [{ label: '27-30°', color: 'rgba(...)' }]

const raster = Slope.render(terrain, classes);   // transparent RGBA Raster
```

`Slope.DEFAULT_CLASSES` holds the avalanche bands (27, 30, 35, 45 and 50 degrees).

### Node

```ts
import { decodeImage, encodePNG, encodeWebP, imageTerrainSource } from '@tak-ps/node-tiles/node';

const raster = await decodeImage(pngOrWebpBytes);
const png = await encodePNG(raster, { palette: true });

const source = imageTerrainSource({
    encoding: 'terrarium',
    minzoom: 0,
    maxzoom: 12,
    fetch: async (tile) => await fetchTileBytes(tile),   // Uint8Array | ArrayBuffer | null
});

const terrain = await Terrain.fetch(tile, source);
if (terrain) await encodePNG(Slope.render(terrain), { palette: true });
```

## Development

```sh
npm install
npm test        # lint + node:test with coverage
npm run build
```
