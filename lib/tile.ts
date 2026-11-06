const EARTH_RADIUS = 6378137;

/** Equatorial circumference of the WGS84 sphere used by Web Mercator, in metres */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;

/** Latitude limit of the Web Mercator projection */
export const MAX_LATITUDE = 85.0511287798066;

export const MAX_ZOOM = 30;

/** [west, south, east, north] in degrees */
export type TileBounds = [number, number, number, number];

export type LngLat = [number, number];

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function tileLng(x: number, scale: number): number {
    return x / scale * 360 - 180;
}

function tileLat(y: number, scale: number): number {
    const n = Math.PI - 2 * Math.PI * y / scale;
    return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}

/**
 * A Web Mercator (XYZ scheme) tile address with hierarchy, neighbour and
 * projection helpers. Instances are immutable.
 */
export class Tile {
    readonly z: number;
    readonly x: number;
    readonly y: number;

    constructor(z: number, x: number, y: number) {
        if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) {
            throw new RangeError(`Invalid tile zoom: ${z}`);
        }

        const scale = 2 ** z;

        if (!Number.isInteger(x) || x < 0 || x >= scale) {
            throw new RangeError(`Invalid tile x at zoom ${z}: ${x}`);
        }

        if (!Number.isInteger(y) || y < 0 || y >= scale) {
            throw new RangeError(`Invalid tile y at zoom ${z}: ${y}`);
        }

        this.z = z;
        this.x = x;
        this.y = y;
    }

    /** Parse a `z/x/y` key */
    static fromKey(key: string): Tile {
        const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
        if (!match) throw new Error(`Invalid tile key: ${key}`);

        return new Tile(Number(match[1]), Number(match[2]), Number(match[3]));
    }

    /** The tile containing a coordinate at the given zoom */
    static fromLngLat(lng: number, lat: number, z: number): Tile {
        const scale = 2 ** z;
        const [fx, fy] = Tile.fractional(lng, lat, z);

        return new Tile(
            z,
            clamp(Math.floor(fx), 0, scale - 1),
            clamp(Math.floor(fy), 0, scale - 1),
        );
    }

    /** Fractional tile coordinates of a point at the given zoom */
    static fractional(lng: number, lat: number, z: number): [number, number] {
        const scale = 2 ** z;
        const latr = clamp(lat, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI / 180;

        return [
            (lng + 180) / 360 * scale,
            (1 - Math.log(Math.tan(latr) + 1 / Math.cos(latr)) / Math.PI) / 2 * scale,
        ];
    }

    get key(): string {
        return `${this.z}/${this.x}/${this.y}`;
    }

    /** Number of tiles along each axis at this zoom */
    get scale(): number {
        return 2 ** this.z;
    }

    toString(): string {
        return this.key;
    }

    equals(other: Tile): boolean {
        return this.z === other.z && this.x === other.x && this.y === other.y;
    }

    parent(): Tile | null {
        return this.z === 0 ? null : this.ancestor(1);
    }

    /** The tile `dz` zoom levels above this one */
    ancestor(dz: number): Tile {
        if (!Number.isInteger(dz) || dz < 0 || dz > this.z) {
            throw new RangeError(`Invalid ancestor distance ${dz} for zoom ${this.z}`);
        }

        const scale = 2 ** dz;
        return new Tile(this.z - dz, Math.floor(this.x / scale), Math.floor(this.y / scale));
    }

    children(): [Tile, Tile, Tile, Tile] {
        if (this.z >= MAX_ZOOM) throw new RangeError(`Zoom ${this.z + 1} exceeds the maximum zoom`);

        const z = this.z + 1;
        const x = this.x * 2;
        const y = this.y * 2;

        return [
            new Tile(z, x, y),
            new Tile(z, x + 1, y),
            new Tile(z, x, y + 1),
            new Tile(z, x + 1, y + 1),
        ];
    }

    /** Whether `tile` is this tile or lies within it at a higher zoom */
    contains(tile: Tile): boolean {
        if (tile.z < this.z) return false;
        return tile.ancestor(tile.z - this.z).equals(this);
    }

    /** Horizontal neighbours wrap around the antimeridian; null above or below the grid */
    neighbor(dx: number, dy: number): Tile | null {
        if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
            throw new RangeError('Neighbour offsets must be integers');
        }

        const scale = this.scale;
        const y = this.y + dy;
        if (y < 0 || y >= scale) return null;

        const x = ((this.x + dx) % scale + scale) % scale;
        return new Tile(this.z, x, y);
    }

    bounds(): TileBounds {
        const scale = this.scale;

        return [
            tileLng(this.x, scale),
            tileLat(this.y + 1, scale),
            tileLng(this.x + 1, scale),
            tileLat(this.y, scale),
        ];
    }

    center(): LngLat {
        const scale = this.scale;
        return [tileLng(this.x + 0.5, scale), tileLat(this.y + 0.5, scale)];
    }

    /** Longitude at the centre of pixel column `col` of a `size` pixel wide tile */
    longitude(col: number, size: number): number {
        return tileLng(this.x + (col + 0.5) / size, this.scale);
    }

    /** Latitude at the centre of pixel row `row` of a `size` pixel tall tile */
    latitude(row: number, size: number): number {
        return tileLat(this.y + (row + 0.5) / size, this.scale);
    }

    /** Ground resolution in metres per pixel at pixel row `row` of a `size` pixel tile */
    resolution(row: number, size: number): number {
        const lat = this.latitude(row, size) * Math.PI / 180;
        return EARTH_CIRCUMFERENCE * Math.cos(lat) / (this.scale * size);
    }

    /** Project a coordinate into this tile's local space; values fall outside [0, extent] when the point is outside the tile */
    project(lng: number, lat: number, extent = 4096): [number, number] {
        const [fx, fy] = Tile.fractional(lng, lat, this.z);
        return [(fx - this.x) * extent, (fy - this.y) * extent];
    }

    /** Inverse of {@link project} */
    unproject(px: number, py: number, extent = 4096): LngLat {
        const scale = this.scale;
        return [tileLng(this.x + px / extent, scale), tileLat(this.y + py / extent, scale)];
    }
}
