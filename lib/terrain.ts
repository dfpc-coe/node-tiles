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
    /**
     * Pixels of neighbouring terrain to read around the tile so kernels such
     * as slope and hillshade have real samples at the tile edge; defaults to 0
     */
    pad?: number;
}

/** Horizontal and vertical elevation gradients in metres per metre for every pixel */
export interface TerrainGradient {
    dzdx: Float32Array;
    dzdy: Float32Array;
}

const TERRARIUM_OFFSET = 32768;
const TERRARIUM_MAX = 65536 - 1 / 256;
const MAPBOX_OFFSET = 10000;
const MAPBOX_MAX = 2 ** 24 - 1;

/**
 * A square elevation grid in metres for one tile. Pixel (0, 0) is the top left
 * and values are sampled at pixel centres. A padded grid also holds `pad`
 * pixels of the neighbouring tiles on every side, addressed with negative and
 * past-the-end coordinates.
 */
export class Terrain {
    static readonly MAX_OVERZOOM = 4;

    readonly tile: Tile;
    readonly size: number;
    readonly pad: number;
    readonly elevation: Float32Array;

    constructor(tile: Tile, size: number, elevation: Float32Array, pad = 0) {
        if (!Number.isInteger(size) || size <= 0) throw new RangeError(`Invalid terrain size: ${size}`);
        if (!Number.isInteger(pad) || pad < 0) throw new RangeError(`Invalid terrain padding: ${pad}`);

        const stride = size + 2 * pad;
        if (elevation.length !== stride * stride) {
            throw new RangeError(`Terrain holds ${elevation.length} samples but a ${size}px tile padded by ${pad} needs ${stride * stride}`);
        }

        this.tile = tile;
        this.size = size;
        this.pad = pad;
        this.elevation = elevation;
    }

    /** Samples per row of the padded grid */
    get stride(): number {
        return this.size + 2 * this.pad;
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

    /** Encode the tile (without padding) as an RGB raster-dem tile; values outside the encoding's range are clamped */
    encode(encoding: TerrainEncoding): Raster {
        if (!TERRAIN_ENCODINGS.includes(encoding)) throw new Error(`Unsupported terrain encoding: ${encoding}`);

        const { size } = this;
        const raster = Raster.alloc(size, size, 3);
        const { data } = raster;

        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                const i = py * size + px;
                const e = this.at(px, py);

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
        }

        return raster;
    }

    /** Elevation at a pixel, clamping coordinates to the edge of the padded grid */
    at(x: number, y: number): number {
        const { pad, stride } = this;
        const max = this.size - 1 + pad;
        const px = Math.min(Math.max(x, -pad), max);
        const py = Math.min(Math.max(y, -pad), max);
        return this.elevation[(py + pad) * stride + (px + pad)];
    }

    /** [min, max] elevation across the tile, excluding padding */
    range(): [number, number] {
        let min = Infinity;
        let max = -Infinity;

        for (let py = 0; py < this.size; py++) {
            for (let px = 0; px < this.size; px++) {
                const e = this.at(px, py);
                if (e < min) min = e;
                if (e > max) max = e;
            }
        }

        return [min, max];
    }

    /**
     * Surround this tile with `pad` pixels read from its neighbours, which are
     * matched by their tile address. Missing neighbours clamp to this tile's
     * edge, as an unpadded grid does everywhere.
     */
    mosaic(neighbors: Iterable<Terrain>, pad = 1): Terrain {
        const { size, tile } = this;

        if (!Number.isInteger(pad) || pad < 1 || pad > size) {
            throw new RangeError(`Invalid terrain padding ${pad} for a ${size}px tile`);
        }

        const grid: (Terrain | null)[] = new Array(9).fill(null);
        grid[4] = this;

        for (const neighbor of neighbors) {
            if (neighbor.tile.z !== tile.z || neighbor.size !== size) {
                throw new RangeError(`Terrain ${neighbor.tile} (${neighbor.size}px) cannot neighbour ${tile} (${size}px)`);
            }

            let dx = neighbor.tile.x - tile.x;
            if (dx > 1) dx -= tile.scale;
            if (dx < -1) dx += tile.scale;
            const dy = neighbor.tile.y - tile.y;

            if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) {
                throw new RangeError(`Terrain ${neighbor.tile} is not adjacent to ${tile}`);
            }

            grid[(dy + 1) * 3 + (dx + 1)] = neighbor;
        }

        const stride = size + 2 * pad;
        const elevation = new Float32Array(stride * stride);

        for (let py = -pad; py < size + pad; py++) {
            const dy = py < 0 ? -1 : py >= size ? 1 : 0;

            for (let px = -pad; px < size + pad; px++) {
                const dx = px < 0 ? -1 : px >= size ? 1 : 0;
                const source = grid[(dy + 1) * 3 + (dx + 1)];

                elevation[(py + pad) * stride + (px + pad)] = source
                    ? source.at(px - dx * size, py - dy * size)
                    : this.at(px, py);
            }
        }

