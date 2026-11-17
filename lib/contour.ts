import { Vector, DEFAULT_EXTENT } from './vector.js';
import type { VectorPosition } from './vector.js';
import type { Terrain } from './terrain.js';

export interface ContourOptions {
    /**
     * Elevation between contour lines in output units, finest first. Every
     * following interval must be a whole multiple of the first and raises the
     * `level` of the lines it lands on, e.g. `[40, 200]` for minor and index lines.
     */
    intervals: number[];
    /** Factor applied to the terrain's metres before contouring, e.g. {@link Contour.FEET} */
    multiplier: number;
    /** Tile space the lines are generated in */
    extent: number;
    /** Terrain pixels to continue each line past the tile edge so adjacent tiles overlap */
    buffer: number;
}

/** Raw contour parameters, as a query string or `args` map carries them */
export type ContourInput = Partial<Record<keyof ContourOptions, string | string[] | undefined>>;

/** Intervals keyed by the lowest zoom they apply from */
export type ContourThresholds = Record<number, number | number[]>;

export interface Isoline {
    /** Elevation of the line in output units */
    elevation: number;
    /** Index of the coarsest interval the elevation is a multiple of; 0 for minor lines */
    level: number;
    /** Lines in tile space, rounded to the integer grid; closed lines repeat their first position last */
    lines: VectorPosition[][];
}

export interface ContourLayerOptions {
    layer?: string;
    elevationKey?: string;
    levelKey?: string;
}

const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;

// [from, to] edge pairs per corner mask (tl 8, tr 4, br 2, bl 1), higher ground on the left of travel
const CASES: readonly (readonly number[])[] = [
    [],
    [BOTTOM, LEFT],
    [RIGHT, BOTTOM],
    [RIGHT, LEFT],
    [TOP, RIGHT],
    [BOTTOM, LEFT, TOP, RIGHT],
    [TOP, BOTTOM],
    [TOP, LEFT],
    [LEFT, TOP],
    [BOTTOM, TOP],
    [LEFT, TOP, RIGHT, BOTTOM],
    [RIGHT, TOP],
    [LEFT, RIGHT],
    [BOTTOM, RIGHT],
    [LEFT, BOTTOM],
    [],
];

const MULTIPLE_TOLERANCE = 1e-9;

class Fragment {
    start: number;
    end: number;
    private readonly head: number[] = [];
    private readonly tail: number[] = [];

    constructor(start: number, end: number) {
        this.start = start;
        this.end = end;
    }

    append(x: number, y: number): void {
        this.tail.push(x, y);
    }

    prepend(x: number, y: number): void {
        this.head.push(x, y);
    }

    join(other: Fragment): void {
        other.flatten(this.tail);
        this.end = other.end;
    }

    flatten(into: number[] = []): number[] {
        for (let i = this.head.length - 2; i >= 0; i -= 2) into.push(this.head[i], this.head[i + 1]);
        for (let i = 0; i < this.tail.length; i++) into.push(this.tail[i]);
        return into;
    }
}

interface LevelState {
    starts: Map<number, Fragment>;
    ends: Map<number, Fragment>;
    lines: Fragment[];
}

function validate(opts: ContourOptions): ContourOptions {
    const { intervals, multiplier, extent, buffer } = opts;

    if (!Array.isArray(intervals) || intervals.length === 0 || intervals.length > Contour.MAX_INTERVALS) {
        throw new RangeError(`Contours need between 1 and ${Contour.MAX_INTERVALS} intervals`);
    }

    for (const interval of intervals) {
        if (!Number.isFinite(interval) || interval <= 0) {
            throw new RangeError(`Invalid contour interval: ${interval}`);
        }

        const ratio = interval / intervals[0];
        if (Math.abs(ratio - Math.round(ratio)) > MULTIPLE_TOLERANCE) {
            throw new RangeError(`Contour interval ${interval} is not a multiple of ${intervals[0]}`);
        }
    }

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
        throw new RangeError(`Invalid contour multiplier: ${multiplier}`);
    }

    if (!Number.isInteger(extent) || extent < Contour.MIN_EXTENT || extent > Contour.MAX_EXTENT) {
        throw new RangeError(`Invalid contour extent: ${extent}`);
    }

    if (!Number.isInteger(buffer) || buffer < 0 || buffer > Contour.MAX_BUFFER) {
        throw new RangeError(`Invalid contour buffer: ${buffer}`);
    }

    return opts;
}

function single(input: ContourInput, key: keyof ContourOptions): string | undefined {
    const raw = input[key];
    if (Array.isArray(raw)) throw new TypeError(`Invalid contour ${key}: expected a single value`);
    return raw;
}

function numeric(key: keyof ContourOptions, raw: string): number {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) {
        throw new Error(`Invalid contour ${key} "${raw}": expected a number`);
    }

    return value;
}

