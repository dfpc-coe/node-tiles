export { Tile, EARTH_CIRCUMFERENCE, MAX_LATITUDE, MAX_ZOOM } from './lib/tile.js';
export type { TileBounds, LngLat } from './lib/tile.js';

export { Raster } from './lib/raster.js';
export type { RasterInit, Pixel } from './lib/raster.js';

export { Terrain, TERRAIN_ENCODINGS } from './lib/terrain.js';
export type { TerrainEncoding, TerrainSource, TerrainFetchOptions, TerrainGradient } from './lib/terrain.js';

export { Vector, VectorLayer, DEFAULT_EXTENT } from './lib/vector.js';
export type {
    VectorFeature,
    VectorGeometryType,
    VectorLayerOptions,
    VectorPosition,
    VectorProperties,
    VectorValue,
} from './lib/vector.js';

export { Slope } from './lib/slope.js';
export type { SlopeClass, LegendEntry } from './lib/slope.js';

export { Hillshade, HILLSHADE_METHODS } from './lib/hillshade.js';
export type { HillshadeMethod, HillshadeOptions, HillshadeInput, HillshadeColorOptions } from './lib/hillshade.js';

export { parseHex, toHex, toCSS } from './lib/color.js';
export type { RGBA } from './lib/color.js';