        return new Terrain(tile, size, elevation, pad);
    }

    /**
     * Bilinearly resample the part of this tile covering a descendant tile,
     * producing a grid of the same size and padding for that tile
     */
    overzoom(child: Tile): Terrain {
        const dz = child.z - this.tile.z;

        if (dz < 1 || !this.tile.contains(child)) {
            throw new RangeError(`Tile ${child} is not a descendant of ${this.tile}`);
        }

        const { size, pad } = this;
        const stride = size + 2 * pad;
        const scale = 2 ** dz;
        const ox = child.x % scale;
        const oy = child.y % scale;
        const elevation = new Float32Array(stride * stride);

        for (let py = -pad; py < size + pad; py++) {
            const sy = (oy + (py + 0.5) / size) * size / scale - 0.5;
            const y0 = Math.floor(sy);
            const fy = sy - y0;

            for (let px = -pad; px < size + pad; px++) {
                const sx = (ox + (px + 0.5) / size) * size / scale - 0.5;
                const x0 = Math.floor(sx);
                const fx = sx - x0;

                elevation[(py + pad) * stride + (px + pad)] = (this.at(x0, y0) * (1 - fx) + this.at(x0 + 1, y0) * fx) * (1 - fy)
                    + (this.at(x0, y0 + 1) * (1 - fx) + this.at(x0 + 1, y0 + 1) * fx) * fy;
            }
        }

        return new Terrain(child, size, elevation, pad);
    }

    /**
     * Elevation gradients for every pixel of the tile using Horn's method.
     * Pixels on an unpadded edge are computed against clamped neighbours.
     */
    gradient(): TerrainGradient {
        const { size, tile } = this;
        const dzdx = new Float32Array(size * size);
        const dzdy = new Float32Array(size * size);

        for (let py = 0; py < size; py++) {
            const cell = tile.resolution(py, size);

            for (let px = 0; px < size; px++) {
                const a = this.at(px - 1, py - 1), b = this.at(px, py - 1), c = this.at(px + 1, py - 1);
                const d = this.at(px - 1, py), f = this.at(px + 1, py);
                const g = this.at(px - 1, py + 1), h = this.at(px, py + 1), i = this.at(px + 1, py + 1);

                dzdx[py * size + px] = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell);
                dzdy[py * size + px] = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell);
            }
        }

        return { dzdx, dzdy };
    }

    /** Slope angle in degrees for every pixel */
    slope(): Float32Array {
        const { dzdx, dzdy } = this.gradient();
        const slope = new Float32Array(dzdx.length);

        for (let i = 0; i < slope.length; i++) {
            slope[i] = Math.atan(Math.sqrt(dzdx[i] * dzdx[i] + dzdy[i] * dzdy[i])) * 180 / Math.PI;
        }

        return slope;
    }

    /**
     * Downslope direction for every pixel in compass degrees (0 north, 90
     * east); flat pixels are -1
     */
    aspect(): Float32Array {
        const { dzdx, dzdy } = this.gradient();
        const aspect = new Float32Array(dzdx.length);

        for (let i = 0; i < aspect.length; i++) {
            if (dzdx[i] === 0 && dzdy[i] === 0) {
                aspect[i] = -1;
                continue;
            }

            const deg = Math.atan2(dzdy[i], -dzdx[i]) * 180 / Math.PI;
            aspect[i] = (450 - deg) % 360;
        }

        return aspect;
    }

    /**
     * Read the terrain for a tile, falling back to the nearest ancestor the
     * source has and overzooming it. Resolves to null when nothing is found.
     * With `pad`, the neighbours needed to fill the padding are read as well.
     */
    static async fetch(tile: Tile, source: TerrainSource, opts: TerrainFetchOptions = {}): Promise<Terrain | null> {
        const maxOverzoom = opts.maxOverzoom ?? Terrain.MAX_OVERZOOM;
        const pad = opts.pad ?? 0;

        if (!Number.isInteger(maxOverzoom) || maxOverzoom < 0) {
            throw new RangeError(`Invalid maxOverzoom: ${maxOverzoom}`);
        }

        if (!Number.isInteger(pad) || pad < 0) {
            throw new RangeError(`Invalid pad: ${pad}`);
        }

        for (let dz = 0; dz <= maxOverzoom && dz <= tile.z; dz++) {
            const parent = tile.ancestor(dz);

            if (parent.z > source.maxzoom) continue;
            if (parent.z < source.minzoom) break;

            const raster = await source.tile(parent);
            if (!raster) continue;

            let terrain = Terrain.decode(parent, raster, source.encoding);

            if (pad > 0) {
                const neighbors = await Terrain.neighbors(parent, source, tile);
                terrain = terrain.mosaic(neighbors, pad);
            }

            return dz === 0 ? terrain : terrain.overzoom(tile);
        }

        return null;
    }

    /**
     * Decode the neighbours of `parent` that border `target`, a tile at or
     * below the parent's zoom. Interior descendants need none, edge
     * descendants need the sides they touch and the parent itself needs all eight.
     */
    private static async neighbors(parent: Tile, source: TerrainSource, target: Tile): Promise<Terrain[]> {
        const scale = 2 ** (target.z - parent.z);
        const ox = target.x % scale;
        const oy = target.y % scale;

        const dxs = [ox === 0 ? -1 : NaN, 0, ox === scale - 1 ? 1 : NaN].filter(Number.isFinite);
        const dys = [oy === 0 ? -1 : NaN, 0, oy === scale - 1 ? 1 : NaN].filter(Number.isFinite);

        const tiles: Tile[] = [];

        for (const dy of dys) {
            for (const dx of dxs) {
                if (dx === 0 && dy === 0) continue;
                const neighbor = parent.neighbor(dx, dy);
                if (neighbor) tiles.push(neighbor);
            }
        }

        const rasters = await Promise.all(tiles.map(tile => source.tile(tile)));
        const terrains: Terrain[] = [];

        for (let i = 0; i < tiles.length; i++) {
            const raster = rasters[i];
            if (raster) terrains.push(Terrain.decode(tiles[i], raster, source.encoding));
        }

        return terrains;
    }
}