/** Elevation at the corners between pixels, the mean of the four pixel centres around each */
function corners(terrain: Terrain, buffer: number, multiplier: number): Float32Array {
    const stride = terrain.size + 2 * buffer + 1;
    const grid = new Float32Array(stride * stride);

    for (let gy = 0; gy < stride; gy++) {
        const y = gy - buffer;

        for (let gx = 0; gx < stride; gx++) {
            const x = gx - buffer;

            grid[gy * stride + gx] = (terrain.at(x - 1, y - 1) + terrain.at(x, y - 1) + terrain.at(x - 1, y) + terrain.at(x, y)) / 4 * multiplier;
        }
    }

    return grid;
}

function positions(flat: number[]): VectorPosition[] {
    const line: VectorPosition[] = [];

    for (let i = 0; i < flat.length; i += 2) {
        const x = Math.round(flat[i]);
        const y = Math.round(flat[i + 1]);
        const last = line.at(-1);

        if (!last || last[0] !== x || last[1] !== y) line.push([x, y]);
    }

    return line;
}

/**
 * Contour lines: parse and serialise options, trace the isolines of a
 * {@link Terrain} with marching squares and render them as a {@link Vector}
 * tile. Use a terrain padded by `buffer + 1` pixels so lines meet across tile edges.
 */
export class Contour {
    /** Multiplier producing contours in feet */
    static readonly FEET = 3.28084;

    static readonly MAX_INTERVALS = 4;
    static readonly MIN_EXTENT = 256;
    static readonly MAX_EXTENT = 16384;
    static readonly MAX_BUFFER = 16;
    /** Most contour elevations a single tile may span before {@link isolines} refuses the interval */
    static readonly MAX_LEVELS = 10000;

    static readonly DEFAULTS: Readonly<ContourOptions> = {
        intervals: [20, 100],
        multiplier: 1,
        extent: DEFAULT_EXTENT,
        buffer: 1,
    };

    static readonly DEFAULT_LAYER: Readonly<Required<ContourLayerOptions>> = {
        layer: 'contours',
        elevationKey: 'ele',
        levelKey: 'level',
    };

    /**
     * Fill and validate options from raw string parameters; unknown keys are
     * ignored. `intervals` is a comma separated list or one value per entry.
     */
    static parse(input: ContourInput = {}): ContourOptions {
        const defaults = Contour.DEFAULTS;

        const rawIntervals = input.intervals;
        let intervals = [...defaults.intervals];

        if (rawIntervals !== undefined) {
            const values = (Array.isArray(rawIntervals) ? rawIntervals : [rawIntervals]).flatMap(value => value.split(','));
            intervals = values.map(value => numeric('intervals', value));
        }

        const multiplier = single(input, 'multiplier');
        const extent = single(input, 'extent');
        const buffer = single(input, 'buffer');

        return validate({
            intervals,
            multiplier: multiplier === undefined ? defaults.multiplier : numeric('multiplier', multiplier),
            extent: extent === undefined ? defaults.extent : numeric('extent', extent),
            buffer: buffer === undefined ? defaults.buffer : numeric('buffer', buffer),
        });
    }

    /** Normalised string parameters for every option, the inverse of {@link parse} */
    static serialize(opts: ContourOptions): Record<keyof ContourOptions, string> {
        return {
            intervals: opts.intervals.join(','),
            multiplier: String(opts.multiplier),
            extent: String(opts.extent),
            buffer: String(opts.buffer),
        };
    }

    /**
     * Intervals for a zoom from a zoom keyed table, taking the entry at or
     * nearest below the zoom. Empty when the zoom is below every entry.
     */
    static intervals(zoom: number, thresholds: ContourThresholds): number[] {
        let best = -Infinity;

        for (const key of Object.keys(thresholds)) {
            const z = Number(key);
            if (z <= zoom && z > best) best = z;
        }

        if (best === -Infinity) return [];

        const found = thresholds[best];
        return Array.isArray(found) ? [...found] : [found];
    }

