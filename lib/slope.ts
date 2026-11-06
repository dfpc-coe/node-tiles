import { Raster } from './raster.js';
import type { Terrain } from './terrain.js';

export type RGBA = [number, number, number, number];

/** A slope angle band coloured as [lower, upper) degrees */
export interface SlopeClass {
    lower: number;
    upper: number;
    color: RGBA;
}

export interface LegendEntry {
    label: string;
    /** CSS colour of the legend swatch */
    color: string;
}

const LAYER_PATTERN = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):#?([0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Slope angle shading: parse and serialise class definitions, describe them
 * as a legend and render a {@link Terrain} into a transparent RGBA raster.
 */
export class Slope {
    static readonly MAX_CLASSES = 16;

    /** Avalanche slope angle classes used when a caller supplies none */
    static readonly DEFAULT_CLASSES: readonly SlopeClass[] = [
        { lower: 27, upper: 30, color: [255, 235, 59, 200] },
        { lower: 30, upper: 35, color: [255, 152, 0, 200] },
        { lower: 35, upper: 45, color: [244, 67, 54, 200] },
        { lower: 45, upper: 50, color: [156, 39, 176, 200] },
        { lower: 50, upper: 90, color: [33, 33, 33, 200] },
    ];

    /**
     * Parse `lower:upper:hex_color` definitions, where the colour is RRGGBB or
     * RRGGBBAA with an optional leading `#`. No values means the default classes.
     */
    static parse(raw: string | string[] | undefined): SlopeClass[] {
        const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        if (!values.length) return [...Slope.DEFAULT_CLASSES];

        if (values.length > Slope.MAX_CLASSES) {
            throw new Error(`At most ${Slope.MAX_CLASSES} slope classes are allowed`);
        }

        return values.map((value) => {
            const match = LAYER_PATTERN.exec(value);
            if (!match) throw new Error(`Invalid slope class "${value}": expected lower:upper:hex_color`);

            const lower = Number(match[1]);
            const upper = Number(match[2]);
            if (lower >= upper || upper > 90) {
                throw new Error(`Invalid slope class "${value}": expected 0 <= lower < upper <= 90`);
            }

            const hex = match[3];
            const color: RGBA = [
                parseInt(hex.slice(0, 2), 16),
                parseInt(hex.slice(2, 4), 16),
                parseInt(hex.slice(4, 6), 16),
                hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
            ];

            return { lower, upper, color };
        });
    }

    /** Normalised `lower:upper:hex` strings, the inverse of {@link parse} */
    static serialize(classes: readonly SlopeClass[]): string[] {
        return classes.map(({ lower, upper, color }) => {
            const hex = color
                .slice(0, color[3] === 255 ? 3 : 4)
                .map(c => c.toString(16).padStart(2, '0'))
                .join('');

            return `${lower}:${upper}:${hex}`;
        });
    }

    static legend(classes: readonly SlopeClass[] = Slope.DEFAULT_CLASSES): LegendEntry[] {
        return classes.map(({ lower, upper, color: [r, g, b, a] }) => ({
            label: upper >= 90 ? `${lower}°+` : `${lower}-${upper}°`,
            color: `rgba(${r}, ${g}, ${b}, ${Math.round(a / 255 * 100) / 100})`,
        }));
    }

    /** Colour each slope value by the first class whose band contains it; unclassified pixels stay transparent */
    static colorize(slope: Float32Array, size: number, classes: readonly SlopeClass[] = Slope.DEFAULT_CLASSES): Raster {
        const raster = Raster.alloc(size, size, 4);

        if (slope.length !== size * size) {
            throw new RangeError(`Slope grid holds ${slope.length} values but a ${size}px tile needs ${size * size}`);
        }

        for (let i = 0; i < slope.length; i++) {
            for (const { lower, upper, color } of classes) {
                if (slope[i] >= lower && slope[i] < upper) {
                    raster.data.set(color, i * 4);
                    break;
                }
            }
        }

        return raster;
    }

    /** Render slope angle classes for a terrain tile as an RGBA raster */
    static render(terrain: Terrain, classes: readonly SlopeClass[] = Slope.DEFAULT_CLASSES): Raster {
        return Slope.colorize(terrain.slope(), terrain.size, classes);
    }
}
