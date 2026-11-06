import { Tile } from './tile.js';
import { Raster } from './raster.js';

export type TerrainEncoding = 'terrarium' | 'mapbox';

export const TERRAIN_ENCODINGS: readonly TerrainEncoding[] = ['terrarium', 'mapbox'];

/** Decoded DEM tiles on demand; `tile` resolves to null where the source has no data */
export interface TerrainSource {
    encoding: TerrainEncoding;
    minzoom: number;
    maxzoom: number;
    tile(tile: Tile): Promise<Raster | null>;
}

export interface TerrainFetchOptions {
    /** Parent zoom levels to walk up when the source has no tile at the requested zoom; defaults to {@link Terrain.MAX_OVERZOOM} */
    maxOverzoom?: number;
}

const TERRARIUM_OFFSET = 32768;
const TERRARIUM_MAX = 65536 - 1 / 256;
const MAPBOX_OFFSET = 10000;
const MAPBOX_MAX = 2 ** 24 - 1;

/**
 * A square elevation grid in metres for one tile. Pixel (0, 0) is the top left
 * and values are sampled at pixel centres.
 */
export class Terrain {
    static readonly MAX_OVERZOOM = 4;

    readonly tile: Tile;
    readonly size: number;
    readonly elevation: Float32Array;

    constructor(tile: Tile, size: number, elevation: Float32Array) {
        if (!Number.isInteger(size) || size <= 0) throw new RangeError(`Invalid terrain size: ${size}`);
        if (elevation.length !== size * size) {
            throw new RangeError(`Terrain holds ${elevation.length} samples but a ${size}px tile needs ${size * size}`);
        }

        this.tile = tile;
        this.size = size;
        this.elevation = elevation;
    }

    /** Decode an RGB or RGBA raster-dem tile */
    static decode(tile: Tile, raster: Raster, encoding: TerrainEncoding): Terrain {
        if (!TERRAIN_ENCODINGS.includes(encoding)) throw new Error(`Unsupported terrain encoding: ${encoding}`);
        if (!raster.square) throw new Error('Terrain rasters must be square');
        if (raster.channels < 3) throw new Error('Terrain rasters need RGB channels');

        const { data, channels } = raster;
        const elevation = new Float32Array(raster.width * raster.height);

        for (let i = 0; i < elevation.length; i++) {
            const r = data[i * channels];
            const g = data[i * channels + 1];
            const b = data[i * channels + 2];

            elevation[i] = encoding === 'terrarium'
                ? (r * 256 + g + b / 256) - TERRARIUM_OFFSET
                : -MAPBOX_OFFSET + ((r * 256 * 256 + g * 256 + b) * 0.1);
        }

        return new Terrain(tile, raster.width, elevation);
    }

    /** Encode as an RGB raster-dem tile; values outside the encoding's range are clamped */
    encode(encoding: TerrainEncoding): Raster {
        if (!TERRAIN_ENCODINGS.includes(encoding)) throw new Error(`Unsupported terrain encoding: ${encoding}`);

        const raster = Raster.alloc(this.size, this.size, 3);
        const { data } = raster;

        for (let i = 0; i < this.elevation.length; i++) {
            const e = this.elevation[i];

            if (encoding === 'terrarium') {
                const v = Math.min(Math.max(e + TERRARIUM_OFFSET, 0), TERRARIUM_MAX);
                const whole = Math.floor(v);
                data[i * 3] = Math.floor(whole / 256);
                data[i * 3 + 1] = whole % 256;
                data[i * 3 + 2] = Math.min(Math.round((v - whole) * 256), 255);
            } else {
                const v = Math.min(Math.max(Math.round((e + MAPBOX_OFFSET) * 10), 0), MAPBOX_MAX);
                data[i * 3] = v >> 16;
                data[i * 3 + 1] = (v >> 8) & 255;
                data[i * 3 + 2] = v & 255;
            }
        }

        return raster;
    }

    /** Elevation at a pixel, clamping coordinates to the grid edge */
    at(x: number, y: number): number {
        const max = this.size - 1;
        const px = Math.min(Math.max(x, 0), max);
        const py = Math.min(Math.max(y, 0), max);
        return this.elevation[py * this.size + px];
    }

    /** [min, max] elevation across the tile */
    range(): [number, number] {
        let min = Infinity;
        let max = -Infinity;

        for (const e of this.elevation) {
            if (e < min) min = e;
            if (e > max) max = e;
        }

        return [min, max];
    }

    /**
     * Bilinearly resample the part of this tile covering a descendant tile,
     * producing a grid of the same size for that tile
     */
    overzoom(child: Tile): Terrain {
        const dz = child.z - this.tile.z;

        if (dz < 1 || !this.tile.contains(child)) {
            throw new RangeError(`Tile ${child} is not a descendant of ${this.tile}`);
        }

        const { size } = this;
        const scale = 2 ** dz;
        const ox = child.x % scale;
        const oy = child.y % scale;
        const elevation = new Float32Array(size * size);

        for (let py = 0; py < size; py++) {
            const sy = (oy + (py + 0.5) / size) * size / scale - 0.5;
            const y0 = Math.floor(sy);
            const fy = sy - y0;

            for (let px = 0; px < size; px++) {
                const sx = (ox + (px + 0.5) / size) * size / scale - 0.5;
                const x0 = Math.floor(sx);
                const fx = sx - x0;

                elevation[py * size + px] = (this.at(x0, y0) * (1 - fx) + this.at(x0 + 1, y0) * fx) * (1 - fy)
                    + (this.at(x0, y0 + 1) * (1 - fx) + this.at(x0 + 1, y0 + 1) * fx) * fy;
            }
        }

        return new Terrain(child, size, elevation);
    }

    /**
     * Slope angle in degrees for every pixel using Horn's method. Edge pixels
     * are computed against clamped neighbours.
     */
    slope(): Float32Array {
        const { size, tile } = this;
        const slope = new Float32Array(size * size);

        for (let py = 0; py < size; py++) {
            const cell = tile.resolution(py, size);

            for (let px = 0; px < size; px++) {
                const a = this.at(px - 1, py - 1), b = this.at(px, py - 1), c = this.at(px + 1, py - 1);
                const d = this.at(px - 1, py), f = this.at(px + 1, py);
                const g = this.at(px - 1, py + 1), h = this.at(px, py + 1), i = this.at(px + 1, py + 1);

                const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell);
                const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell);

                slope[py * size + px] = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * 180 / Math.PI;
            }
        }

        return slope;
    }

    /**
     * Read the terrain for a tile, falling back to the nearest ancestor the
     * source has and overzooming it. Resolves to null when nothing is found.
     */
    static async fetch(tile: Tile, source: TerrainSource, opts: TerrainFetchOptions = {}): Promise<Terrain | null> {
        const maxOverzoom = opts.maxOverzoom ?? Terrain.MAX_OVERZOOM;

        if (!Number.isInteger(maxOverzoom) || maxOverzoom < 0) {
            throw new RangeError(`Invalid maxOverzoom: ${maxOverzoom}`);
        }

        for (let dz = 0; dz <= maxOverzoom && dz <= tile.z; dz++) {
            const parent = tile.ancestor(dz);

            if (parent.z > source.maxzoom) continue;
            if (parent.z < source.minzoom) break;

            const raster = await source.tile(parent);
            if (!raster) continue;

            const terrain = Terrain.decode(parent, raster, source.encoding);
            return dz === 0 ? terrain : terrain.overzoom(tile);
        }

        return null;
    }
}