    /**
     * Trace every contour line crossing a terrain tile in a single pass,
     * ordered by elevation. Cells touching a NaN sample are skipped.
     */
    static isolines(terrain: Terrain, options: Partial<ContourOptions> = {}): Isoline[] {
        const { intervals, multiplier, extent, buffer } = validate({ ...Contour.DEFAULTS, ...options });

        const interval = intervals[0];
        const multiples = intervals.map(value => Math.round(value / interval));

        const cells = terrain.size + 2 * buffer;
        const stride = cells + 1;
        const scale = extent / terrain.size;
        const grid = corners(terrain, buffer, multiplier);

        let low = Infinity;
        let high = -Infinity;

        for (let i = 0; i < grid.length; i++) {
            if (grid[i] < low) low = grid[i];
            if (grid[i] > high) high = grid[i];
        }

        if ((high - low) / interval > Contour.MAX_LEVELS) {
            throw new RangeError(`Contour interval ${interval} is too fine for terrain spanning ${low} to ${high}`);
        }

        const levels = new Map<number, LevelState>();

        let cx = 0;
        let cy = 0;
        let tl = 0;
        let tr = 0;
        let bl = 0;
        let br = 0;
        let px = 0;
        let py = 0;

        const locate = (edge: number, threshold: number): void => {
            if (edge === TOP) {
                px = cx + (threshold - tl) / (tr - tl);
                py = cy;
            } else if (edge === BOTTOM) {
                px = cx + (threshold - bl) / (br - bl);
                py = cy + 1;
            } else if (edge === LEFT) {
                px = cx;
                py = cy + (threshold - tl) / (bl - tl);
            } else {
                px = cx + 1;
                py = cy + (threshold - tr) / (br - tr);
            }

            px = (px - buffer) * scale;
            py = (py - buffer) * scale;
        };

        const key = (edge: number, corner: number): number => {
            if (edge === TOP) return corner * 2;
            if (edge === BOTTOM) return (corner + stride) * 2;
            if (edge === LEFT) return corner * 2 + 1;
            return (corner + 1) * 2 + 1;
        };

        const connect = (state: LevelState, from: number, to: number, corner: number, threshold: number): void => {
            const { starts, ends } = state;
            const startKey = key(from, corner);
            const endKey = key(to, corner);

            const before = ends.get(startKey);
            const after = starts.get(endKey);

            if (before && after) {
                ends.delete(startKey);
                starts.delete(endKey);

                if (before === after) {
                    locate(to, threshold);
                    before.append(px, py);
                    state.lines.push(before);
                } else {
                    before.join(after);
                    ends.set(before.end, before);
                }
            } else if (before) {
                ends.delete(startKey);
                locate(to, threshold);
                before.append(px, py);
                before.end = endKey;
                ends.set(endKey, before);
            } else if (after) {
                starts.delete(endKey);
                locate(from, threshold);
                after.prepend(px, py);
                after.start = startKey;
                starts.set(startKey, after);
            } else {
                const fragment = new Fragment(startKey, endKey);
                locate(from, threshold);
                fragment.append(px, py);
                locate(to, threshold);
                fragment.append(px, py);
                starts.set(startKey, fragment);
                ends.set(endKey, fragment);
            }
        };

        for (cy = 0; cy < cells; cy++) {
            for (cx = 0; cx < cells; cx++) {
                const corner = cy * stride + cx;

                tl = grid[corner];
                tr = grid[corner + 1];
                bl = grid[corner + stride];
                br = grid[corner + stride + 1];

                const min = Math.min(tl, tr, bl, br);
                if (Number.isNaN(min)) continue;
                const max = Math.max(tl, tr, bl, br);

                const last = Math.floor(max / interval);

                for (let k = Math.ceil(min / interval); k <= last; k++) {
                    const threshold = k * interval;
                    const segments = CASES[(tl > threshold ? 8 : 0) | (tr > threshold ? 4 : 0) | (br > threshold ? 2 : 0) | (bl > threshold ? 1 : 0)];
                    if (segments.length === 0) continue;

                    let state = levels.get(k);
                    if (!state) {
                        state = { starts: new Map(), ends: new Map(), lines: [] };
                        levels.set(k, state);
                    }

                    for (let s = 0; s < segments.length; s += 2) {
                        connect(state, segments[s], segments[s + 1], corner, threshold);
                    }
                }
            }
        }

        const isolines: Isoline[] = [];

        for (const [k, state] of [...levels].toSorted(([a], [b]) => a - b)) {
            const lines: VectorPosition[][] = [];

            for (const fragment of [...state.lines, ...state.starts.values()]) {
                const line = positions(fragment.flatten());
                if (line.length >= 2) lines.push(line);
            }

            if (lines.length === 0) continue;

            let level = 0;
            for (let i = 1; i < multiples.length; i++) {
                if (k % multiples[i] === 0) level = i;
            }

            isolines.push({
                elevation: Math.round(k * interval * 1e6) / 1e6 + 0,
                level,
                lines,
            });
        }

        return isolines;
    }

    /**
     * Contour lines for a terrain tile as a vector tile with one multi-part
     * LineString per elevation carrying its elevation and level
     */
    static render(terrain: Terrain, options: Partial<ContourOptions> = {}, layerOptions: ContourLayerOptions = {}): Vector {
        const { layer, elevationKey, levelKey } = { ...Contour.DEFAULT_LAYER, ...layerOptions };
        const extent = options.extent ?? Contour.DEFAULTS.extent;

        const vector = new Vector();
        const isolines = Contour.isolines(terrain, options);
        if (isolines.length === 0) return vector;

        const contours = vector.layer(layer, { extent });

        for (const isoline of isolines) {
            contours.add({
                type: 'LineString',
                geometry: isoline.lines,
                properties: {
                    [elevationKey]: isoline.elevation,
                    [levelKey]: isoline.level,
                },
            });
        }

        return vector;
    }
}
